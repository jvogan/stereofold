import { lessonEntryCameraScene } from './lesson-entry-camera.js';
import { lessonSourceInitialization } from './lesson-source-initialization.js';
import { molecularLessonToTour } from './molecular-lesson-tour.js';
import { lessonRestingState } from './tour-player.js';
// @ts-ignore Shared JavaScript menu status store.
import { assistantStatus } from '../../lab/browser-roundtrip/assistant-status.mjs';
import { waitForPanelRender, panelEntering, sameEntryScene, withWearerEdits } from './inspection-render-settle.js';
import { createSceneHistoryClient } from './scene-history-client.js';
import { sceneImportPreflightView } from './scene-import-preflight-view.js';
// @ts-ignore Shared XR liveness module.
import { createConnectionWatchdog, subscribeConnectionStatus, connectionStatus, setConnectionStatus, setConnectionFrameHandler, setConnectionRecovery, LINK_LOST, PAIR_AGAIN } from '../../lab/browser-roundtrip/connection-liveness.mjs';
// @ts-ignore Shared renderer budget confirmation.
import { sourceGeometryBudget, geometryBudgetChanged } from '../../lab/browser-roundtrip/geometry-advisory.mjs';
// @ts-ignore Shared renderer budget confirmation.
import { geometryBudgetConfirmation } from '../../lab/browser-roundtrip/representation-budget.mjs';
// @ts-ignore Shared diagnostics module.
import { recordLoopStage } from '../../lab/browser-roundtrip/loop-timing.mjs';
// @ts-ignore On-demand, scalar-only renderer diagnostics.
import { captureRendererStats } from '../../lab/browser-roundtrip/renderer-stats.mjs';
import './inspector.css';
import './inspector-card-chrome.css';
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import { PLUGIN_VERSION } from 'molstar/lib/mol-plugin/version.js';
import { desiredPanelHeight, panelFixedHeight } from './panel-size.js';
import { readStructureHeading, type StructureHeading } from './structure-heading.js';
import { createInspectorDisplayModeController, waitForInspectorDisplayModeBox } from './inspector-display-mode.js';
import { inspectorHeadsetRequest, type HeadsetChoice } from './inspector-headset-request.js';
import { followHostTheme } from './inspection-theme.js';
import { thrownErrorMessage, toolResultError } from './tool-result.js';
import { inspectionFailureReceipt, rendererContextReport } from './inspection-failure-receipt.js';
import { canRefreshInspectionAttach, isStaleInspectionAttach, MAX_ATTACH_REFRESHES, STALE_ATTACH_MESSAGE } from './inspection-attach-recovery.js';
import { VIEWER_BUILD_PLACEHOLDER } from './viewer-build.js';
import { reloadOutdatedCompanion, rejectsPageBuild } from './inspector-build-reload.js';
import { companionConnectionFrame, recoverCompanionConnection, companionPageKey, createCompanionClient } from './inspection-companion-client.js';
import { grownTierIntent, mountTourPlayer, placeLessonScene, savedLessonPlayback, stopUnanimatedLessonPlayback, type TourPlayer, type TourStep, type StageContinuationIntent } from './tour-player.js';
import { TOURS } from './tour-catalog.js';
import { mountExperiencePlayer, type ExperiencePlayer, type ExperienceView } from './experience-player.js';
import { inspectionRefusalCaption, shouldCaptionInspectionRefusal } from './inspection-refusal-caption.js';
import type { JourneySaveClaim } from './inspection-contract.js';
import { findInspectionCanvas, recordInspectionCanvas, downloadInspectionRecording } from './inspection-recording.js';
import { createPanelNarrator } from './panel-narration.js';
import { applyTourCommand, tourHeartbeat, createPanelTourController } from './inspection-tour-client.js';
import { confirmFailureRecovery, followsSourceTransition, panelAvailability, saveFailureRecovery, staleHudWaiting } from './inspection-panel-recovery.js';
import { createSaveRetryAdmission } from './inspection-save-retry.js';
import {
  applyRendererTabClose, decideRendererTabClose, isRendererHeartbeatFailure, tabIsHostOpened,
} from './renderer-tab.js';
import { companionStartupMessage, SHARE_ENDED_STARTUP_FAILURE } from './companion-startup.js';
import { decodeInspectionCatalog, verifyInspectionCatalogSource } from './inspection-catalog-codec.js';
import { hydrateComparisonSource, createInspectionBytesHydrator } from './inspection-chunk-client.js';
const hydrateInspectionBytes = createInspectionBytesHydrator();
import { createReadinessStrip, type ReadinessStripHandlers } from './inspection-readiness-strip.js';
// A swap the wearer is standing inside says which phase it is in
// and never waits forever in any of them.
import { abortableSwapPhase, createSourceSwapTrace, type SwapTrace } from './source-swap-trace.js';
import { GROW_NOT_YET_SPOKEN, retryWhileNotYet } from './command-in-flight.js';
import { nativeStructureViewerPrompt, officialMolstarUrl, parseNativeStructureViewerHandoff, type NativeStructureViewerHandoff } from './inspection-handoff.js';
import { mountConnectedWorkbench } from './connected-workbench.js';
// Which application this panel is mounted in, so a button
// never names one the host never claimed to be.
import { hostIdentity, offerCodexHandoff, readCodexOptIn, writeCodexOptIn } from './host-identity.js';
import { executeInspectionVoiceAction } from './inspection-voice-actions.js';
// The compound line the host names and this page speaks, shared
// so the two can never say different things about one change.
import { compoundConfirmation, scopedStyleConfirmation } from './inspection-operation-words.js';
import { enterImmersiveWithFallback } from './xr-entry-fallback.js';
import { createPollBackoff } from './inspection-poll-backoff.js';
// @ts-ignore Browser helper shared with the headset runtime.
import { isAppleSafariXr } from '../../lab/browser-roundtrip/xr-session-request.mjs';
// @ts-ignore Shared JavaScript device classification. The
// growth budget is a property of the headset, so the page has to name it.
import { deviceClass } from '../../lab/browser-roundtrip/input-capabilities.mjs';
// The hint the detailed page leaves when the wearer taps Back.
import { armXrReentryTap, readXrReentry, xrReentryEntryView } from './xr-reentry-hint.js';
// @ts-ignore Shared browser microphone interaction, also used by the XR toolbar.
import { createVoiceInteraction } from '../../lab/browser-roundtrip/voice-interaction.mjs';
// @ts-ignore Shared immersive status sink; safe when no headset is presenting.
import { showHeadsetCaption } from '../../lab/browser-roundtrip/xr-manipulate.mjs';
// @ts-ignore Shared JavaScript grip push-to-talk module.
import { setPushToTalkSender, setVoiceCommandSender } from '../../lab/browser-roundtrip/push-to-talk-grip.mjs';
// @ts-ignore Shared JavaScript voice narration slot.
import { setVoiceCommandSpeaker, voiceCommandSpeaker } from '../../lab/browser-roundtrip/voice-command-speaker.mjs';
// @ts-ignore Shared JavaScript density wording. The one line
// a wearer gets when the map will not draw, spoken and plated in the same words.
import { MAP_DRAW_FAILED_SPOKEN } from '../../lab/browser-roundtrip/volume-source.mjs';
// @ts-ignore Shared JavaScript caption-plate event name. The page arms the plate
// from this event whether the sentence came from the host or from a failed draw.
import { GROWTH_CAPTION_EVENT } from '../../lab/browser-roundtrip/growth-caption.mjs';
// @ts-ignore Shared JavaScript confirmation wording. An
// agent's command and a spoken one confirm in exactly the same words.
import { SPATIAL_VOICE_ACTIONS, renderQualityConfirmation } from '../../lab/browser-roundtrip/voice-command-runner.mjs';
// @ts-ignore Shared JavaScript blend-mode wording. The page and
// the headset name the same press with the same words.
import { entryFallbackCopy } from '../../lab/browser-roundtrip/xr-session-request.mjs';
// @ts-ignore Shared JavaScript decision about which side opens the full Mol*
// viewer.
import { createDetailedViewAvailability, DETAILED_VIEW_UNREACHABLE_CAPTION } from '../../lab/browser-roundtrip/workbench-handoff.mjs';
// @ts-ignore Shared JavaScript headset microphone streamer.
import { setPushToTalkAudioSender, primePushToTalkMicrophone } from '../../lab/browser-roundtrip/push-to-talk-audio.mjs';
// @ts-ignore Shared JavaScript headset view capture.
import { setHeadsetViewSender, requestHeadsetViewCapture } from '../../lab/browser-roundtrip/xr-snapshot.mjs';
// @ts-ignore Shared JavaScript headset diagnostics ring buffer.
import { installHeadsetDiagnostics, recordHeadsetEvent } from '../../lab/browser-roundtrip/headset-diagnostics.mjs';
// @ts-ignore Shared JavaScript reply and speech diagnostics for the talk orb.
import { installTalkReplyDiagnostics, recordTalkReplyDelivery } from '../../lab/browser-roundtrip/talk-reply-diagnostics.mjs';
// @ts-ignore Shared JavaScript playback of the reply audio this Mac rendered.
import { installReplyAudio } from '../../lab/browser-roundtrip/reply-audio.mjs';
// @ts-ignore Shared workspace is deliberately the same implementation as the preview.
import { createInspectionWorkspace } from '../../lab/inspection/workspace.mjs';
// Only wire constants here: do not bundle server validators/Zod into the UI.
let comparisonPrimaryName='the primary structure';
/**
 * The comparison structures this page has assembled, by source digest and
 * assembly, from the last non-empty registration.
 *
 * A heartbeat repeats a comparison's descriptors for as long as a command or
 * a shared scene names it, and pulling 30 MB again for each would cost more
 * than the structure is worth. An entry is reused only when its descriptors
 * (the two part digests and sizes) are identical, so a replaced structure is
 * fetched afresh, and a load that fails is dropped so the next call retries.
 */
let heldComparisons=new Map<string,{identity:string;loaded:Promise<any>}>();
let comparisonRegistration=0;
async function registerComparisonSources(sources:any[]|undefined, sessionId:string) {
  // Omitted transport is no update. Explicit emptiness supersedes a pending
  // publication without discarding assets retained for local/shared history.
  if(sources===undefined)return;
  const ownRegistration=++comparisonRegistration;
  if(!sources.length) return;
  const next=new Map<string,{identity:string;loaded:Promise<any>}>();
  for(const source of sources) {
    const key=`${source?.sha256}:${source?.assemblyId}`;
    const identity=JSON.stringify([source?.sourceBytes,source?.catalogBytes]);
    let held=heldComparisons.get(key);
    if(!held || held.identity!==identity) {
      const entry:{identity:string;loaded:Promise<any>}={identity,loaded:(async()=>{
        await hydrateComparisonSource(source,call,sessionId);
        const catalog=await decodeInspectionCatalog(source.catalogWire);
        await verifyInspectionCatalogSource(source.cif,catalog);
        return {...source,catalog};
      })()};
      entry.loaded.catch(()=>{if(heldComparisons.get(key)===entry)heldComparisons.delete(key);});
      held=entry;
    }
    next.set(key,held);
  }
  heldComparisons=next;
  const decoded=await Promise.all(sources.map(source=>next.get(`${source?.sha256}:${source?.assemblyId}`)!.loaded));
  // Hydration and a heartbeat may overlap. Only the newest asset payload may
  // publish: the viewer prunes unused sources when registering this set.
  if(comparisonRegistration!==ownRegistration)return;
  workspace?.registerComparisonSources?.(decoded);
}
const PRIVATE_KEY = 'stereo_structure/inspection';
document.body.dataset.inspectorBuild = VIEWER_BUILD_PLACEHOLDER;
const app = new App({name:'Stereofold Inspector',version:'0.1.22'},{},{autoResize:false});
const isCompanion=(window as any).__STEREOFOLD_COMPANION__===true;
if(isCompanion) {
  installHeadsetDiagnostics().begin();
  installTalkReplyDiagnostics();
  installReplyAudio();
  document.body.dataset.companion='true';
  // pagehide tears down the transport and timers. A history-cache restore
  // retains that closed JS heap; reload to establish a fresh bound panel.
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
}
/**
 * How this page takes delivery of the coordinates.
 *
 * On the host bridge there is a documented result-size threshold and no
 * measured structure ceiling, so the panel asks for descriptors and pulls the
 * bytes in 96 KiB chunks. In the headset the coordinates already arrive as raw
 * bytes on the LAN `/source` route, which is cheaper than any chunk loop, so
 * the companion keeps the inline shape it has.
 */
const HYDRATION_TRANSPORT = isCompanion ? {} : {transport:'chunked'} as const;
let companionCall:ReturnType<typeof createCompanionClient>|undefined;
/**
 * Where "Open in Mol*" sends the wearer. See workbench-handoff.mjs.
 *
 * A host new enough to report `detailedViewAvailable` answers this without any
 * request at all; `call()` below records that field from every tool answer.
 * The `/detailed` request stays only for a host too old to carry it, and one
 * success is remembered for the life of the page. A request that cannot be
 * made is `unreachable`, never "open it on the Mac": reading it that way is
 * what sent a headset press to a monitor the wearer could not see.
 */
const detailedView=createDetailedViewAvailability({probe:async()=>{
  try {
    const response=await fetch('/detailed',{method:'GET',cache:'no-store',credentials:'omit'});
    return {ok:response.ok,status:response.status,contentType:response.headers.get('content-type')??''};
  } catch { return {failed:true}; }
}});
const syncTheme = followHostTheme(app);
let sourceGeometryBudgetSupported=false;
let rendererContextSupported=false;
let renderedSourceIdentitySupported=false;
let sourceAdvisory:{sourceToken:string;receipt:any}|undefined;
function announceSourceGeometryBudget(receipt:any,sourceToken:string) {
  if(!receipt) {sourceAdvisory=undefined;return;}
  if(sourceAdvisory?.sourceToken===sourceToken && !geometryBudgetChanged(sourceAdvisory.receipt,receipt))return;
  sourceAdvisory={sourceToken,receipt};
  workspace?.setStatus?.(receipt.message);
  try {globalThis.dispatchEvent(new CustomEvent(GROWTH_CAPTION_EVENT,{detail:{spoken:receipt.message}}));} catch { /* Receipt stays readable. */ }
}
let workspace:any, binding:any, loading=false, dirty=false, blocked=false, closed=false;
if(isCompanion) {
  // Read-only CDP support: enough to diagnose a stalled clock, without
  // exposing the workspace, scene payload or companion transport credentials.
  const diagnostics=(globalThis as any).__stereofoldDiagnostics;
  if(diagnostics) diagnostics.snapshot=()=>{
    const live=workspace?.snapshot();
    return {documentVisibility:document.visibilityState,documentHidden:document.hidden,nowMs:performance.now(),
      status:live?.status??'unavailable',ready:live?.ready===true,contextLost:live?.contextLost===true,
      presenting:live?.xrPresenting===true,drawCount:live?.drawCount??0,lastDrawTimestampMs:live?.lastDrawTimestampMs??null,
      animation:live?.animation??null,animationActivity:live?.animationActivity??null};
  };
  if(diagnostics) diagnostics.renderStats=()=>captureRendererStats(workspace?.viewer?.plugin);
}
let activePreviewRecording:AbortController|undefined;
let completedHydration=false;
let connectedWorkbench:{open:()=>void}|undefined;
let tourPlayer:TourPlayer|undefined;
let installedLesson:import('./tour-player.js').Tour|undefined;
let panelTour:ReturnType<typeof createPanelTourController>|undefined;
let tourCommandContext:any, tourCommandReceipt:any;
let experienceSourceChanged=false;
let experiencePlayer:ExperiencePlayer|undefined, experienceView:ExperienceView|undefined;
let generation=0, edits=0, timer:ReturnType<typeof setTimeout>|undefined;
let saving:Promise<void> = Promise.resolve(), rendering:Promise<void> = Promise.resolve();
const saveRetryAdmission=createSaveRetryAdmission();
// The newer host build this page should reload into, and whether the host takes `pageBuild`.
let pendingHostBuild:unknown, hostTakesPageBuild=true;
let latestToken=0, epoch:string|undefined, requestedId:string|undefined;
let panelId:string|undefined, savedScene:any, remote=false, pendingReceipt:any;
let pendingReceiptFields:string[]|undefined;
let attaching:{generation:number;promise:Promise<void>}|undefined;
let attachRetryAt=0;
/** Set when this headset tab is about to navigate to the full Mol* viewer. */
let leavingForDetailedView=false;
/**
 * Whether this Mac serves the full Mol* viewer, as the host itself reports it
 * on every inspection answer. The desktop panel offers that viewer only once
 * the host has said so, rather than showing a button that opens nothing.
 */
let detailedViewHere=false;
let pollTimer:ReturnType<typeof setTimeout>|undefined;
/**
 * Two guards, because one of them has to be allowed to wait.
 *
 * `pollInFlight` owns the half of the beat that can legitimately take tens of
 * seconds — a save, a re-attach, a hydration, a shared-scene follow. `beatInFlight`
 * owns the half that must never take that long: the `poll_inspection` that keeps
 * the panel current and is the only place a queued command is claimed. Before
 * they were separated, one guard covered both, so a poll that was rebuilding a
 * scene silenced every tick behind it, and a command issued in that window
 * expired at fifteen seconds without the page ever having been offered it.
 */
let pollInFlight=false, beatInFlight=false;
let beatCompletion:Promise<void>|undefined;
let desktopReceiptInFlight=false;
let desktopReceiptBeat:{sent:any;commandId:string}|undefined;
// User input may begin and end while a source read is awaiting bytes. Keep
// that edge even when hydration temporarily suppresses the save timer.
let localInteractionSerial=0;
// When the wearer last pressed a menu row or face button: an edit, unlike a
// hand on the structure, which only places it. Read by a tour's draw in `receive`.
let lastLocalEditAt=-Infinity;
/** When this Mac tab went hidden, and which panel stepped aside for it. See `stepAsideWhileHidden`. */
let hiddenSince:number|undefined, steppedAside:string|undefined;
document.addEventListener('visibilitychange',()=>{hiddenSince=document.visibilityState==='hidden'?Date.now():undefined;});
/** The host's heartbeat grace for a desktop panel; after it the host drops a silent panel itself. */
const HIDDEN_STEP_ASIDE_MS=10_000;
// The journey owns source/read/save/attach/ack as one transaction. The fast
// heartbeat stays live, but the full poll must not register a replacement
// without the retiring panel's identity while hydration is saving.
let experiencePreparing=false;
let connectionWatchdog:any;
let repairNeeded=false, nextRepairAt=0;
let rebinding:Promise<void>|undefined, rebindRetryAt=0;
let retryHydrationId:string|undefined;
let loadErrorDetails='';
let connectionNotice=false;
let updateReadinessStrip=(readiness:unknown)=>{void readiness;};
/**
 * Consecutive failed heartbeats on a host-opened Mac renderer
 * tab. The headset companion never closes itself; a pasted tab neither.
 */
let rendererFailedHeartbeats=0;
function rendererTabAccess(): { sameOriginTop: boolean; hostOpened: boolean } {
  try {
    const top=window.top??window;
    return {sameOriginTop:true,hostOpened:tabIsHostOpened({opener:top.opener,name:top.name,search:top.location.search})};
  } catch { return {sameOriginTop:false,hostOpened:false}; }
}
function noteRendererHeartbeat(ok:boolean, hostAskedClose=false) {
  rendererFailedHeartbeats=ok?0:rendererFailedHeartbeats+1;
  const access=rendererTabAccess();
  applyRendererTabClose(decideRendererTabClose({
    companion:isCompanion,sameOriginTop:access.sameOriginTop,hostOpened:access.hostOpened,
    hostAskedClose,consecutiveFailedHeartbeats:rendererFailedHeartbeats,
  }),()=>{try{(window.top??window).close();}catch{/* Chrome ignores close on a user-opened tab */}});
}
let handoffSource:NativeStructureViewerHandoff|undefined;
let handoffFeedback='';
let handoffPending=false, handoffVersion=0;
let syncHandoff=()=>{};
let voiceInteraction:any;
let voiceMessage='Tap to talk. Microphone access is requested only when you start.';
let updateVoiceUi=()=>{};
let pendingVoiceIntent:string|undefined;
const seenVoicePlaybacks=new Set<string>();
let voiceHandoffBusy=false;
let voiceReadyBinding='';
// A source-changing fast command owns its navigation through hydrate. That
// one transition must retain the in-flight microphone request long enough to
// validate the new binding and speak its rendered acknowledgement.
let voiceOwnedSourceTransition=0;
const voiceBindingKey=(value:any)=>JSON.stringify([value.sessionId,value.serverEpoch,value.sourceToken,value.baseStateRevision,value.baseInspectionRevision,value.panelId]);

async function waitForVoicePanel() {
  const started=Date.now(), ownGeneration=generation;
  while(!closed && generation===ownGeneration && Date.now()-started<3500) {
    if(voiceReadyBinding===voiceBindingKey({...expected(),panelId}))return;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw Error('The headset view has not finished saving. Please try again.');
}

async function handoffSpokenRequest() {
  // The standalone preview host deliberately advertises no chat capability.
  // It must not consume speech and pretend that an idle task was awakened.
  if(isCompanion || voiceHandoffBusy || closed || loading || !binding || !app.getHostCapabilities()?.message?.text || !panelId || dirty || blocked) return;
  voiceHandoffBusy=true;
  const ownGeneration=generation, sent={...expected(),panelId};
  const claimIsStale=()=>closed || loading || !binding || generation!==ownGeneration
    || voiceBindingKey({...expected(),panelId})!==voiceBindingKey(sent);
  let deliveryStarted=false;
  try {
    const result=await call('claim_voice_intent',sent);
    // This is routine background polling. A source swap can retire its binding
    // before an empty claim or refusal arrives; nothing has reached the task.
    if(claimIsStale())return;
    const claim=(result._meta?.[PRIVATE_KEY] as any)?.voiceIntent;
    if(!claim?.intent) return;
    const intent=claim.intent;
    deliveryStarted=true;
    const response=await app.sendMessage({role:'user',content:[{type:'text',text:
      `Spoken request from my connected Stereofold headset: ${intent.transcript}\n\n`+
      `Use the current inspection session ${intent.sessionId}; the originating headset panel is ${intent.panelId}. `+
      `Read current state before acting and confirm rendered changes. After handling my request, use stereo_structure.speak_to_headset with the current binding and a brief reply so I can hear it in the headset.`}]});
    if(response.isError)throw Error('The host declined the spoken request.');
    await call('acknowledge_voice_intent',{...expected(),panelId,intentId:intent.id,claimToken:claim.claimToken});
    outcome.textContent='Spoken request delivered to this task.';
  } catch(error) {
    // The server can replace the source before this panel receives its next
    // binding. An explicit pre-claim refusal means nothing was delivered.
    if(!deliveryStarted && (claimIsStale() || (error as any)?.code==='STALE_VOICE_CLAIM'))return;
    // A timeout is ambiguous. Re-sending could execute the same user action
    // twice, so leave an explicit error instead of an automatic retry.
    recordHeadsetEvent('page-error',{operation:'voice-handoff',message:thrownErrorMessage(error)});
    outcome.textContent='Could not confirm the spoken request. Check the view before asking again.';
  } finally {voiceHandoffBusy=false;}
}

function receiveSpokenReply(playback:any) {
  if(!isCompanion || !voiceInteraction || !playback?.id || seenVoicePlaybacks.has(playback.id))return;
  if(playback.panelId!==panelId || playback.sourceToken!==binding?.sourceToken)return;
  // `playing` used to be a refusal, so an agent's spoken line
  // arriving during a tour chapter was skipped and re-offered every heartbeat
  // until its 300 s TTL dropped it unheard. It now waits in the speech queue
  // instead. An open microphone is still a refusal: the wearer is mid-request.
  if(!['idle','error','playing'].includes(voiceInteraction.state()))return;
  seenVoicePlaybacks.add(playback.id);
  if(seenVoicePlaybacks.size>64)seenVoicePlaybacks.delete(seenVoicePlaybacks.values().next().value!);
  const targetPanel=panelId,sourceToken=binding.sourceToken;
  void voiceInteraction.play(playback.wavBase64,'Reply from your task').then(async(played:boolean)=>{
    if(closed || panelId!==targetPanel || binding?.sourceToken!==sourceToken)return;
    // A line dropped for a new tour chapter was never heard. Acknowledging it
    // would tell the agent the wearer got an answer that never played, so let
    // the short-lived queue offer it again on the next heartbeat instead.
    if(played===false){seenVoicePlaybacks.delete(playback.id);return;}
    await call('acknowledge_voice_playback',{...expected(),panelId,playbackId:playback.id});
    pendingVoiceIntent=undefined;
  }).catch((error:unknown)=>{
    // Leave the short-lived queue entry unacknowledged, so a transient audio
    // failure can be retried by the next heartbeat instead of being lost.
    seenVoicePlaybacks.delete(playback.id);
    // A reply a new chapter spoke over is re-offered like any other, but it is
    // not a fault: saying so would overwrite the status the chapter just set.
    if(speechWasInterrupted(error))return;
    recordHeadsetEvent('page-error',{operation:'reply-playback',message:thrownErrorMessage(error)});
    voiceMessage='Could not play the reply. Try again.';updateVoiceUi();
  });
}

async function beginVoiceRequest() {
  tourPlayer?.pause(); experiencePlayer?.pause();
  await workspace?.viewer.inspection.setMotion({paused:true});
  scheduleSave();
  await save();
  if (!binding || !panelId || loading || blocked || dirty || !workspace?.snapshot().ready)
    throw Error('Wait for the structure to finish connecting before speaking.');
  await waitForVoicePanel();
  return { generation, utteranceId: crypto.randomUUID(), binding: { ...expected(), panelId } };
}
async function sendVoiceRequest(audio:any, context:any) {
  if (closed || !context || context.generation!==generation || context.binding.sourceToken!==binding?.sourceToken)
    throw Error('The structure changed while recording. Please try again.');
  const result=await call('voice_command',{...context.binding,audio});
  recordLoopStage('transcript-received',context);
  const data=result.structuredContent as any;
  if(data?.heard)assistantStatus.update({heard:data.heard});
  if (closed || context.generation!==generation || context.binding.sourceToken!==binding?.sourceToken)
    throw Error('The structure changed during transcription. No command was applied.');
  if (data?.intentId) {
    pendingVoiceIntent=data.intentId;
    return { message: data.message || 'Request queued for the connected task.' };
  }
  if (!data?.command) return { message:data?.message || 'No speech was recognized.' };
  const sourceChangingCommand=['show-cas9','show-telomerase','show-tubulin','assemble-filament','assemble-microtubule','add-eb-protein','add-eb3-protein',
    'grow-structure','shrink-structure','grow-wall','grow-tip'].includes(data.command);
  if(sourceChangingCommand) voiceOwnedSourceTransition++;
  // "undo that" is executed on the Mac, because the history it
  // reads belongs to the shared scene rather than to this tab. The restoring
  // command is already queued for this panel and arrives on the next
  // heartbeat; all that is left here is the line the wearer hears.
  if(data.handled===true) {
    const handledMessage:string=data.message || 'Done.';
    try { const acknowledged=await call('voice_acknowledgement',{...expected(),panelId,message:handledMessage});
      return {message:handledMessage,wavBase64:acknowledged.structuredContent?.wavBase64}; }
    catch(error) {
      recordHeadsetEvent('speech-failed',{route:'voice-command',chars:handledMessage.length,
        status:callStatus(error),reason:thrownErrorMessage(error).slice(0,120)});
      return {message:handledMessage};
    }
  }
  let message:string;
  try {
    recordLoopStage('action-posted',context);
    message=await executeInspectionVoiceAction(data.command,{
      tour:()=>tourPlayer,experience:()=>experiencePlayer,player:()=>panelTour?.current(),workspace:()=>workspace,navigate:async(id,step)=>{await navigateExperience(id,step);},grow:growStructure,
      save:async()=>{scheduleSave();await save();if(dirty || blocked)throw Error('The visible action could not be saved.');},
    });
  } finally { if(sourceChangingCommand) voiceOwnedSourceTransition--; }
  recordLoopStage('receipt-rendered',context);
  await waitForVoicePanel();
  // A renderer failure never reaches this request. Bind narration to the new
  // current source after an intentional experience transition.
  //
  // The action above already happened. A refused spoken line
  // used to reject this whole request, which put the voice interaction into
  // `error` and drew "Could not apply" over a change the wearer was looking
  // at. The caption still carries the message; only the audio is missing.
  let acknowledged:any;
  try { acknowledged=await call('voice_acknowledgement',{...expected(),panelId,message}); }
  catch(error) {
    recordHeadsetEvent('speech-failed',{route:'voice-command',chars:message.length,
      status:callStatus(error),reason:thrownErrorMessage(error).slice(0,120)});
    return {message};
  }
  return {message,wavBase64:acknowledged.structuredContent?.wavBase64};
}
const retiredEpochs = new Set<string>();
let hudSignature='';
/** When the plate last went orange, or 0. See `retireStaleHud`. */
let hudWaitingSince=0;
let entryClicks=0,pointerDowns=0,trustedClick:boolean|null=null;
const pageInput={pagePointerDowns:0,pagePointerUps:0,pageClicks:0,pointerCancels:0,
  lastInputTarget:'none' as 'none'|'enter-ar'|'enter-vr'|'canvas'|'options'|'other'};
if(isCompanion) {
  for(const [eventName,key] of [['pointerdown','pagePointerDowns'],['pointerup','pagePointerUps'],['click','pageClicks'],['pointercancel','pointerCancels']] as const) {
    document.addEventListener(eventName,event=>{
      pageInput[key]=Math.min(65535,pageInput[key]+1);
      const target=event.target instanceof Element?event.target:null;
      const entry=target?.closest<HTMLElement>('[data-enter-xr]')?.dataset.enterXr;
      pageInput.lastInputTarget=entry==='immersive-ar'?'enter-ar':entry==='immersive-vr'?'enter-vr'
        :target?.closest('canvas')?'canvas':target?.closest('.xr-options')?'options':'other';
    },true);
  }
}
function xrStartupReport() {
  const startup=workspace?.viewer.xr?.startup?.();
  return startup?{...startup,...(rendererContextSupported?{rendererContext:rendererContextReport(workspace?.snapshot())}:{}),...pageInput,build:document.body.dataset.inspectorBuild,entryClicks,pointerDowns,trustedClick,
    visible:document.visibilityState==='visible',focused:document.hasFocus()}:undefined;
}
const outcome=document.createElement('div');outcome.className='session-outcome';outcome.dataset.sessionOutcome='';outcome.setAttribute('role','status');
// An empty outcome line hides itself, so the card shows no heading until
// there is something to report. See .session-outcome:empty.
outcome.textContent=isCompanion?'Connecting to your desktop inspection…':'';
let publishedModelContextSignature='';
function publishModelContext(result:any) {
  if(isCompanion) return;
  const context=result?.structuredContent?.modelContext;
  if(!context || !app.getHostCapabilities()?.updateModelContext?.structuredContent) return;
  const signature=JSON.stringify(context);
  if(signature===publishedModelContextSignature) return;
  publishedModelContextSignature=signature;
  void app.updateModelContext({structuredContent:context}).catch(()=>{
    if(publishedModelContextSignature===signature) publishedModelContextSignature='';
  });
}
const displayModeToggle=document.createElement('button');
displayModeToggle.type='button';displayModeToggle.dataset.displayModeToggle='';displayModeToggle.hidden=true;
const displayModeController=createInspectorDisplayModeController({
  getHostContext:()=>app.getHostContext(),
  requestDisplayMode:params=>app.requestDisplayMode(params),
},state=>{
  displayModeToggle.hidden=state.hidden;
  displayModeToggle.textContent=state.label;
  displayModeToggle.title=state.title;
  displayModeToggle.setAttribute('aria-label',state.label);
  displayModeToggle.setAttribute('aria-pressed',state.ariaPressed);
});
displayModeToggle.addEventListener('click',()=>{
  displayModeToggle.disabled=true;
  void displayModeController.toggle().then(async result=>{
    const context=result.changed ? await waitForInspectorDisplayModeBox({
      expectedMode:result.mode,
      readContext:()=>app.getHostContext(),
      readBox:hostContext=>JSON.stringify([innerWidth,innerHeight,hostContext?.containerDimensions]),
      nextFrame:()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())),
    }) : app.getHostContext();
    sendSize(context);
  }).catch(()=>{
    outcome.textContent='The host could not change the inspector display mode.';
    displayModeController.sync();
    sendSize();
  }).finally(()=>{displayModeToggle.disabled=false;});
});
function showOutcome(data:any) {
  if(!data) return;
  // `saved` is an edit the Mac kept while this page was paused,
  // in the saved scene at `savedRevision`. It waits while this page is behind
  // that revision, and it is applied only when this page holds exactly that
  // revision, because this page drew it to get there. A page that caught up
  // to a later revision instead, say one the Mac saved over the edit while
  // the headset slept, drew that later scene and never this edit. Its receipt
  // then says nothing: a Waiting line left for it comes down, and it is never
  // read as applied.
  if(data.status==='saved' && Number(binding?.inspectionRevision)>data.savedRevision) {
    if(outcome.dataset.state==='waiting') {
      outcome.textContent=`Shared view shown · revision ${binding.inspectionRevision}`;outcome.dataset.state='connected';
    }
    clearWaitingHud('superseded');
    return;
  }
  assistantStatus.renderedCommand(data);
  const status=data.status==='saved'?(Number(binding?.inspectionRevision)===data.savedRevision?'rendered':'queued'):data.status;
  const revision=data.renderedRevision??data.savedRevision;
  const what=Array.isArray(data.fields)?data.fields.map((s:string)=>s==='selectionKeys'?'selection':s.replace(/([A-Z])/g,' $1').toLowerCase()).join(', '):'scene';
  outcome.textContent=['cancelled','superseded'].includes(status)?'The earlier request was dropped for your correction.'
    : data.reason==='panel_hold_expired' || data.reason==='recovery_failed' ? data.detail
    : status==='rendered'?`Applied · ${what} · revision ${revision}${data.detail?` · ${data.detail}`:''}`
    : ['queued','rendering'].includes(status)?`Waiting · ${what}`:`Could not apply · ${what}${data.detail?` · ${data.detail}`:data.reason?` · ${data.reason}`:''}`;
  outcome.dataset.state=status==='rendered'?'applied':['queued','rendering'].includes(status)?'waiting':'error';
  if(workspace?.snapshot().xrPresenting && workspace.viewer.xr?.outcome) {
    const signature=JSON.stringify([data.commandId,status,revision,what]);
    if(signature!==hudSignature) {
      hudSignature=signature;
      hudWaitingSince=outcome.dataset.state==='waiting'?Date.now():0;
      // Every hand-off from the page to the wearer's status
      // row. Without it a plate nobody wrote to and a plate that was written
      // and then overdrawn read the same in a headset log.
      // And a plate whose reason died with the page. A
      // Quest 2 recorded `hud-outcome {status:"failed",
      // fields:""}` mid-chapter with nothing left to say why; the sentence the
      // wearer was never shown is the one line a later diagnosis needs.
      recordHeadsetEvent('hud-outcome',{status,fields:what,revision:revision??null,
        ...(data.detail?{detail:String(data.detail).slice(0,160)}:{})});
      void workspace.viewer.xr.outcome(outcome.textContent,outcome.dataset.state).catch(()=>{
        hudSignature='';outcome.textContent+=' · The in-headset status could not be drawn.';
      });
    }
  }
}
/**
 * Take down an orange plate whose command is gone.
 *
 * Every ordinary command overdraws its own `Waiting` with the rendered
 * receipt. The ones that do not are the ones that disappear: a confirmation
 * dropped by `recoverConfirmation`, a panel that re-attached under a new id,
 * a claim the server let expire. Those used to leave the last sentence the
 * wearer can read saying that something is still on its way. The decision is
 * in `inspection-panel-recovery.ts` so a test can hold it.
 */
function retireStaleHud(latest:any) {
  if(!staleHudWaiting({waitingSince:hudWaitingSince,now:Date.now(),
    pendingReceipt:Boolean(pendingReceipt),latestStatus:latest?.status})) return;
  clearWaitingHud('expired');
}
/** Take down the orange plate, if one is up, and log why. */
function clearWaitingHud(reason:'expired'|'superseded') {
  if(!hudWaitingSince) return;
  hudWaitingSince=0;
  if(!workspace?.snapshot().xrPresenting || !workspace.viewer.xr?.outcome) return;
  // The next outcome has to draw even if it repeats the one just retired.
  hudSignature='';
  recordHeadsetEvent('hud-outcome',{status:reason,fields:'',revision:null});
  void workspace.viewer.xr.outcome('','').catch(()=>{});
}
/**
 * The wearer's own acknowledgment for a source load.
 *
 * Every other agent change draws `Waiting · <field>` when this page takes it
 * and `Applied · <field> · r<N>` when it has drawn and saved. A
 * `replace_inspection_source` load drew neither. The readout's title and
 * source line changed when the new coordinates arrived, so the load was not
 * silent -- but from the moment the wearer said "Show me crambin" to the
 * moment the new structure stood in front of them, the status row still
 * carried whatever the previous command had left there, for as long as this
 * host's per-source budget allows a load to take.
 *
 * The word on the plate is `structure`, not the structure's own name: the
 * readout's title line already carries the name, and the plate holds about
 * thirty characters across two lines (`outcome-copy.mjs`). Held as the new
 * source token rather than as a flag, so the orange plate and the teal one
 * that overdraws it share a command the way a command receipt's pair does.
 */
let failedSourceLoad:{sessionId:string;sourceToken:string;receipt?:Record<string,unknown>}|undefined;
let sourceLoadOutcome:{commandId:string;fields:string[]}|undefined;
/** The load is this page's work now. Drawn before any of that work. */
function beginSourceLoadOutcome(commandId:string) {
  sourceLoadOutcome={commandId,fields:['structure']};
  showOutcome({...sourceLoadOutcome,status:'rendering'});
}
/**
 * Drawn, saved and registered: the same moment the host's `sourceRenderReceipt`
 * goes rendered, on the revision that receipt names. Called after `attach` and
 * never before it, because an acknowledgment follows the frame it acknowledges.
 */
function finishSourceLoadOutcome(renderedRevision:number|undefined) {
  const pending=sourceLoadOutcome;
  if(!pending) return;
  sourceLoadOutcome=undefined;
  showOutcome({...pending,status:'rendered',renderedRevision});
}
/**
 * The load threw. `Structure load failed…` says what to do about it on the
 * caption line; this is the half that takes the orange plate down, so a
 * refused load can never be read as one that is still on its way.
 */
function failSourceLoadOutcome(detail:string) {
  const pending=sourceLoadOutcome;
  if(!pending) return;
  sourceLoadOutcome=undefined;
  showOutcome({...pending,status:'failed',detail:detail.slice(0,200)});
}
const notice=document.createElement('div'); notice.className='session-notice'; notice.hidden=true; notice.setAttribute('role','alert');
const scenePreflightNotice=document.createElement('section'); scenePreflightNotice.className='session-notice';
scenePreflightNotice.dataset.scenePreflight=''; scenePreflightNotice.hidden=true; scenePreflightNotice.setAttribute('role','status');
let sceneImportNoticeSource:{sessionId:string;sourceToken:string}|undefined;
function updateSceneImportNotice(sessionId:string,sourceToken:string,renderingDifference?:string) {
  if(renderingDifference) {
    sceneImportNoticeSource={sessionId,sourceToken};
    scenePreflightNotice.hidden=false;
    scenePreflightNotice.replaceChildren(document.createTextNode(renderingDifference));
  } else if(sceneImportNoticeSource
    && (sceneImportNoticeSource.sessionId!==sessionId || sceneImportNoticeSource.sourceToken!==sourceToken)) {
    sceneImportNoticeSource=undefined;
    scenePreflightNotice.hidden=true;
  }
}
const message=document.createElement('span');
const details=document.createElement('details');details.hidden=true;
const detailsLabel=document.createElement('summary');detailsLabel.textContent='Error details';
const detailsText=document.createElement('pre');details.append(detailsLabel,detailsText);
const reload=document.createElement('button'); reload.textContent='Load saved view';
const retry=document.createElement('button'); retry.textContent='Retry save';
const pairAgain=document.createElement('button');pairAgain.textContent='Pair again';pairAgain.hidden=true;
notice.append(message,retry,reload,pairAgain,details);
type ProblemRetryKind='save'|'poll'|'reconnect'|'delivery'|'confirmation'|'loading';
let problemRetryKind:ProblemRetryKind='save';
function showProblem(text:string, retryKind:ProblemRetryKind='save', error?:unknown) {
  problemRetryKind=retryKind;
  connectionNotice=false;retry.hidden=false;pairAgain.hidden=true;
  blocked=!(failedSourceLoad && retryHydrationId===failedSourceLoad.sessionId && workspace?.snapshot().ready); notice.hidden=false;
  message.textContent=retryHydrationId?(workspace?.snapshot().ready
    ?'Structure load failed. View preserved. Choose Retry loading.':'Structure load failed. Choose Retry loading.'):text;
  retry.textContent=retryHydrationId?'Retry loading':'Retry';
  const errorDetail=retryHydrationId?loadErrorDetails:error===undefined?'':thrownErrorMessage(error);
  details.hidden=!errorDetail;
  detailsText.textContent=errorDetail;
  reload.hidden=Boolean(retryHydrationId) && !workspace?.snapshot().ready;
  if(retryHydrationId && !workspace?.snapshot().ready) {
    document.body.dataset.ready='error';
    document.querySelector('.scene-heading h1')!.textContent='Couldn’t load structure';
    document.querySelector('.canvas-caption > span')!.textContent='STRUCTURE NOT LOADED';
    workspace.setStatus('Structure not loaded. See the session message above.',true);
  }
}
// Keep the flat-page notice separately from the caption's bounded warning.
let connectionRecoveryLine='';
function showConnectionProblem(error:unknown, ownGeneration:number) {
  const code=(error as any)?.code;
  const sessionEnded=/session[^\n]*(?:expired|not found)/i.test((error as any)?.message ?? '');
  const ended=sessionEnded || code==='companion_expired' || (code==='companion_request' && Boolean(companionStartupMessage(error as any)));
  if(code!=='companion_connection' && !ended)return false;
  if(closed || generation!==ownGeneration)return true;
  if(isCompanion) {
    repairNeeded ||= code==='companion_expired';
    setConnectionStatus(sessionEnded || connectionStatus().recovery ? PAIR_AGAIN : LINK_LOST,sessionEnded || connectionStatus().recovery);
  }
  const line=sessionEnded ? 'Session ended. Reopen the structure on desktop, then share again.'
    : ended ? 'Share ended. Reopen sharing on the desktop; open its new link.'
    : 'Disconnected. View preserved; use Pair again to reconnect.';
  // The caption observes link state itself for one bounded reading window.
  // Writing an outcome here would replace a pending scientific answer.
  connectionRecoveryLine=line;
  if(!blocked && !pendingReceipt) {
    connectionNotice=true;notice.hidden=false;details.hidden=true;
    message.textContent=line;
    retry.hidden=true;reload.hidden=true;pairAgain.hidden=false;
  }
  return true;
}
function clearConnectionProblem() {
  // A successful heartbeat after a lost-link edge permits an immediate save.
  // Ordinary successful beats must not erase a busy/validation save backoff.
  if(connectionRecoveryLine) { saveRetryAdmission.reset(binding,generation);saveAttempts=0; }
  connectionRecoveryLine='';
  repairNeeded=false;
  connectionWatchdog?.succeeded();
  setConnectionStatus();
  if(!connectionNotice)return;
  connectionNotice=false;retry.hidden=false;reload.hidden=false;pairAgain.hidden=true;
  if(!blocked)notice.hidden=true;
}
/**
 * The companion link now shares another session: the Mac restarted, or the
 * agent opened a new session and shared it. The link refuses every call that
 * names the old one, so read the link's own session and hydrate it as boot
 * does. Hydration swaps sources while presenting, so the wearer stays in XR;
 * only a failed re-bind falls back to Pair again, which reloads the page.
 */
function rebindCompanionSession(refused:string|undefined) {
  // A refusal sent before an earlier re-bind finished names a session this
  // page has already left.
  if(closed || rebinding || Date.now()<rebindRetryAt || !binding || refused!==binding.sessionId)return;
  rebinding=rendering.catch(()=>{}).then(async()=>{
    if(closed || refused!==binding?.sessionId)return;
    recordHeadsetEvent('connection',{phase:'session-changed'});
    showHeadsetCaption('The Mac now shares a new session. Loading it.');
    // The old panel belongs to the old session; a detach would be refused too.
    panelId=undefined;delete document.body.dataset.panelId;
    const response=await call('get_inspection',{}),data=response._meta?.[PRIVATE_KEY] as any;
    if(!data?.sessionId || !data?.serverEpoch) throw Error('The companion did not receive its session.');
    epoch=data.serverEpoch;requestedId=data.sessionId;
    // A new session opens like a fresh tab: its lesson rests rather than
    // carrying on the old session's tour.
    completedHydration=false;
    await hydrate(data.sessionId,response);
  }).catch(error=>{
    rebindRetryAt=Date.now()+15_000;
    recordHeadsetEvent('connection',{phase:'rebind-failed',message:thrownErrorMessage(error).slice(0,200)});
    if(closed)return;
    const line='The new session didn’t load. Use Pair again.';
    setConnectionStatus(PAIR_AGAIN,true);showHeadsetCaption(line);
    connectionNotice=true;notice.hidden=false;details.hidden=true;message.textContent=line;
    retry.hidden=true;reload.hidden=true;pairAgain.hidden=false;
  }).finally(()=>{rebinding=undefined;});
  rendering=rebinding;
}
async function sendHeadsetViewCapture(args:Record<string,unknown>) {
  const result=await call('submit_headset_view',{...expected(),panelId,...args});
  // A stored failure receipt is acknowledged with accepted:false. A captured
  // image requires accepted:true; HTTP success alone must not retire its bytes.
  if(result.isError || result.structuredContent?.accepted !== (args.status==='captured'))
    throw Error('The host did not acknowledge the headset capture.');
  return result;
}
async function call(name:string,args:Record<string,unknown>,journeyOwned=false) {
  const historyRequest=sceneHistoryClient.requestStarted();
  const journeyPending=experiencePreparing || experiencePlayer?.getState().navigating===true;
  if(tourCommandContext && ['navigate_experience','sync_inspection','attach_inspection','acknowledge_experience_step'].includes(name))args={...args,tourCommand:tourCommandContext};
  const beat=name==='attach_inspection' || name==='poll_inspection';
  const sendsBuild=beat && isCompanion && hostTakesPageBuild;
  if(sendsBuild) args={...args,pageBuild:document.body.dataset.inspectorBuild};
  if(['update_inspection','emphasize','focus_selection','control_tour','import_detailed_view'].includes(name)) recordLoopStage('action-posted',args);
  try {
    const invoke=(sent:Record<string,unknown>)=>companionCall?companionCall(name,sent):app.callServerTool({name:`stereo_structure.${name}`,arguments:sent});
    let result=await invoke(args).catch(error=>{ if(sendsBuild && rejectsPageBuild(thrownErrorMessage(error))) return undefined; throw error; });
    if(sendsBuild && (!result || rejectsPageBuild(toolResultError(result)))) {
      // A host from before build checks refuses the unknown field. Stop sending
      // it, so a newer page still works with an older host on the same share.
      hostTakesPageBuild=false;
      const {pageBuild:_unsent,...plain}=args; args=plain;
      result=await invoke(args);
    }
    const failure=toolResultError(result);
    if(failure) {
      // Classify only the server's known validation result, never a rejected
      // transport promise or an acknowledgement after host delivery.
      const staleVoiceClaim=name==='claim_voice_intent'
        && failure==='The voice request belongs to a changed or unavailable view. Try again when the scene is ready.';
      const staleAttach=name==='attach_inspection' && failure===STALE_ATTACH_MESSAGE;
      throw Object.assign(new Error(failure),staleVoiceClaim?{code:'STALE_VOICE_CLAIM'}:staleAttach?{code:'inspection_attach_stale'}:{});
    }
    if(beat && isCompanion) pendingHostBuild=(result as any)?.structuredContent?.outdatedHostBuild;
    if(name==='acknowledge_experience_step' && tourCommandContext)tourCommandReceipt=(result as any)?.structuredContent?.command;
    publishModelContext(result);
    // Every inspection answer carries the host's own report of
    // whether it serves the full Mol* viewer. Reading it here means the first
    // "Open in Mol*" press already knows, with no probe of its own. It is only
    // the companion whose origin is the one the host serves, so only a
    // companion page may take the host at its word; anything else probes.
    if(isCompanion)detailedView.note((result as any)?.structuredContent);
    if((result as any)?.structuredContent?.detailedViewAvailable===true){detailedViewHere=true;if(!isCompanion)syncHandoff?.();}
    updateReadinessStrip((result as any)?.structuredContent?.readiness);
    sceneHistoryClient.note((result as any)?.structuredContent,historyRequest);
    return result;
  } catch(error) {
    const message=thrownErrorMessage(error);
    if(callStatus(error)===409) {
      const journeyBookkeeping=journeyPending || experiencePreparing || experiencePlayer?.getState().navigating===true;
      const staleBinding=typeof args.sourceToken==='string' && !!binding && args.sourceToken!==binding.sourceToken;
      // Attach owns this definitive bookkeeping conflict and its safe refresh.
      // Do not replace a scientific answer with an intermediate stale-revision
      // instruction before that recovery has even had a chance to run.
      const captioned=!(name==='attach_inspection' && isStaleInspectionAttach(error)) && shouldCaptionInspectionRefusal(name,message,
        loading || journeyBookkeeping,staleBinding,journeyBookkeeping || journeyOwned);
      recordHeadsetEvent('tool-refused',{tool:name,status:409,reason:message,captioned,journeyPending:journeyBookkeeping,staleBinding,...(journeyOwned?{journeyOwned:true}:{})});
      console.warn(`${name}: ${message}`);
      if(captioned)showHeadsetCaption(inspectionRefusalCaption(message));
      if(!captioned && name==='voice_acknowledgement' && message==='This action belongs to a different structure.')
        return {structuredContent:{speechDropped:true}};
    }
    if(name==='get_inspection') {
      const inspectionLoadDetail=inspectionRefusalCaption(message);
      const recovery=/thread[^\n]*not found/i.test(message)
        ? 'This panel lost its connection to the desktop app. Open Stereofold in a new task.'
        : /session[^\n]*(?:expired|not found)/i.test(message)
          ? 'This session is no longer available. Ask the desktop app to inspect the structure again.'
          : /(?:unknown|not found|not available)[^\n]*tool|tool[^\n]*(?:unknown|not found|not available)/i.test(message)
            ? 'The desktop app couldn’t find the inspector’s load tool. Reconnect Stereofold, then open it in a new conversation.'
            : 'The structure couldn’t load. Retry loading, or open Stereofold in a new task if the request keeps failing.';
      // This rewrite used to drop the transport's own code and
      // status, which is how a closed LAN share reached the wearer as a
      // sentence about a structure. The words the flat page shows are
      // unchanged; only the classification rides along now, for
      // `companionStartupMessage`.
      // The owning hydrate publishes this detail only after checking its
      // generation. An obsolete transport failure must not change newer UI.
      throw Object.assign(new Error(recovery),{code:(error as any)?.code,status:(error as any)?.status,inspectionLoadDetail});
    }
    // The companion client's HTTP status is kept so a diagnostic can name it.
    throw Object.assign(new Error(inspectionRefusalCaption(message)),{code:(error as any)?.code,status:(error as any)?.status});
  }
}
/** The status a failed `call` carried, for a diagnostic that must not guess. */
function callStatus(error:unknown) {
  const status=(error as {status?:unknown})?.status;
  return typeof status==='number' && Number.isFinite(status) ? status : null;
}
function scheduleSave() {
  if(loading || remote || closed || reloading || failedSourceLoad || !binding || !workspace?.snapshot().ready) return;
  dirty=true; edits++;
  workspace?.syncSceneHistory?.();
  if(timer) clearTimeout(timer);
  timer=setTimeout(()=>{ void save(undefined,true); },Math.max(250,saveRetryAdmission.delay(binding,generation)));
}
function scheduleLessonSave() {
  if(loading || remote || closed || reloading || !binding || !workspace?.snapshot().ready) return;
  // Pause/status updates also emit player state. A no-op pause before remote
  // admission must not mark the unchanged view dirty and refuse the command.
  if(JSON.stringify(workspace.capture())!==JSON.stringify(savedScene)) scheduleSave();
}
let saveAttempts=0, lastAutoReload=0, reloading=false;
/** Whether every scene change chained on `rendering` so far has settled. */
async function renderingSettled() {
  const tail=rendering;
  // A settled promise answers in a microtask, before the zero-delay timer.
  const settled=await Promise.race([tail.then(()=>true,()=>true),new Promise<boolean>(done=>setTimeout(()=>done(false),0))]);
  return settled && tail===rendering;
}
/**
 * Reload into the host's newer build at a quiet moment, once per host build.
 *
 * A reload ends an immersive session, drops unsaved work and cuts off a
 * command, a recording or an Enter VR prompt, so it waits for none of those
 * to be happening. A delivered command is chained on `rendering`, so a page
 * whose chain has settled has finished it. A wearer in VR keeps the older
 * page until they leave VR; `wearer.pageOutdated` tells the agent.
 */
async function reloadPendingCompanion() {
  if(!isCompanion || closed || !pendingHostBuild || !workspace || pollInFlight || beatInFlight || !binding) return;
  const settled=await renderingSettled();
  if(closed || !pendingHostBuild || pollInFlight || beatInFlight) return;
  const snapshot=workspace.snapshot();
  reloadOutdatedCompanion(pendingHostBuild,{
    dirty:dirty || blocked,
    presenting:snapshot.xrPresenting===true,
    // An Enter VR request or its permission prompt is still open.
    enteringXr:workspace.viewer.xr?.startup?.()?.pending===true,
    // A recording, a request in flight or a spoken reply.
    voice:Boolean(voiceInteraction) && !['idle','error'].includes(voiceInteraction.state()),
    loading:loading || reloading || Boolean(attaching) || experiencePreparing,
    rendering:remote || !settled || !snapshot.ready,
    navigating:Boolean(tourPlayer?.getState().navigating || experiencePlayer?.getState().navigating),
    interacting:snapshot.interactionActive===true,
    pendingReceipt:Boolean(pendingReceipt),
  },sessionStorage,()=>location.reload());
}
/**
 * A refused save on a headset panel has no reachable button.
 *
 * `showProblem` sets `blocked`, and a blocked panel answers `unsaved`, which
 * `enqueue` refuses. Inside an immersive session neither Retry save nor Load
 * saved view is on screen, so blocking there ends the demo. The decisions live
 * in `inspection-panel-recovery.ts`; the server-side conflict rule is unchanged.
 */
function recoverSave(kind:'busy'|'conflict'|'error', problem:string) {
  // Journey navigation owns rollback. A background retry/reload here would
  // race that rollback and could replace its binding or strand its panel.
  if(experiencePreparing) throw Error(problem);
  saveAttempts++;
  const recovery=saveFailureRecovery({kind,companion:isCompanion,attempt:saveAttempts,msSinceReload:Date.now()-lastAutoReload});
  if(recovery.action==='retry') {
    saveRetryAdmission.defer(binding,generation,recovery.delayMs);
    timer=setTimeout(()=>{void save(undefined,true);},recovery.delayMs); return;
  }
  if(recovery.action==='reload') {
    const id=binding?.sessionId;
    if(reloading) return;
    if(id) {
      lastAutoReload=Date.now(); saveAttempts=0; dirty=false; reloading=true;
      outcome.textContent='This session changed elsewhere; showing the saved view.';
      rendering=rendering.then(async()=>{await hydrate(id);}).catch(error=>showProblem(problemMessage('loading',error),'loading',error))
        .finally(()=>{reloading=false;});
      return;
    }
  }
  showProblem(problemMessage('save',problem),'save',problem);
}
/**
 * Draw the host's saved scene again when this page cannot put its own back.
 *
 * A headset has no reachable Retry button. A lesson left half drawn would be
 * saved by the next beat as the wearer's work, and a viewer left in `error`
 * expires every later command. `reloading` holds every save until the
 * hydration owns the renderer. A viewer in `error` cannot restore over itself,
 * so its source is drawn again.
 */
function reloadSavedScene(reason:string) {
  const id=binding?.sessionId;
  if(!id || closed || reloading) return false;
  reloading=true; dirty=false;
  const redraw=workspace?.snapshot().status==='error';
  recordHeadsetEvent('viewer-recovery',{phase:'reload',reason,redraw});
  rendering=rendering.then(async()=>{
    await hydrate(id,undefined,undefined,{restoreExactScene:true,redraw});
    recordHeadsetEvent('viewer-recovery',{phase:'reloaded',reason});
  }).catch(error=>{
    recordHeadsetEvent('viewer-recovery',{phase:'reload-failed',reason,message:thrownErrorMessage(error).slice(0,200)});
    if(!closed) showProblem(problemMessage('loading',error),'loading',error);
  }).finally(()=>{reloading=false;});
  return true;
}
/**
 * A viewer that a failed change left in `error`.
 *
 * The viewer redraws its own checkpoint after a failed change. It stays in
 * `error` only when that redraw fails too, rather than draw a lesson without
 * its figure or motion. The companion then answered busy with a renderer error
 * and every later command expired. With nothing local running, this asks the
 * viewer to redraw, waiting longer after each attempt. When it cannot, or what
 * it draws is not the saved scene, the host's saved scene is loaded instead.
 * An error that persists is tried once per backoff step and then left alone;
 * a viewer that recovers starts over, so the same error later is tried again.
 * A recovered scene is never marked dirty, and a degraded one is never saved.
 * A desktop keeps its Retry and Load buttons.
 */
let viewerErrorRecovery:{error:string;attempt:number;repeats:number;at:number}|undefined;
const VIEWER_RECOVERY_BACKOFF_MS=[0,5_000,15_000,60_000];
async function recoverViewerError() {
  // No command, hydration, journey, recording or receipt may own the renderer.
  const idle=()=>!closed && Boolean(binding) && !remote && !loading && !reloading && !experiencePreparing
    && !activePreviewRecording && !pendingReceipt;
  if(!isCompanion || workspace?.snapshot().status!=='error' || !idle() || !(await renderingSettled()) || !idle()) return;
  const error=String(workspace.snapshot().error ?? 'The viewer failed.'), now=Date.now();
  const previous=viewerErrorRecovery;
  const repeats=previous?.error===error ? previous.repeats+1 : 1;
  if(repeats>VIEWER_RECOVERY_BACKOFF_MS.length) return;
  const attempt=(previous?.attempt??0)+1;
  if(previous && now-previous.at<VIEWER_RECOVERY_BACKOFF_MS[Math.min(attempt,VIEWER_RECOVERY_BACKOFF_MS.length)-1]!) return;
  viewerErrorRecovery={error,attempt,repeats,at:now};
  const recover=workspace.viewer?.inspection?.recover;
  const localWork=dirty;
  recordHeadsetEvent('viewer-recovery',{phase:'recover',attempt,error:error.slice(0,200),available:typeof recover==='function'});
  let drawn=false;
  // `remote` holds the save paths and reports the panel busy while it draws.
  remote=true;
  try {
    if(typeof recover==='function') {
      await recover.call(workspace.viewer.inspection);
      drawn=workspace.snapshot().status!=='error' && workspace.snapshot().ready===true;
    }
  } catch(failure) {
    recordHeadsetEvent('viewer-recovery',{phase:'recover-failed',attempt,message:thrownErrorMessage(failure).slice(0,200)});
  } finally { remote=false; }
  let saved=false;
  try { saved=drawn && JSON.stringify(workspace.capture())===JSON.stringify(savedScene); } catch { /* Reload below. */ }
  // Local work the wearer had before the failure is still theirs to save.
  if(saved || (drawn && localWork)) {
    dirty=localWork; viewerErrorRecovery=undefined;
    recordHeadsetEvent('viewer-recovery',{phase:'recovered',attempt,saved});
    return;
  }
  if(reloadSavedScene('viewer-error'))
    rendering=rendering.then(()=>{ if(workspace?.snapshot().status!=='error') viewerErrorRecovery=undefined; });
}
function save(journeySave?:JourneySaveClaim, automatic=false, hydrationGeneration?:number, onReferenceOnly?:()=>void) {
  // A 250 ms poll must not clear the slower retry timer or recapture the scene.
  // Only background callers may skip. An awaited scene/receipt checkpoint,
  // journey rollback or explicit Retry must perform its real save or fail.
  if(automatic && saveRetryAdmission.delay(binding,generation)>0) return Promise.resolve();
  if(timer) clearTimeout(timer);
  const commit=async()=>{
    if(!dirty || blocked || loading || remote || !binding || closed || !workspace.snapshot().ready) return;
    // A preceding queued save may have failed since this one was requested.
    if(automatic && saveRetryAdmission.delay(binding,generation)>0) return;
    // A timer must not save between a chapter's operations; the beat retries.
    if(automatic && tourPlayer?.getState().navigating) return;
    const ownGeneration=generation, edit=edits, expected={...binding};
    /**
     * THE CAPTURE BELONGS INSIDE THIS TRY.
     *
     * `workspace.capture()` refuses a scene it cannot identify, and it used to
     * be read on the line above the try. Its throw went to the outer
     * `.catch(error=>showProblem(...))`, which sets `blocked` unconditionally —
     * so a capture refusal skipped `recoverSave` entirely, wedged the panel on
     * every surface including a headset with no reachable button, and the
     * `attach()` guarded on `!blocked` never ran. That is how the first hardware
     * density run spent ninety seconds waiting for a panel nothing had
     * registered (maptier7's report, "LEFT FOR A FRESH LANE" item B). A capture
     * refusal is now the same kind of failure as a refused save, and takes the
     * same recovery.
     */
    try {
      const scene=workspace.capture();
      const response=await call('sync_inspection',{sessionId:expected.sessionId,serverEpoch:expected.serverEpoch,
        baseStateRevision:expected.stateRevision,baseInspectionRevision:expected.inspectionRevision,sourceToken:expected.sourceToken,scene,panelId,
        ...(journeySave?{journeySave}:{})});
      if(generation!==ownGeneration || closed) return;
      const next=response.structuredContent as any;
      if(next?.busy) {
        outcome.textContent='Waiting for the current command before saving your edit';
        recoverSave('busy','The current command never finished. Your visible work is unsaved.');return;
      }
      if(next?.conflict) { recoverSave('conflict','This session changed in another panel. Your visible work is unsaved. Load the saved view to continue.'); return; }
      if(next?.referenceOnly && hydrationGeneration!==undefined && onReferenceOnly) {
        binding={...binding,...next};savedScene=scene;
        dirty=edits!==edit || (workspace.snapshot().ready && JSON.stringify(workspace.capture())!==JSON.stringify(scene));
        saveAttempts=0;saveRetryAdmission.reset(binding,generation);onReferenceOnly();
        workspace.setStatus('Reference coordinates only; the density lesson is on the companion.');
        return;
      }
      if(next?.referenceOnly) throw Error(next.reason);
      if(!next?.saved) throw Error('The server did not confirm the save.');
      saveAttempts=0;
      saveRetryAdmission.reset(binding,generation);
      binding={...binding,...next}; savedScene=scene;
      dirty=edits!==edit || (workspace.snapshot().ready && JSON.stringify(workspace.capture())!==JSON.stringify(scene));
      if(!dirty) workspace.setStatus('Current view saved to this session');
    } catch(error) { recordHeadsetEvent('page-error',{operation:'save',message:thrownErrorMessage(error)});if(generation===ownGeneration) recoverSave('error','Could not save your work. Your visible work is unsaved.'); }
  };
  saving=saving.then(async()=>hydrationGeneration===undefined ? commit() : await waitForPanelRender({
    // Lesson notifications can start menu-clearance work after installation
    // resolves. A source checkpoint must wait for that draw, not silently
    // skip its save and try attaching a source the host has never saved.
    ready:()=>workspace.snapshot().ready,
    current:()=>!closed && generation===hydrationGeneration,
    onReady:()=>{
      // Mark and capture in the same ready turn, inside the save queue. The
      // ordinary debounce intentionally ignores mutations during hydration.
      dirty=true;edits++;
      return commit();
    },
  })).catch(error=>{
    if(hydrationGeneration!==undefined && (closed || generation!==hydrationGeneration))return;
    if(experiencePreparing)throw error;
    showProblem(problemMessage('save',error),'save',error);
  });
  // A failed transaction must not poison the next rollback save's queue.
  const result=saving;
  saving=saving.catch(()=>{});
  void result.finally(()=>workspace?.syncSceneHistory?.()).catch(()=>{});
  return result;
}
/**
 * The trace `growStructure` opened, handed to the hydrate that
 * actually rebuilds the tier.
 *
 * A grow is two halves that do not share a call frame. `grow_structure`
 * replaces the coordinates on the Mac and returns; the rebuild happens inside
 * `hydrate`, which the poll can also reach on its own. This carries the open
 * trace across that seam so one timeline covers `requested` through `attached`
 * instead of two that cannot be joined. Any hydrate that finds none and is
 * presenting opens its own, because a wearer standing inside a swap is the
 * case that has to be bounded whatever started it.
 */
let sourceSwapTrace:SwapTrace|undefined;
/**
 * The context every phase of the open swap is labelled with.
 *
 * Read at write time, not at creation, so the tier's lesson id can be filled in
 * by whichever half of the swap learns it first. A grow the wearer pressed
 * knows it from `grow_structure`'s answer; a grow the agent sent from the Mac
 * reaches the page as an ordinary source change on the poll, and `hydrate` is
 * where that one finds out. Without it the Mac gets a timeline it cannot tie to
 * a tier, which is most of what a multi-tier diagnosis needs from it.
 */
let sourceSwapContext:Record<string,unknown>={};
function beginSourceSwapTrace(context:Record<string,unknown>={}):SwapTrace {
  sourceSwapContext=context;
  sourceSwapTrace=createSourceSwapTrace({presenting:()=>workspace?.snapshot().xrPresenting===true,context});
  return sourceSwapTrace;
}
async function hydrate(id:string,provided?:any,journeySave?:JourneySaveClaim,options:{restoreExactScene?:boolean;xrRecoveryFrame?:unknown;
  autoplayContinuation?:()=>boolean;
  continuationNarration?:boolean;
  attachRecoveryAttempt?:number;checkpointRestore?:(hydrationGeneration:number)=>void;
  admitRestore?:(hydrationGeneration:number)=>void;
  /** Draw the same source again: a viewer left in `error` cannot restore over itself. */
  redraw?:boolean}={}) {
  let releaseHostLoad:(()=>void)|undefined;
  let releaseSourcePresentation:(()=>void)|undefined;
  try {
  // Poll admission can precede a newer journey. Read its actual ownership
  // before stopping players, detaching, or drawing a chapter for another panel.
  // Keep the renderer busy during this read so local input and heartbeat saves
  // cannot interleave with admission; a superseded read must not clear its lock.
  loading=true; const ownGeneration=++generation;
  const trace=sourceSwapTrace??beginSourceSwapTrace();
  sourceSwapTrace=undefined;
  let response:any;
  try {
    // Revoke the idle recovery lease before Retry starts a competing draw. A
    // replacement that committed first is then read as the current descriptor.
    if(failedSourceLoad?.sessionId===id && panelId && binding?.sessionId===id)
      await call('poll_inspection',{...expected(),panelId,availability:'busy'});
    response=provided??await trace.phase('source-fetched',call('get_inspection',{sessionId:id,...HYDRATION_TRANSPORT}));
    if(closed || generation!==ownGeneration)return;
    const pending=response?._meta?.[PRIVATE_KEY]?.journeyTransition;
    if(pending?.status==='pending' && pending.panelId!==journeySave?.panelId && pending.panelId!==tourCommandContext?.panelId) {
      trace.skip('attached','Waiting for the journey owner to save and acknowledge this chapter.');
      return;
    }
  } catch(error) {
    trace.fail(error);
    if(closed || generation!==ownGeneration)return;
    // This read failed before hydration could establish a binding or enter
    // its renderer transaction. Retry the intended source, not an idle poll;
    // leave any existing view and its source-failure ownership untouched.
    retryHydrationId=id;
    loadErrorDetails=typeof (error as any)?.inspectionLoadDetail==='string'
      ?(error as any).inspectionLoadDetail:thrownErrorMessage(error);
    recordHeadsetEvent('page-error',{operation:'source',message:loadErrorDetails});
    throw error;
  }
  finally {if(generation===ownGeneration)loading=false;}
  if(closed || generation!==ownGeneration)return;
  const initialOpen=!completedHydration;
  // A pending clip belongs to the visit before this restore, even if the
  // restored cursor later names the same chapter.
  narrationGeneration++;
  // A new hydration can replace the source or end XR. Stop a pending capture
  // or reply before its old binding can continue speaking.
  if(!voiceOwnedSourceTransition) void voiceInteraction?.cancel?.();
  // Read what the lesson was doing BEFORE stopping it. `stop`
  // is one line below and it is the only record there is; without this the page
  // cannot tell a wearer who was mid-lesson from one who had put it away, and
  // every grow looked like the latter.
  const priorTour=tourPlayer?.getState();
  const priorLessonOnScreen=priorTour?.active===true;
  const priorAutoplay=options.autoplayContinuation ? options.autoplayContinuation() : priorTour?.autoplay===true;
  const reconnectingJourney=!experiencePreparing ? experiencePlayer?.getState() : undefined;
  // Distinguish a failed load from later chapter/view work in the same hydrate.
  let structureRendered=false;
  /** Set inside the try: this hydrate replaced the coordinates, and with what lesson. */
  let swappedSource=false, grownLesson:{id:string;steps:readonly TourStep[]}|undefined;
  let restoredLessonPlayback=false;
  /**
   * The density build that failed, when one did.
   *
   * Set only for a map. A failed atomic build still throws, because there is
   * nothing else that hydration could have been for; a failed map leaves real
   * coordinates, a real session and a real lesson behind it, and the page is
   * worth more paired and honest than thrown away. See `finishMapDrawFailure`.
   */
  let mapDrawFailure:Error|undefined;
  let defaultToLesson:boolean|undefined;
  let experienceAcknowledgementNeeded=false;
  let passiveSavedRestore=false;
  let densityReferenceOnly=false, densityReferencePreview=false;
  let supersededJourney=false;
  let completion:any, completionReceipt:{status:'rendered';message?:string}|undefined;
  let restoredPlacement:{placementRestored:boolean;fitted:boolean}|undefined;
  // Stop before the host read so the legacy player cannot repaint during a
  // restore. Hydration can reuse loaded geometry as well as replace a source.
  loading=true; pendingReceipt=undefined; pendingReceiptFields=undefined;
  if(priorLessonOnScreen || (response?._meta?.[PRIVATE_KEY] as any)?.customTour)
    releaseSourcePresentation=panelTour?.beginSourceTransition();
  tourPlayer?.stop('Tour stopped while the inspection is restored.',{restoreResting:false,
    preserveContinuation:Boolean(options.autoplayContinuation)});
  experiencePlayer?.setRendering(true);
  // A hydration that is superseded returns without an outcome of
  // its own, so the next one starts owing the wearer nothing. Only a source
  // replacement arms this, below.
  sourceLoadOutcome=undefined; failedSourceLoad=undefined;
  handoffSource=undefined;handoffFeedback='';handoffPending=false;handoffVersion++;syncHandoff();
  loadErrorDetails='';details.open=false;
  retry.disabled=true; reload.disabled=true;
  if(!workspace.snapshot().ready) {
    document.body.dataset.ready='loading';
    document.querySelector('.scene-heading h1')!.textContent='Loading structure…';
    document.querySelector('.canvas-caption > span')!.textContent='WAITING FOR STRUCTURE';
  }
  // A source load can take tens of seconds. Read its handoff while this
  // renderer can still heartbeat; retain the admitted owner during the draw.
  // Unrelated hydrations keep the existing detach-with-loading behavior.
  const replacesPanelId=panelId;
  let sourceReplacement=false;
  let sourceFailureBinding:Record<string,unknown>|undefined;
  try {
    // The synchronous, page-owned stop may update saved lesson playback. An
    // attach recovery checkpoints that change before any awaited input/read.
    options.checkpointRestore?.(ownGeneration);
    const data=response?._meta?.[PRIVATE_KEY] as any;
    if(!data || data.sessionId!==id || data.serverEpoch!==epoch || (!data.catalog && !data.catalogWire) || data.format!=='mmcif') throw Error('Inspection hydration did not match the opened session.');
    sourceGeometryBudgetSupported=data.sourceGeometryBudget===true;
    rendererContextSupported=data.rendererContext===true;
    renderedSourceIdentitySupported=data.renderedSourceIdentity===true;
    // Read the host's source handoff before deciding whether this mounted
    // renderer is leaving. The selected replacement keeps its heartbeat and
    // ID through draw/save; the host validates that save before rebinding it.
    sourceReplacement=Boolean(panelId && data.sourceReplacement?.panelId===panelId
      && data.sourceReplacement.previousSourceToken===binding?.sourceToken && data.serverEpoch===binding?.serverEpoch);
    // This hydration is an agent's source load, and it is the only
    // hydration that is. Acknowledge it here, ahead of the parse, the draw and
    // the save that the host's render budget is actually spent on.
    if(sourceReplacement) {
      sourceFailureBinding={sessionId:id,serverEpoch:data.serverEpoch,sourceToken:data.sourceToken,
        baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision,
        panelId,previousSourceToken:binding.sourceToken};
      beginSourceLoadOutcome(String(data.sourceToken));
    }
    if(sourceReplacement) releaseHostLoad=await workspace.viewer.prepareHostLoad?.();
    await registerComparisonSources(data?.comparisonSources,id);
    comparisonPrimaryName=data?.pdbId??'the primary structure';
    // Chunked hydration lands here: descriptors in, coordinates and compressed
    // catalog assembled and digest-checked, then the same shape the headset got.
    await hydrateInspectionBytes(data,call);
    if(typeof data.structureText!=='string') throw Error('Inspection hydration did not match the opened session.');
    // Import resolution below promotes an uncommitted candidate into data.scene
    // for drawing. Only a scene already saved by the host is a passive restore.
    const hasSavedHostScene=Boolean(data.scene);
    options.admitRestore?.(ownGeneration);
    if((journeySave && panelId===journeySave.panelId) || sourceReplacement) {experienceSourceChanged=false;}
    else if(experienceSourceChanged) {panelId=undefined;delete document.body.dataset.panelId;experienceSourceChanged=false;}
    else await detach('loading');
    const catalog=await trace.phase('parsed',(async()=>{
      const decoded=await decodeInspectionCatalog(data.catalogWire ?? data.catalog,{isCurrent:()=>!closed && generation===ownGeneration});
      await verifyInspectionCatalogSource(data.structureText,decoded);
      return decoded;
    })()) as Awaited<ReturnType<typeof decodeInspectionCatalog>>;
    if(data.customTour?.id)sourceSwapContext.lessonId=String(data.customTour.id);
    const sceneImport=data.sceneImport as any;
    let importedRenderingDifference=sceneImport?.preflight?.renderingDifference as string|undefined;
    // A scene saved before chapters were drawn whole can play a moving chapter
    // without its animation, which `savedLessonPlayback` refuses. It opens
    // stopped on that chapter instead of not at all; Rejoin draws it again.
    const lessonTours=data.customTour ? [data.customTour,...TOURS] : TOURS;
    if(data.scene) data.scene=stopUnanimatedLessonPlayback(data.scene,lessonTours);
    // `let`, because the density branch below drops a scene that
    // belongs to the other renderer of this session. Read its comment.
    let restoredScene=data.scene ?? sceneImport?.resolvedScene;
    if(isCompanion && initialOpen && !options.restoreExactScene && !sceneImport && data.customTour) {
      restoredScene=lessonEntryCameraScene(restoredScene,data.customTour.steps[0]?.id);
      if(data.scene) data.scene=restoredScene;
    }
    const loadSettings=sceneImportLoadSettings(sceneImport?.sceneJson,catalog);
    if(!sceneImport && data.sourceSelection) Object.assign(loadSettings,data.sourceSelection);
    supersededJourney=data.journeyTransition?.status==='superseded';
    completion=supersededJourney?undefined:data.experienceCompletion;
    const restoreExactScene=options.restoreExactScene===true || completion?.status==='pending';
    const experience = data.experience as (ExperienceView & {applied?:boolean}) | undefined;
    const stage = experience?.definition.stages.find(item=>item.id===experience.stageId);
    if(experience && (!stage || !experience.definition.steps[experience.stepIndex])) throw Error('The experience stage is incomplete.');
    // Preview the incoming chapter before any staged geometry can become visible.
    // The rendered counter and narration still wait for save/attach/ack below.
    experiencePlayer?.preview(experience);
    await workspace.viewer.xr?.refreshToolbar?.();
    const visible = stage ? {entityIds:stage.assembly.visibleEntityIds,
      ...(stage.assembly.activeOperatorIds.length?{operatorIds:stage.assembly.activeOperatorIds}:{})}:undefined;
    /**
     * The density map this tier is drawn from, if it has one.
     *
     * A volume tier still opens beside real coordinates — the catalog, the
     * residue rows and every agent query run on them — but what the wearer sees
     * is the map, so the fixture handed to the viewer carries `map` INSTEAD of
     * `cif`. `isVolumeFixture` in `volume-source.mjs` keys on exactly that, and
     * the viewer's volume branch never parses coordinates.
     *
     * `companionFetch` in `inspection-companion-client.ts` has already checked
     * these bytes against the descriptor and the response header. The viewer
     * re-digests them once more: that check is the last one before a parse, and
     * it is the one that covers everything between here and there.
     */
    const density=typeof data.mapSha256==='string' && data.mapBytes
      ? {map:data.mapBytes as Uint8Array,sha256:data.mapSha256 as string,contour:data.mapContour as number} : undefined;
    // The loaded source's identity is the map's digest when there is a map: the
    // coordinates' digest belongs to bytes this panel is not drawing.
    const loadedSha256=density?density.sha256:catalog.source.sha256;
    densityReferencePreview=!isCompanion && Boolean(data.density && !density);
    densityReferenceOnly=densityReferencePreview && data.scene?.sourceSha256===data.density.sha256;
    // A map chapter cannot be drawn over the desktop's reference atoms. Keep
    // the ordinary atomic tours available without offering the map's controls.
    const panelCustomTour=densityReferencePreview ? undefined : data.customTour;
    /**
     * A saved scene belonging to the OTHER renderer of this
     * session is not this panel's to restore.
     *
     * A density session has two panels drawing two different sets of bytes: the
     * Mac's panel draws the coordinates the session opened beside, and the
     * headset draws the map. They share one saved scene, so each panel is
     * routinely handed the other's. Restoring it cannot work — `liveScene` and
     * `validInspectionCapture` compare digests, and the mismatch throws
     * `inspection_identity_mismatch` inside `loadSource`, which on the headset
     * is caught as a failed map draw and on the desktop fails the hydration
     * outright. The reference panel opens on its own fitted preview without
     * saving over an established map, and nothing downstream sees a scene it
     * cannot draw. The digest is the only field compared, because it is the one
     * that distinguishes the two sources; the model and assembly checks inside
     * the viewer are untouched.
     */
    if(data.scene && data.scene.sourceSha256!==loadedSha256) data.scene=undefined;
    if(restoredScene && restoredScene.sourceSha256!==loadedSha256) restoredScene=undefined;
    const loaded=workspace.snapshot();
    // Done invalidates the host capability even when it returns to these same
    // coordinates. Match the complete drawn identity before restoring in place;
    // the fresh binding and completion claim still own save/attach/ack below.
    /**
     * The reuse decision, term by term.
     *
     * Both device-session Done rings carry `journey-restore {sourceReused:false}` and
     * nothing else, so there was no way to tell a swapped digest from an
     * expired token, and no way to tell which of the eight conditions below
     * withheld the in-place restore. These are exactly the operands
     * `restoringLoaded` is built from, hoisted out of the one expression and
     * named. Every one is a pure comparison, so the decision is unchanged.
     */
    const completionPending=completion?.status==='pending';
    const scenePresent=Boolean(data.scene);
    const subsetFalse=loaded.sourceSubset===false;
    const sessionMatch=binding?.sessionId===id;
    const epochMatch=binding?.serverEpoch===data.serverEpoch;
    const sceneDigestMatch=data.scene?.sourceSha256===loaded.sourceSha256;
    const modelMatch=data.scene?.modelNumber===loaded.modelNumber;
    const assemblyMatch=data.scene?.assemblyId===loaded.assemblyId;
    const restoringLoaded=completion && data.scene && loaded.ready && subsetFalse
      && sessionMatch && epochMatch && sceneDigestMatch && modelMatch && assemblyMatch;
    const same=!options.redraw && loaded.sourceSha256===loadedSha256 && (binding?.sourceToken===data.sourceToken || restoringLoaded);
    // Refuse stale lesson metadata before replacing any rendered coordinates.
    savedLessonPlayback(data.scene, lessonTours);
    // A redraw keeps the tier it had; only a new source opens a grown lesson.
    swappedSource=!same && !options.redraw;
    // The grow trace's host read is named source-fetched even when the client
    // reused bytes and this page restores existing geometry. Record the branch.
    //
    // The two tokens are recorded eight characters deep: enough to see that the
    // binding is holding a different one, short enough not to put a session
    // credential in a diagnostics ring.
    if(completionPending) recordHeadsetEvent('journey-restore',{sourceReused:Boolean(same),
      sameDigest:loaded.sourceSha256===loadedSha256,
      sameToken:binding?.sourceToken===data.sourceToken,
      restoringLoaded:Boolean(restoringLoaded),
      completionPending,scenePresent,ready:loaded.ready===true,subsetFalse,
      sessionMatch,epochMatch,sceneDigestMatch,modelMatch,assemblyMatch,
      boundToken:typeof binding?.sourceToken==='string'?binding.sourceToken.slice(0,8):null,
      sceneToken:typeof data.sourceToken==='string'?data.sourceToken.slice(0,8):null});
    if(same && data.scene) {
      options.admitRestore?.(ownGeneration);
      if(JSON.stringify(workspace.capture())!==JSON.stringify(data.scene) || restoreExactScene) await trace.phase('built',workspace.restore(data.scene,{preserveCamera:workspace.snapshot().xrPresenting===true,...(restoreExactScene?{restorePlacement:true,preservePreviewCamera:true,xrRecoveryFrame:options.xrRecoveryFrame}:{})}));
      else await trace.phase('built');
      structureRendered=true;
    } else {
      /**
       * A map that will not draw must not take the panel with it.
       *
       * The whole of the rest of this hydration — the binding, the lesson, the
       * save and the `attach` that pairs this page with the Mac — used to be
       * downstream of this one await. On the first hardware density run the
       * isosurface swap threw at 1.3 s, every line below was skipped, `binding`
       * stayed unset, and `poll` returns at its first line without one. The
       * driver then waited ninety seconds for a panel that nothing was ever
       * going to register, and the wearer stood in front of "Loading
       * structure…" with no way to be told.
       *
       * The viewer has already rolled itself back to the retained record by the
       * time this rejects (`rollbackLoad` in viewer.mjs), so the picture on the
       * wearer's face is the tier they had. What is left is to carry on with
       * the session that is genuinely there and say what happened.
       *
       * Only a map takes this branch. A failed atomic build is the whole of
       * what the hydration was for and still throws.
       */
      try {
        await trace.phase('built',(async()=>{
          // `seatForEntry`: an agent's replacement is a different structure, so
          // it takes the entry seat; a lesson tier keeps the placement it grew from.
          // The panel heading names what the file names ("Hemoglobin 4HHB");
          // the headset page keeps its own heading.
          const heading:StructureHeading=density||isCompanion?{}:await readStructureHeading(data.structureText).catch(()=>({}));
          options.admitRestore?.(ownGeneration);
          await workspace.loadSource({id:'session',
            ...(density?{map:density.map,contour:density.contour}:{cif:data.structureText}),sha256:loadedSha256,catalog,pdbId:data.pdbId,
            ...(visible?{visible}:{}),title:stage?`${stage.title} `:panelCustomTour?.title ? `${panelCustomTour.title} ` : `${heading.name ?? 'Molecular structure'} `,code:data.pdbId ?? heading.code ?? 'mmCIF',caption:densityReferencePreview?'REFERENCE COORDINATES':stage?.title ?? panelCustomTour?.title ?? (data.pdbId ? `PUBLIC STRUCTURE / ${data.pdbId}` : 'SESSION STRUCTURE')},
            {modelNumber:stage?.source.modelNumber ?? restoredScene?.modelNumber ?? loadSettings.modelNumber,assemblyId:stage?.assembly.assemblyId ?? restoredScene?.assemblyId ?? loadSettings.assemblyId,scene:restoredScene,
              initialInspection:lessonSourceInitialization(panelCustomTour,{density:Boolean(data.density),chapterId:data.lessonStart?.chapterId}),
              preserveCamera:workspace.snapshot().xrPresenting===true,seatForEntry:sourceReplacement,restorePlacement:restoreExactScene,xrRecoveryFrame:options.xrRecoveryFrame});
          structureRendered=true;
          // The size the HEADSET measured, on the record of the
          // swap. `sourceSwapContext` is read at write time, so setting it
          // inside the work puts the count on `built` itself and on every phase
          // after it. The count comes off the built geometry rather than off the
          // demo index: the index is the Mac's promise about a mesh this page
          // never actually built, and a measured
          // mesh that disagrees with the promise is exactly what a later
          // diagnosis needs to be shown.
          if(density) {
            const triangles=Number(workspace.snapshot()?.triangleCount);
            if(Number.isFinite(triangles) && triangles>0) sourceSwapContext.size={count:triangles,unit:'triangles'};
            // The COLOUR the headset measured, on the same
            // record and for the same reason. The diagnostics ring holds 200
            // entries and a filament run had rolled the `volume-build` entry
            // off it before the capture was taken, so nobody could say whether
            // the radial theme had applied; the swap trace's phases survive
            // that rollover, so the paint read-back rides along on them.
            const paint=workspace.snapshot()?.volumeTheme as
              {themed?:boolean;colorType?:string|null;wall?:number;crown?:number;other?:number;uniform?:string|null}|null|undefined;
            if(paint && typeof paint==='object') sourceSwapContext.theme={
              themed:paint.themed===true,colorType:paint.colorType??null,
              wall:Number(paint.wall)||0,crown:Number(paint.crown)||0,other:Number(paint.other)||0,
              ...(paint.uniform?{uniform:paint.uniform}:{})};
          }
        })());
      } catch(error) {
        if(!density) throw error;
        mapDrawFailure=error instanceof Error?error:Error(String(error));
      }
      if(!isCompanion && !mapDrawFailure) console.debug('[stereofold:timing] mac-first-frame', {at:Date.now()});
      if(!mapDrawFailure && !data.scene && sceneImport && !sceneImport.resolvedScene) {
        const requestedAtomIds=Array.isArray(sceneImport.sceneJson?.selection?.atomIds) ? sceneImport.sceneJson.selection.atomIds : [];
        const target=workspace.viewer.inspection?.captureStructureViewerImportTarget?.(requestedAtomIds);
        if(!target) throw Error('The loaded structure did not expose a complete scene-import boundary.');
        const resolved=await call('resolve_scene_import',{sessionId:id,serverEpoch:data.serverEpoch,baseStateRevision:data.stateRevision,baseInspectionRevision:data.inspectionRevision,sourceToken:data.sourceToken,target});
        const value=resolved.structuredContent as any;
        if(value?.conflict) throw Error('The inspection changed before the local scene snapshot could be resolved.');
        if(!value?.scene || value.provenanceStatus!=='declared-local') throw Error(value?.preflight?.message ?? 'The local scene snapshot was not resolved as declared-local data.');
        await workspace.restore(value.scene);
        importedRenderingDifference=value.preflight?.renderingDifference;
        data.scene=value.scene;
      }
      if(!mapDrawFailure && !data.scene && restoredScene) data.scene=restoredScene;
    }
    /**
     * After Done the
     * molecule sat in front of the wearer's face, crossing the left-edge
     * spatial menu and the caption plate in both eyes
     *.
     *
     * The restore above puts the pre-journey `placement` back, and in XR it
     * deliberately does NOT replay the saved Mol* camera: the headset owns the
     * tracked view. So the two things a chapter changed that the restore cannot
     * undo are the framing the wearer sees the structure at, and the menu seat
     * the tour held. The lesson tour player already ends with `restoreTourSeat`
     * for exactly this reason; a journey never called anything.
     *
     * `restoreJourneySeat` is the journey's version of that ending: it fits
     * when the restored view names no pose to return to, clears the restored
     * seat off the drawn menu and caption under the same rule Reset uses, and
     * puts the resting menu column back. The scene goes over rather than a
     * verdict about it, because the renderer owns what counts as a pose
     * (`cameraSnapshot`). It runs BEFORE `save`, so the scene the host confirms
     * is the one the wearer is looking at. A page with no immersive session and
     * a host fixture with no viewer both no-op.
     */
    if(completion?.status==='pending' && !mapDrawFailure)
      restoredPlacement=await workspace.viewer.inspection?.restoreJourneySeat?.({scene:data.scene ?? restoredScene});
    // A chapter cannot be placed on a tier that is not on screen. The custom
    // lesson's first colour key and opt-in component plates are also attachment
    // state: put them on during `placed`, before `saved` and `attached`, rather
    // than waiting for Start tour to replay the same opening changes.
    //
    // `placeLessonScene` owns which half of this
    // phase takes the workspace's tour queue, and therefore which half pauses
    // the structure's turn. Only an experience chapter does. Widening the
    // condition with `|| data.customTour` put every lesson hydrate through
    // `runTour`, whose `setMotion({paused:true})` latches `motionUserPaused`,
    // so a lesson page that used to come up turning came up still — including
    // a reload of a saved scene whose motion was running.
    //
    // The resting state itself now goes out on every hydrate, `undefined`
    // included, so a plain session on the same structure stops inheriting the
    // previous lesson's key. A failed map draw is the exception: nothing about
    // the loaded lesson changes there (see `replaceTours` below), so its
    // baseline must not change either.
    //
    // This runs AFTER the saved scene has been restored, not
    // before. `loadSource` replays the scene inside the `built` phase above, so
    // by the time the baseline arrives here the molecule is already wearing the
    // key the capture named, and the page has to decide whether that key is the
    // lesson's to repaint. It decides from the origin the capture carries: the
    // saved chapter keeps its key; only a resting scene adopts the baseline.
    // A key the wearer asked for by name also survives this call untouched. Do not move this
    // ahead of `built` to make that easier — the restore would then replay over
    // a freshly painted baseline, and the phase order is what the grow trace,
    // the swap record and `attached` are all read against.
    // A genuine newer edit can supersede an unacknowledged chapter. Its saved
    // scientific scene stays authoritative; a follower must not replay the
    // chapter's authored appearance over it or acknowledge that aborted visit.
    if (!mapDrawFailure) workspace.viewer.inspection?.setSourceCoordinateFrame?.(panelCustomTour?.presentation?.coordinateFrame,loadedSha256);
    const placedStep=!mapDrawFailure && experience && (!data.scene || (!experience.applied && !supersededJourney))
      ? experience.definition.steps[experience.stepIndex] : undefined;
    // A follower restores a chapter that its owner already drew and
    // acknowledged, including later scientific edits to that saved scene.
    // Re-acknowledging it would race the next companion edit and block this
    // otherwise healthy panel. Transition owners still prove their own save.
    experienceAcknowledgementNeeded=Boolean(experience && (!data.scene || (!experience.applied && !supersededJourney) || journeySave || tourCommandContext));
    passiveSavedRestore=densityReferenceOnly || Boolean(hasSavedHostScene && data.scene && !journeySave && !tourCommandContext && !experiencePreparing
      && !sourceReplacement && completion?.status!=='pending' && (!experience || experience.applied || supersededJourney));
    if(mapDrawFailure) await trace.phase('placed');
    else await abortableSwapPhase(trace,'placed',signal=>placeLessonScene(workspace,{
      ...(panelCustomTour?{tour:panelCustomTour}:{}),
      applyInitialVisibility: !data.scene,
      preserveEmphasis: Boolean(data.scene?.inspection?.lessonPlayback),
      ...(placedStep?{placeExperienceStep:async()=>{
        // An authored chapter owns its look. Keep the host's scoped styles in
        // the journey's return view, but clear them from the chapter budget.
        // Only use the compound draw when there are layers to clear: ordinary
        // chapter repeats retain configure's no-op appearance fast path.
        if(workspace.viewer.inspection.styles?.().length)
          await workspace.viewer.inspection.compound({kind:'compound',patch:{ops:[
            {kind:'styles',patch:{styles:[]}},
            {kind:'appearance',patch:{...placedStep.appearance,labels:false}},
          ]}});
        else await workspace.viewer.inspection.configure({...placedStep.appearance,labels:false},{signal});
        signal.throwIfAborted();
        const selectedEntities=placedStep.selectionEntityIds ?? stage!.assembly.selectedEntityIds;
        const entities=new Set(selectedEntities.length===stage!.assembly.visibleEntityIds.length && selectedEntities.every((id:string)=>stage!.assembly.visibleEntityIds.includes(id))?[]:selectedEntities);
        const rows=workspace.identityRows();
        await workspace.viewer.select(rows.filter((row:any)=>entities.has(row.identity.entityId) && row.coordinateState==='resolved').map((row:any)=>row.key));
      }}:{}),
    }));
    // A lesson teaches the thing on screen. When the map did not
    // draw, the thing on screen is the tier the wearer already had, and the
    // map's chapters would talk about geometry nobody can see — so the loaded
    // lesson is left exactly as it was and no grown tier is opened below.
    const lessonStartedAt=Date.now();
    if(!mapDrawFailure) {
      if(closed || generation!==ownGeneration) return;
      // The restored scene already owns its molecular playback. With saved
      // lesson playback, reconcile the catalog without selecting a lesson
      // (selection pauses its clock); otherwise keep any running animation.
      const hasSavedPlayback=Boolean(data.scene?.inspection?.lessonPlayback);
      // A density lesson cannot run on the desktop's reference atoms. Save that
      // panel first so sharing can open the companion, which loads the map and
      // starts its chapter normally. Atomic lessons still start before saving.
      const canStartLesson=!densityReferencePreview;
      await tourPlayer?.replaceTours(panelCustomTour ? [panelCustomTour,...TOURS] : TOURS,{preservePlayback:hasSavedPlayback,preserveMolecularPlayback:Boolean(data.scene),
        preserveContinuation:Boolean(options.autoplayContinuation)});
      if(closed || generation!==ownGeneration) return;
      if(panelCustomTour && !hasSavedPlayback) {
        await tourPlayer?.select(panelCustomTour.id,{preserveMolecularPlayback:Boolean(data.scene),preserveContinuation:Boolean(options.autoplayContinuation)});
        // An explicit source entry keeps the installer's animation framing,
        // but must also apply the authored placement, view and chapter motion.
        // Only a plain open defers to a journey's own chapter.
        if(canStartLesson && !data.scene && (data.lessonStart || !experience)) {
          if(data.lessonStart) await tourPlayer?.installLesson(panelCustomTour,data.lessonStart,undefined,'entry');
          else {
            // A tier grown under a lesson on screen continues it, spoken and
            // at its pace; every other open is a silent resting chapter. A map
            // opening waits for its tracked entry seat so its chapter can frame.
            const grown=swappedSource ? grownTierIntent({presenting:workspace.snapshot().xrPresenting===true,
              hasChapters:true,lessonOnScreen:priorLessonOnScreen,
              autoplay:options.autoplayContinuation ? options.autoplayContinuation() : priorAutoplay,initialOpen}) : undefined;
            const continuing=grown?.open==='chapter';
            await tourPlayer?.start(continuing && grown.autoplay,0,{
              narration:options.autoplayContinuation ? options.continuationNarration!==false : continuing,waitForXrEntry:true,
              preserveContinuation:Boolean(options.autoplayContinuation)});
          }
          if(closed || generation!==ownGeneration) return;
          // Save/attach below acknowledges this complete chapter. Never start
          // it again in openGrownTier after publishing the rendered receipt.
          restoredLessonPlayback=true;
        }
      }
      if(closed || generation!==ownGeneration) return;
      if(data.scene?.inspection?.lessonPlayback) { tourPlayer?.restorePlayback(data.scene,{waitForXrEntry:isCompanion}); restoredLessonPlayback=true; }
      installedLesson=panelCustomTour;
      if(panelCustomTour?.steps?.length)grownLesson=panelCustomTour;
      if(data.lessonStart && canStartLesson) recordHeadsetEvent('demo-load',{phase:'lesson-started',elapsedMs:Date.now()-lessonStartedAt});
    }
    // A newer hydrate has already claimed this panel. Committing here would
    // bind the older session's revisions against the newer session's scene.
    if(closed || generation!==ownGeneration) return;
    binding={sessionId:id,serverEpoch:data.serverEpoch,stateRevision:data.stateRevision,inspectionRevision:data.inspectionRevision,sourceToken:data.sourceToken,shared:data.shared};
    updateSceneImportNotice(id,data.sourceToken,importedRenderingDifference);
    sceneHistoryClient.note({...data,sessionId:id},sceneHistoryClient.requestStarted());
    // The hydration carries the shared library, so the
    // desktop Saved views panel is host-driven from the first render.
    if(data.namedViews) noteNamedViews(data.namedViews);
    handoffSource=parseNativeStructureViewerHandoff(data.nativeStructureViewerHandoff);handoffFeedback='';handoffPending=false;handoffVersion++;syncHandoff();
    savedScene=data.scene; blocked=false; dirty=false; connectionNotice=false;retry.hidden=false;notice.hidden=true; reload.hidden=false; document.body.dataset.sessionId=id;
    experienceView=mapDrawFailure?undefined:experience;
    if(data.experienceCatalog)experiencePlayer?.setCatalog(data.experienceCatalog);
    experiencePlayer?.setSubject(workspace.viewer.xr?.getSubject?.() ?? {pdbId:data.pdbId,sourceSha256:loadedSha256,assembly:catalog.assemblyId,modelNumber:workspace.snapshot().modelNumber});
    document.body.dataset.experienceActive=String(!!experienceView);
    if(!mapDrawFailure) defaultToLesson=Boolean(panelCustomTour);
    workspace.setStatus(densityReferenceOnly ? 'Reference coordinates only; the density lesson is on the companion.' : mapDrawFailure ? MAP_DRAW_FAILED_SPOKEN
      : data.scene ? 'Saved current view restored' : 'Structure ready');
    retryHydrationId=undefined;
  } catch(error) {
    experiencePlayer?.preview(undefined);
    retryHydrationId=id;
    loadErrorDetails=thrownErrorMessage(error);
    recordHeadsetEvent('page-error',{operation:structureRendered?'view':'source',message:loadErrorDetails});
    // A rendered load can still fail while placing the chapter. Navigation
    // owns its rollback and final caption; do not announce a load failure or
    // claim the previous view is restored before that recovery has happened.
    if(!journeySave || !structureRendered) showHeadsetCaption(structureRendered
      ? 'Could not update the view. Try again.'
      : workspace.snapshot().ready
        ? 'Structure load failed. Your previous view is still shown.'
        : 'Structure load failed. Use Retry loading on the page.');
    failSourceLoadOutcome(loadErrorDetails);
    if(sourceFailureBinding && !closed && generation===ownGeneration) {
      const receipt={...sourceFailureBinding,...inspectionFailureReceipt(error)};
      const failed={sessionId:id,sourceToken:String(sourceFailureBinding.sourceToken),
        receipt:receipt as Record<string,unknown>|undefined};
      failedSourceLoad=failed;
      // The source transaction rolled back; abandoned input is not unsaved work
      // against the retired token. Keep polling, without trying to save it there.
      dirty=false; blocked=false;
      try { savedScene=workspace.capture(); } catch { /* Preserve the load error; renderer recovery runs on the next beat. */ }
      try {
        await call('report_source_failure',receipt);
        if(!closed && generation===ownGeneration && failedSourceLoad===failed) failed.receipt=undefined;
      }
      catch(receiptError) { recordHeadsetEvent('page-error',{operation:'source-receipt',message:thrownErrorMessage(receiptError)}); }
    }
    trace.fail(error);
    throw error;
  } finally { loading=false; retry.disabled=false; reload.disabled=false; experiencePlayer?.setRendering(false); }
  // Following a saved view is a read. Renderer camera/placement normalization
  // belongs to this panel's clean baseline, not to a new shared manual edit.
  // In particular it must not supersede a journey that started during drawing.
  if(passiveSavedRestore) {
    savedScene=workspace.capture();
    trace.skip('saved','Restored an already saved view without publishing a new edit.');
  } else {
    // Initial views and transition owners still publish their actual drawing.
    scheduleSave();
    if(densityReferencePreview) {
      await save(journeySave,false,ownGeneration,()=>{densityReferenceOnly=true;});
      if(densityReferenceOnly)trace.skip('saved','Reference coordinates did not replace the shared density map.');
      else await trace.phase('saved');
    } else await trace.phase('saved',save(journeySave,false,ownGeneration));
  }
  if(closed || generation!==ownGeneration)return;
  if(!dirty && !blocked) {
    if(isCompanion) recordHeadsetEvent('first-pixel',{stage:'scene-saved',at:Date.now()});
    else console.debug('[stereofold:timing] scene-saved', {at:Date.now()});
  }
  // Only the saved attachment advances the retained owner to the new source
  // and publishes its rendered receipt. An unsaved/refused view records why
  // that phase was skipped instead of reporting an attachment that never ran.
  if(!dirty && !blocked) await trace.phase('attached',attach(replacesPanelId,journeySave,true,options.attachRecoveryAttempt));
  else trace.skip('attached',blocked?'the save was refused, so this page registered no panel':'the view is unsaved, so this page registered no panel');
  // A definitive attach refusal can restore a newer host snapshot in place.
  // The older hydrate must not publish its load or acknowledge its old lesson.
  if(closed || generation!==ownGeneration)return;
  // Only the saved attachment publishes the load's rendered receipt,
  // so only it is an `Applied`. An unsaved or refused view registered no panel
  // and says nothing; its orange plate retires with every other stale wait.
  if(panelId && !dirty && !blocked) finishSourceLoadOutcome(binding?.inspectionRevision);
  if(experiencePreparing && (!panelId || dirty || blocked))
    throw Error('The journey view did not save and register its replacement panel.');
  // A completed save and fresh attachment prove connectivity after recovery.
  // A slow failed draw may have left a watchdog notice while hydration owned
  // the renderer and ordinary heartbeat replies could not clear it.
  if(panelId && !dirty && !blocked)clearConnectionProblem();
  if(experienceAcknowledgementNeeded && experienceView && panelId && !dirty && !blocked) {
    const acknowledged=await call('acknowledge_experience_step',{...expected(),panelId,experienceId:experienceView.definition.id,
      experienceRevision:experienceView.revision,stepIndex:experienceView.stepIndex,
      tourState:{selectedId:experienceView.definition.id,step:experienceView.stepIndex,total:experienceView.definition.steps.length,active:true,autoplay:experiencePlayer?.getState().autoplay??false,navigating:false}});
    if(!(acknowledged.structuredContent as any)?.experienceAcknowledged)throw Error('The experience scene has not been acknowledged.');
  }
  if(completion?.status==='pending' && panelId && !dirty && !blocked && !mapDrawFailure) {
    const acknowledged=await call('acknowledge_experience_step',{...expected(),panelId,experienceId:completion.experienceId,
      experienceRevision:completion.revision,stepIndex:completion.stepIndex,completionToken:completion.token,
      tourState:{step:-1,total:0,active:false,autoplay:false,navigating:false}});
    const receipt=(acknowledged.structuredContent as any)?.experienceCompletion;
    if(receipt?.token!==completion.token || receipt.status!=='rendered') throw Error('Your restored view has not been confirmed.');
    // The renderer can adjust a saved pose for menu clearance. Publish its
    // outcome only after the restored draw, save and host acknowledgement.
    completionReceipt=restoredPlacement ? {...receipt,message:restoredPlacement.placementRestored
      ? 'Restored your pre-tour view.'
      : restoredPlacement.fitted ? 'Fitted your view to clear the menu.'
        : 'Restored your view and adjusted it to clear the menu.'} : receipt;
  }
  experiencePlayer?.update(experienceView);
  // The incoming view and its rendering flag must settle before choosing its
  // controls: setDefault preserves a navigating or active player.
  if(defaultToLesson!==undefined) panelTour?.setDefault(defaultToLesson);
  if(mapDrawFailure) { finishMapDrawFailure(mapDrawFailure); completedHydration=true; return; }
  completedHydration=true;
  if(densityReferencePreview)workspace.setStatus('Reference coordinates only; the density lesson is on the companion.');
  if(!sourceReplacement && !experienceView && !supersededJourney && reconnectingJourney?.active) await reconcileExperience(undefined,reconnectingJourney);
  if(!completion) {
    if(swappedSource && !restoredLessonPlayback && !densityReferenceOnly)await openGrownTier(grownLesson,priorLessonOnScreen,
      options.autoplayContinuation ? options.autoplayContinuation() : priorAutoplay,initialOpen,options.continuationNarration);
  }
  return completionReceipt;
  } finally { releaseSourcePresentation?.(); releaseHostLoad?.(); }
}
/**
 * Tell the wearer the map did not draw, once, in one sentence.
 *
 * Reached only after the panel has attached, so the page the wearer is standing
 * in is paired with the Mac and answering commands about the tier that IS on
 * screen. The three channels are the ones every other headset message already
 * uses: the diagnostics ring for a later diagnosis to read, the caption
 * plate above the menu, and the narration voice.
 *
 * None of the three is allowed to fail the hydration a second time. A page that
 * cannot speak is still a paired page.
 */
function finishMapDrawFailure(error:Error) {
  try {
    (globalThis as {__stereofoldDiagnostics?:{record?:(kind:string,detail:unknown)=>unknown}})
      .__stereofoldDiagnostics?.record?.('volume-draw-failed',{failed:error.message.split('\n',1)[0]!.slice(0,160)});
  } catch { /* The ring is advisory. */ }
  try { globalThis.dispatchEvent(new CustomEvent(GROWTH_CAPTION_EVENT,{detail:{spoken:MAP_DRAW_FAILED_SPOKEN}})); }
  catch { /* No event target means no plate; the spoken half still lands. */ }
  try { void voiceCommandSpeaker()?.(MAP_DRAW_FAILED_SPOKEN); }
  catch { /* Speech is accessory to the pairing. */ }
}
/**
 * The grown tier arrives wearing its own lesson.
 *
 * `grownTierIntent` in tour-player.ts states the rule and why. This is the one
 * place that carries it out, and it runs at the very end of `hydrate` — after
 * `save()` and `attach()` — so it is exactly what a wearer pressing Start a
 * second after the swap would get, and so the Mac has its panel back before the
 * first chapter renders rather than after it.
 *
 * Nothing here may fail the swap. A tier that landed in front of the wearer is
 * a success even if its opening chapter could not be painted; the alternative
 * is rolling back a structure the wearer is already looking at.
 */
async function openGrownTier(lesson:{id:string;steps:readonly TourStep[]}|undefined,
  lessonOnScreen:boolean,autoplay:boolean,initialOpen=false,narration?:boolean):Promise<void> {
  const intent=grownTierIntent({presenting:workspace.snapshot().xrPresenting===true,
    hasChapters:Boolean(lesson?.steps?.length),lessonOnScreen,autoplay,initialOpen});
  try {
    if(intent.open==='chapter') {
      // The same call `control_tour play` and the toolbar's Start row make, so
      // the chapter is placed, painted, spoken and the menu collapses exactly
      // as it does for a lesson the wearer opened themselves.
      await tourPlayer?.start(intent.autoplay,narration===undefined?undefined:0,{narration,preserveContinuation:narration!==undefined});
    } else if(intent.open==='key') {
      // No lesson on screen, so nothing is spoken and no chapter opens. Paint
      // its key while keeping the room anchor the source swap just installed.
      // Only the first open takes the lesson's framing; an inactive grow keeps
      // the molecule where the wearer placed it, even after they walk around.
      const emphasis=lesson!.steps[0]?.emphasis;
      if(emphasis?.parts?.length) {
        await workspace.viewer.inspection.emphasize?.({...emphasis,focus:undefined,
          framing:initialOpen?emphasis.framing:undefined,origin:'lesson'});
      }
    }
  } catch(error) {
    recordHeadsetEvent('page-error',{operation:'grown-tier-chapter',message:thrownErrorMessage(error)});
    workspace.setStatus('Could not start this chapter. Try again.');
  }
}
async function navigateExperience(experienceId:string,stepIndex:number,loadedSourceOnly=false,finish=false) {
  const run=async()=>{
    await save();
    if(!binding || dirty || blocked || loading || workspace.snapshot().interactionActive)throw Error('Finish the current edit before changing scenes.');
    if(!panelId)await attach();
    if(!panelId)throw Error('The viewer is not connected.');
    const sessionId=binding.sessionId, owner=panelId;
    const xrRecoveryFrame=workspace.viewer.inspection.captureXrRecoveryFrame?.();
    let transition:any;
    const note=(phase:string,error?:unknown)=>{
      let savedMatchesDrawn:boolean|null=null;
      try {savedMatchesDrawn=JSON.stringify(workspace.capture())===JSON.stringify(savedScene);} catch { /* Capture may be unavailable during a failed draw. */ }
      try {(globalThis as any).__stereofoldDiagnostics?.record?.('journey',{
        phase,experienceId,stepIndex,finish,commandId:tourCommandContext?.commandId??null,
        owner,panelId:panelId??null,generation,stateRevision:binding?.stateRevision,
        inspectionRevision:binding?.inspectionRevision,loading,dirty,blocked,remote,savedMatchesDrawn,
        ...(error?{error:thrownErrorMessage(error).slice(0,200)}:{})});} catch { /* Diagnostics cannot fail the transaction. */ }
    };
    experiencePreparing=true;
    note('preparing');
    try {
      try {
        if(!tourCommandContext) {
          // Saving a local chapter advances this page's binding before the next
          // heartbeat. Advertise the saved view before requesting another step.
          const sent={...expected(),panelId:owner,availability:'ready',animation:workspace.snapshot().animation??null,tourState:tourHeartbeat(panelTour),...(experienceView?{experience:{experienceId:experienceView.definition.id,stepIndex:experienceView.stepIndex}}:{})};
          const refreshed=await call('poll_inspection',sent), data=refreshed.structuredContent as any;
          const delivery=(refreshed._meta?.[PRIVATE_KEY] as any)?.delivery;
          if(delivery) {
            await receive(delivery,sent,generation);
            throw Error('A desktop command arrived before this tour step. Use Play to continue.');
          }
          if(!data?.attached || data.sourceToken!==sent.sourceToken || data.stateRevision!==sent.baseStateRevision
            || data.inspectionRevision!==sent.baseInspectionRevision)throw Error('The saved view changed before this tour step. Read the current inspection.');
        }
        const response=await call('navigate_experience',{...expected(),panelId:owner,experienceId,stepIndex,loadedSourceOnly,...(finish?{finish:true}:{}),baseExperienceRevision:experienceView?.revision??0});
        transition=(response.structuredContent as any)?.experienceTransition;
        experienceSourceChanged=transition?.sourceChanged===true;
        note('prepared');
      } finally {remote=false;}
      try {
        // Only this admitted navigation's hydration may advance its rollback
        // revision. Background saves and recovery hydrations carry no claim.
        const receipt=await hydrate(sessionId,undefined,transition?.rollbackToken
          ? {panelId:owner,rollbackToken:transition.rollbackToken} : undefined);
        if(finish && receipt?.status!=='rendered') throw Error('Your restored view has not been confirmed.');
        note('acknowledged');
        return receipt;
      }
      catch(error) {
        const why=thrownErrorMessage(error).trim().replace(/[.!?]+$/u,'');
        const budgetFailure=/headset geometry budget|vertex headset limit/u.test(why);
        note('hydration-failed',error);
        if(!transition?.rollbackToken) throw Error(budgetFailure
          ? 'This chapter is too detailed for this headset.' : `Journey could not render: ${why}`);
        try {
          const latest=(await call('get_inspection',{sessionId,...HYDRATION_TRANSPORT}))?._meta?.[PRIVATE_KEY] as any;
          await call('navigate_experience',{sessionId,serverEpoch:latest.serverEpoch,sourceToken:latest.sourceToken,
            baseStateRevision:latest.stateRevision,baseInspectionRevision:latest.inspectionRevision,
            baseExperienceRevision:latest.experience?.revision??0,panelId:owner,experienceId,stepIndex,rollbackToken:transition.rollbackToken});
          // A failed hydrate detached this id; retain it for the successful
          // recovery attach to retire, even when the stale detach was refused.
          panelId ??= owner;
          experienceSourceChanged=true;
          // A failed chapter restores the exact saved scene, including its
          // placement. Ordinary source-transition anchoring would resize it
          // again from the failed candidate's visible bounds.
          await hydrate(sessionId,undefined,undefined,{restoreExactScene:true,xrRecoveryFrame});
          note('rolled-back');
        } catch(restoreError) {
          note('rollback-failed',restoreError);
          throw Error(budgetFailure ? 'This chapter could not open, and your previous view could not be restored.'
            : `Journey could not render: ${why}. Previous view could not be restored: ${thrownErrorMessage(restoreError)}`);
        }
        throw Error(budgetFailure ? 'This chapter is too detailed for this headset; your previous view is back.'
          : `Journey could not render: ${why}. Previous view restored.`);
      }
    } catch(error) {
      // Host preflight can refuse a chapter before hydration has a rollback
      // token. Keep its vertex accounting out of the wearer's speech as well.
      if(/headset geometry budget|vertex headset limit/u.test(thrownErrorMessage(error)))
        throw Error('This chapter is too detailed for this headset.');
      throw error;
    } finally {experiencePreparing=false;}
  };
  if(tourCommandContext)return run();
  const operation=rendering.catch(()=>{}).then(run);
  // The returned operation keeps its rejection; this tail only serializes the
  // next scene. The experience player publishes the reason on plate/status.
  rendering=operation.then(()=>{},()=>{});
  return operation;
}

/**
 * One tier up or down the staged lesson, from inside the session.
 *
 * This is `navigateExperience` for authored lessons. The server replaces the
 * coordinates and the lesson together and leases the transition to this panel,
 * so hydrating here rebuilds the structure in place; `preserveRoomPlacement`
 * inside `viewer.load` is what keeps the immersive session, the room anchor and
 * the scale, which is why the tier appears to form where the wearer left it.
 * A refused tier returns normally and carries the line to speak.
 */
/** What this browser is, so the server can refuse a tier this headset cannot hold. */
function headsetDeviceClass():string {
  try { return deviceClass(typeof navigator==='undefined'?undefined:navigator); }
  catch { return 'unknown'; }
}
/**
 * The companion `/tool` body for one grow: this panel's id, the live binding,
 * the spoken stage, and the paired headset class.
 */
function growStructureArgs(stage:string) {
  return {...expected(),panelId,stage,device:headsetDeviceClass()};
}
/**
 * Whether the local scene differs from the saved one at most in the camera
 * and the structure's placement: the wearer moved or scaled it, or entry
 * seated it. A capture the workspace refuses is never placement work.
 */
function placementOnlyWork() {
  try { return sameEntryScene(savedScene,workspace.capture()); } catch { return false; }
}
/**
 * What this panel actually is right now, in the host's three words.
 *
 * The ordinary heartbeat in `poll` is no longer the only beat
 * that has to answer this. A panel waiting for the host to accept a grow is
 * not rendering anything, and it has to be able to say so, so the rule lives
 * in one place and both beats read it.
 */
function liveAvailability() {
  const snapshot=workspace.snapshot();
  return panelAvailability({blocked,dirty,ready:snapshot.ready,interactionActive:snapshot.interactionActive,
    // A grab, stick nudge or entry seat is a save in flight that a waiting
    // command follows, not work it could overwrite.
    placementOnly:dirty && !blocked && placementOnlyWork(),
    // Experience pending includes its host acknowledgement. Hydration and the
    // workspace readiness flag already cover its actual draw; reporting that
    // saved, attached panel as busy would refuse its own acknowledgement.
    navigating:Boolean(panelTour?.current()===tourPlayer && tourPlayer?.getState().navigating),
    // A headset running an autoplaying lesson is
    // presenting, not editing. Read the comment in
    // `inspection-panel-recovery.ts`.
    presenting:isCompanion&&Boolean(panelTour?.getState().active&&panelTour.getState().autoplay),
    // Only a companion has a wearer to lose. A desktop panel
    // has no XR session and this reads false there.
    blind:isCompanion&&workspace.viewer.xr?.blind?.()===true});
}
/**
 * Re-read session revisions without hydrating, so a retry of grow_structure
 * posts the binding the host holds now rather than the one that was refused.
 *
 * This beat used to declare `busy` outright. It is sent from
 * inside the wait for permission, where nothing is being drawn, so `busy` was
 * simply untrue — and because `grow_structure` will only target a `ready`
 * panel, saying it here re-asserted on every try the one condition the retry
 * was waiting to clear. It reports what the panel is, like every other beat.
 */
async function refreshGrowBinding() {
  if(!binding || !panelId) return;
  const ownGeneration=generation;
  const sent={...expected(),panelId,availability:liveAvailability(),animation:workspace.snapshot().animation??null,tourState:tourHeartbeat(panelTour),...(experienceView?{experience:{experienceId:experienceView.definition.id,stepIndex:experienceView.stepIndex}}:{})};
  try {
    const response=await call('poll_inspection',sent);
    await registerComparisonSources((response._meta?.[PRIVATE_KEY] as any)?.comparisonSources,binding.sessionId);
    const delivery=(response._meta?.[PRIVATE_KEY] as any)?.delivery;
    const data=response.structuredContent as any;
    if(data && typeof data.stateRevision==='number')
      binding={...binding,serverEpoch:data.serverEpoch??binding.serverEpoch,sourceToken:data.sourceToken??binding.sourceToken,
        stateRevision:data.stateRevision,
        inspectionRevision:typeof data.inspectionRevision==='number'?data.inspectionRevision:binding.inspectionRevision};
    // RUN the claimed command here, do not queue it behind
    // this grow.
    //
    // A beat that reports `ready` can be handed the command the Mac queued,
    // and this beat is sent from inside the grow's own retry wait. Chaining
    // the delivery onto `rendering` put it behind the grow operation — which
    // is itself the tail of `rendering` — while `readyPanel` refuses a grow
    // for as long as any command is pending (`inspection-commands.ts`,
    // `hasPending`). So the grow waited for a receipt that was waiting for the
    // grow: six attempts, about ten seconds, and the command was rendered only
    // after the grow had already failed with "Still busy. Try again."
    //
    // Awaiting it here cannot wait on itself. Nothing else can render
    // meanwhile — every other renderer chains onto `rendering`, whose tail is
    // this grow — so the serialization the queue exists for still holds, and
    // `retryWhileNotYet` awaits `refresh` before its next attempt, so the
    // receipt has landed and the panel is admissible again by then.
    if(delivery) await receive(delivery,sent,ownGeneration)
      .catch(error=>{if(!closed)showProblem(problemMessage('delivery',error),'delivery',error);});
  } catch { /* Keep the last binding; the next post will retry or fail. */ }
}
async function growStructure(stage:string, hooks?:{onNotYet?:()=>void;continuation?:StageContinuationIntent}):Promise<string> {
  const operation:Promise<string>=rendering.catch(()=>{}).then(async()=>{
    const continuationNarration=tourPlayer?.getState().narration;
    await save();
    if(hooks?.continuation && !hooks.continuation.isCurrent()) return 'Continuation cancelled.';
    if(hooks?.continuation && workspace.snapshot().interactionActive)
      throw Object.assign(Error('Release the structure to load the next batch.'),{code:'continuation_deferred'});
    if(!binding || dirty || blocked || loading || workspace.snapshot().interactionActive)throw Error('Finish the current edit before growing the structure.');
    if(!panelId)await attach();
    if(!panelId)throw Error('The viewer is not connected.');
    // The clock starts here, at the press, not at the hydrate.
    // `context` is read at write time, so the tier the server picks names every
    // phase after `requested` without a second trace.
    const context:Record<string,unknown>={stage};
    const atomSites=Number(workspace.snapshot()?.atomCount);
    let grow:any;
    try {
      // A 409 busy panel is not a failed grow. Re-read the
      // binding, wait two seconds, and post the same body again, up to the
      // same size-aware budget the unattended driver uses. The swap trace
      // starts only once the host has accepted the post, so a wait does not
      // look like a failed `requested` phase.
      //
      // Waiting for permission to start is not rendering.
      //
      // `remote` is the renderer-busy flag: it diverts the heartbeat to
      // `busyBeat`, which reports the panel `busy`, and `grow_structure`
      // targets a `ready` panel only. Setting it here, before the first post,
      // meant that the moment one attempt was refused the panel could never
      // report anything else — every retry re-asserted the very condition it
      // was waiting on, and the budget always ran out. A first attempt could
      // still succeed, which is why this looked like an intermittent fault.
      // The flag now goes on where the renderer is really claimed, the instant
      // the host accepts the post, and comes off when the swap ends or fails.
      grow=await retryWhileNotYet(async()=>{
        if(hooks?.continuation && !hooks.continuation.isCurrent()) throw Error('Continuation cancelled.');
        if(hooks?.continuation && workspace.snapshot().interactionActive)
          throw Object.assign(Error('Release the structure to load the next batch.'),{code:'continuation_deferred'});
        const result=await call('grow_structure',growStructureArgs(stage));
        hooks?.continuation?.beginTransition();
        remote=true;
        return (result as any)?.structuredContent?.grow;
      },{atomSites:Number.isFinite(atomSites)&&atomSites>0?atomSites:undefined,refresh:refreshGrowBinding,onNotYet:()=>{
        hooks?.onNotYet?.();
        if(!hooks?.onNotYet) { try { void voiceCommandSpeaker()?.(GROW_NOT_YET_SPOKEN); } catch { /* Speech is accessory to the wait. */ } }
      }});
    } catch(error) { remote=false; sourceSwapTrace=undefined; throw error; }
    try {
      const trace=beginSourceSwapTrace(context);
      await trace.phase('requested');
      if(grow?.to)context.tier=String(grow.to);
      if(grow?.lessonId)context.lessonId=String(grow.lessonId);
      if(Number.isFinite(grow?.atomSites))context.atomSites=Number(grow.atomSites);
      // The tier's size in the unit the tier is measured in.
      // `stageSize` on the Mac is the one place that decides which unit that is,
      // and `atomSites` alone reads 0 for a density tier — so every phase of the
      // first density swap said the page was growing into nothing. The host's own
      // answer is copied through unchanged.
      if(Number.isFinite(grow?.size?.count) && typeof grow?.size?.unit==='string')
        context.size={count:Number(grow.size.count),unit:String(grow.size.unit)};
      if(grow?.refused) { sourceSwapTrace=undefined; return String(grow.spoken ?? 'Not this time.'); }
    } finally {remote=false;}
    // The claim passes from this flag to `hydrate`, which stops the lesson,
    // detaches the panel and raises `loading` — the state the beat already
    // reads while a tier is being built. It is deliberately not held across
    // the rebuild: `onMutation` labels every workspace change with this flag,
    // and a tier forming in front of the wearer is the page's own work, not an
    // agent change landing on top of a chapter.
    await hydrate(binding.sessionId,undefined,undefined,
      hooks?.continuation ? {autoplayContinuation:hooks.continuation.shouldAutoplay,continuationNarration} : {});
    return String(grow?.spoken ?? 'Ready.');
  });
  rendering=operation.then(()=>undefined).catch(()=>{});
  return await operation;
}
function expected() { return {sessionId:binding.sessionId,serverEpoch:binding.serverEpoch,sourceToken:binding.sourceToken,
  baseStateRevision:binding.stateRevision,baseInspectionRevision:binding.inspectionRevision}; }
// The desktop Saved views panel is host-driven. The
// shared library arrives on every poll/hydration payload and is pushed into
// the workspace; its buttons call the same validated manage_inspection_view
// flow the agent tool uses, so the host library stays the only authority.
// Save/restore are queued commands whose receipts arrive on later beats;
// delete answers at once and refreshes the panel from its answer. Callbacks
// stay desktop-only: the companion /tool route serves private tools only, so
// a headset page keeps its tab-local panel rather than failing honest calls
// it cannot make.
const sceneHistoryClient=createSceneHistoryClient({
  context:view=>{
    const snapshot=view??workspace?.snapshot();
    return {binding,panelId,generation,ready:snapshot?.ready===true,loading,dirty,blocked,closed,remote,
      interactionActive:snapshot?.interactionActive===true,pending:Boolean(pendingReceipt)||experiencePreparing||reloading};
  },
  flush:async()=>{
    if(workspace?.snapshot().ready && JSON.stringify(workspace.capture())!==JSON.stringify(savedScene)) scheduleSave();
    await save();
  },
  call,commandId:()=>crypto.randomUUID(),changed:()=>workspace?.syncSceneHistory?.(),
});
const noteNamedViews=(value:any)=>{ if(value && typeof value==='object' && Array.isArray(value.entries)) workspace?.setNamedViews?.(value); };
const namedViewBase=()=>{ if(!binding || !panelId) throw Error('Save the inspection before managing named views.'); return {...expected(),panelId}; };
const saveHostNamedView=async(name:string)=>{
  // A panel-side pre-check only; the host validates again before queueing.
  const trimmed=name.trim().replace(/\s+/g,' ');
  if(!trimmed || trimmed.length>80) throw Error('A view name must be 1–80 characters.');
  const response=await call('manage_inspection_view',{...namedViewBase(),action:'save',commandId:crypto.randomUUID(),name:trimmed});
  return (response.structuredContent as any);
};
const restoreHostNamedView=async(entry:{id:string})=>{
  const response=await call('manage_inspection_view',{...namedViewBase(),action:'restore',commandId:crypto.randomUUID(),viewId:entry.id});
  return (response.structuredContent as any);
};
const deleteHostNamedView=async(entry:{id:string;viewRevision:number})=>{
  const response=await call('manage_inspection_view',{...namedViewBase(),action:'delete',viewId:entry.id,viewRevision:entry.viewRevision});
  const deleted=(response.structuredContent as any);
  if(deleted?.namedViews) noteNamedViews(deleted.namedViews);
  return deleted;
};
async function detach(reason?:'loading') {
  const retiring=panelId;panelId=undefined;delete document.body.dataset.panelId;
  if(retiring && binding) {
    try { await call('detach_inspection',{...expected(),panelId:retiring,
      ...(leavingForDetailedView?{reason:'detailed-view' as const}:reason?{reason}:{})}); }
    catch { /* A disconnected panel expires without a heartbeat. */ }
  }
}
/** Adopt only a host view that still matches this saved panel's binding. */
async function reconcileExperience(provided?:any,previous=experiencePlayer?.getState()) {
  const sent=expected(), ownGeneration=generation, owner=panelId;
  const response=provided??await call('get_inspection',{sessionId:sent.sessionId,...HYDRATION_TRANSPORT});
  const data=response?._meta?.[PRIVATE_KEY], next=data?.experience as ExperienceView|undefined;
  const admit=()=>{
    if(!owner || closed || generation!==ownGeneration || panelId!==owner || dirty || blocked || loading
      || workspace.snapshot().interactionActive || !data?.scene
      || data.serverEpoch!==sent.serverEpoch || data.sourceToken!==sent.sourceToken
      || data.stateRevision!==sent.baseStateRevision || data.inspectionRevision!==sent.baseInspectionRevision
      || JSON.stringify(expected())!==JSON.stringify(sent))
      throw Error('The saved view changed before the journey could reconnect. Retry reconnect.');
  };
  admit();
  // A published step may still be unapplied. Hydration applies the declared
  // chapter before acknowledging it; the saved scene alone cannot prove it.
  if(next) { await hydrate(sent.sessionId,response); return; }
  const wasRemote=remote;
  experiencePreparing=true; remote=true; experiencePlayer?.setRendering(true);
  try {
    await workspace.restoreShared(data.scene,admit,workspace.snapshot().xrPresenting===true,true);
    admit();
    await workspace.viewer.inspection?.restoreJourneySeat?.({scene:data.scene});
    admit();
    experiencePlayer?.update(undefined);
    await workspace.viewer.xr?.refreshToolbar?.();
    admit();
    const state={step:-1,total:0,active:false,autoplay:false,navigating:false};
    if(tourCommandContext) {
      // Page-only Done is a same-source command. Its ordinary rendered scene
      // receipt retains the admitted panel and the command's original deadline.
      tourCommandReceipt=await confirmReceipt({...tourCommandContext,sessionId:sent.sessionId,scene:workspace.capture(),tourState:state},['tour']);
      if(tourCommandReceipt?.status!=='rendered') throw Error('Your restored view has not been confirmed.');
    } else {
      remote=false; scheduleSave(); await save();
      if(dirty || blocked) throw Error('Your restored view has not been saved.');
    }
    const heartbeat={...expected(),panelId:owner,availability:'ready',tourState:state};
    const polled=await call('poll_inspection',heartbeat), delivery=polled._meta?.[PRIVATE_KEY]?.delivery;
    if(delivery) {
      await receive(delivery,heartbeat,generation);
      throw Error('A desktop command arrived before the journey reconnected. Retry reconnect.');
    }
    const acknowledged=await call('acknowledge_experience_step',{...expected(),panelId:owner,tourState:state,
      experienceId:previous?.selectedId,experienceRevision:data.experienceCompletion?.revision??0,
      stepIndex:Math.max(0,previous?.step??0),reconcileEnded:true});
    const receipt=acknowledged.structuredContent?.experienceReconciled;
    if(receipt?.status!=='rendered') throw Error('The reconnected journey view has not been confirmed.');
    experienceView=undefined; document.body.dataset.experienceActive='false';
    const message='The lesson ended while the link was down. Back to your view.';
    experiencePlayer?.update(undefined,message); workspace.setStatus(message,false); showHeadsetCaption(message);
    await workspace.viewer.xr?.refreshToolbar?.();
    return {...receipt,message};
  } finally {remote=wasRemote;experiencePreparing=false;experiencePlayer?.setRendering(false);}
}
function attach(replacesPanelId?:string,journeySave?:JourneySaveClaim,hydrating=false,recoveryAttempt=0) {
  if((panelId && !journeySave && !(hydrating && replacesPanelId===panelId)) || Date.now()<attachRetryAt) return Promise.resolve();
  if(attaching?.generation===generation) return attaching.promise;
  const ownGeneration=generation, ownEdits=edits, ownInteraction=localInteractionSerial, sent=expected();
  const geometryBudget=sourceGeometryBudget(workspace.snapshot().applied?.geometryBudget);
  // Keep the scene at dispatch, not just `dirty`: XR edits can precede the
  // save timer. A capture refusal itself forbids automatic restoration.
  let cleanScene:string|undefined, cleanSavedScene:string|undefined;
  try { const scene=JSON.stringify(workspace.capture());if(scene===JSON.stringify(savedScene))cleanScene=cleanSavedScene=scene; } catch { /* Preserve unidentifiable local work. */ }
  const canRefresh=(expectedGeneration=ownGeneration,hydrationOwned=false,checkpointing=false)=>{
    const snapshot=workspace.snapshot();
    let sceneUnchanged=false;
    try {sceneUnchanged=cleanScene!==undefined && (checkpointing || JSON.stringify(workspace.capture())===cleanScene)
      && JSON.stringify(savedScene)===cleanSavedScene && localInteractionSerial===ownInteraction
      && JSON.stringify(expected())===JSON.stringify(sent);} catch { /* Do not discard a capture failure. */ }
    return canRefreshInspectionAttach({closed,generation,expectedGeneration,edits,expectedEdits:ownEdits,
      ready:snapshot.ready===true,dirty,blocked,loading:loading && !hydrationOwned,remote,
      interactionActive:snapshot.interactionActive===true,pendingReceipt:Boolean(pendingReceipt),sceneUnchanged});
  };
  const entry={generation:ownGeneration,promise:Promise.resolve()};
  entry.promise=(async()=>{
    const response=await call('attach_inspection',{...sent,surface:isCompanion?'companion':'desktop',...(renderedSourceIdentitySupported?{renderedSourceSha256:workspace.snapshot().sourceSha256}:{}),...(sourceGeometryBudgetSupported && geometryBudget?{geometryBudget}:{}),...(replacesPanelId?{replacesPanelId}:{}),...(journeySave?{journeySave}:{})}), issued=(response.structuredContent as any)?.panelId;
    if(!issued) throw Error('The inspection panel did not attach.');
    if(closed || generation!==ownGeneration) {
      try { await call('detach_inspection',{...sent,panelId:issued}); } catch { /* Heartbeat expiry is the fallback. */ }
      return;
    }
    attachRetryAt=0;panelId=issued;document.body.dataset.panelId=issued;
    announceSourceGeometryBudget(geometryBudget,String(sent.sourceToken));
    if(isCompanion && outcome.textContent==='Connecting to your desktop inspection…') {
      outcome.textContent='Structure ready';outcome.dataset.state='connected';
    }
    let label=document.querySelector('[data-panel-label]');
    if(!label) { label=document.createElement('span');label.className='panel-label';label.setAttribute('data-panel-label','');document.querySelector('.header-actions')!.prepend(label); }
    label.textContent=`${isCompanion?'Companion':'Desktop'} ${issued.slice(0,8)}`;
    // A card hides the label (inspector-card-chrome.css); the wordmark's
    // tooltip still tells two panels apart.
    document.querySelector('.app-header .brand')?.setAttribute('title',`${isCompanion?'Companion':'Desktop'} panel ${issued.slice(0,8)}`);
    // Hydration already draws and acknowledges its supplied journey. A plain
    // re-registration must do the same even when the host now omits experience.
    if(!hydrating && !experiencePreparing && ((response.structuredContent as any)?.experience || experiencePlayer?.getState().active)) {
      const resumed=(response._meta?.[PRIVATE_KEY] as any)?.journeySave as JourneySaveClaim|undefined;
      if(resumed) await hydrate(sent.sessionId,undefined,resumed);
      else await reconcileExperience();
    }
  })().catch(async error=>{
    if(isStaleInspectionAttach(error) && !journeySave) {
      if(closed || generation!==ownGeneration)return;
      // This refusal allocated no capability. Only this path may read the
      // authoritative binding immediately; a lost attach response still uses
      // the expiry delay below. Keep genuine edits for explicit resolution.
      if(recoveryAttempt>=MAX_ATTACH_REFRESHES || !canRefresh())throw error;
      recordHeadsetEvent('connection',{phase:'attach-revision-refresh',attempt:recoveryAttempt+1});
      try {
        const response=await call('get_inspection',{sessionId:binding.sessionId,...HYDRATION_TRANSPORT});
        if(closed || generation!==ownGeneration)return;
        if(!canRefresh())throw Error('Local work changed before the saved view arrived. Your visible work is preserved.');
        await hydrate(binding.sessionId,response,undefined,{restoreExactScene:true,
          attachRecoveryAttempt:recoveryAttempt+1,checkpointRestore:hydrationGeneration=>{
            if(!canRefresh(hydrationGeneration,true,true))throw Error('Local work changed before the saved view arrived. Your visible work is preserved.');
            cleanScene=JSON.stringify(workspace.capture());
          },admitRestore:hydrationGeneration=>{
            if(!canRefresh(hydrationGeneration,true))throw Error('Local work changed before the saved view arrived. Your visible work is preserved.');
          }});
      } catch(refreshError) {
        if(!showConnectionProblem(refreshError,generation))throw refreshError;
      }
      return;
    }
    // Registration has no scene write. If its response is lost, the unused
    // panel expires and the next clean poll can register again.
    if(!showConnectionProblem(error,ownGeneration))throw error;
    // A lost attach response may already have allocated a panel. Wait beyond
    // its heartbeat lifetime before trying again instead of filling all slots.
    // A newly issued companion starts ready and has a 60 s registry grace;
    // the desktop grace is 10 s. Eleven seconds would duplicate an unknown
    // companion capability while it was still live on the Mac.
    if(generation===ownGeneration)attachRetryAt=Date.now()+(isCompanion?61_000:11_000);
  }).finally(()=>{if(attaching===entry)attaching=undefined;});
  attaching=entry;return entry.promise;
}
/** Register poll assets before a delivery can reach the renderer. */
async function registerPollState(response:any, sessionId:string) {
  const data=response.structuredContent;
  if(data?.namedViews) noteNamedViews(data.namedViews);
  // A changed source registers its assets inside validated hydration.
  if(data?.sourceToken===binding?.sourceToken && data?.serverEpoch===binding?.serverEpoch)
    await registerComparisonSources(response._meta?.[PRIVATE_KEY]?.comparisonSources,sessionId);
}
async function receivePollDelivery(response:any, sent:any, ownGeneration:number) {
  if(closed || generation!==ownGeneration) return;
  await registerPollState(response,sent.sessionId);
  const delivery=response._meta?.[PRIVATE_KEY]?.delivery;
  if(delivery) await receive(delivery,sent,ownGeneration);
}
async function confirmReceipt(receipt:any, fields:string[]=pendingReceiptFields??['scene'], commitScene=true) {
  if(tourCommandContext && (receipt.failure || receipt.phase==='settled'))receipt={...receipt,...expected(),panelId:panelId??receipt.panelId,tourCommand:tourCommandContext};
  pendingReceipt=receipt; pendingReceiptFields=fields;
  let response;
  if(!isCompanion && receipt.scene && !receipt.failure && !receipt.phase) {
    desktopReceiptInFlight=true;
    try {
      // The frame is drawn, but completion publishes the saved revision to other
      // clients immediately. Drain the earlier busy report and refresh the strip
      // before that publication; hold subsequent busy beats until it finishes.
      await beatCompletion;
      if(closed || loading || panelId!==receipt.panelId
        || JSON.stringify(workspace.capture())!==JSON.stringify(receipt.scene))
        throw Error('The local view changed before confirmation. Your visible work is unsaved.');
      const ownGeneration=generation, sent={...expected(),panelId,availability:'ready'};
      const ready=await call('poll_inspection',sent);
      if(!(ready.structuredContent as any)?.attached)
        throw Error('The panel could not register its completed frame. Retry confirmation.');
      // A retry of an already accepted capture can encounter the next queued
      // command. Preserve its delivery until this confirmation releases the queue.
      rendering=rendering.then(()=>receivePollDelivery(ready,sent,ownGeneration))
        .catch(error=>{if(!closed)showProblem(problemMessage('delivery',error),'delivery',error);});
      if(closed || generation!==ownGeneration || panelId!==receipt.panelId
        || JSON.stringify(workspace.capture())!==JSON.stringify(receipt.scene))
        throw Error('The local view changed before confirmation. Your visible work is unsaved.');
      desktopReceiptBeat={sent,commandId:receipt.commandId};
      response=await call('complete_inspection',receipt);
    } finally {
      // Drain the last ready beat before a later edit can report unsaved.
      desktopReceiptBeat=undefined;
      await beatCompletion;
      desktopReceiptInFlight=false;
    }
  } else response=await call('complete_inspection',receipt);
  const next=response.structuredContent as any;
  if(next?.command?.status==='rendered') recordLoopStage('receipt-rendered',next.command);
  pendingReceipt=undefined; pendingReceiptFields=undefined;
  if(receipt.phase==='settled') {
    if(!next?.settled) throw Error('The host has not released the cancelled command. Reconnect before continuing.');
    return;
  }
  if(receipt.failure) {
    // A journey may have rendered and saved before its acknowledgement was
    // lost locally. The immutable claim can recover that existing receipt;
    // the failure request itself never creates a rendered receipt.
    const recoveredTour=receipt.tourCommand && next?.command?.status==='rendered'
      && next.command.commandId===receipt.commandId && typeof next.command.renderedAt==='number'
      && next.sourceToken===binding?.sourceToken && next.stateRevision===binding?.stateRevision
      && next.command.renderedRevision===binding?.inspectionRevision;
    if(!recoveredTour && !['rejected','expired','conflict','unconfirmed','cancelled','superseded'].includes(next?.command?.status))
      throw Error('The failed command could not be confirmed. Load the saved view to recover.');
    showOutcome(next.command);
    // A rejected command drew nothing and committed nothing, so the panel is
    // not stale and must not block: the server released the revision, and the
    // next heartbeat has to advertise `ready` for the following command. On
    // One `render_failed` blocked a Quest panel for eight minutes.
    blocked=false;notice.hidden=true;
    return next.command;
  }
  if(['cancelled','superseded'].includes(next?.command?.status)) {
    showOutcome(next.command);
    throw Object.assign(Error('The earlier request was dropped for a newer utterance.'),{code:'superseded',replacement:(response._meta?.[PRIVATE_KEY] as any)?.replacement});
  }
  if(!next?.accepted || next.command?.status!=='rendered' || next.command.renderedRevision!==next.inspectionRevision
    || next.sourceToken!==binding?.sourceToken || next.stateRevision!==receipt.baseStateRevision) {
    dirty=true;
    throw Error('The command could not save over a newer or expired view. Your visible work is unsaved. Load the saved view to continue.');
  }
  binding={...binding,...next}; if(commitScene)savedScene=receipt.scene;
  showOutcome({...next.command,fields});
  if(commitScene)dirty=JSON.stringify(workspace.capture())!==JSON.stringify(receipt.scene);
  blocked=false; notice.hidden=true;
  if(fields.includes('lesson'))tourPlayer?.confirmLessonInstallation();
  return next.command;
}
/**
 * A confirmation that fails must not wedge a headset panel.
 *
 * `complete_inspection` is the last step of an agent command, and it can fail
 * on its own: the companion socket drops, the desktop sleeps, the claim
 * expires mid-flight. Both of `receive`'s catch arms raised the blocking
 * notice for that, which sets `blocked`, which answers `unsaved`, which refuses
 * every command after it — the same eight-minute wedge the `render_failed` fix
 * closed, reached by the other door. A wearer cannot press Retry confirmation.
 *
 * A companion re-sends the same receipt a few times and then drops it, saying
 * so on the status line and on the in-headset readout `showOutcome` drives.
 * The decision itself is in `inspection-panel-recovery.ts` so a test can hold
 * it. A desktop panel still blocks and keeps its button.
 */
async function recoverConfirmation(error:unknown, _context:string, ownGeneration:number, keepTransaction=false) {
  const receipt=pendingReceipt, fields=pendingReceiptFields;
  let last=error;
  for(let attempt=1;;attempt++) {
    const recovery=confirmFailureRecovery({companion:isCompanion,attempt});
    if(recovery.action==='block') { const kind=pendingReceipt?'confirmation':'delivery';showProblem(problemMessage(kind,last),kind,last); return; }
    showOutcome({status:'failed',fields:fields??[],detail:thrownErrorMessage(last).slice(0,200)});
    if(recovery.action==='drop') break;
    await new Promise(resolve=>setTimeout(resolve,recovery.delayMs));
    if(closed || generation!==ownGeneration || !receipt) break;
    try { return await confirmReceipt(receipt,fields); }
    catch(retryError) {
      if(keepTransaction && (retryError as any).code==='superseded') throw retryError;
      last=retryError;
    }
  }
  // Dropped. The command is unconfirmed and the server releases its claim when
  // it expires; the panel has to be answering `ready` long before that.
  pendingReceipt=undefined; pendingReceiptFields=undefined;
  if(!closed && generation===ownGeneration) { blocked=false; notice.hidden=true; }
  if(keepTransaction) throw Object.assign(last instanceof Error?last:Error(thrownErrorMessage(last)),{receiptRecoveryTried:true});
}
/**
 * The two words the wearer hears when Claude moves something.
 *
 * A spoken "next step" answered "Next step." and an agent's `control_tour`
 * answered with silence and a status line 47 degrees off to one side, which a
 * wearer facing the structure never reads. The same change made two ways
 * sounded like two different systems, and one of them sounded like nothing at
 * all. These are literally the strings the spoken grammar uses, imported
 * rather than retyped, so the two can never drift apart.
 *
 * Only a presenting headset is spoken to: a desktop panel has the status line
 * on screen and does not need to be told out loud. And a reply arriving on the
 * same heartbeat wins outright — `say_to_headset` is the agent's own sentence,
 * it carries its own audio, and speaking a confirmation over it would put two
 * voices in the wearer's ears at once.
 */
const REMOTE_CONFIRMATIONS:Record<string,string> = {
  play:'tour-play', start:'tour-play', pause:'tour-pause', next:'tour-next', back:'tour-back',
};
/**
 * What a wearer hears when the agent raises or lowers the
 * render budget. Two words, the same ones the menu row and the spoken "best
 * quality" answer with, so the three routes to one setting never disagree.
 */
const REMOTE_QUALITY_CONFIRMATIONS:Record<string,string> = {
  best:'Max quality.', balanced:'Balanced.', fast:'Fast.',
};
let replyOnThisBeat=false;
/**
 * @param applied what the panel's renderer actually did, when it reported it.
 *   Only the render budget has an answer that can differ from its request: the
 *   framebuffer half of `max` cannot touch a live XR layer and lands on the
 *   wearer's next entry, and a confirmation that does not say so promises a
 *   sharper picture the wearer is still not looking at.
 * @param narrated whether applying the command already started the new
 *   chapter's own spoken line. See the `chapter-line` branch below.
 */
function speakRemoteConfirmation(change:any, applied?:any, narrated=false, timing?:any) {
  // Keep the advisory in the host receipt without replacing an unchanged command answer.
  if(applied?.geometryBudgetChanged===false)applied={...applied,geometryBudget:undefined};
  if((replyOnThisBeat && !applied?.geometryBudget) || !isCompanion || !workspace?.snapshot().xrPresenting) return;
  // A next or back that had to start the lesson is a start, and
  // the wearer hears the two words a start is answered with rather than "Next
  // step." over a lesson that was not running a moment ago.
  const command=change?.kind==='tour' ? (applied?.started===true?'tour-play':REMOTE_CONFIRMATIONS[change.patch?.action])
    : change?.kind==='focus' ? (change.patch?.framing==='fill'?'focus-selection':'show-whole')
      : undefined;
  // The same two words the wearer's own "spin it" and "stop" are answered with.
  // The wearer hears the part's own name, which is what
  // the spoken "show me the guide RNA" answers with on the page itself.
  // One request, one line. A compound is answered with a single
  // sentence naming what moved, never one sentence per field.
  const say=geometryBudgetConfirmation(applied, change?.kind==='compound' ? compoundConfirmation(change.patch?.ops ?? [])
    : change?.kind==='styles' ? scopedStyleConfirmation(change.patch ?? {})
    : change?.kind==='emphasis' ? (change.patch?.focus?.length
    ? `${change.patch.parts.find((part:any)=>part.id===change.patch.focus[0])?.label ?? 'Highlighted'}.`
    : 'Whole structure.')
    : change?.kind==='companion-structure' ? (change.patch?.remove?'Comparison removed.':`Now comparing ${comparisonPrimaryName} with ${change.patch?.source?.kind==='pdb'?change.patch.source.id.toUpperCase():'the companion structure'}.`)
    : change?.kind==='animation' ? (applied?.animation?.state==='paused'?'Animation paused.':applied?.animation?.state==='playing'?'Animation playing.':'Animation updated.')
    : change?.kind==='motion' ? (change.patch?.state==='spin'?'Spinning.':'Stopped.')
    // The same two words the menu row and "best quality" say.
    // With the pending half named, exactly as the wearer's
    // own spoken phrase names it (voice-command-runner.mjs spokenConfirmation).
    : change?.kind==='render-quality' ? renderQualityConfirmation(change.patch?.level,REMOTE_QUALITY_CONFIRMATIONS[change.patch?.level as string],applied)
      : command?(SPATIAL_VOICE_ACTIONS as any)[command]?.say:undefined);
  if(!say) return;
  if(applied?.geometryBudget || change?.kind==='styles'
    || (change?.kind==='compound' && change.patch.ops.some((op:any)=>op.kind==='styles'))) {
    try { globalThis.dispatchEvent(new CustomEvent(GROWTH_CAPTION_EVENT,{detail:{spoken:say}})); }
    catch { /* The receipt still contains the rendered detail. */ }
  }
  // "Next scene." is not spoken when the scene speaks for
  // itself. An acknowledgement takes its turn behind whatever is speaking, and
  // the thing speaking is the chapter this command just opened — a twenty
  // second line, after which "Next scene." arrives about a move the wearer made
  // twenty seconds ago and describes the chapter before the one they are on.
  // Interrupting the chapter to say it and then resuming is not available
  // either: the line is a rendered WAV from the Mac, so resuming means fetching
  // and replaying it from the top. The chapter's own line is the confirmation —
  // it starts within the same beat as the press and says far more.
  if(narrated) { recordHeadsetEvent('remote-confirmation',{change:change?.kind,say,route:'chapter-line'}); return; }
  // Best effort, never awaited: a confirmation that costs the command its
  // render latency is worse than a silent one. This is the same rule the
  // local voice runner's own `announce` follows.
  // The headset log is the only place a wearer's missing confirmation can be
  // read back afterwards, so record the attempt and, separately, a narration
  // route that refused. Speech itself stays best effort and is never awaited.
  try {
    const spoken=voiceCommandSpeaker()?.(say,timing);
    recordHeadsetEvent('remote-confirmation',{change:change?.kind,say,route:spoken?'voice-acknowledgement':'none'});
    // A confirmation the next tour chapter spoke over was heard as far as it
    // got and then deliberately replaced; that is not a failed confirmation.
    if(spoken?.catch) spoken.catch((error:unknown)=>{if(speechWasInterrupted(error))return;
      recordHeadsetEvent('remote-confirmation-failed',
        {change:change?.kind,say,status:callStatus(error),reason:thrownErrorMessage(error).slice(0,120)});});
  }
  catch(error) { recordHeadsetEvent('remote-confirmation-failed',{change:change?.kind,say,status:callStatus(error),reason:thrownErrorMessage(error).slice(0,120)}); }
}
/**
 * Say one tour line. A refusal is recorded as `speech-failed` with its HTTP
 * status and swallowed: the scene is already drawn and its caption is already
 * on screen, so an unhandled rejection here would report a failure the wearer
 * did not have.
 */
/**
 * Whether a spoken line was cut off on purpose rather than failing.
 *
 * A new tour chapter, a microphone press and a session cancel all abort the
 * audio in progress, and the wearer hears exactly what was meant: the line
 * that replaced it. Recording those as failures filled the headset log — the
 * only place a missing confirmation can be read back afterwards — with
 * failures nobody had, and hid the real ones among them.
 */
function speechWasInterrupted(error:unknown) {
  return (error as {name?:unknown})?.name==='AbortError';
}
/**
 * Which chapter line the page is currently asking the Mac to say.
 *
 * The Mac renders each line over HTTP and can take
 * tens of seconds. Two chapters in flight together return in whatever order
 * they finish, and the loser used to arrive with `interrupt: true` and speak
 * the chapter the wearer had already left over the one they were on.
 */
let narrationGeneration=0;
async function speakNarration(line:string) {
  // A chapter line is only narrated once (`speakScene` in
  // tour-player.ts drops a repeat), so every call here is a new chapter and
  // replaces whatever the previous one was still saying. Acknowledgements
  // take the default and wait their turn instead.
  const stamp=++narrationGeneration;
  // Is this line still worth saying? Asked when the audio arrives, and again at
  // the moment it would finally be spoken if it had to wait for the speaker.
  //
  // The second half of this used to be the
  // microphone's takeover count, which could only ever answer "drop it" — and
  // that is what left a chapter unnarrated after the wearer talked to the
  // agent. The lesson answers better, in two parts.
  //
  // `stopped` is the lesson letting go of the scene itself: explore, Rejoin,
  // a workspace takeover, a changed structure. The scene the line describes is
  // genuinely gone then, and rejoining re-narrates it.
  //
  // `narratingLine` is the lesson's memory of what it is saying, and a
  // *different* line means the chapter moved on. `undefined` deliberately does
  // not: `pause()` forgets the line, and `receive()` pauses before every remote
  // command — including the `control_tour next` whose own chapter is about to
  // speak. Reading that gap as "moved on" silenced four of nine chapters in the
  // agent-driven emulator pass.
  const stale=()=>{
    if(stamp!==narrationGeneration) return true;
    const lesson=panelTour?.getState();
    if(lesson && (lesson.stopped || !lesson.active || lesson.narration===false)) return true;
    const held=(panelTour?.current() as TourPlayer|ExperiencePlayer|undefined)?.narratingLine?.();
    return held!==undefined && held!==line;
  };
  try { await voiceCommandSpeaker()?.(line,{kind:'narration',interrupt:true,stale}); }
  catch(error) {
    if(speechWasInterrupted(error)) return;
    recordHeadsetEvent('speech-failed',{route:'tour-narration',chars:line.length,
      status:callStatus(error),reason:thrownErrorMessage(error).slice(0,120)});
  }
}
async function receive(delivery:any, sent:any, ownGeneration:number) {
  let releaseHostLoad:(()=>void)|undefined;
  try {
  // An inspection command lands on top of the running lesson.
  //
  // Every remote command used to pause the tour before it was applied, which
  // is the opposite of what the headset is for: the wearer says
  // "bigger" and sees it happen while the cinematic keeps playing. The chapter
  // motion is a transient the viewer pins (`applyLessonMotion`), so the scene
  // this command builds on is the saved one whether the camera is turning or
  // not, and `admit()` below still refuses anything that really did change.
  // A `tour` command is its own control surface — play/pause/next decide what
  // the lesson does next — so settle chapter advancement without publishing
  // molecular controls until admit() has accepted the command.

  const base={...sent,panelId:delivery.panelId,commandId:delivery.commandId,claimToken:delivery.claimToken};
  delete base.animation;delete base.availability;delete base.spatialContext;delete base.tourState;delete base.experience;delete base.xrStartup;
  let drew=false,settledSuperseded=false,recoveryFailed=false;
  let activeDelivery=delivery;
  // The scene a lesson start, chapter change or lesson install was admitted
  // on, and the lesson installed then. Any failure after admission puts that
  // scene back before the page replies, while `remote` still holds every save,
  // so half a chapter is never left on screen or saved as the wearer's work.
  let checkpoint:any, checkpointAt=Infinity, checkpointDraws=0, lessonBefore:any, reloadPending=false;
  const lessonCommand=delivery.change.kind==='lesson' || delivery.change.kind==='tour';
  const receivedAt=performance.now(), entryInteraction=localInteractionSerial;
  const entryScene=panelEntering(workspace.viewer?.xr?.startup?.()) && !dirty ? savedScene : undefined;
  // Reserve the delivered claim before waiting. Entry can publish placement
  // while it finishes; a background save must not race this claim's binding.
  if(entryScene) remote=true;
  let settleDeadline=Date.now()+Math.min(delivery.settleBudgetMs??15000,15000);
  // A held grip or stick is the wearer placing the structure, so the command
  // waits for the release rather than refusing. The settle budget bounds the
  // wait; a hand still on the molecule when it runs out gets the old refusal.
  const settleRender=(current:()=>boolean=()=>true,onReady?:()=>any)=>waitForPanelRender({
    ready:()=>workspace.snapshot().ready && !workspace.snapshot().interactionActive,
    presentation:()=>({...workspace.viewer?.xr?.startup?.(),presenting:workspace.snapshot().xrPresenting,drawCount:workspace.snapshot().drawCount}),
    current:()=>current() && !closed && generation===ownGeneration && panelId===delivery.panelId && !blocked,
    onReady,waitMs:Math.max(0,settleDeadline-Date.now()),onEntryWait:elapsed=>{settleDeadline+=elapsed;}}).catch(error=>{
    if((error as any)?.code!=='local_changed' && workspace.snapshot().interactionActive)
      throw Object.assign(Error('Release the molecular drag before applying a command.'),{code:'interaction_active'});
    throw error;
  });
  // A tour command pauses the lesson before admission (below). That pause is
  // this command's own: it settles a turning chapter's camera and rewrites the
  // lesson cursor's motion progress, so the capture changes although nobody
  // edited anything. Reading that as a local edit refused every next sent
  // while a chapter turned, and the assistant had to send it again. While the
  // capture is still exactly what the pause left, admission judges the scene
  // as it stood before the pause.
  let ownPause:{before:any;after:string}|undefined;
  const admissionCapture=()=>{
    const scene=workspace.capture();
    return ownPause && JSON.stringify(scene)===ownPause.after ? ownPause.before : scene;
  };
  // Work that only moved the structure or the camera: a grab, a stick nudge.
  // The host lets this command follow its save, bound or not, so the page
  // hands the unadmitted claim back, saves, and is delivered the same command
  // again inside its original delivery deadline. Entry has its own rule.
  const placementWork=()=>{
    if(entryScene || blocked) return false;
    try { const scene=admissionCapture(); return JSON.stringify(scene)!==JSON.stringify(savedScene) && sameEntryScene(savedScene,scene); }
    catch { return false; }
  };
  const deferForLocalSave=async()=>
    (await call('complete_inspection',{...base,phase:'defer-local-save'})).structuredContent?.deferred===true;
  // The lesson player this command drew with. A journey owns its own rollback
  // and source, so it never takes the checkpoint below.
  const lessonPlayer=()=>delivery.change.kind==='lesson' ? tourPlayer
    : panelTour && !panelTour.matchesLoadedSource ? panelTour.current?.() as TourPlayer|undefined : undefined;
  const ownsCheckpoint=()=>checkpoint!==undefined && !tourCommandReceipt && !closed && generation===ownGeneration
    && base.sourceToken===binding?.sourceToken && base.panelId===panelId
    && (delivery.change.kind==='lesson' || !panelTour?.matchesLoadedSource);
  const withoutCamera=(scene:any)=>JSON.stringify({...scene,camera:undefined});
  // Head tracking owns a presenting camera, so the camera is not compared.
  const shows=(scene:any)=>{ try { return withoutCamera(workspace.capture())===withoutCamera(scene); } catch { return false; } };
  /**
   * The checkpoint, with whatever the wearer changed after admission kept.
   *
   * A toolbar edit made while the chapter drew waits in the workspace queue
   * and lands after it. The player records what its action left before that,
   * so the edit is the difference between that scene and the one on screen.
   * When this command drew nothing, the checkpoint itself is that scene.
   */
  const putBackTarget=()=>{
    if(!(lastLocalEditAt>=checkpointAt)) return checkpoint;
    const drawn=lessonPlayer()?.drawnScene?.();
    try { return withWearerEdits(checkpoint,drawn && drawn.serial>checkpointDraws ? drawn.scene : checkpoint,workspace.capture()); }
    catch { return checkpoint; }
  };
  /**
   * Put the admitted scene back after a lesson command failed.
   *
   * The player's own rollback has usually done it already. This makes sure,
   * through the ordinary workspace path, and leaves the player holding the
   * checkpoint's lesson and cursor with nothing scheduled. False when the
   * scene could not be put back.
   */
  const putBackCheckpoint=async(reason:string)=>{
    const player=lessonPlayer();
    try {
      // Nothing the failed command scheduled may draw over the checkpoint.
      player?.pause(reason,{preserveMolecularPlayback:true});
      const shown=putBackTarget();
      if(shows(shown)) { if(shown!==checkpoint) dirty=true; return true; }
      // Let an in-flight frame land and a hand leave the structure. A viewer
      // left in `error` cannot become ready, so it does not wait for that.
      await waitForPanelRender({ready:()=>!workspace.snapshot().interactionActive
          && (workspace.snapshot().ready || workspace.snapshot().status==='error'),
        current:()=>!closed && generation===ownGeneration && panelId===delivery.panelId});
      const target:any={};
      let keptWearerEdits=false;
      const lessonReplaced=delivery.change.kind==='lesson' && installedLesson!==lessonBefore;
      if(lessonReplaced)
        await workspace.viewer.inspection.setLessonRestingState?.(lessonRestingState(lessonBefore),{preserveEmphasis:true});
      await workspace.restoreShared(target,()=>{
        if(closed || generation!==ownGeneration || panelId!==delivery.panelId
          || sent.sourceToken!==binding.sourceToken || sent.serverEpoch!==binding.serverEpoch)
          throw Error('The session changed before the lesson could be put back.');
        // Admission runs inside the workspace queue, after earlier toolbar
        // edits have landed. Merge their values immediately before restore.
        const merged=putBackTarget();
        keptWearerEdits=merged!==checkpoint;
        Object.assign(target,merged);
      },true,true,async(scene:any)=>{
        if(lessonReplaced) {
          await tourPlayer?.replaceTours(lessonBefore?[lessonBefore,...TOURS]:TOURS,{preservePlayback:true});
          installedLesson=lessonBefore;
        }
        await player?.restorePlayback(scene);
      });
      const restored=shows(target);
      // The wearer's kept edits are theirs to save once the command lets go.
      if(restored && keptWearerEdits) dirty=true;
      recordHeadsetEvent('command-rollback',{commandId:delivery.commandId,outcome:restored?'restored':'mismatch',
        ...(keptWearerEdits?{keptWearerEdits:true}:{})});
      return restored;
    } catch(error) {
      recordHeadsetEvent('command-rollback',{commandId:delivery.commandId,outcome:'failed',message:thrownErrorMessage(error).slice(0,200)});
      return false;
    }
  };
  // A headset that cannot put the checkpoint back reloads the host's saved
  // scene. A desktop blocks behind Load saved view, as a failed rollback does.
  const putBackOrReload=async(reason:string)=>{
    if(await putBackCheckpoint(reason)) return true;
    if(isCompanion) { reloadPending=true; reloadSavedScene('lesson-rollback'); }
    else {
      recoveryFailed=true; dirty=true; blocked=true;
      showOutcome({status:'failed',reason:'recovery_failed',detail:'The lesson could not be put back. Load the saved view before trying again.'});
    }
    return false;
  };
  /**
   * `rendered` means the chapter on screen is whole. A chapter that moves has
   * its animation installed and, when it plays, a clock that has advanced on
   * drawn frames. A paused chapter needs only the installed animation. Quest
   * Browser stops window requestAnimationFrame for an immersive session, so
   * this samples on a timer and counts the frames the viewer drew.
   */
  const chapterClockRuns=async(chapter:TourStep|undefined)=>{
    if(!chapter?.animation) return;
    const waitMs=3000, capMs=10000, frames=3;
    const began=Date.now(), drawsBefore=workspace.snapshot().drawCount;
    let firstTime:number|undefined;
    for(;;) {
      const live=workspace.snapshot(), sample=live.animation, own=sample?.chapterId===chapter.id;
      if(own && sample.state!=='playing') return;
      if(own && firstTime===undefined) firstTime=sample.timeSeconds;
      else if(own && sample.timeSeconds!==firstTime) return;
      // A slow headset gets until the cap to draw three frames.
      const elapsed=Date.now()-began, draws=live.drawCount;
      const drawn=typeof drawsBefore==='number' && typeof draws==='number' ? draws-drawsBefore : undefined;
      if(elapsed>=waitMs && (drawn===undefined || drawn>=frames || elapsed>=capMs)) {
        recordHeadsetEvent('animation-clock-stalled',{chapterId:chapter.id,waitedMs:elapsed,drawnFrames:drawn??null,
          visibility:typeof document==='undefined'?'unknown':document.visibilityState,
          presenting:live.xrPresenting===true,status:live.status,animation:sample??null,
          activity:live.animationActivity??null});
        throw Object.assign(Error(own ? `The "${chapter.title}" animation was drawn but its clock did not advance.`
          : `The "${chapter.title}" animation was not drawn.`),{code:'render_failed'});
      }
      await new Promise<void>(resolve=>setTimeout(resolve,16));
    }
  };
  // The lesson chapter the lesson player now shows, for the clock check.
  const lessonChapterShown=()=>{
    if(!panelTour || panelTour.matchesLoadedSource) return undefined;
    const state=panelTour.getState();
    if(!state.active || state.step<0) return undefined;
    return [installedLesson,...TOURS].find(entry=>entry?.id===state.selectedId)?.steps[state.step];
  };
  try {
    if(delivery.change.kind==='lesson') {
      releaseHostLoad=await workspace.viewer.prepareHostLoad?.();
    }
    await settleRender();
    // A ready heartbeat can be overtaken by a wake/entry save. Release only
    // this unadmitted claim; the host compares the saved inputs before it
    // delivers the same command again, inside its original delivery deadline.
    if(((dirty && !blocked && delivery.deferLocalSave) || placementWork()) && await deferForLocalSave()) {
      scheduleSave();await save();return;
    }
    if(delivery.change.kind==='tour' && (delivery.change.patch.action!=='start' || panelTour?.getState().active || panelTour?.getState().navigating)) {
      const captured=()=>{ try { return workspace.capture(); } catch { return undefined; } };
      const before=captured();
      // Player subscribers save a settled motion cursor. This synchronous
      // pause belongs to the command, so it must not mark the page dirty or
      // start a competing save before admission. Later local edits still do.
      const wasRemote=remote;
      remote=true;
      try { panelTour?.pause('A remote inspection command paused your tour.',{preserveMolecularPlayback:true}); }
      finally { remote=wasRemote; }
      const after=captured();
      if(before!==undefined && after!==undefined && JSON.stringify(after)!==JSON.stringify(before))
        ownPause={before,after:JSON.stringify(after)};
    }
    // Once the host has admitted a tour command, a nudge that only moved the
    // structure while the answer travelled is the wearer's placement: the
    // chapter draws on it, as it does on a hand that arrives mid-draw. A
    // lesson install is still held to its admitted placement by the host.
    const localAdmission=()=>{
      if(closed || generation!==ownGeneration || panelId!==delivery.panelId || dirty || blocked || loading
        || sent.serverEpoch!==binding.serverEpoch || sent.sourceToken!==binding.sourceToken
        || sent.baseStateRevision!==binding.stateRevision || sent.baseInspectionRevision!==binding.inspectionRevision
        || (entryScene && localInteractionSerial!==entryInteraction)
        || !(JSON.stringify(admissionCapture())===JSON.stringify(savedScene)
          || (entryScene && sameEntryScene(entryScene,admissionCapture()))
          || (hostAdmitted && delivery.change.kind==='tour' && sameEntryScene(savedScene,admissionCapture()) && !(lastLocalEditAt>=receivedAt))))
        throw Object.assign(Error('The local view changed before the command arrived.'),{code:'local_changed'});
      if(workspace.snapshot().interactionActive) throw Object.assign(Error('Release the molecular drag before applying a command.'),{code:'interaction_active'});
    };
    let hostAdmitted=false;
    const admit=async()=>{
      await settleRender();
      // A grip released while this waited leaves the wearer's placement
      // unsaved. Before the host admits the claim it can still be handed back.
      if(placementWork() && await deferForLocalSave())
        throw Object.assign(Error('The panel is saving the wearer’s placement before this command.'),{code:'local_save_deferred'});
      localAdmission();
      remote=true;
      const response=await call('complete_inspection',{...base,phase:'admit',
        ...(delivery.historyAction?{historyScene:workspace.capture()}:{})}),state=response.structuredContent as any;
      if(!state?.admitted) throw Object.assign(Error(state?.reason??'The command is no longer eligible to render.'),
        {code:['cancelled','superseded'].includes(state?.command?.status)?'superseded':'local_changed'});
      // Local state can move while host admission is in flight.
      await settleRender();
      hostAdmitted=true;
      localAdmission();
      // Placement work was saved before admission, so this is the saved
      // scene. During entry it also carries the entry seat, which stays.
      if(lessonCommand) {
        checkpoint=workspace.capture(); checkpointAt=performance.now();
        checkpointDraws=lessonPlayer()?.drawnScene?.()?.serial ?? 0;
      }
    };
    if(delivery.change.kind==='save-view') {
      if(typeof workspace.captureNamedView!=='function') throw Error('This panel cannot capture a shared named view.');
      await workspace.captureNamedView(admit,async(scene:any,applied:any)=>{drew=true;
        await confirmReceipt({...base,scene,...(applied?.namedViewIntent?{namedViewIntent:applied.namedViewIntent}:{})},['named-view','save'],false);});
    } else if(delivery.change.kind==='restore-view') {
      if(typeof workspace.restoreNamedView!=='function') throw Error('This panel cannot restore a shared named view.');
      await workspace.restoreNamedView(delivery.change.patch.scene,admit,async(scene:any)=>{drew=true;
        await confirmReceipt({...base,scene},['named-view','restore']);},delivery.change.patch.namedViewIntent);
    } else if(delivery.change.kind==='lesson') {
      await admit();
      if(!tourPlayer) throw Error('This panel has no lesson player.');
      lessonBefore=installedLesson;
      const lessonInteraction=localInteractionSerial, lessonStartedAt=performance.now();
      const tour=molecularLessonToTour(delivery.change.patch.lesson);
      // The player owns rollback until its final draw. A chapter that never
      // ticks, or a receipt the host refuses, puts the checkpoint back below.
      // A receipt whose answer was lost keeps the drawn lesson: retrying the
      // immutable receipt must reconcile this picture with the host's manifest.
      await tourPlayer.installLesson(tour,delivery.change.patch.start,async()=>{
        // Quest Browser stops servicing window requestAnimationFrame for the
        // whole immersive session, so a headset page counts drawn XR frames.
        const drawsBefore=workspace.snapshot().drawCount;
        if(workspace.snapshot().xrPresenting && typeof drawsBefore==='number') {
          const until=Date.now()+3000; // two frames, or one within 3 s
          while((workspace.snapshot().drawCount??drawsBefore)<drawsBefore+2) {
            if(Date.now()>=until) {
              if((workspace.snapshot().drawCount??drawsBefore)>drawsBefore) break;
              throw Object.assign(Error('The lesson change did not produce a headset frame.'),{code:'render_timeout'});
            }
            await new Promise<void>(resolve=>setTimeout(resolve,16));
          }
        } else await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
        const shown=tourPlayer!.getState();
        if(shown.selectedId===tour.id && shown.active && shown.step>=0) await chapterClockRuns(tour.steps[shown.step]);
        // As for a tour command: a hand on the structure waits for its
        // release and the receipt carries the placement the wearer chose,
        // while a real local edit during the draw refuses the lesson.
        settleDeadline=Date.now()+Math.min(delivery.settleBudgetMs??15000,15000);
        const scene=await settleRender(()=>localInteractionSerial===lessonInteraction || !(lastLocalEditAt>=lessonStartedAt),()=>workspace.capture());
        drew=true;
        installedLesson=tour;
        await confirmReceipt({...base,scene,...(localInteractionSerial!==lessonInteraction?{wearerPlacement:true}:{}),
          tourState:tourHeartbeat(panelTour),animation:workspace.snapshot().animation??null},['lesson']);
      },delivery.change.patch.frame);
    } else if(delivery.change.kind==='tour') {
      await admit();
      // `speakScene` runs inside the scene it opens and stamps a new narration
      // generation before this resolves, so a changed stamp means this command
      // has a chapter line of its own on the way.
      const narrationBefore=narrationGeneration;
      recordHeadsetEvent('command-phase',{commandId:delivery.commandId,phase:'receive-to-tour-dispatch',elapsedMs:performance.now()-receivedAt,queueWaitMs:delivery.queueWaitMs});
      tourCommandContext={...base};delete tourCommandContext.sessionId;
      tourCommandReceipt=undefined;
      const tourInteraction=localInteractionSerial, tourStartedAt=performance.now();
      const appliedTour=await applyTourCommand(panelTour,delivery.change.patch,{atomCount:workspace.snapshot().atomCount});
      if(!tourCommandReceipt) await chapterClockRuns(lessonChapterShown());
      // Showing the chapter redraws its menu. Automatic clearance can still
      // own the viewer when the player resolves; capture only its drawn state.
      // A real local edit during this wait must never become this receipt: a
      // menu row or a face button is one. A hand on the structure is not; the
      // capture waits for its release and the receipt carries the placement
      // the wearer chose, which the host does not hold a tour to.
      if(!tourCommandReceipt) {
        settleDeadline=Date.now()+Math.min(delivery.settleBudgetMs??15000,15000);
      }
      const scene=tourCommandReceipt ? workspace.capture()
        : await settleRender(()=>localInteractionSerial===tourInteraction || !(lastLocalEditAt>=tourStartedAt),()=>workspace.capture());
      // A journey replaces its source/panel while preserving the original
      // command claim. Never send the ordinary pre-transition scene receipt
      // through the companion's current-source capability check.
      if(!tourCommandReceipt && (base.sourceToken!==binding.sourceToken || base.panelId!==panelId)) {
        const recovered=await confirmReceipt({...base,failure:'render_failed',
          failureReason:'The journey did not return its rendered acknowledgement.'},[]);
        if(recovered?.status!=='rendered') throw Error('The journey did not return its rendered acknowledgement.');
        tourCommandReceipt=recovered;
      }
      drew=true;
      try {
        if(tourCommandReceipt) {
          if(tourCommandReceipt.status!=='rendered')throw Error('The journey command has not been confirmed.');
          // A bare completion receipt has no fields; the generic fallback
          // calls it scene and overwrites the player's confirmed Done caption.
          showOutcome({...tourCommandReceipt,fields:['tour']});recordLoopStage('receipt-rendered',tourCommandReceipt);
        } else await confirmReceipt({...base,scene,tourState:tourHeartbeat(panelTour),animation:workspace.snapshot().animation??null},['tour']);
      }
      catch(error) {
        // A lesson's checkpoint is put back below; a journey's view here.
        if((error as any).code==='superseded' && !ownsCheckpoint()) {
          panelTour?.pause('The earlier tour request was cancelled.');
          await workspace.restoreShared(savedScene,()=>{},true,true);
        }
        throw error;
      }
      speakRemoteConfirmation(delivery.change,appliedTour,narrationGeneration!==narrationBefore,delivery);
    } else await workspace.applyRemote(delivery.change,admit,async function confirm(scene:any,applied:any):Promise<any> {drew=true;
      // The one thing the rendered scene cannot carry. A
      // raised framebuffer scale lands on the wearer's next immersive entry, so
      // it rides the receipt and reaches the agent through `latestOutcome`.
      // Without it the agent reports a change the wearer has not been shown.
      const pendingScale=activeDelivery.change.kind==='render-quality' && applied?.scaleAppliesOnNextEntry===true;
      // The status line names what changed; a turntable is "motion", not "state".
      try {
        await confirmReceipt({...base,scene,allowReplacement:true,...(pendingScale?{scaleAppliesOnNextEntry:true}:{}),
          ...(applied?.animation?{animation:applied.animation}:{}),
          ...(applied?.recenterCompletion?{recenterCompletion:applied.recenterCompletion}:{}),
          ...(applied?.placementAdjusted?{placementAdjusted:true,placementFit:applied.placementFit}:{}),
          ...(applied?.geometryBudget?{geometryBudget:applied.geometryBudget}:{})},
          activeDelivery.change.kind==='animation'?['animation']
          :activeDelivery.change.kind==='motion'?['motion']
          :activeDelivery.change.kind==='compound'?activeDelivery.change.patch.ops.map((op:any)=>op.kind)
          :Object.keys(activeDelivery.change.patch));
      } catch(error) {
        // A lost response can already have claimed the correction. Retry the
        // same receipt while the workspace still owns its rollback checkpoint.
        if(isCompanion && pendingReceipt) {
          try {
            const recovered=await recoverConfirmation(error,'',ownGeneration,true);
            if(recovered?.status==='rendered') {
              speakRemoteConfirmation(activeDelivery.change,applied,false,activeDelivery);return;
            }
          } catch(retryError) { error=retryError; }
        }
        const replacement=(error as any).replacement;
        if(!replacement || replacement.panelId!==delivery.panelId) throw error;
        activeDelivery=replacement;
        Object.assign(base,{commandId:replacement.commandId,claimToken:replacement.claimToken});
        drew=false;
        return {change:replacement.change,historyOptions:replacement.historyAction?{preservePlacement:true}:{},confirm,admit:async()=>{
          const unchanged=()=>{
            if(closed || generation!==ownGeneration || panelId!==replacement.panelId || dirty || blocked || loading
              || sent.serverEpoch!==binding.serverEpoch || sent.sourceToken!==binding.sourceToken
              || sent.baseStateRevision!==binding.stateRevision || sent.baseInspectionRevision!==binding.inspectionRevision
              || workspace.snapshot().interactionActive || JSON.stringify(workspace.capture())!==JSON.stringify(scene))
              throw Object.assign(Error('The local view changed before the correction arrived.'),{code:'local_changed',rollbackRequired:true});
          };
          unchanged();
          const response=await call('complete_inspection',{...base,phase:'admit'}),state=response.structuredContent as any;
          if(!state?.admitted) throw Object.assign(Error(state?.reason??'The correction is no longer eligible to render.'),
            {code:['cancelled','superseded'].includes(state?.command?.status)?'superseded':'local_changed',rollbackRequired:true});
          unchanged();
        }};
      }
      speakRemoteConfirmation(activeDelivery.change,applied,false,activeDelivery);},()=>{
        // The workspace reports only after its rollback frame and undo rebuild
        // finish. Keep that proof even if a later UI refresh throws.
        settledSuperseded=true;
      },delivery.historyAction?{preservePlacement:true}:{});
  } catch(error) {
    // A lesson command that failed after admission puts its checkpoint back
    // before anything replies. A receipt that was sent and then lost is the
    // exception: the host may have kept it, so the page retries it below.
    let putBack:boolean|undefined;
    if(ownsCheckpoint() && !(drew && pendingReceipt))
      putBack=await putBackOrReload((error as any).code==='superseded'
        ? 'The earlier tour request was cancelled.' : 'The lesson could not be drawn, so your view was put back.');
    if((error as any).code==='rollback_failed') {
      // A failed undo rebuild does not own later commands. Restore the saved
      // revision once through the ordinary workspace path, then release the
      // claim only after that frame. Persistent failure keeps local work dirty
      // and reports the reason instead of leaving a ready panel behind a fence.
      try {
        const recoveryScene=JSON.stringify(workspace.capture());
        await workspace.restoreShared(savedScene,()=>{
          if(closed || generation!==ownGeneration || panelId!==delivery.panelId
            || sent.sourceToken!==binding.sourceToken || sent.serverEpoch!==binding.serverEpoch
            || sent.baseStateRevision!==binding.stateRevision || sent.baseInspectionRevision!==binding.inspectionRevision
            || workspace.snapshot().interactionActive || JSON.stringify(workspace.capture())!==recoveryScene)
            throw Error('The saved view changed before cancellation recovery.');
        },true,true);
        settledSuperseded=true;
      } catch(recovery) {
        recoveryFailed=true;settledSuperseded=true;dirty=true;blocked=true;
        showOutcome({status:'failed',reason:'recovery_failed',detail:'The previous change could not be restored. Load the saved view before trying again.'});
      }
      // An inline replacement may own a new, still-rendering claim.
      if(activeDelivery!==delivery) await confirmReceipt({...base,...inspectionFailureReceipt(error)},[]);
    } else if((error as any).code==='superseded') {
      settledSuperseded=true;
      outcome.textContent='The earlier request was dropped.';
    } else if((error as any).code==='local_save_deferred') {
      // Not a refusal: the host holds the command again and delivers it once
      // the save timer has committed the wearer's placement.
      scheduleSave();
    } else if(!drew) {
      // Preserve geometry admission as a typed refusal and carry its complete
      // actionable sentence; display paging is separate from this receipt.
      const refusal=inspectionFailureReceipt(error);
      // A transient named-view capture refusal (stale
      // head tracking or a held grip) rides as `capture_refused` with its
      // actionable sentence, so the receipt reads as a refusal to retry
      // rather than a rendering fault.
      try {
        const rejected=await confirmReceipt({...base,...refusal},[]);
        settledSuperseded=settledSuperseded || ['cancelled','superseded'].includes(rejected?.status);
      }
      catch(error) { await recoverConfirmation(error,' Retry confirmation to release the failed command; the command will not be rendered again.',ownGeneration); }
    } else if(putBack!==undefined) {
      // The host answered and refused the drawn lesson. Its checkpoint is back,
      // so only an entry seat or a following local edit is left to save.
      if(putBack) { try { dirty=JSON.stringify(workspace.capture())!==JSON.stringify(savedScene); } catch { dirty=true; } }
      showOutcome({status:'failed',fields:[delivery.change.kind],detail:thrownErrorMessage(error).slice(0,200)});
    } else {
      dirty=true;
      const recovered=(error as any).receiptRecoveryTried ? undefined
        : await recoverConfirmation(error,pendingReceipt?' The visible change has not been confirmed. Retry confirmation.':'',ownGeneration);
      // A headset that gave up on a lost receipt keeps no lesson the host may
      // never have saved. If the host did save it, the next beat follows it.
      if(!recovered && isCompanion && !pendingReceipt && !blocked && ownsCheckpoint()
        && await putBackOrReload('The lesson was not confirmed, so your view was put back.')) {
        try { dirty=JSON.stringify(workspace.capture())!==JSON.stringify(savedScene); } catch { dirty=true; }
      }
    }
  } finally {
    if(settledSuperseded) {
      if(!recoveryFailed && !reloadPending && !closed && generation===ownGeneration && panelId===delivery.panelId) {
        // Rollback normally restores the already saved scene. If a local edit
        // followed it in the queue, save that actual picture before readiness.
        dirty=true;
        try { dirty=JSON.stringify(workspace.capture())!==JSON.stringify(savedScene); }
        catch { /* save() reports capture failures through its recovery path. */ }
        blocked=false;notice.hidden=true;
      }
      try { await confirmReceipt({...base,phase:'settled',...(recoveryFailed?{recoveryFailed:true}:{})},[]); }
      catch(error) { await recoverConfirmation(error,' Cancellation settled locally; reconnect before continuing.',ownGeneration); }
    }
    tourCommandContext=undefined;tourCommandReceipt=undefined;
    remote=false;
    if(recoveryFailed) {dirty=true;blocked=true;}
    // A reload owns the renderer next; the half-drawn scene is never saved.
    if(settledSuperseded && !reloadPending && !closed && generation===ownGeneration && dirty && !blocked) {
      scheduleSave();await save();
    }
    // Report any local work that followed completion. The desktop success
    // path already published readiness before its receipt; recovery and the
    // companion still need their actual post-command availability here.
    if(drew && !pendingReceipt && !closed && generation===ownGeneration && panelId===delivery.panelId)
      await busyBeat(ownGeneration);
  }
  } finally { releaseHostLoad?.(); }
}
/**
 * The beat that keeps running while a command renders.
 *
 * A command in flight sets `remote`, and the full poll below deliberately does
 * nothing while it is set: a hydrate or an attach must not land inside a scene
 * that is still being built. Before this, "does nothing" also meant "sends
 * nothing", so a Quest 2 whose chapter-2 scene never finished
 * went completely silent — the Mac's panel snapshot went stale in twelve
 * seconds, the host then listed no companion panel at all, and the page's
 * diagnostics piled up unsent, which is why that hang left no log to read.
 *
 * This is the same beat with its answer ignored. It reports the panel as
 * `busy`, which is exactly true, and it carries the diagnostics queue and its
 * acknowledgement, so the headset log keeps arriving through a stuck scene.
 *
 * The same beat now also runs behind a slow poll.
 *
 * On the second wearer run every first command after an utterance expired at
 * fifteen seconds and its immediate retry rendered in seven, and the Mac saw
 * `spatialContext.ageMs` climb from ten seconds to forty-three while the page
 * held seventy frames a second. One in-flight guard covered the whole of
 * `poll`, so the slow half of a beat — a save, a re-attach, a hydration, or
 * simply a `poll_inspection` running out its own fetch deadline — suppressed
 * every tick behind it, and the command sitting in the queue was never offered
 * to the page at all. The guard is now two guards and this is the fast one.
 *
 * It handles only the parts of the answer that do not touch the renderer: the
 * link, the diagnostics acknowledgement, the agent's presence, a spoken reply,
 * a caption, and the delivery of a command when the panel really is ready for
 * one. A hydration, a re-attach, a source transition and a shared-scene follow
 * stay in `poll`, which owns the renderer and is allowed to take its time.
 */
function beatSuspended() {
  return closed || !binding || !panelId || !workspace
    // A hidden desktop tab has nothing to keep current; a headset page and a
    // host that can wake a task both do. Same rule the full poll applies.
    || (!isCompanion && document.visibilityState==='hidden' && !workspace?.snapshot().xrPresenting
      && !app.getHostCapabilities()?.message?.text);
}
/**
 * A hidden Mac tab leaves a headset share's panel list at once.
 *
 * A browser stops calling requestAnimationFrame in a hidden tab, and a command
 * renders only when Mol* draws a frame, so this page can render nothing until
 * it is shown again. The host still listed the silent panel as ready for its
 * ten-second heartbeat grace. In Claude Code and the Codex CLI, Meta's Web
 * Launch page opens in front of this tab, and an edit sent in the next ten
 * seconds, before the headset page had attached, was queued for this tab and
 * expired fifteen seconds later. A build that kept polling while hidden was
 * worse: the tab claimed the edit, could not draw it, and held the queue.
 *
 * So a hidden panel asks to detach, and the host agrees only when the session
 * is shared with a headset. An edit then goes to the headset page, or is
 * refused at once with a sentence that names the missing headset page. A
 * Mac-only session keeps its panel for the grace, as before. The page keeps
 * its panel ID, so showing the tab again takes the same path as a panel whose
 * grace ran out: the host answers `attached:false`, and `poll` re-attaches or
 * hydrates. Only an idle panel asks, and only within the grace, because after
 * it the host has dropped the panel anyway.
 */
async function stepAsideWhileHidden() {
  const now=Date.now(), owner=panelId;
  hiddenSince??=now;
  if(!owner || !binding || steppedAside===owner || now-hiddenSince>HIDDEN_STEP_ASIDE_MS
    || remote || loading || experiencePreparing || dirty || blocked) return;
  try {
    const response=await call('detach_inspection',{...expected(),panelId:owner,reason:'hidden'});
    if((response.structuredContent as any)?.detached===true) steppedAside=owner;
  } catch { /* The host's heartbeat grace drops the panel instead. */ }
}
async function busyBeat(ownGeneration:number, forceBusy=false) {
  if(beatSuspended() || beatInFlight || pollBackoff.remaining()>0 || (!isCompanion && desktopReceiptInFlight && !desktopReceiptBeat)) return;
  beatInFlight=true;
  let finishBeat!:()=>void;
  beatCompletion=new Promise<void>(resolve=>{finishBeat=resolve;});
  // A renderer that is mid-command or mid-hydration is exactly `busy`, and a
  // busy panel is never handed a delivery, so this beat cannot claim a command
  // into a scene that is still being built.
  const busy=forceBusy || remote || loading || !workspace.snapshot().ready;
  const receiptBeat=!isCompanion?desktopReceiptBeat:undefined;
  const recovery=failedSourceLoad && failedSourceLoad.sessionId===binding.sessionId && retryHydrationId===binding.sessionId
    && !forceBusy && !remote && !loading;
  const availability=recovery?'ready' as const:receiptBeat?'ready' as const:busy?'busy' as const:liveAvailability();
  // A journey's `tourState` is inactive for its whole
  // run, so `experience` is the only thing on the beat that says an authored
  // lesson is playing and which chapter it just drew. The host needs it to
  // tell the lesson's own saved revisions from a hand on the scene, which is
  // what lets a wearer's stop still be about the scene they were looking at
  // when they spoke.
  let sent={...expected(),panelId,availability,
    ...(recovery?{sourceFailureToken:failedSourceLoad!.sourceToken}:{}),
    animation:workspace.snapshot().animation??null,tourState:tourHeartbeat(panelTour),...(experienceView?{experience:{experienceId:experienceView.definition.id,stepIndex:experienceView.stepIndex}}:{}),
    ...(isCompanion?{spatialContext:workspace.viewer.xr?.spatialContext?.()??null,xrStartup:xrStartupReport()}:{})};
  const diagnostics=isCompanion?((globalThis as any).__stereofoldDiagnostics?.heartbeat?.()??{}):{};
  try {
    if(receiptBeat) {
      // Completion may have committed while its response is still in transit.
      // Only that exact receipt can advance this ready heartbeat's revision;
      // never infer readiness from an unrelated saved revision or local flags.
      const state=(await call('get_inspection_state',{sessionId:receiptBeat.sent.sessionId,
        commandId:receiptBeat.commandId})).structuredContent as any;
      if(closed || generation!==ownGeneration || panelId!==receiptBeat.sent.panelId) return;
      if(state?.command?.status==='rendered' && state.command.commandId===receiptBeat.commandId
        && state.command.panelId===receiptBeat.sent.panelId
        && state.command.renderedRevision===state.inspectionRevision
        && state.serverEpoch===receiptBeat.sent.serverEpoch && state.sourceToken===receiptBeat.sent.sourceToken
        && state.stateRevision===receiptBeat.sent.baseStateRevision)
        receiptBeat.sent={...receiptBeat.sent,baseInspectionRevision:state.inspectionRevision};
      sent={...receiptBeat.sent};
    }
    const response=await call('poll_inspection',{...sent,...diagnostics});
    pollBackoff.succeeded();
    if(closed || generation!==ownGeneration) return;
    clearConnectionProblem();
    const privateState=response._meta?.[PRIVATE_KEY] as any;
    // A busy heartbeat can be the first successful delivery after a lost poll.
    // The capture module deduplicates IDs without restarting its GPU work.
    const captureState=response.structuredContent as any;
    if(isCompanion&&privateState?.headsetViewRequest&&captureState?.sourceToken===binding?.sourceToken
      &&captureState?.serverEpoch===binding?.serverEpoch)requestHeadsetViewCapture(privateState.headsetViewRequest);
    noteRendererHeartbeat(true,privateState?.closeRendererTab===true);
    if(privateState?.diagnosticsAck!==undefined)(globalThis as any).__stereofoldDiagnostics?.acknowledge?.(privateState.diagnosticsAck);
    assistantStatus.notePresence(privateState);
    // The agent's own sentence and a command can ride the same beat; the
    // sentence is what the wearer should hear. See speakRemoteConfirmation.
    replyOnThisBeat=Boolean(privateState?.headsetCaption);
    receiveSpokenReply(privateState?.voicePlayback);
    if(privateState?.headsetCaption)recordTalkReplyDelivery(privateState.headsetCaption,{seatOutcome:isCompanion?'pending':'unavailable'});
    if(isCompanion&&privateState?.headsetCaption)globalThis.dispatchEvent(new CustomEvent('stereofold-headset-reply',{detail:privateState.headsetCaption}));
    if(isCompanion&&privateState?.growthCaption)
      globalThis.dispatchEvent(new CustomEvent('stereofold-growth-caption',{detail:privateState.growthCaption}));
    // Everything else in the answer — a source transition, a shared scene, a
    // saved-scene revision, a re-attachment — belongs to `poll`, which owns the
    // renderer. The short-lived queue re-offers anything skipped here.
    // A lesson may be admitted on a busy input beat: receive() retires that
    // gesture before drawing. Keep the host's claim on the same renderer queue
    // rather than dropping it merely because the wearer was still holding on.
    const delivery=availability==='ready' || privateState?.delivery?.change?.kind==='lesson'?privateState?.delivery:undefined;
    // Start the command, do not wait for it.
    if(delivery) rendering=rendering.then(()=>receivePollDelivery(response,sent,ownGeneration))
      .catch(error=>{if(!closed)showProblem(problemMessage('delivery',error),'delivery',error);});
  } catch(error) {
    if((error as any)?.code==='companion_session_changed') { rebindCompanionSession(sent.sessionId); return; }
    if((error as any)?.code==='companion_connection' || isRendererHeartbeatFailure(error)) { pollBackoff.failed(); armPoll(); }
    if(isRendererHeartbeatFailure(error)) noteRendererHeartbeat(false);
    if(!showConnectionProblem(error,ownGeneration) && !isRendererHeartbeatFailure(error))
      { if(!closed) showProblem(problemMessage('poll',error),'poll',error); return; }
    retireStaleHud(undefined);
  } finally { beatInFlight=false;beatCompletion=undefined;finishBeat();workspace?.syncSceneHistory?.(); }
}
function problemMessage(kind:ProblemRetryKind, _error?:unknown) {
  return kind==='save' ? 'Your changes are unsaved; choose Retry.' : 'Your view is preserved; choose Retry.';
}
/**
 * Arm the next tick before the work, never after it.
 *
 * The timer used to be re-armed in `poll`'s `finally`, so the beat's period was
 * one second plus however long that beat took. A forty second hydration was
 * therefore forty-one seconds of silence even on the flat page. Arming here
 * keeps the polling period independent of that work; the two in-flight guards
 * stop ticks from piling up. Visible or immersive companions check four times
 * a second so laptop commands do not sit behind a one-second heartbeat. Hidden
 * flat pages and embedded host panels retain the one-second background beat.
 */
const pollBackoff=createPollBackoff();
function armPoll() {
  if(pollTimer!==undefined)clearTimeout(pollTimer);
  const interval=isCompanion && (document.visibilityState==='visible'||workspace?.snapshot().xrPresenting)?250:1000;
  pollTimer=closed?undefined:setTimeout(()=>{void poll();},Math.max(interval,pollBackoff.remaining()));
}
async function poll() {
  if(closed)return;
  armPoll();
  if(pollBackoff.remaining()>0)return;
  // The slow half owns the page. Keep the link, the log and the claim alive.
  if(pollInFlight) { await busyBeat(generation); return; }
  pollInFlight=true;
  let failureKind:'save'|'poll'|'reconnect'='poll';
  const beatSession=binding?.sessionId;
  try {
    if(isCompanion && repairNeeded && Date.now()>=nextRepairAt) {
      nextRepairAt=Date.now()+15_000;
      try {
        if(await recoverCompanionConnection())repairNeeded=false;
        else setConnectionStatus(PAIR_AGAIN,true);
      } catch { /* Keep the rendered view and retry redemption on a later beat. */ }
    }
    if(pendingReceipt?.phase==='settled') { await confirmReceipt(pendingReceipt,[]);return; }
    if(closed || !binding) return;
    if(!isCompanion && document.visibilityState==='hidden'&&!workspace?.snapshot().xrPresenting&&!app.getHostCapabilities()?.message?.text) {
      await stepAsideWhileHidden(); return;
    }
    // A command or a hydration owns the renderer; the heartbeat still has to
    // reach the Mac. `loading` used to return here without sending anything,
    // which is how a re-hydrating headset disappeared from the Mac's panel list.
    if(remote || loading) { await busyBeat(generation,true); return; }
    if(experiencePreparing) { await busyBeat(generation); return; }
    const pollGeneration=generation;
    const snapshot=workspace.snapshot();
    // The beat below still reports this panel busy while it redraws or reloads.
    if(snapshot.status==='error') await recoverViewerError();
    // A transport failure must not strand an otherwise valid source refusal.
    // Retry the exact source/owner-bound acknowledgement before offering its lease.
    const pendingSourceFailure=failedSourceLoad;
    if(pendingSourceFailure?.receipt && pendingSourceFailure.sessionId===binding.sessionId) {
      try {
        await call('report_source_failure',pendingSourceFailure.receipt);
        if(failedSourceLoad===pendingSourceFailure) pendingSourceFailure.receipt=undefined;
      } catch(error) {
        // Still poll: a host restart or a newer authorized source can invalidate
        // this receipt, and must remain discoverable instead of wedging recovery.
        recordHeadsetEvent('page-error',{operation:'source-receipt',message:thrownErrorMessage(error)});
      }
      if(closed || generation!==pollGeneration || failedSourceLoad!==pendingSourceFailure)return;
    }
    syncHandoff();
    // A chapter the lesson player is still drawing is saved once it is whole.
    if(!failedSourceLoad && !dirty && !blocked && snapshot.ready && workspace.serializeCapture()!==JSON.stringify(savedScene)
      && !tourPlayer?.getState().navigating) scheduleSave();
    // A completed local edit is saved before the panel advertises readiness.
    if(dirty && !blocked && !snapshot.interactionActive) { failureKind='save';await save(undefined,true); }
    failureKind='poll';
    if(closed || loading || remote || experiencePreparing || generation!==pollGeneration) return;
    // A headset page attaches while dirty.
    //
    // Registering needs current revisions, not a quiet scene: `dirty` is local
    // work the panel has yet to push, and the revisions it sends are still the
    // ones the server holds. Waiting for it to clear is safe on a desktop,
    // where the person can see the panel; in a headset it meant that a wearer
    // who re-entered XR with an unsaved seat adjustment had no panel in the
    // registry at all, and the agent answered `control_tour play` with "Open
    // the printed address in a browser". An attached panel that is dirty
    // advertises `unsaved` and is refused with a sentence about this session;
    // an absent one cannot be talked about at all.
    if(!panelId) { if((isCompanion || !dirty) && !blocked && snapshot.ready) { failureKind='reconnect';await attach(); } return; }
    const ownGeneration=generation, sent={...expected(),panelId,
      // This ready renderer can take another source even if the wearer grabs
      // the rolled-back molecule or hides the page. Its old token still fences
      // ordinary edits against coordinates that have not drawn.
      availability:failedSourceLoad?'ready' as const:liveAvailability(),
      ...(failedSourceLoad && failedSourceLoad.sessionId===binding.sessionId && retryHydrationId===binding.sessionId
        && !remote && !loading
        ? {sourceFailureToken:failedSourceLoad.sourceToken} : {}),
      animation:workspace.snapshot().animation??null,tourState:tourHeartbeat(panelTour),...(experienceView?{experience:{experienceId:experienceView.definition.id,stepIndex:experienceView.stepIndex}}:{}),
      ...(isCompanion?{spatialContext:workspace.viewer.xr?.spatialContext?.()??null,
        xrStartup:xrStartupReport()}:{})};
    let response;
    const diagnostics=isCompanion?((globalThis as any).__stereofoldDiagnostics?.heartbeat?.()??{}):{};
    try { response=await call('poll_inspection',{...sent,...diagnostics}); pollBackoff.succeeded(); }
    catch(error) {
      if(!showConnectionProblem(error,ownGeneration) && !isRendererHeartbeatFailure(error))throw error;
      if((error as any)?.code==='companion_connection' || isRendererHeartbeatFailure(error)) { pollBackoff.failed(); armPoll(); }
      if(isRendererHeartbeatFailure(error)) noteRendererHeartbeat(false);
      // A dropped connection used to return before the plate
      // was ever looked at, so the one case where nothing can arrive to
      // overdraw an orange `Waiting` was also the one case that never retired
      // it. The desktop reads `Reconnecting…` in the flat notice; a wearer
      // sees only this row, and after ten seconds out of contact there is
      // nothing still on its way to them.
      retireStaleHud(undefined);
      return;
    }
    // A poll sent before an explicit source transition must not start a second
    // hydration while that transition owns the renderer.
    if(closed || loading || remote || experiencePreparing || generation!==ownGeneration) return;
    clearConnectionProblem();
    noteRendererHeartbeat(true,(response._meta?.[PRIVATE_KEY] as any)?.closeRendererTab===true);
    const data=response.structuredContent as any;
    if(data?.superseded===true) { closed=true; activePreviewRecording?.abort(); if(pollTimer!==undefined)clearTimeout(pollTimer); workspace.setStatus('This page was replaced by another tab on this headset.'); return; }
    // Handle capture before any hydration or other slow/early-return path.
    // A changed source must first complete its own hydration and new request.
    const captureRequest=(response._meta?.[PRIVATE_KEY] as any)?.headsetViewRequest;
    if(isCompanion&&captureRequest&&data?.sourceToken===binding?.sourceToken
      &&data?.serverEpoch===binding?.serverEpoch)requestHeadsetViewCapture(captureRequest);
    showOutcome(data?.outcome);
    retireStaleHud(data?.outcome);
    const sourceChanged=data?.sourceToken!==binding.sourceToken || data?.serverEpoch!==binding.serverEpoch;
    const experienceChanged=Boolean(data?.experience
      ? !experienceView || data.experience.id!==experienceView.definition.id || data.experience.revision!==experienceView.revision || data.experience.stepIndex!==experienceView.stepIndex
      : experiencePlayer?.getState().active);
    const privateState=response._meta?.[PRIVATE_KEY] as any;
    await registerPollState(response,sent.sessionId);
    // The heartbeat is the only place the page ever learns
    // that an agent is on the Mac. Recorded before anything below can return
    // early, because a poll that hydrates or re-attaches still carried the
    // answer, and the headset's wording depends on it.
    assistantStatus.notePresence(privateState);
    // A host-initiated grow refusal rides this beat. The
    // page's own grow branch already arms the caption plate from the tool
    // return; this is the half that was missing when the Mac called
    // grow_structure itself. Dispatched before the hydrate early-return so a
    // busy poll cannot swallow the sentence the plate is owed.
    if(isCompanion&&privateState?.growthCaption)
      globalThis.dispatchEvent(new CustomEvent('stereofold-growth-caption',{detail:privateState.growthCaption}));
    // The agent's own sentence and a command can ride the same beat. When they
    // do, the sentence is what the wearer should hear; see speakRemoteConfirmation.
    replyOnThisBeat=Boolean(privateState?.headsetCaption);
    // A transition owner is the single panel named by the server-side lease.
    // It must hydrate before an experience can become applied. Every other
    // panel waits for that first saved/acknowledged scene, avoiding a race.
    const transitionReady=privateState?.transitionTarget===true
      || (data?.hasScene===true && data?.experienceCompletion?.status!=='pending' && (!experienceChanged || data?.experience?.applied===true));
    // Whether this headset page can draw a frame now. A hidden
    // page, or a presenting one whose headset shows something else, draws
    // none, so anything that restores or loads a scene on this beat would wait
    // out its frame deadline and leave the page blocked behind Retry, unable
    // to follow anything when it wakes. The source transition below, the
    // shared follow and the recovery after `attached:false` all wait for the
    // first beat on which this is false.
    const paused=isCompanion && ((document.visibilityState==='hidden' && !workspace.snapshot().xrPresenting)
      || workspace.viewer.xr?.blind?.()===true);
    // A SOURCE change is followed whether or not this panel is
    // holding unsaved work, because that work is captured against coordinates
    // the host no longer has and can never be saved. The decision and the
    // hardware defect it fixes are in `inspection-panel-recovery.ts`.
    if(transitionReady && !privateState?.delivery && !paused
      && !(failedSourceLoad && data.sourceToken===failedSourceLoad.sourceToken) && followsSourceTransition({sourceChanged,experienceChanged,dirty,blocked:blocked && !(failedSourceLoad && failedSourceLoad.sessionId===binding.sessionId && retryHydrationId===binding.sessionId
        && data.sourceToken!==failedSourceLoad.sourceToken && !dirty),
      interactionActive:workspace.snapshot().interactionActive})) { failureKind='reconnect';await hydrate(binding.sessionId,undefined,privateState?.journeySave); return; }
    voiceReadyBinding=sent.availability==='ready'&&!privateState?.delivery?voiceBindingKey(sent):'';
    receiveSpokenReply(privateState?.voicePlayback);
    if(privateState?.diagnosticsAck!==undefined)(globalThis as any).__stereofoldDiagnostics?.acknowledge?.(privateState.diagnosticsAck);
    // Log the caption where it is read off the heartbeat, not only where it is
    // drawn: a reply that reaches a surface with no talk orb is otherwise
    // indistinguishable from one the Mac never sent.
    if(privateState?.headsetCaption)recordTalkReplyDelivery(privateState.headsetCaption,{seatOutcome:isCompanion?'pending':'unavailable'});
    if(isCompanion&&privateState?.headsetCaption)globalThis.dispatchEvent(new CustomEvent('stereofold-headset-reply',{detail:privateState.headsetCaption}));
    void handoffSpokenRequest();
    // "of this exact source" is the promise the comment below
    // makes, and the digest is what keeps it. On a density session the other
    // panel draws other bytes — the Mac draws the coordinates, the headset
    // draws the map — so its saved scene arrives on every heartbeat and
    // `restoreShared` would throw `inspection_identity_mismatch` out of `poll`.
    // A panel follows the shared view only while the shared view is of the
    // thing it has on screen.
    //
    // And only while this headset page can draw (`paused` above).
    // An edit the Mac saved while the headset slept arrives on every beat the
    // page still sends; the first beat after the page wakes follows it.
    // The host can offer the last saved scene to a returning desktop after
    // Stop closes headset sharing. Its private snapshot remains authoritative;
    // the same local-edit and source guards apply while the listener is closed.
    const followable=(data?.shared || !isCompanion) && privateState?.scene && !dirty && !blocked && !remote && !workspace.snapshot().interactionActive
      && !paused && privateState.scene.sourceSha256===workspace.snapshot().sourceSha256;
    // A scene minted before a server-epoch rotation carries a catalog this
    // panel no longer holds, so an epoch change reloads instead of merging.
    if(followable && sourceChanged) { failureKind='reconnect';await hydrate(binding.sessionId); return; }
    // Follow only a saved scene of this exact source and only when no local
    // input has intervened. Head tracking remains local to Mol* XR, so a
    // presenting workspace keeps its own camera instead of the shared one.
    // Revision ordering applies within this epoch/source only. A save or
    // command receipt can settle while this poll is in transport; its older
    // snapshot must never move the visible scene or binding back.
    if(followable && Number.isSafeInteger(data.inspectionRevision) && data.inspectionRevision>binding.inspectionRevision) {
      const nextLesson='customTour' in privateState?privateState.customTour??undefined:installedLesson;
      const lessonChanged=JSON.stringify(nextLesson)!==JSON.stringify(installedLesson);
      const validatePlayback=()=>lessonChanged ? savedLessonPlayback(privateState.scene,nextLesson?[nextLesson,...TOURS]:TOURS)
        : tourPlayer?.validatePlayback(privateState.scene);
      validatePlayback();
      // A bookkeeping pause must not change capture() before admission or
      // overwrite the molecular playback this peer is about to restore.
      tourPlayer?.pause('A shared inspection update paused your tour.',{preserveMolecularPlayback:true});
      const ownEdits=edits, ownRevision=binding.inspectionRevision;
      remote=true;
      try {
        const restored=await workspace.restoreShared(privateState.scene,()=>{
          if(generation!==ownGeneration || edits!==ownEdits || dirty || blocked || loading
            || data.serverEpoch!==binding.serverEpoch
            || data.sourceToken!==binding.sourceToken || data.stateRevision!==binding.stateRevision
            || binding.inspectionRevision!==ownRevision
            || JSON.stringify(workspace.capture())!==JSON.stringify(savedScene)) throw Error('Local work changed before the shared view arrived.');
          validatePlayback();
        },workspace.snapshot().xrPresenting===true,false,async(scene:any)=>{
          if(lessonChanged) {
            await tourPlayer?.replaceTours(nextLesson?[nextLesson,...TOURS]:TOURS,{preservePlayback:true});
            await workspace.viewer.inspection.setLessonRestingState?.(lessonRestingState(nextLesson),{preserveEmphasis:true});
            installedLesson=nextLesson;
          }
          await tourPlayer?.restorePlayback(scene,{frame:!lessonChanged});
        });
        binding={...binding,...data};savedScene=restored;
        outcome.textContent=`Shared view shown · revision ${data.inspectionRevision}`;
        showOutcome(data.outcome);
      } finally {remote=false;}
    }
    // A refused source still belongs to this connected transition owner. Keep
    // its identity and heartbeat so Retry can finish the same handoff. It is
    // deliberately not ready for edits against coordinates it did not draw.
    if(data?.attached===false && retryHydrationId && data.sourceRenderReceipt?.status==='failed'
      && data.sourceRenderReceipt.panelId===panelId) return;
    if(data?.attached===false) {
      // The host drops a headset page that went quiet for its
      // grace, and a frozen page's first timer after that lands here while
      // the page is still hidden. Hydrating then would draw into a page that
      // shows no frames, run out the frame deadline and leave the page behind
      // Retry, and re-registering would reconcile a lesson the same way. So a
      // page that cannot draw keeps its panel ID and does neither; the first
      // beat it sends awake is answered `attached:false` again and recovers.
      if(paused) return;
      panelId=undefined;delete document.body.dataset.panelId;
      document.querySelector('[data-panel-label]')?.remove();document.querySelector('.app-header .brand')?.removeAttribute('title');
      // A clean, expired panel has now caught up before re-registration.
      // Dirty/blocked panels keep their work and require explicit recovery.
      if(!dirty && !blocked && !workspace.snapshot().interactionActive) {
        failureKind='reconnect';
        if(data.serverEpoch!==binding.serverEpoch || data.sourceToken!==binding.sourceToken
          || data.stateRevision!==binding.stateRevision || data.inspectionRevision!==binding.inspectionRevision)
          await hydrate(binding.sessionId);
        else await attach();
      }
      return;
    }
    const delivery=privateState?.delivery;
    // Start the command, do not wait for it.
    //
    // The next beat is armed in this function's `finally`, so awaiting the
    // command here made the heartbeat only as alive as the slowest thing a
    // command could touch. A chapter that never finished therefore never
    // rearmed the timer, and the page stopped talking to the Mac for good
    // while its WebXR frames carried on at 72 fps. The beat now continues
    // through the render as `busyBeat` above, and the command reports its own
    // failure where an awaited one used to report it.
    if(delivery) {
      rendering=rendering.then(()=>receive(delivery,sent,ownGeneration))
        .catch(error=>{if(!closed)showProblem(problemMessage('delivery',error),'delivery',error);});
    }
  } catch(error) {
    if((error as any)?.code==='companion_connection') { pollBackoff.failed(); armPoll(); }
    // Rendering is transient; armPoll already scheduled the next attempt.
    if((error as {code?:unknown})?.code==='viewer_busy') return;
    // Every call this beat made named `beatSession`, and the link has left it.
    if((error as any)?.code==='companion_session_changed') rebindCompanionSession(beatSession);
    else if(!closed) showProblem(problemMessage(failureKind,error),failureKind,error);
  // The next tick was armed at the top, so a slow beat no longer delays it.
  } finally { pollInFlight=false;workspace?.syncSceneHistory?.(); }
}
// The pending update is checked on its own clock, apart from the beat.
if(isCompanion) setInterval(()=>{ void reloadPendingCompanion(); },1000);
reload.addEventListener('click',()=>{
  const id=binding?.sessionId ?? requestedId; if(!id) return;
  rendering=rendering.then(async()=>{await saving; await hydrate(id);})
    .catch(error=>showProblem(problemMessage('loading',error),'loading',error));
});
// Deliberate recovery for an obsolete page key after a host restart. Keep the
// rendered scene available offline until the wearer chooses this; the root
// route alone may redeem this origin's remembered device and issue a new key.
pairAgain.addEventListener('click',()=>location.assign('/'+location.search));
retry.addEventListener('click',()=>{
  let failureKind=problemRetryKind;
  rendering=rendering.then(async()=>{
    if(retryHydrationId) {
      failureKind='loading';
      const id=retryHydrationId;
      blocked=false;notice.hidden=true;
      await hydrate(id);
      return;
    }
    if(pendingReceipt) {failureKind='confirmation';await confirmReceipt(pendingReceipt);return;}
    blocked=false;notice.hidden=true;
    if(problemRetryKind!=='save') { clearTimeout(pollTimer);await poll();return; }
    await save();
  }).catch(error=>showProblem(problemMessage(failureKind,error),failureKind,error));
});
// A compatibility check opens no structure, so its card asks for the height of
// its content; inspector.css lets the shell take its natural height for that.
function sendSize(context=app.getHostContext()) {
  const contentHeight=document.body.dataset.ready==='preflight'?document.querySelector('#app')?.getBoundingClientRect().height:undefined;
  void app.sendSizeChanged({height:desiredPanelHeight({width:innerWidth,fixedHeight:panelFixedHeight(context?.containerDimensions),contentHeight})}).catch(()=>{});
}
function size() { const context=app.getHostContext(); displayModeController.sync(context); sendSize(context); }
function sceneImportLoadSettings(value:any,catalog:any) {
  const object=value?.objects?.[0], construction=object?.construction, options=object?.constructionOptions;
  let modelNumber=catalog.modelNumbers[0], assemblyId=catalog.assemblyId;
  if(Number.isSafeInteger(construction?.modelIndex)) {
    const model=Array.isArray(options?.models) ? options.models.find((candidate:any)=>candidate?.index===construction.modelIndex) : undefined;
    if(Number.isSafeInteger(model?.modelNumber)) modelNumber=model.modelNumber;
  }
  // A selection-mmcif export contains the viewer's already constructed atom
  // positions. Its observed-only catalog therefore exposes asymmetric_unit,
  // even when the upstream object was assembled as "1". Load the assembly
  // present in these exact bytes; resolve_scene_import verifies the upstream
  // construction and the native single-copy provenance before restoring it.
  if(construction?.kind==='assembly' && construction.assemblyId===catalog.assemblyId) assemblyId=construction.assemblyId;
  return {modelNumber,assemblyId};
}
async function boot() {
  const readinessActions:ReadinessStripHandlers={
    'load-saved-view':()=>reload.click(),
    'connect-headset':()=>document.querySelector<HTMLButtonElement>('[data-quest-open]')?.click(),
  };
  const readinessStrip=!isCompanion?createReadinessStrip(document,readinessActions):undefined;
  if(readinessStrip)updateReadinessStrip=readinessStrip.update;
  if(isCompanion) {
    // First thing, before a single await. Quest Browser draws the
    // whole address in the wearer's view, so the page key is taken out of the
    // bar and into this tab's storage ahead of any paint or any capture the
    // owner might share. Everything downstream reads the hold, not the URL.
    companionPageKey();
    const diagnostics=document.createElement('details');diagnostics.className='companion-diagnostics';diagnostics.dataset.companionDiagnostics='';
    const summary=document.createElement('summary');summary.textContent='Connection diagnostics';
    if(location.pathname==='/viewer') {const repair=document.createElement('a');repair.href='/';repair.textContent='Pair again';diagnostics.append(repair);}
    const values=document.createElement('pre');diagnostics.append(summary,values);document.body.append(diagnostics);
    const failures:string[]=[];
    window.addEventListener('error',event=>{if(event.target!==window && failures.length<10)failures.push('A local asset failed to load.');},true);
    const updateDiagnostics=async()=>{
      const xr=(navigator as any).xr;
      const support=await workspace?.viewer.xr?.capabilities?.()??null;
      values.textContent=JSON.stringify({origin:location.origin,secureContext:window.isSecureContext,webXR:Boolean(xr),support,
        molstar:PLUGIN_VERSION,sceneRevision:binding?.inspectionRevision??null,rendered:Boolean(workspace?.snapshot().ready),
        immersiveStartup:xrStartupReport(),assetFailures:failures},null,2);
    };
    await updateDiagnostics();const diagnosticsTimer=setInterval(()=>{void updateDiagnostics();},3000);
    window.addEventListener('pagehide',()=>clearInterval(diagnosticsTimer),{once:true});
    companionCall=createCompanionClient();
    // The immersive session binds the controller grip; it reaches the desktop
    // through this page's authenticated tool route and nothing else.
    setPushToTalkSender((state:'down'|'up')=>call('push_to_talk',{state}));
    // Version 2 sends the microphone itself. Registering this sender is the
    // opt-in: without it the grip binding never opens a microphone.
    setPushToTalkAudioSender((args:Record<string,unknown>)=>call('push_to_talk_audio',{...args,panelId}));
    // The answer to a capture the Mac armed on the heartbeat.
    if(isCompanion)setHeadsetViewSender(sendHeadsetViewCapture);
  }
  workspace=await createInspectionWorkspace({embedded:true,enableXr:isCompanion,onLocalEdit:()=>{localInteractionSerial++;lastLocalEditAt=performance.now();},onInteraction:(interaction:{kind?:string})=>{localInteractionSerial++;tourPlayer?.notifyMutation(undefined,{interaction:true});experiencePlayer?.notifyInteraction();},
    getSceneHistory:(view:any)=>sceneHistoryClient.get(view),onSceneHistoryAction:(kind:'undo'|'redo')=>sceneHistoryClient.act(kind),
    ...(!isCompanion?{onSaveNamedView:saveHostNamedView,onRestoreNamedView:restoreHostNamedView,onDeleteNamedView:deleteHostNamedView}:{}),
    onMutation:(snapshot:any)=>{
    scheduleSave();
    // Source hydration restores saved animation before publishing its load
    // mutation. That publication is bookkeeping, not a wearer takeover.
    // Genuine input still reaches onInteraction while loading.
    if(!loading) tourPlayer?.notifyMutation(snapshot,{agent:remote,origin:snapshot?.mutationOrigin});
    experiencePlayer?.notifyMutation();
  // The wearer's own "grow it". `executeInspectionVoiceAction`
  // reaches `growStructure` from the Mac's push-to-talk route, and this is the
  // same function reached from the page's own grammar,
  // so a spoken tier is one code path whichever microphone heard it. It returns
  // the sentence to speak — a landing and a refusal both — and never throws for
  // a tier the headset cannot hold.
  },onSettled:scheduleSave,onGrowStructure:(stage:string, notify?:{onNotYet?:()=>void})=>growStructure(stage, notify),onOpenWorkbench:async(options?:{immersive?:boolean;target?:'mac'})=>{
    // The host that serves this page also serves the full Mol* viewer at
    // /detailed on this same origin, so in the headset the wearer gets it in
    // Quest Browser rather than on a Mac monitor they cannot see. A host too
    // old to serve it still opens on the Mac.
    if(options?.immersive){
      if(!binding)return{opened:false,reason:'Save this inspection first.'};
      await save();
      // `target:'mac'` is the wearer's explicit "open it on the
      // Mac", the one phrase that means a monitor. Everything else stays in the
      // headset wherever this host can serve it.
      // Three answers, not two. `unreachable` means the page
      // could not find out, and a wearer who cannot see the Mac must not be
      // sent there on a guess: say so and let the next press ask again.
      const where=await detailedView.resolve({target:options.target});
      if(where==='unreachable')return{opened:false,reason:DETAILED_VIEW_UNREACHABLE_CAPTION};
      const here=where==='here';
      const result=await call('open_detailed_view',{sessionId:binding.sessionId,serverEpoch:binding.serverEpoch,
        baseStateRevision:binding.stateRevision,baseInspectionRevision:binding.inspectionRevision,sourceToken:binding.sourceToken,open:!here});
      // The page key this companion already holds is the same bearer the
      // detailed page reads, so the handoff needs no second capability.
      // It is also the same tab, so where sessionStorage took the
      // key this link carries no fragment at all and the wearer's URL bar never
      // renders the secret. `fragment` is '#<key>' only where storage refused.
      // The caller ends the session and sends this same tab to `/detailed`, so
      // the next thing that happens to this page is `pagehide`. Say why, or the
      // registry reads an empty session and an agent answers a wearer in a
      // headset with instructions for a desktop browser.
      // The mark is provisional until the page really
      // leaves. A handoff whose teardown was refused keeps the wearer in the
      // scene, and a detach later on for some other reason must not then tell
      // the registry they went to Mol*. `onStayed` is how the page takes it
      // back; see `beginWorkbenchHandoff`.
      if(here){leavingForDetailedView=true;return{opened:true,headsetUrl:`/detailed${companionPageKey().fragment}`,
        onStayed:()=>{leavingForDetailedView=false;}};}
      const view=(result?.structuredContent as any)?.detailedView;
      return view?.opened===true?{opened:true}:{opened:false,reason:view?.openReason??view?.openDetail??'could not open'};
    }
    try {
      if(!connectedWorkbench)throw Error('Mol* workbench is unavailable.');
      // The drawer uses the desktop DOM over the same PluginUIContext. End
      // the headset session first so its stock controls never compete with
      // the XR presentation or hidden companion layout.
      if(workspace?.snapshot().xrPresenting)await workspace.viewer.xr.end();
      connectedWorkbench.open();
    }catch(error){recordHeadsetEvent('page-error',{operation:'open-workbench',message:thrownErrorMessage(error)});workspace?.setStatus?.('Could not open the Mol* workbench. Try again.');}
  }});
  document.querySelector('.app-header')!.after(notice);
  notice.after(scenePreflightNotice,outcome);
  if(readinessStrip)outcome.after(readinessStrip.element);
  // A card has no room for a selection row under the stage as well as a
  // status row under the card, so card mode hides the first and the footer
  // shows this copy of its count beside the status.
  const selectionCount=document.querySelector<HTMLElement>('.selection-count'),footer=document.querySelector('.app-footer');
  if(!isCompanion && selectionCount && footer) {
    const footerSelection=document.createElement('span');footerSelection.className='footer-selection';footer.append(footerSelection);
    const copySelection=()=>{footerSelection.textContent=selectionCount.textContent;footerSelection.dataset.empty=selectionCount.dataset.empty??'true';};
    new MutationObserver(copySelection).observe(selectionCount,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['data-empty']});
    copySelection();
  }
  // Keep the canvas's vertical budget intact in compact 800 × 640 hosts.
  // The inspector sidebar already scrolls its tools, so tours belong there.
  // A lesson scene speaks through the same Mac voice route a
  // voice command already uses. `voiceCommandSpeaker()` is registered only once
  // this page holds an authenticated companion binding, so a tour run before
  // pairing simply stays silent and keeps its captions.
  //
  // A narration that cannot be spoken is a diagnostic, not a
  // page error. `void` on the rejected promise reached the global handler as an
  // `unhandled-rejection` carrying only `request_failed`, which reads in the
  // headset as though the scene itself failed. The scene applied; the caption
  // stands; only the audio is missing, and the status says why.
  tourPlayer=mountTourPlayer({workspace,tours:TOURS,after:document.querySelector('.inspector-heading')!,
    continueStage:(stage,intent)=>growStructure(stage,{continuation:intent}),
    narrate:line=>{void speakNarration(line);},onExplore:kind=>{
    document.querySelector<HTMLButtonElement>(`[data-workspace="${kind}"]`)?.click();
    if(kind==='sequence') {
      document.querySelector('.sequence-panel')?.scrollIntoView({block:'nearest'});
      document.querySelector<HTMLInputElement>('[data-control="search"]')?.focus();
    }
  }});
  connectedWorkbench=mountConnectedWorkbench({workspace,anchor:document.querySelector('.inspector-heading')!,onOpen:()=>{
    tourPlayer?.pause('Paused for Mol* exploration.');
    experiencePlayer?.pause('Paused for Mol* exploration. Next continues your journey.');
  }});
  // The companion viewer exists before the player; attach only the player's
  // narrow action/state surface so its immersive toolbar can read and drive
  // the same tour without gaining scene or camera access.
  // The shared controller is attached after both renderers are mounted.
  experiencePlayer=mountExperiencePlayer({after:document.querySelector('.inspector-heading')!,
    settle:()=>tourCommandContext?Promise.resolve():rendering,
    narrate:line=>speakNarration(line),
    navigate:async(id,step,loadedOnly)=>{await navigateExperience(id,step,loadedOnly);},
    finish:async()=>{
      const current=await call('get_inspection',{sessionId:binding.sessionId,...HYDRATION_TRANSPORT});
      if(!(current._meta?.[PRIVATE_KEY] as any)?.experience) return reconcileExperience(current);
      if(!experienceView) throw Error('There is no current journey to finish.');
      const receipt=await navigateExperience(experienceView.definition.id,experienceView.stepIndex,false,true);
      if(receipt?.status!=='rendered') throw Error('Your restored view has not been confirmed.');
      return receipt;
    },
    onFeedback:message=>{workspace.setStatus(message,!['Back to your view','The lesson ended while the link was down. Back to your view.',
      'Restored your pre-tour view.','Restored your view and adjusted it to clear the menu.','Fitted your view to clear the menu.'].includes(message));showHeadsetCaption(message);
      try { void voiceCommandSpeaker()?.(message,{journey:true})?.catch?.(()=>{}); } catch { /* The caption remains when speech is unavailable. */ }},
    explore:()=>document.querySelector<HTMLButtonElement>('[data-tab="look"]')?.click(),
    place:async target=>{if(!workspace.viewer.xr?.placeInRoom)throw Error('Open this experience on Quest to place it in your room.');await workspace.viewer.xr.placeInRoom(target);await save();},
  });
  panelTour=createPanelTourController(tourPlayer,experiencePlayer);
  workspace.viewer.xr?.setSpatialTour(panelTour);
  const showTourOwner=()=>{
    document.querySelector<HTMLElement>('.tour-player')!.hidden=panelTour!.current()!==tourPlayer;
    document.querySelector<HTMLElement>('.experience-player')!.hidden=panelTour!.current()!==experiencePlayer;
  };
  panelTour.subscribe(showTourOwner);showTourOwner();
  // Cursor/stop changes are saved even when they changed no geometry.
  tourPlayer.subscribe(scheduleLessonSave);
  if(isCompanion) {
    const voicePanel=document.createElement('section');voicePanel.className='voice-panel';voicePanel.setAttribute('aria-label','Voice control');
    voicePanel.innerHTML='<button type="button" class="voice-orb" data-voice-orb aria-label="Start voice request"><span aria-hidden="true">◉</span><span data-voice-label>Talk</span></button><span class="voice-readout" role="status" data-voice-status></span><button type="button" data-voice-cancel hidden>Cancel</button>';
    const orb=voicePanel.querySelector<HTMLButtonElement>('[data-voice-orb]')!;
    const label=voicePanel.querySelector<HTMLElement>('[data-voice-label]')!;
    const status=voicePanel.querySelector<HTMLElement>('[data-voice-status]')!;
    const cancel=voicePanel.querySelector<HTMLButtonElement>('[data-voice-cancel]')!;
    let voiceState='idle';
    updateVoiceUi=()=>{
      const listening=voiceState==='listening',starting=voiceState==='starting';
      const busy=['processing','transcribing','speaking','sending','playing'].includes(voiceState);
      voicePanel.dataset.voiceState=voiceState;
      orb.disabled=busy || (!listening&&!starting&&(!panelId||loading||blocked));
      label.textContent=listening?'Finish':starting?'Opening mic…':busy?(['speaking','playing'].includes(voiceState)?'Speaking':'Working…'):'Talk';
      orb.setAttribute('aria-label',listening?'Finish voice request':'Start voice request');
      orb.setAttribute('aria-pressed',String(listening));cancel.hidden=!['starting','listening','speaking','playing'].includes(voiceState);
      cancel.textContent=['speaking','playing'].includes(voiceState)?'Stop audio':'Cancel';
      status.textContent=voiceMessage;
    };
    /**
     * Voice state does not write on the inspection plate.
     *
     * This handler used to push `voiceMessage` at the wearer's status row with
     * a hard-coded `waiting`, on every transition including the ones that end
     * a reply. Two things came of that. The message never survived: the plate's
     * copy reads its field names out of an `Applied ·`/`Waiting ·` sentence, so
     * a voice line like "Sent to Claude" matched nothing and was redrawn as
     * `Waiting · change` in orange. And because an agent command speaks its own
     * two-word confirmation, every command ran `Applied · motion · r24` and
     * then, a second later, the playback's own state change painted the stale
     * orange `Waiting · change` back over it. On hardware
     * that plate stayed orange through a six-scene tour, a spin, a stop and two
     * render-quality commands, every one of which the host had receipted
     * `rendered`.
     *
     * The wearer keeps every voice signal they had. The menu's Talk row reads
     * `Listening…`/`Answering…` off this same state, the grip binding writes
     * its own microphone lines to the status row, and the reply is both spoken
     * and drawn by the caption sink. The plate is the agent's channel.
     */
    voiceInteraction=createVoiceInteraction({begin:beginVoiceRequest,send:sendVoiceRequest,onState:(state:string,message:string)=>{
      voiceState=state;
      assistantStatus.update({microphone:state});
      if(state==='error' || message.startsWith('Audio reply unavailable:')) {
        recordHeadsetEvent('page-error',{operation:'voice',message});
        voiceMessage='Voice is unavailable. Try again.';
      } else voiceMessage=message||voiceMessage;
      updateVoiceUi();
    }});
    // XR uses this same controller; the sender also supports the optional
    // legacy host adapter without changing the source-bound transport.
    setVoiceCommandSender(voiceInteraction.voiceSender);
    // A locally executed headset command asks the Mac for its
    // one spoken line, because a Quest 2 has no voice of its own.
    // `speech` carries how this line should be said, not just
    // what it says. Every existing caller passes only the message and keeps
    // the old behaviour — one reply, queued behind anything already speaking.
    // `stale` is asked again once the audio exists, because
    // that is the only moment worth asking. Everything the caller knew when it
    // asked for the line may have been undone by the round trip itself.
    // Done feedback can leave the synthesis queue after navigation settles.
    // Keep its journey ownership even while this page still has the host's
    // previous binding; neither pending nor a local token comparison proves it.
    setVoiceCommandSpeaker(createPanelNarrator({prepare:async(message:string,speech?:{kind?:string;journey?:boolean;interrupt?:boolean;stale?:()=>boolean;utteranceId?:string;commandId?:string})=>{if(!binding||!panelId)return async()=>{};const spoken=await call('voice_acknowledgement',{...expected(),panelId,message},speech?.journey===true || speech?.kind==='narration');const wav=(spoken.structuredContent as any)?.wavBase64;
      return async()=>{if(!wav)return;
      if(speech?.stale?.()){recordHeadsetEvent('speech-dropped',{route:speech.kind==='narration'?'tour-narration':'voice-acknowledgement',chars:message.length,reason:'stale'});return;}
      // The same question goes down with the line. A chapter
      // line that cannot be spoken yet waits for the speaker instead of being
      // dropped, and `stale` is what the wait is re-checked against.
      await voiceInteraction.play(wav,message,speech?{kind:speech.kind,interrupt:speech.interrupt,stale:speech.stale,timing:speech}:undefined);};}}));
    orb.addEventListener('click',()=>{void voiceInteraction.toggle().catch((error:unknown)=>{recordHeadsetEvent('page-error',{operation:'voice-toggle',message:thrownErrorMessage(error)});voiceMessage='Could not start voice. Try again.';updateVoiceUi();});});
    cancel.addEventListener('click',()=>{void voiceInteraction.cancel().catch(()=>{});});
    workspace.viewer.xr?.setVoiceInteraction?.(voiceInteraction);
    // The panel and the source/footer caption now share one positioned stage,
    // so CSS can reserve their two rows without guessing the viewport height.
    document.querySelector('.stage')!.append(voicePanel);
    updateVoiceUi();
    window.addEventListener('pagehide',()=>{void voiceInteraction.cancel();},{once:true});
  }
  const recording=document.createElement('button');recording.type='button';
  recording.textContent='Capture preview · 10 s';recording.dataset.recordInspection='';
  recording.title='Experimental silent WebM capture. Frame delivery depends on this browser; check playback before sharing.';
  recording.addEventListener('click',async()=>{
    if(activePreviewRecording)return;
    if(closed || !workspace.snapshot().ready || workspace.snapshot().xrPresenting) {
      outcome.textContent='Recording needs a loaded desktop view. For headset footage, use your headset’s screen recording.';return;
    }
    recording.disabled=true;recording.textContent='Recording · 10 seconds';
    const controller=new AbortController();activePreviewRecording=controller;
    try {
      const result=await recordInspectionCanvas(findInspectionCanvas(document),{
        frameRate:10,
        signal:controller.signal,
        requestDraw:()=>{
          const current=workspace.snapshot();
          if(closed||!current.ready||current.xrPresenting) {controller.abort();return;}
          workspace.viewer.plugin.canvas3d.requestDraw();
        },
      });
      if(controller.signal.aborted||closed||!workspace.snapshot().ready||workspace.snapshot().xrPresenting)
        throw Object.assign(Error('The desktop view changed before the preview finished.'),{code:'recording_aborted'});
      const revoke=downloadInspectionRecording(result);setTimeout(revoke,60_000);
      outcome.textContent='Preview downloaded · check playback for dropped frames before sharing';
    } catch(error) {
      if((error as any)?.code==='recording_aborted')outcome.textContent='Preview cancelled because the desktop view changed or closed. Start a new preview when it is ready.';
      else {recordHeadsetEvent('page-error',{operation:'recording',message:thrownErrorMessage(error)});outcome.textContent='Could not record the preview. Try again.';}
    }
    finally {if(activePreviewRecording===controller)activePreviewRecording=undefined;recording.disabled=false;recording.textContent='Capture preview · 10 s';}
  });
  const connect=document.createElement('button');connect.type='button';connect.dataset.companionOpen='';connect.dataset.workspace='';
  connect.textContent=isCompanion?'Return to desktop':'Open in browser';
  if(!isCompanion)connect.title='Open this inspection in a browser tab on this Mac. Changes there save back here.';
  const quest=document.createElement('button');quest.type='button';quest.dataset.questOpen='';quest.dataset.workspace='';quest.textContent='Open on headset';
  quest.title='Choose Quest, Vision Pro, manual pairing, or a Meta relay link.';
  /**
   * One primary action, and everything else named.
   *
   * This button used to say "Open in…" over a dialog that mixed two unrelated
   * kinds of thing: Mol*'s own tools driving this very canvas, and viewers that
   * are separate applications with no way back. Which one a press got, and what
   * of the wearer's work survived it, was not written anywhere.
   *
   * So the live tools are the primary action on the panel itself ("Mol* tools",
   * mounted by connected-workbench.ts) and this button is the secondary group.
   * It is called what it holds — other viewers — and every entry states in one
   * line what carries over and what comes back.
   */
  const handoff=document.createElement('button');handoff.type='button';handoff.dataset.handoffOpen='';handoff.dataset.workspace='';handoff.textContent='Other viewers';handoff.disabled=true;
  const handoffDialog=document.createElement('dialog');handoffDialog.className='lan-dialog handoff-dialog';handoffDialog.dataset.handoffDialog='';
  handoffDialog.innerHTML=`<form method="dialog"><button class="lan-dismiss" aria-label="Close other viewers">Close</button></form>
    <h2>Other viewers</h2>
    <p class="dialog-lead handoff-lead">Each opens a <strong>separate</strong> viewer and leaves this view as it is. To change this canvas, close this and use <strong>Mol* tools</strong>.</p>
    <p class="handoff-summary" data-handoff-summary></p>
    <p data-handoff-status role="status"></p>
    <section class="dialog-option" data-handoff-detailed-section><h3>Full Mol* viewer on this Mac</h3>
      <p>The complete Mol* application, open on this structure.</p>
      <p class="handoff-carries" data-handoff-detailed-carries>Carries over: coordinates, model, representation, colour, opacity, background and your residue selection. Comes back: press “Apply supported changes and return” there.</p>
      <button type="button" data-handoff-detailed>Open the full viewer</button></section>
    <section class="dialog-option" data-handoff-web-section><h3>Mol* website</h3>
      <p>A new public PDB view on molstar.org, in your own browser.</p>
      <p class="handoff-carries">Carries over: the PDB ID only. Nothing comes back.</p>
      <button type="button" data-handoff-web>Open Mol* website</button></section>
    <section class="dialog-option" data-handoff-native-section><h3 data-handoff-native-title>Molecular Structure Viewer in Codex</h3>
      <p data-handoff-native-note>Asks Codex to open its own viewer for this structure.</p>
      <p class="handoff-carries">Carries over: the PDB ID, or the file path and its checksum. Nothing comes back.</p>
      <button type="button" data-handoff-native>Open in Codex</button></section>
    <details data-handoff-native-optin hidden><summary>Ask for the Codex viewer anyway</summary>
      <p>This host did not say which application it is, so Stereofold cannot tell whether the Codex Molecular Structure Viewer is there. Turn this on and the request is sent to whatever assistant is running this panel; if that is not Codex, nothing will open.</p>
      <label><input type="checkbox" data-handoff-native-enable> Offer the Codex request on this host</label></details>`;
  document.body.append(handoffDialog);
  const handoffSummary=handoffDialog.querySelector<HTMLElement>('[data-handoff-summary]')!;
  const handoffStatus=handoffDialog.querySelector<HTMLElement>('[data-handoff-status]')!;
  const handoffWebSection=handoffDialog.querySelector<HTMLElement>('[data-handoff-web-section]')!;
  const handoffNativeSection=handoffDialog.querySelector<HTMLElement>('[data-handoff-native-section]')!;
  const handoffWeb=handoffDialog.querySelector<HTMLButtonElement>('[data-handoff-web]')!;
  const handoffNative=handoffDialog.querySelector<HTMLButtonElement>('[data-handoff-native]')!;
  const handoffDetailedSection=handoffDialog.querySelector<HTMLElement>('[data-handoff-detailed-section]')!;
  const handoffDetailed=handoffDialog.querySelector<HTMLButtonElement>('[data-handoff-detailed]')!;
  const handoffNativeTitle=handoffDialog.querySelector<HTMLElement>('[data-handoff-native-title]')!;
  const handoffNativeNote=handoffDialog.querySelector<HTMLElement>('[data-handoff-native-note]')!;
  const handoffNativeOptIn=handoffDialog.querySelector<HTMLDetailsElement>('[data-handoff-native-optin]')!;
  const handoffNativeEnable=handoffDialog.querySelector<HTMLInputElement>('[data-handoff-native-enable]')!;
  const handoffStorage=(()=>{try{return window.localStorage;}catch{return null;}})();
  let codexOptIn=readCodexOptIn(handoffStorage);
  handoffNativeEnable.checked=codexOptIn;
  handoffNativeEnable.addEventListener('change',()=>{codexOptIn=handoffNativeEnable.checked;writeCodexOptIn(handoffStorage,codexOptIn);syncHandoff?.();});
  syncHandoff=()=>{
    if(isCompanion) return;
    const presenting=workspace?.snapshot?.().xrPresenting===true;
    const website=officialMolstarUrl(handoffSource);
    const capabilities=app.getHostCapabilities();
    const canOpenLink=Boolean(capabilities?.openLinks);
    const canMessage=Boolean(capabilities?.message);
    // The host names itself in the MCP Apps handshake or not at all; see
    // host-identity.ts for why an unnamed host is offered nothing by default.
    const identity=hostIdentity(app.getHostVersion(),app.getHostContext());
    const canAskCodex=canMessage && offerCodexHandoff(identity,codexOptIn);
    const canUseViewer=Boolean(website && canOpenLink) || canAskCodex || detailedViewHere;
    handoff.disabled=!handoffSource || presenting || !canUseViewer || handoffPending;
    handoff.title=handoffPending?'Opening another viewer…':presenting?'Leave headset view before opening another viewer.'
      :!handoffSource?'Only the original public PDB or a verified local file can be handed off.'
        :!canUseViewer?'This host cannot open any separate viewer for this source.'
        :'Separate viewers. Your Stereofold view stays as it is.';
    handoffDetailedSection.hidden=!detailedViewHere;
    handoffDetailed.disabled=handoffPending || presenting || !binding;
    handoffDetailed.title=handoffPending?'Opening another viewer…':presenting?'Leave headset view before opening another viewer.'
      :!binding?'Save this inspection first.':'Opens on this Mac. One press over there sends the supported changes back.';
    handoffWebSection.hidden=!website;
    handoffWeb.disabled=handoffPending || !canOpenLink || presenting;
    handoffWeb.title=handoffPending?'Opening another viewer…':!canOpenLink?'This host cannot open external links.':presenting?'Leave headset view before opening another viewer.':'';
    handoffNativeSection.hidden=!canAskCodex;
    handoffNative.disabled=handoffPending || !canAskCodex || presenting;
    handoffNative.title=handoffPending?'Opening another viewer…':presenting?'Leave headset view before opening another viewer.':'';
    // Only a host that said it is Codex is named as Codex. An unidentified one
    // that the user opted into is described as what it actually is: a request
    // sent to whichever assistant is running this panel.
    handoffNativeTitle.textContent=identity==='codex'?'Molecular Structure Viewer in Codex':'Molecular Structure Viewer request';
    handoffNativeNote.textContent=identity==='codex'?'Asks Codex to open its own viewer for this structure.'
      :'Asks the assistant running this panel to open the Codex Molecular Structure Viewer. This host did not identify itself.';
    handoffNative.textContent=identity==='codex'?'Open in Codex':'Send the viewer request';
    handoffNativeOptIn.hidden=!canMessage || identity!=='unknown';
    handoffSummary.textContent=presenting?'Leave headset view before opening another viewer.'
      :handoffSource?.kind==='public-pdb'?`PDB ${handoffSource.pdbId}`
        :handoffSource?.kind==='local-file'?'Local file. It stays on this Mac.'
          :'This source cannot be handed off. Pasted coordinates, fixtures, lessons and scene imports remain in Stereofold.';
    handoffStatus.textContent=handoffFeedback
      || (identity==='other'?'This host is not Codex, so the Codex viewer request is not offered.':'');
  };
  handoff.addEventListener('click',()=>{if(!handoff.disabled) handoffDialog.showModal();});
  handoffWeb.addEventListener('click',()=>{void (async()=>{
    const source=handoffSource, ownVersion=handoffVersion, url=officialMolstarUrl(source);if(!url || handoffWeb.disabled)return;
    handoffPending=true;syncHandoff();
    try {
      const result=await app.openLink({url});
      if((result as any)?.isError) throw Error('Host rejected the website request.');
      if(handoffVersion===ownVersion) handoffFeedback='Opened the independent Mol* website view. Stereofold remains unchanged.';
    } catch {if(handoffVersion===ownVersion) handoffFeedback='This host could not open the Mol* website.';}
    finally {if(handoffVersion===ownVersion) {handoffPending=false;syncHandoff();}}
  })();});
  handoffNative.addEventListener('click',()=>{void (async()=>{
    const source=handoffSource, ownVersion=handoffVersion;if(!source || handoffNative.disabled)return;
    handoffPending=true;syncHandoff();
    try {
      const result=await app.sendMessage({role:'user',content:[{type:'text',text:nativeStructureViewerPrompt(source)}]});
      if((result as any)?.isError)throw Error('Host rejected the handoff request.');
      if(handoffVersion===ownVersion) handoffFeedback='Requested Molecular Structure Viewer in Codex. It opens independently after Codex handles the request.';
    } catch {if(handoffVersion===ownVersion) handoffFeedback='This host could not request Molecular Structure Viewer in Codex.';}
    finally {if(handoffVersion===ownVersion) {handoffPending=false;syncHandoff();}}
  })();});
  // The full local viewer. It is the only entry here with a way back, so it is
  // the only one whose press has to leave the panel's saved state current: the
  // handoff is built from the saved scene, not from what is on the canvas.
  handoffDetailed.addEventListener('click',()=>{void (async()=>{
    const ownVersion=handoffVersion;if(handoffDetailed.disabled || !binding)return;
    handoffPending=true;syncHandoff();
    try {
      await save();
      if(!binding)throw Error('Save this inspection first.');
      const answer=await call('open_detailed_view',{sessionId:binding.sessionId,serverEpoch:binding.serverEpoch,
        baseStateRevision:binding.stateRevision,baseInspectionRevision:binding.inspectionRevision,sourceToken:binding.sourceToken,open:true});
      const view=(answer?.structuredContent as any)?.detailedView;
      if(handoffVersion!==ownVersion)return;
      // The address carries this session's page key, so it is never printed
      // here. A Mac that could not open a browser is the agent's errand.
      handoffFeedback=view?.opened===true
        ?'Opened the full Mol* viewer on this Mac. Press “Apply supported changes and return” there to bring appearance, camera and selection back.'
        :'This Mac could not open a browser. Ask the assistant for the full viewer address.';
    } catch(error) {recordHeadsetEvent('page-error',{operation:'open-full-viewer',message:thrownErrorMessage(error)});if(handoffVersion===ownVersion) handoffFeedback='Could not open the full Mol* viewer. Try again.';}
    finally {if(handoffVersion===ownVersion) {handoffPending=false;syncHandoff();}}
  })();});
  const link=document.createElement('a');link.hidden=true;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open connected browser';
  outcome.after(link);link.className='companion-link';
  const questDialog=document.createElement('dialog');questDialog.className='lan-dialog quest-connect-dialog';questDialog.dataset.questConnectDialog='';
  // One row per route, the action on the right, and the
  // status line above the rows so a reply is never scrolled out of view.
  questDialog.innerHTML=`<form method="dialog"><button class="lan-dismiss" aria-label="Close headset connection">Close</button></form>
    <h2>Open on a headset</h2><p class="dialog-lead">Keep this Mac app running while the headset is connected.</p>
    <p data-quest-status role="status"></p><a data-quest-launch hidden target="_blank" rel="noopener noreferrer">Continue to Meta →</a>
    <section class="dialog-option"><h3>Meta Quest</h3><p>Same Wi-Fi. Opens on an already authorized Quest when available; otherwise sends the link through Meta. No developer setup is required.</p><button type="button" class="primary" data-quest-web>Open on Quest</button></section>
    <section class="dialog-option"><h3>Apple Vision Pro</h3><p>Same Wi-Fi. Copies a one-time link; paste it into Safari on Vision Pro with Universal Clipboard.</p><button type="button" data-quest-apple>Copy for Vision Pro</button></section>
    <p class="dialog-group">Other ways</p>
    <section class="dialog-option"><h3>Manual pairing</h3><p>Type the private address and pairing code into the headset browser.</p><button type="button" data-quest-lan>Show address and code</button></section>
    <section class="dialog-option"><h3>Send with Meta</h3><p>A 30-minute HTTPS link through Cloudflare’s relay; you choose the headset on Meta’s page. Meta receives the launch link.</p><button type="button" data-quest-meta>Send using Meta</button></section>`;
  document.body.append(questDialog);
  const questStatus=questDialog.querySelector<HTMLElement>('[data-quest-status]')!;
  const questLaunch=questDialog.querySelector<HTMLAnchorElement>('[data-quest-launch]')!;
  let metaLaunchExpires=0,metaLaunchGeneration=-1;
  function validMetaLaunch() {return metaLaunchGeneration===generation && Number.isFinite(metaLaunchExpires) && Date.now()<metaLaunchExpires;}
  const lanDialog=document.createElement('dialog');lanDialog.className='lan-dialog';lanDialog.dataset.lanDialog='';
  // Address, code and status first, in the order the
  // wearer uses them; the certificate and network settings stay folded.
  lanDialog.innerHTML=`<form method="dialog"><button class="lan-dismiss" aria-label="Close connection details">Close</button></form><h2>Manual headset pairing</h2>
    <p class="dialog-lead">On the same network, open this address in Quest Browser or Vision Pro Safari, bookmark it, then enter the code.</p>
    <p class="lan-address"><a data-lan-url target="_blank" rel="noopener noreferrer"></a> <button type="button" data-lan-copy>Copy address</button></p>
    <p class="lan-code">Pairing code <strong data-lan-code>—</strong></p><p class="lan-expiry" data-lan-expiry></p>
    <p data-lan-status role="status"></p><ul data-lan-clients></ul>
    <p class="lan-next">Then choose <strong>Enter VR</strong>. It opens with passthrough where the headset browser supports it; <strong>Enter plain VR</strong>, under <strong>More options</strong>, opens the opaque room. Keep this Mac app running.</p>
    <details><summary>Certificate warning</summary><p>The headset browser warns that this connection is not private; on Vision Pro, Safari shows “This Connection Is Not Private”. Accept the development certificate only for this exact private address: open the warning’s details, choose to visit the website, and confirm. No certificate authority is installed.</p><p class="lan-fingerprint-label">Certificate fingerprint</p><code data-lan-fingerprint></code></details>
    <details><summary>Network address</summary><label>Interface <select data-lan-host><option value="">Choose automatically</option></select></label><label>Port <input data-lan-port type="number" min="1024" max="65535" value="8443"></label></details>
    <div class="lan-actions"><button type="button" data-lan-restart>Restart sharing</button><button type="button" data-lan-stop>Stop sharing</button></div>`;
  document.body.append(lanDialog);
  let lanInfo:any,lanSession:string|undefined;
  const lanElement=<T extends HTMLElement>(selector:string)=>lanDialog.querySelector<T>(selector)!;
  const lanStatus=lanElement<HTMLElement>('[data-lan-status]');
  const management=async(action:'status'|'close'|'revoke',clientId?:string)=>{
    const {sessionId,serverEpoch,sourceToken}=expected();
    return (await call('manage_companion',{sessionId,serverEpoch,sourceToken,action,...(clientId?{clientId}:{})})).structuredContent as any;
  };
  const pairedDeviceName=(kind:unknown)=>({quest2:'Quest 2',quest3:'Quest 3','quest-pro':'Quest Pro','vision-pro':'Vision Pro'} as Record<string,string>)[String(kind)]??'Paired device';
  async function refreshLan() {
    if(!binding || isCompanion || closed) return;
    const next=await management('status');
    const selector=lanElement<HTMLSelectElement>('[data-lan-host]'),chosen=selector.value;
    selector.replaceChildren(new Option('Choose automatically',''),...(next.addresses??[]).map((entry:any)=>new Option(`${entry.interface} · ${entry.address}`,entry.address)));
    selector.value=chosen;
    const clients=lanElement<HTMLUListElement>('[data-lan-clients]');clients.replaceChildren();
    if(!next.lan) {lanInfo=undefined;quest.textContent='Open on headset';lanElement<HTMLElement>('[data-lan-code]').textContent='—';lanElement<HTMLElement>('[data-lan-code]').dataset.state='stopped';lanElement<HTMLElement>('[data-lan-expiry]').textContent='';lanStatus.dataset.state='stopped';lanStatus.textContent='Sharing is stopped. Choose Restart sharing for a new code.';return;}
    const pairingExpired=Date.parse(next.lan.pairingExpiresAt)<=Date.now();
    if(pairingExpired) {const code=lanElement<HTMLElement>('[data-lan-code]');code.textContent=next.lan.clients.length?'Paired':'Expired';code.dataset.state=next.lan.clients.length?'paired':'expired';}
    for(const client of next.lan.clients??[]) {
      const row=document.createElement('li'),device=document.createElement('span'),id=document.createElement('small');
      device.textContent=pairedDeviceName(client.deviceClass);id.textContent=client.id.slice(0,8);row.append(device,id);
      const revoke=document.createElement('button');revoke.type='button';revoke.textContent='Disconnect';revoke.dataset.lanRevoke=client.id;
      revoke.onclick=()=>{void management('revoke',client.id).then(refreshLan).catch(error=>{recordHeadsetEvent('page-error',{operation:'disconnect-headset',message:thrownErrorMessage(error)});lanStatus.textContent='Could not disconnect the headset. Try again.';});};row.append(revoke);clients.append(row);
    }
    lanStatus.dataset.state=next.lan.clients.length?'paired':pairingExpired?'expired':'waiting';
    lanStatus.textContent=next.lan.clients.length
      ? `${next.lan.clients.length} paired device${next.lan.clients.length===1?'':'s'}.`
      : pairingExpired ? 'Pairing code expired. Restart sharing for a new code.' : 'Waiting for your headset to pair.';
  }
  function showLan(local:any) {
    lanInfo=local;lanSession=binding.sessionId;quest.textContent='Headset connection';
    const address=lanElement<HTMLAnchorElement>('[data-lan-url]');address.href=local.url;address.textContent=local.url;
    lanElement<HTMLElement>('[data-lan-code]').textContent=local.pairingCode;delete lanElement<HTMLElement>('[data-lan-code]').dataset.state;
    lanElement<HTMLElement>('[data-lan-fingerprint]').textContent=local.fingerprint;
    const clock=(at:string)=>new Date(at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
    lanElement<HTMLElement>('[data-lan-expiry]').textContent='Code expires '+clock(local.pairingExpiresAt)+'. Sharing ends '+clock(local.sessionExpiresAt)+'.';
    if(!lanDialog.open)lanDialog.showModal();
    void refreshLan().catch(error=>{recordHeadsetEvent('page-error',{operation:'refresh-sharing',message:thrownErrorMessage(error)});lanStatus.textContent='Could not refresh sharing. Try again.';});
  }
  async function connectBrowser(connection:'loopback'|'lan'|'https', headsetChoice:HeadsetChoice='manual') {
    connect.disabled=true;quest.disabled=true;
    questDialog.querySelectorAll<HTMLButtonElement>('[data-quest-lan],[data-quest-web],[data-quest-apple],[data-quest-meta]').forEach(button=>button.disabled=true);
    // Every route that leaves the dialog open reports
    // its progress inside it, not only on the panel line behind the backdrop.
    const inDialog=connection==='https' || (connection==='lan' && headsetChoice!=='manual');
    if(inDialog)questStatus.textContent=connection==='https'?'Creating your headset link…':'Starting private Wi-Fi sharing…';
    if(connection==='https' || headsetChoice==='quest')questLaunch.hidden=true;
    try {
      tourPlayer?.pause();
      await workspace.viewer.inspection.setMotion({paused:true});await save();
      if(dirty || blocked || !binding) throw Error('Save or resolve your current view before connecting.');
      if(isCompanion) {await workspace.viewer.xr.end();outcome.textContent='Saved to your desktop inspection. You can return to the app.';return;}
      outcome.textContent=connection==='lan'?'Starting private Wi-Fi sharing…':connection==='https'?'Creating your headset link…':'Opening the browser view…';
      const lanHost=lanElement<HTMLSelectElement>('[data-lan-host]').value;
      const lanPort=Number(lanElement<HTMLInputElement>('[data-lan-port]').value);
      const ownGeneration=generation;
      const request=connection==='lan'?inspectorHeadsetRequest(expected(),headsetChoice,lanHost,lanPort):{...expected(),connection};
      const deadline=Date.now()+180_000;
      let next:any;
      do {
        const response=await call('open_companion',request);
        next=response.structuredContent as any;
        if(closed || ownGeneration!==generation)return;
        if(!next?.sharePending)break;
        outcome.textContent=next.sharePending.status==='rendering'?'Saving the current view for the headset…'
          :connection==='loopback'?'Still opening the browser view…':'Still starting the headset connection…';
        if(inDialog)questStatus.textContent=outcome.textContent;
        if(Date.now()>=deadline)throw Error('The connection is still starting. Try connecting again.');
        await new Promise(resolve=>setTimeout(resolve,500));
      } while(true);
      if(!next?.companion)throw Error('The companion connection ended without an address. Try connecting again.');
      if(closed || ownGeneration!==generation)return;
      binding={...binding,...next};
      if(connection==='lan') {
        lanInfo=next.companion;lanSession=binding.sessionId;
        if(headsetChoice==='manual' || next.launch?.handoff==='manual') {questDialog.close();showLan(next.companion);}
        else questStatus.textContent=next.launch?.message??'Headset handoff started. Use manual pairing if the page does not open.';
        // When the Mac browser did not start, the server's message points to
        // "the link below"; show that Web Launch link here, where the host can
        // open it, instead of leaving the wearer with no link.
        if(headsetChoice==='quest' && next.launch?.reason!=='started' && typeof next.launch?.link==='string') {
          const fallback=new URL(next.launch.link);
          if(fallback.origin==='https://www.oculus.com' && fallback.pathname==='/open_url/') {
            metaLaunchExpires=Date.now()+10*60_000;metaLaunchGeneration=ownGeneration;
            questLaunch.href=fallback.href;questLaunch.hidden=false;
            questStatus.textContent=(next.launch.reason==='attempted'?'If Meta’s page did not appear, choose Continue to Meta.':'Your Mac browser did not open Meta. Choose Continue to Meta.')
              +' Click Open on Meta’s page, then enter the pairing code from Manual pairing on the headset.';
          }
        }
        outcome.textContent=headsetChoice==='apple' && next.launch?.handoff==='clipboard'
          ? 'One-time link copied. Paste it into Safari on Vision Pro; it expires with the pairing code.'
          : headsetChoice==='quest'?(next.headsetPage?.drew?'The headset page loaded. Check its Enter VR prompt.'
            :next.launch?.message??'Waiting for the headset to connect. Open headset connection for details.')
            :'Private Wi-Fi sharing started. Open headset connection for the address and pairing code.';
      }
      else if(connection==='https') {
        const launch=new URL(next.companion.webLaunchUrl);
        if(launch.origin!=='https://www.oculus.com' || launch.pathname!=='/open_url/')throw Error('The Meta launch address was not valid.');
        metaLaunchExpires=Date.parse(next.companion.expiresAt);
        metaLaunchGeneration=ownGeneration;
        if(!validMetaLaunch())throw Error('The headset link has expired. Create a new one to continue.');
        questLaunch.href=launch.href;questLaunch.hidden=false;
        questStatus.textContent=`Your link is ready until ${new Date(metaLaunchExpires).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}. Continue to Meta, sign in there if asked, then choose your Quest. In the headset, open the received page and press Enter VR.`;
        outcome.textContent='Quest link ready. Continue to Meta in the connection dialog.';
      }
      else {link.href=next.companion.url;link.hidden=false;outcome.textContent='Companion connected to this inspection. Changes save back here.';
        try {await app.openLink({url:next.companion.url});} catch {outcome.textContent='Use Open connected browser to open this inspection’s companion.';}}
    } catch(error) {
      recordHeadsetEvent('page-error',{operation:'connect-headset',message:thrownErrorMessage(error)});
      // These refusals are written for the person (an expired link, sharing
      // turned off), so show them; fall back only when there is no text.
      outcome.textContent=thrownErrorMessage(error).trim()||'Could not connect your headset. Try again.';
      if(inDialog)questStatus.textContent=outcome.textContent;
      if(connection==='lan') {if(!lanDialog.open)lanDialog.showModal();await refreshLan().catch(()=>{});lanStatus.textContent=outcome.textContent;}
    } finally {connect.disabled=false;quest.disabled=false;questDialog.querySelectorAll<HTMLButtonElement>('[data-quest-lan],[data-quest-web],[data-quest-apple],[data-quest-meta]').forEach(button=>button.disabled=false);}
  }
  connect.addEventListener('click',()=>{void connectBrowser('loopback');});
  quest.addEventListener('click',()=>{questDialog.showModal();if(metaLaunchExpires && !validMetaLaunch()){questLaunch.hidden=true;questStatus.textContent='Create a fresh link for this inspection to continue.';}});
  questDialog.querySelector('[data-quest-lan]')!.addEventListener('click',()=>{if(lanInfo && lanSession===binding?.sessionId){questDialog.close();showLan(lanInfo);}else void connectBrowser('lan');});
  questDialog.querySelector('[data-quest-web]')!.addEventListener('click',()=>{void connectBrowser('lan','quest');});
  questDialog.querySelector('[data-quest-apple]')!.addEventListener('click',()=>{void connectBrowser('lan','apple');});
  questDialog.querySelector('[data-quest-meta]')!.addEventListener('click',()=>{void connectBrowser('https');});
  questLaunch.addEventListener('click',event=>{
    event.preventDefault();
    if(!validMetaLaunch()){questLaunch.hidden=true;questStatus.textContent='Create a fresh link for this inspection to continue.';return;}
    void app.openLink({url:questLaunch.href}).catch(()=>{questStatus.textContent='The host could not open Meta. Copy the Continue to Meta link into your normal browser.';});
  });
  lanElement<HTMLButtonElement>('[data-lan-restart]').onclick=()=>{void connectBrowser('lan');};
  lanElement<HTMLButtonElement>('[data-lan-stop]').onclick=()=>{void management('close').then(()=>{lanInfo=undefined;quest.textContent='Open on headset';lanElement<HTMLElement>('[data-lan-code]').textContent='—';return refreshLan();}).catch(error=>{recordHeadsetEvent('page-error',{operation:'stop-sharing',message:thrownErrorMessage(error)});lanStatus.textContent='Could not stop sharing. Try again.';});};
  lanElement<HTMLButtonElement>('[data-lan-copy]').onclick=()=>{if(lanInfo)void navigator.clipboard.writeText(lanInfo.url).then(()=>{lanStatus.textContent='Address copied.';}).catch(()=>{lanStatus.textContent='Select and copy the address above.';});};
  const lanTimer=!isCompanion?setInterval(()=>{if(lanDialog.open)void refreshLan().catch(error=>{recordHeadsetEvent('page-error',{operation:'refresh-sharing',message:thrownErrorMessage(error)});lanStatus.textContent='Could not refresh sharing. Try again.';});},5000):undefined;
  window.addEventListener('pagehide',()=>{if(lanTimer)clearInterval(lanTimer);},{once:true});
  const headerActions=document.querySelector('.header-actions')!;
  // Recording belongs to the desktop view, including custom structures with
  // no active lesson. A lesson-owned mount disappears when its player hides.
  if(isCompanion) headerActions.prepend(connect,recording);
  else {
    /*
     * The panel renders about 700 px wide in a chat card. Four full-text
     * buttons wrapped to two lines there, so only the display mode toggle
     * stays in the row. The rest keep their nodes, their data attributes and
     * their handlers, and move under a "More" menu that opens below the
     * header. syncHandoff still enables and disables the handoff button from
     * inside the menu.
     */
    const headerMenu=document.createElement('details');
    headerMenu.className='header-menu';headerMenu.dataset.headerMenu='';
    const headerMenuSummary=document.createElement('summary');
    headerMenuSummary.textContent='More';headerMenuSummary.title='Browser, headset and other viewers';
    const headerMenuBody=document.createElement('div');headerMenuBody.className='header-menu-body';
    headerMenuBody.append(connect,quest,handoff,recording);
    headerMenu.append(headerMenuSummary,headerMenuBody);
    const closeHeaderMenu=()=>{headerMenu.open=false;};
    headerMenuBody.addEventListener('click',closeHeaderMenu);
    document.addEventListener('pointerdown',event=>{
      if(headerMenu.open && event.target instanceof Node && !headerMenu.contains(event.target)) closeHeaderMenu();
    });
    document.addEventListener('keydown',event=>{
      if(event.key!=='Escape' || !headerMenu.open) return;
      event.preventDefault();closeHeaderMenu();headerMenuSummary.focus();
    });
    headerActions.prepend(displayModeToggle);
    headerActions.append(headerMenu);
    syncHandoff();
  }
  app.ontoolresult=result=>{
    publishModelContext(result);
    const data=result.structuredContent as any;
    const preflight=sceneImportPreflightView(data);
    if(preflight) {
      sceneImportNoticeSource=undefined;
      scenePreflightNotice.hidden=false;
      scenePreflightNotice.dataset.supported=String(preflight.supported);
      // A title, what happened and the next step. The checker's reasons name
      // scene fields and tools, so they stay collapsed under Technical details.
      const title=document.createElement('h2'), text=document.createElement('p'), next=document.createElement('p');
      title.className='scene-preflight-title';title.textContent=preflight.title;
      text.textContent=preflight.text;next.textContent=preflight.next;
      const disclosure=document.createElement('details'), label=document.createElement('summary'), explanation=document.createElement('pre');
      label.textContent='Technical details'; explanation.textContent=preflight.details; disclosure.append(label,explanation);
      disclosure.addEventListener('toggle',()=>sendSize());
      scenePreflightNotice.replaceChildren(title,text,next,disclosure);
      if(!binding && !loading) {
        document.body.dataset.ready='preflight';
        document.querySelector('.scene-heading h1')!.textContent=preflight.title;
        document.querySelector('.canvas-caption > span')!.textContent='NO STRUCTURE OPENED';
        workspace?.setStatus('Compatibility check complete. No structure was opened.');
      }
      return;
    }
    if(data?.kind!=='inspect' || typeof data.sessionId!=='string' || typeof data.serverEpoch!=='string' || !Number.isSafeInteger(data.renderToken)) return;
    if(!sceneImportNoticeSource) scenePreflightNotice.hidden=true;
    if(retiredEpochs.has(data.serverEpoch)) return;
    if(epoch!==data.serverEpoch) { if(epoch) retiredEpochs.add(epoch); epoch=data.serverEpoch; latestToken=0; }
    if(data.renderToken<=latestToken) return;
    latestToken=data.renderToken; requestedId=data.sessionId;
    let failureKind:ProblemRetryKind='save';
    rendering=rendering.then(async()=>{
      await save();
      if(dirty && binding) { showProblem(problemMessage('save','Your current view has unsaved changes.'),'save','Your current view has unsaved changes.'); return; }
      failureKind='loading';
      if(data.renderToken===latestToken && data.serverEpoch===epoch) await hydrate(data.sessionId);
    }).catch(error=>showProblem(problemMessage(failureKind,error),failureKind,error));
    return rendering;
  };
  app.onhostcontextchanged=size;
  if(isCompanion) {
    document.body.dataset.companion='true';
    const response=await call('get_inspection',{}),data=response._meta?.[PRIVATE_KEY] as any;
    if(!data?.sessionId || !data?.serverEpoch) throw Error('The companion did not receive its session.');
    epoch=data.serverEpoch;requestedId=data.sessionId;
    await hydrate(data.sessionId,response);
    const controls=document.createElement('div');controls.className='xr-controls';
    const entryActions=document.createElement('div');entryActions.className='xr-entry-actions';controls.append(entryActions);
    const options=document.createElement('details');options.className='xr-options';
    const optionsLabel=document.createElement('summary');optionsLabel.textContent='More options';
    const optionsBody=document.createElement('div');optionsBody.className='xr-options-body';
    options.append(optionsLabel,optionsBody);
    const note=document.createElement('small');note.textContent='Checking this browser’s headset support…';
    note.setAttribute('role','status');
    const refresh=document.createElement('button');refresh.textContent='Reload to retry VR';refresh.hidden=true;
    refresh.addEventListener('click',()=>location.reload());
    let xrSyncSequence=0;
    let xrPending=false, xrProblem='', entryWatchdog:ReturnType<typeof setTimeout>|undefined;
    let xrEntryAttempt:{presented:boolean;exited:boolean}|undefined;
    // True while the next tap on the page background is the way
    // back into VR. `syncXr` rewrites the status line every two seconds, so the
    // arming below cannot simply set it once.
    // `disarmReentry` is how every other way into a session calls the shortcut
    // off: it is a one-shot, and a wearer who pressed Enter VR themselves must
    // not find a stray tap re-entering for them a minute later.
    let reentryArmed=false, disarmReentry:(()=>void)|undefined;
    // Whether this browser can give the wearer their own room.
    // On Quest it can, and passthrough is expected to be the default.
    // Enter VR therefore asks for `immersive-ar` wherever it exists and
    // falls back to `immersive-vr` where it does not.
    let arSupported=false;
    const enterButtons:HTMLButtonElement[]=[];
    // Passthrough is the primary entry path: Enter VR asks for immersive-ar
    // wherever the browser reports it, and falls back to immersive-vr on the
    // same button where it does not. The More options button forces plain VR,
    // for a Quest that holds the immersive-ar request while it waits for an MR
    // permission decision, and for a wearer who wants the opaque room.
    for(const [mode,label] of [['immersive-ar','Enter VR'],['immersive-vr','Enter plain VR']] as const) {
      const button=document.createElement('button');button.type='button';button.dataset.enterXr=mode;button.textContent=label;button.disabled=false;
      button.addEventListener('pointerdown',()=>{pointerDowns=Math.min(65535,pointerDowns+1);});
      button.addEventListener('click',event=>{
        if(xrPending || workspace.viewer.xr.startup?.()?.pending===true)return;
        entryClicks=Math.min(65535,entryClicks+1);trustedClick=event.isTrusted;
        disarmReentry?.();
        // Invoke entry directly from this gesture; do not await another RPC.
        const attempt={presented:false,exited:false};xrEntryAttempt=attempt;
        xrPending=true;xrProblem='';note.dataset.state='starting';note.textContent='Entering headset view…';
        refresh.hidden=true;options.open=false;
        for(const control of enterButtons)control.disabled=true;
        const requested=mode==='immersive-ar'&&!arSupported?'immersive-vr':mode;
        entryWatchdog=setTimeout(()=>{
          if(!xrPending || xrEntryAttempt!==attempt)return;
          const phase=workspace.viewer.xr.startup?.().phase;
          // Safari holds the request behind its own consent prompt for as long
          // as the wearer takes, so a slow answer there is not a failure.
          if(phase==='requesting-headset'&&isAppleSafariXr(navigator)) {
            note.textContent='Choose Allow in Safari’s prompt to open the headset view.';return;
          }
          xrProblem=phase==='requesting-headset'
            ? `The headset hasn’t accepted the ${requested==='immersive-ar'?'passthrough':'VR'} request. Reload to try again.`
            : phase==='preparing-menu'
              ? 'The floating menu hasn’t finished loading. Reload the viewer to try again.'
              : 'The headset display hasn’t finished starting. Reload the viewer to try again.';
          note.textContent=xrProblem;note.dataset.state='error';refresh.hidden=false;
        },15000);
        // Ask for the microphone here, in 2D, while a prompt can still be
        // drawn: Quest cannot show one over an immersive session, so a first
        // request made from a talk press inside VR never gets answered. The
        // grant is parked with its tracks disabled until a press.
        if(isCompanion && !isAppleSafariXr(navigator)) void primePushToTalkMicrophone();
        // Keep headset admission isolated at the trusted gesture boundary.
        // Talk/grip owns audio activation when the wearer requests voice.
        // A Quest that reports AR support can still reject the AR request, so
        // plain VR is tried once inside this same gesture before the wearer is
        // handed an error they can only answer by pressing Enter again.
        const enterPromise=enterImmersiveWithFallback(m=>{
          if(xrEntryAttempt!==attempt || attempt.presented)return Promise.reject(Error('The headset entry was interrupted.'));
          return workspace.viewer.xr.enter(m as typeof requested);
        },requested,()=>{if(xrEntryAttempt===attempt && !attempt.presented)note.textContent='Passthrough refused; opening plain VR…';});
        void enterPromise
          .catch((error:Error)=>{if(xrEntryAttempt!==attempt || (attempt.exited && !workspace.viewer.xr.startup?.()?.reloadRequired))return;recordHeadsetEvent('page-error',{operation:'enter-headset',message:thrownErrorMessage(error)});xrProblem='Could not open the headset view. Try again.';refresh.hidden=false;})
          .finally(()=>{if(xrEntryAttempt!==attempt)return;clearTimeout(entryWatchdog);xrEntryAttempt=undefined;xrPending=false;void syncXr();});
      });enterButtons.push(button);
      if(mode==='immersive-ar') {button.dataset.primary='true';entryActions.append(button);}
      else optionsBody.append(button);
    }
    // The one press that finishes a blend-mode switch.
    //
    // Passthrough and plain VR are separate WebXR sessions, so crossing between
    // them ends immersion and asks for a new session, and Chromium refuses that
    // request without transient activation — which nothing inside a session
    // grants. The wearer therefore lands here, on a flat page, holding a
    // controller. Everything else on this page is competition for the only
    // press that matters, so while a switch is pending the entry row and More
    // options are hidden and this sits alone at the top of the page, sized so
    // it can be hit with a controller ray from across a room.
    const resume=document.createElement('div');resume.className='xr-resume';resume.hidden=true;
    const resumeButton=document.createElement('button');resumeButton.type='button';resumeButton.dataset.resumeXr='';
    const resumeNote=document.createElement('small');
    resume.append(resumeButton,resumeNote);
    let resumeMode:'immersive-ar'|'immersive-vr'|null=null;
    resumeButton.addEventListener('pointerdown',()=>{pointerDowns=Math.min(65535,pointerDowns+1);});
    resumeButton.addEventListener('click',event=>{
      const mode=resumeMode;if(!mode || xrPending || workspace.viewer.xr.startup?.()?.pending===true)return;
      entryClicks=Math.min(65535,entryClicks+1);trustedClick=event.isTrusted;
      disarmReentry?.();
      // This click is the activation the switch could not have. Spend it on the
      // request itself and await nothing before it.
      const attempt={presented:false,exited:false};xrEntryAttempt=attempt;
      xrPending=true;xrProblem='';resumeButton.disabled=true;
      note.dataset.state='starting';note.textContent='Entering headset view…';refresh.hidden=true;
      if(isCompanion && !isAppleSafariXr(navigator)) void primePushToTalkMicrophone();
      void enterImmersiveWithFallback(m=>{
        if(xrEntryAttempt!==attempt || attempt.presented)return Promise.reject(Error('The headset entry was interrupted.'));
        return workspace.viewer.xr.enter(m);
      },mode,()=>{if(xrEntryAttempt===attempt && !attempt.presented)note.textContent='Passthrough refused; opening plain VR…';})
        .catch((error:Error)=>{if(xrEntryAttempt!==attempt || (attempt.exited && !workspace.viewer.xr.startup?.()?.reloadRequired))return;recordHeadsetEvent('page-error',{operation:'resume-headset',message:thrownErrorMessage(error)});xrProblem='Could not open the headset view. Try again.';refresh.hidden=false;})
        .finally(()=>{if(xrEntryAttempt!==attempt)return;xrEntryAttempt=undefined;xrPending=false;resumeButton.disabled=false;void syncXr();});
    });
    const leave=document.createElement('button');leave.type='button';leave.dataset.leaveXr='';leave.textContent='Leave headset view';leave.disabled=true;
    leave.addEventListener('click',()=>{
      xrPending=true;xrProblem='';leave.disabled=true;
      void workspace.viewer.xr.end().catch((error:Error)=>{recordHeadsetEvent('page-error',{operation:'leave-headset',message:thrownErrorMessage(error)});xrProblem='Could not leave the headset view. Try again.';})
        .finally(()=>{xrPending=false;void syncXr();});
    });
    optionsBody.append(leave);
    // Desktop HTTPS previews use the same canvas recorder. Keep it out of
    // immersive sessions, where Quest's own recorder is the correct source.
    optionsBody.append(recording);
    for(const selector of ['[data-action="rotation"]','[data-action="fit"]']) {
      const previewControl=document.querySelector(selector);
      if(previewControl) optionsBody.append(previewControl);
    }
    const diagnostics=document.querySelector('.companion-diagnostics');
    if(diagnostics)optionsBody.append(diagnostics);
    controls.append(options,refresh,note);document.querySelector('#app')!.append(controls);
    // Top of the page, above the preview and the entry row, because a wearer
    // who has just been dropped out of immersion looks at the top first.
    document.querySelector('#app')!.prepend(resume);
    async function syncXr() {
      const sequence=++xrSyncSequence, ownGeneration=generation;
      const capabilities=await workspace.viewer.xr.capabilities();
      if(closed || sequence!==xrSyncSequence || ownGeneration!==generation)return;
      arSupported=capabilities.ar===true; // Enter VR prefers passthrough when Quest offers it.
      const presenting=workspace.snapshot().xrPresenting;
      // Any session at all, however it started, has spent the shortcut.
      if(presenting)disarmReentry?.();
      updateVoiceUi();
      recording.hidden=presenting;
      if(!presenting){hudSignature='';hudWaitingSince=0;}
      const startup=workspace.viewer.xr.startup?.();
      // Native exit can retire the session before the entry promise settles.
      // Recover only an attempt that actually presented and whose native
      // startup is now idle with no request pending; consent and cleanup still
      // keep admission closed. Retire its owner so late fallback/finally work
      // cannot issue another request or clear a newer entry's pending state.
      if(xrEntryAttempt?.presented && !presenting && startup?.phase==='idle' && startup.pending===false) {
        xrEntryAttempt=undefined;clearTimeout(entryWatchdog);xrPending=false;xrProblem='';
      }
      const entryBusy=xrPending || startup?.pending===true;
      const reloadRequired=startup?.reloadRequired;
      // A switch the browser refused is waiting on one press here.
      // A page that needs reloading cannot serve that press, so it keeps its own
      // reload path instead of showing a button that would fail.
      const pendingEntry=reloadRequired||presenting?null:startup?.pendingEntry??null;
      resumeMode=pendingEntry?pendingEntry.mode:null;
      resume.hidden=!pendingEntry;
      resumeButton.disabled=entryBusy;
      if(pendingEntry) {
        const copy=entryFallbackCopy(pendingEntry.mode);
        resumeButton.textContent=copy.label;resumeNote.textContent=copy.note;
      }
      // While it is up it is the only thing to press. The entry row and the
      // disclosure both offer the same modes by other names, and a wearer
      // choosing between four controls with a controller ray is the problem.
      entryActions.hidden=Boolean(pendingEntry);
      options.hidden=Boolean(pendingEntry);
      // The primary button falls back to immersive-vr, so only a browser with
      // neither mode disables it. The plain-VR button needs immersive-vr.
      for(const button of enterButtons)button.disabled=entryBusy || reloadRequired || presenting
        || (button.dataset.enterXr==='immersive-vr' ? capabilities.vr===false : capabilities.ar===false && capabilities.vr===false);
      const vrButton=enterButtons.find(button=>button.dataset.enterXr==='immersive-vr')!;
      const arButton=enterButtons.find(button=>button.dataset.enterXr==='immersive-ar')!;
      // A wearer coming back from the full Mol* viewer
      // gets one control, not three. See `xrReentryEntryView`.
      const returning=xrReentryEntryView({returning:reentryArmed,presenting,pending:entryBusy,
        problem:xrProblem,pendingEntry:Boolean(pendingEntry),enterDisabled:arButton.disabled});
      vrButton.hidden=returning.single;
      arButton.hidden=false;
      arButton.dataset.primary='true';
      leave.disabled=entryBusy || !presenting;
      leave.hidden=!presenting;
      note.dataset.state=xrProblem?'error':entryBusy?'starting':presenting?'active':'connected';
      note.textContent=xrProblem || (!presenting && startup?.phase==='idle' && startup.pending===true?'Closing headset view…':entryBusy?'Opening headset view — check for a permission prompt.'
        :pendingEntry?entryFallbackCopy(pendingEntry.mode).caption:presenting?'Headset view open. Use the floating menu to control the tour.':capabilities.vr===null&&capabilities.ar===null?'Ready to try headset entry. Enter VR opens passthrough wherever the browser supports it.':capabilities.ar?'Enter VR opens the headset view with passthrough. Enter plain VR, under More options, opens the opaque room.':capabilities.vr?'This browser reports no passthrough, so Enter VR opens the opaque headset view.':'Preview ready. Open this page on your headset, then choose Enter VR.');
      // While one tap is the way back into VR, that is the only
      // thing this line has to say. Nothing overrides a problem or a pending
      // entry, which are both news the wearer needs more.
      // The disclosure closes with the second button,
      // so there is one visible way in and one line about it.
      if(returning.single) {
        note.textContent=returning.line!;
        options.open=false;options.hidden=true;
      }
    }
    // Native/system exit bypasses the Leave button's finally handler. Update
    // the real controls on that edge rather than waiting for the fallback poll.
    const unwatchPresentation=workspace.viewer.xr.onPresentationChange((presenting:boolean)=>{
      if(presenting) {
        if(xrEntryAttempt)xrEntryAttempt.presented=true;
        activePreviewRecording?.abort();
      } else if(xrEntryAttempt?.presented)xrEntryAttempt.exited=true;
      void syncXr().catch(()=>{});
    });
    await syncXr();
    // The way back in from the full Mol* viewer.
    //
    // "Open in Mol*" ends the session and sends this tab to /detailed; its
    // Back link sends it here and leaves a same-tab hint. The tap that
    // followed the link cannot be spent on `requestSession`, because a
    // navigation carries no transient activation into the next document, so
    // Enter VR is put in view and under focus and the next tap on the page
    // background is spent on it instead. A tap on any real control is that
    // control's; `xr-reentry-hint.ts` draws that line and expires the hint.
    if(isCompanion) {
      const hintStorage=(()=>{try{return window.sessionStorage;}catch{return null;}})();
      const arButton=enterButtons.find(button=>button.dataset.enterXr==='immersive-ar');
      // The return half of the leave/return ring record.
      //
      // `viewer.mjs` records the `workbench` entry for the leg out. Nothing
      // recorded the leg home, so a hardware run could show the wearer going
      // to Mol* and then simply stop, with no way to tell a wearer who came
      // back in eight seconds from one who was stranded for four minutes. The
      // detailed page is a stock Mol* document with none of this page's
      // modules in it, so the companion is the only end that can write the
      // entry; the hint carries when the wearer left and which control they
      // used, and the arithmetic happens here. An expired hint is recorded
      // too: "away 9 minutes, hint stale" is exactly the stranding to see.
      const hint=readXrReentry(hintStorage);
      if(hint.via!==undefined)recordHeadsetEvent('workbench',{event:'returned',via:hint.via,
        ...(typeof hint.awayMs==='number'?{awayMs:Math.round(hint.awayMs)}:{}),
        armed:hint.fresh&&Boolean(arButton),...(hint.fresh?{}:{hintExpired:true})});
      if(arButton && hint.fresh) {
        const reentry=armXrReentryTap({document,button:arButton,onState:state=>{
          reentryArmed=state==='armed';
          document.body.dataset.reenterXr=state;
          void syncXr().catch(()=>{});
        }});
        disarmReentry=()=>{disarmReentry=undefined;reentry.disarm();};
        window.addEventListener('pagehide',()=>{disarmReentry?.();},{once:true});
      }
    }
    const xrTimer=setInterval(()=>{void syncXr().catch(()=>{});},2000);
    window.addEventListener('pagehide',()=>{unwatchPresentation();clearInterval(xrTimer);clearTimeout(entryWatchdog);},{once:true});
  } else {
    await app.connect(new PostMessageTransport(window.parent,window.parent));
    if(app.getHostCapabilities()?.message?.text)readinessActions['ask-assistant']=async()=>{
      const response=await app.sendMessage({role:'user',content:[{type:'text',text:
        'Please join this Stereofold lesson. Listen for headset voice requests and answer them in the headset.'}]});
      if(response.isError)throw Error('The assistant could not join this lesson.');
    };
    size();
    // The check card and the stage ask for different heights, so the card is
    // resized each time the page moves between them.
    new MutationObserver(()=>sendSize()).observe(document.body,{attributes:true,attributeFilter:['data-ready']});
  }
  syncTheme();
  if(isCompanion) {
    // Repaint the Talk row on connection edges, including successful recovery.
    // The caption reads persistent link state even when this transient line is empty.
    const unwatchConnection=subscribeConnectionStatus(()=>showHeadsetCaption(''));
    connectionWatchdog=createConnectionWatchdog({poll,deadlines:companionConnectionFrame,intervalMs:250,
      active:()=>!closed && Boolean(binding),
      onMissed:()=>showConnectionProblem({code:'companion_connection'},generation)});
    setConnectionFrameHandler(()=>connectionWatchdog.frame());
    setConnectionRecovery(()=>location.assign('/'+location.search));
    // A frozen page is not a closed one.
    //
    // This teardown ran on any `pagehide`, once, and never came back. A browser
    // that fires `pagehide` with `persisted` -- a back/forward cache freeze, and
    // on a headset the moment the flat page stops being the foreground document
    // -- therefore unwired the XR frame clock permanently. Window timers are
    // frozen inside an immersive session, so that clock is the only thing that
    // retires a stalled request: with it gone, a Mac that stops answering
    // produces no error, no lost-link line and no Talk row change, which is what
    // the wearer met. Only a page that is really going away tears the
    // watchdog down, and the listener stays registered for that.
    window.addEventListener('pagehide',event=>{
      if((event as PageTransitionEvent).persisted)return;
      unwatchConnection();connectionWatchdog?.dispose();setConnectionFrameHandler(undefined);setConnectionRecovery(undefined);
    });
  }
  armPoll();
  if(!isCompanion)window.addEventListener('resize',size);
  window.addEventListener('pagehide',()=>{closed=true;activePreviewRecording?.abort();generation++;if(timer)clearTimeout(timer);if(pollTimer)clearTimeout(pollTimer);
    // Browser navigation can hide the companion before its Exit handler runs.
    // Join the viewer's session teardown while detaching the Mac transport.
    void workspace?.viewer.xr?.end().catch(()=>{});
    void detach().finally(()=>app.close());},{once:true});
}
void boot().catch(error=>{
  document.body.dataset.ready='error';
  const status=document.querySelector('#status')!;
  // A share that has closed is not a viewer that failed.
  // The Mac's share window shuts on its own about half an hour after the last
  // pairing, and a headset opening the companion after that used to read "The
  // viewer couldn't finish starting. The structure couldn't load." over a
  // Reload button that reloads into the same closed door. Nothing in the
  // headset can reopen a share, so the page says who can. There is no retry
  // here on purpose: knocking on a closed share is the endless wait again.
  // `call()` rewrote a failed `get_inspection` into the flat
  // page's sentence about a structure, so `message` can no longer say whether
  // the socket found nobody or the 15 s deadline simply ran out. The transport's
  // own words survive on the failed request, with hydrated details as a fallback,
  // and they are the difference between
  // "sharing ended" and a Reload that would have worked.
  const shareEnded=isCompanion?companionStartupMessage({code:(error as any)?.code,
    status:(error as any)?.status,message:(error as Error)?.message,
    detail:typeof (error as any)?.inspectionLoadDetail==='string'
      ?(error as any).inspectionLoadDetail:loadErrorDetails||undefined}):undefined;
  document.body.dataset.startupFailure=shareEnded?SHARE_ENDED_STARTUP_FAILURE:'viewer';
  const missingPageKey=isCompanion&&(error as any)?.code==='companion_key_missing';
  status.textContent=shareEnded??(missingPageKey?'This tab needs pairing. Choose Pair again to reconnect.':`The viewer could not finish starting: ${String((error as Error)?.message ?? error).trim().replace(/[.!?]+$/u,'')}. Choose Reload viewer.`);
  if(isCompanion) {
    // Workspace normally moves status into its footer, which is hidden on Quest.
    document.body.append(status);
    status.setAttribute('role','alert');
    const reloadViewer=document.createElement('button');reloadViewer.type='button';reloadViewer.textContent=missingPageKey?'Pair again':'Reload viewer';
    reloadViewer.addEventListener('click',()=>missingPageKey?location.assign('/'+location.search):location.reload());status.append(reloadViewer);
  }
});
