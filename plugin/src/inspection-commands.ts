import { compatibleLocalSave, localSaveConflictReason } from './inspection-local-settle.js';
import { panelEntering, sameEntryScene } from './inspection-render-settle.js';
import { animationReceiptMatches } from './animation-receipt.js';
import type { AnimationState, GeometryBudgetReceipt, RequestReferent } from './inspection-contract.js';
import type { ReferentAppliedTo } from './inspection-operation.js';
import { visualEdit, visualOperation } from './inspection-operations.js';
import type { OperationContract } from './inspection-contract.js';
import { createHash, randomUUID } from 'node:crypto';
import { availabilityCauseSchema, classifyPanelAvailability, inspectionJson, expectedInspection, matchesInspectionChange, type PlacementFitEvidence, type RecenterCompletion, type EmphasisCatalog, type InspectionScene, type InspectionChange, type NamedViewIntent, type SpatialContext, type XrStartup } from './inspection-contract.js';

export type InspectionBinding = {serverEpoch:string; sourceToken:string; stateRevision:number; inspectionRevision:number};
type SourceUtteranceContinuation={utteranceId:string;binding:InspectionBinding};
/** A voice refusal may explain a changed binding without authorizing an edit. */
export class UtteranceBindingError extends Error {}
export type InspectionSourceOperation = {signal:AbortSignal; utteranceId?:string; panelId:string; commandId:string;
  assertCurrent:()=>void; release:()=>void};
type Expected = {serverEpoch:string; sourceToken:string; baseStateRevision:number; baseInspectionRevision:number};
export type TourCommandClaim = Expected & {panelId:string;commandId:string;claimToken:string};
export type InspectionViewChange = {kind:'save-view';patch:{name:string;replaceViewId?:string}}
  | {kind:'restore-view';patch:{viewId:string;scene:InspectionScene;namedViewIntent?:NamedViewIntent}};
type CommandChange = InspectionChange|InspectionViewChange;
type FocusReceipt = {residueCount:number;modelledResidueCount:number;missingCoordinateCount:number};
type Request = Expected & {deferLocalSave?:boolean; assistantName?:string; waitForRenderMs?:number;focus?:FocusReceipt;requestIdentity?:unknown; referent?:RequestReferent; appliedTo?:ReferentAppliedTo; panelId:string; commandId:string; utteranceId?:string; actionPostedAt?:number; change:CommandChange};
/**
 * `saved` is an edit the host saved for a paused headset page.
 *
 * It is not `rendered`: no panel drew it. The saved scene holds it, and the
 * page draws it when it next checks in awake, by following the saved scene the
 * way it follows an edit made on the Mac. `savedRevision` is the revision that
 * holds it, and `wearerPaused` says why the page could not draw it.
 */
type Status = 'queued'|'rendering'|'rendered'|'saved'|'conflict'|'rejected'|'expired'|'unconfirmed'|'cancelled'|'superseded';
/**
 * `heldForPanel` marks a command admitted while its panel was `busy`, or while
 * its superseded render was discarding unsaved work. A system dialog or drag
 * can also keep the panel busy. It
 * rides the receipt so the agent can say the change landed after the blur
 * rather than reporting it as an ordinary immediate render.
 */
/**
 * `scaleAppliesOnNextEntry` marks a rendered render-quality command whose
 * framebuffer half is still pending: the level is in force now for
 * representation detail, and the resolution rises when the wearer next enters
 * an immersive session, because an XRWebGLLayer's scale is fixed at build time.
 * It rides the receipt so the agent can say "sharper after re-entry" rather
 * than reporting a picture the wearer has not been shown yet.
 */
type FenceRelease = 'rolled-back'|'deadline'|'panel-lost'|'recovery-failed';
type Receipt = {assistantName?:string; action?:string;focus?:FocusReceipt;comparison?:{alignment:'side-by-side';sourceSha256:string;modelNumber:number;assemblyId:string};appliedTo?:ReferentAppliedTo; supersededBy?:string; fenceReleased?:FenceRelease|'pending'|'replacement-rendered'; utteranceSequence?:number; operation:OperationContract; acceptedAt:number; renderedAt?:number; actionPostedAt?:number; utteranceId?:string; commandId:string; panelId:string; status:Status; reason?:string; detail?:string; renderedRevision?:number; heldForPanel?:boolean; scaleAppliesOnNextEntry?:boolean;geometryBudget?:GeometryBudgetReceipt; animation?:AnimationState; renderBudgetMs?:number;
  savedRevision?:number; wearerPaused?:WearerPause};
type Command = {input:Request; signature:string; expected?:InspectionScene; receipt:Receipt; deadline:number; claimToken?:string; issuedAt:number; admitted?:boolean; renderFence?:boolean;
  toolRequest?:{tool:string;fingerprint:string};
  localBase?:InspectionScene; deliveryDeadline?:number;
  /** One entry allowance per command; heartbeats and retries cannot renew it. */
  entryHold?:{until:number;ready:boolean};
  /** When `renderFence` came down, so a queued edit can tell whether a fence stood at its deadline. */
  fenceReleasedAt?:number;
  replacesCommandId?:string; replacementCommandId?:string; holdReason?:string;
  tourTransition?:{binding:InspectionBinding;panelId:string;restoring?:boolean}};
type Utterance = {utteranceId:string;sequence:number;panelIds:string[];binding:InspectionBinding;supersededBy?:string;renderingCommandIds:string[];
  /** The lesson playing in this utterance's panel when the wearer began speaking. */
  tour?:{selectedId?:string};
  /** A source swap was already in flight for this utterance's panel when the wearer began speaking. */
  swapPending?:boolean;
  /** The binding followed a placement save the wearer made after the words began. See `settleLocalSave`. */
  wearerMoved?:boolean};
type SpatialSample = { value:SpatialContext; receivedAt:number };
type TourState = {selectedId?:string;step:number;total:number;active:boolean;autoplay:boolean;narration?:boolean;navigating:boolean};
/** Which authored lesson a panel is showing, and which chapter of it. */
type ExperienceChapter = {experienceId:string;stepIndex:number};
/** The lesson a panel is showing, from either player: the tour or a journey. */
type PanelLesson = {selectedId?:string;step:number};
/**
 * `detailed` is the full Mol* viewer page.
 *
 * It is a third surface rather than a flag on `companion` because the two want
 * different things from the registry. A companion draws the wearer's immersive
 * scene and takes every command there is; a detailed page draws the saved
 * picture inside the stock viewer and takes the three that are pictures of it.
 * Both run in the same headset browser, so they share the long grace below, and
 * both are the wearer, so both are offered the caption mailbox.
 */
type Panel = Expected & {panelId:string; seen:number; attachedAt:number; visibleAt?:number; availability:'ready'|'busy'|'unsaved'; surface:'desktop'|'companion'|'detailed'; pageBuild?:string; unsavedSince?:number; sourceRecoveryUntil?:number; spatial?:SpatialSample;animation?:AnimationState|null;tourState?:TourState;xrStartup?:{value:XrStartup;receivedAt:number};registrationFrom?:InspectionBinding;registeringRevision?:boolean;
  renderedSourceSha256?:string; referenceOnly?:boolean;
  /** When a report last showed the immersive frame count move in a visible session. See `wearerPage`. */
  xrDrawnAt?:number;
  /** The authored lesson and chapter this panel last said it was showing. */
  experience?:ExperienceChapter;
  /** The chapter this panel last said it was on, and the saved revision it said it on. */
  tourChapter?:{selectedId?:string;step:number;inspectionRevision:number;pending?:boolean}};
const same = (a:Expected & {referenceOnly?:boolean},b:InspectionBinding) => !a.referenceOnly && a.serverEpoch===b.serverEpoch && a.sourceToken===b.sourceToken
  && a.baseStateRevision===b.stateRevision && a.baseInspectionRevision===b.inspectionRevision;
/**
 * The lesson a panel is showing, whichever player runs it.
 *
 * Stereofold has two. The tour player reports itself in the heartbeat's
 * `tourState`, and its chapter is `step`. An authored lesson is a journey: it
 * draws each chapter through its own navigate-and-acknowledge transaction, and
 * its `tourState` says `active:false` for the whole run, so a
 * hemoglobin lesson autoplaying a chapter every 17 s looked to the host like a
 * panel with no lesson at all, and the wearer's "Stop, go back to my view" was
 * refused seven seconds after the words. Both report the same two facts, so
 * everything downstream — which lesson began an utterance, which lesson is
 * playing now, which advance was a chapter — reads them from here.
 *
 * A live tour player wins: it is the surface the wearer's tour controls speak
 * to, and its beat is the fresher of the two.
 */
const lessonOf = (panel?:Pick<Panel,'tourState'|'experience'>):PanelLesson|undefined =>
  panel?.tourState?.active ? {...(panel.tourState.selectedId===undefined?{}:{selectedId:panel.tourState.selectedId}),step:panel.tourState.step}
  : panel?.experience ? {selectedId:panel.experience.experienceId,step:panel.experience.stepIndex}
  : undefined;
/**
 * The tour controls a wearer's "stop" can reach.
 *
 * These three end or suspend the lesson. Nothing in this set draws a new
 * chapter, opens the menu or starts anything, so forgiving the revisions the
 * tour itself advanced cannot make an older request act on a newer scene.
 */
const TOUR_STOP_ACTIONS = new Set(['done','restore-start','pause']);
const revisionKey = (b:InspectionBinding) => JSON.stringify([b.serverEpoch,b.sourceToken,b.stateRevision]);
const MAX_TOUR_REVISION_SOURCES = 4;
const MAX_TOUR_REVISIONS = 512;
const pending = (c:Command) => c.receipt.status==='queued' || c.receipt.status==='rendering';
/** Whether a change sets where the structure sits: a placement, a focus framing, a restored view or a framed install. */
const movesPlacement = (change?:{kind:string;patch?:any}):boolean => change?.kind==='placement' || change?.kind==='focus'
  || change?.kind==='restore-view' || (change?.kind==='lesson' && change.patch?.frame===true)
  || (change?.kind==='compound' && Array.isArray(change.patch?.ops) && change.patch.ops.some(movesPlacement));
const SPATIAL_STALE_MS = 3_000;
const PANEL_HEARTBEAT_GRACE_MS = 10_000;
const PANEL_ENTRY_HOLD_MS = 45_000;
/**
 * A headset panel gets six times the desktop grace.
 *
 * Taking a Quest off does not close its page: the browser freezes and throttles
 * it, and the heartbeat stops without a `pagehide`. Ten seconds is shorter than
 * the pause a wearer takes to answer a question, so the panel was deleted and
 * the demo could not be resumed by putting the headset back on. A desktop tab
 * has no equivalent pause, so its grace is unchanged.
 */
const COMPANION_HEARTBEAT_GRACE_MS = 60_000;
/**
 * A headset panel that said `busy` before it went quiet.
 *
 * `busy` is the page reporting heavy work in flight — a scene build, a
 * representation rebuild, a hydrate — and heavy work on a Quest 2 is the one
 * thing that can stop the beat without the page being gone: the beat is
 * JavaScript, and a main thread inside Mol* geometry does not run JavaScript.
 * The microtubule wall stage, 40,908 atom sites, runs the headset
 * at 3 fps for the whole tour window. The minute of ordinary companion grace is
 * an unrelated measure — it is how long a wearer might hold the headset off —
 * and a rebuild at that scale can outlast it. Only a panel that last said
 * `busy` gets this; a `ready` panel that stops beating is gone as before.
 */
const BUSY_COMPANION_GRACE_MS = 180_000;
// A detailed page runs in the same headset browser as a companion, and is
// frozen and throttled by the same pause when the wearer lifts the headset, so
// it is given the same grace rather than the desktop's ten seconds.
const graceFor = (panel:Pick<Panel,'surface'|'availability'>) => panel.surface==='desktop'?PANEL_HEARTBEAT_GRACE_MS
  :panel.availability==='busy'?BUSY_COMPANION_GRACE_MS:COMPANION_HEARTBEAT_GRACE_MS;
/**
 * How long "the wearer walked over to the Mol* detail view" stays true.
 *
 * Pressing Open in Mol* in the headset sends that same browser tab to
 * `/detailed`, so the companion page unloads and its panel detaches. For as
 * long as the wearer is over there the registry is empty, and without this an
 * agent command answers "Open the printed address in a browser" — desktop
 * instructions read out to someone wearing a headset. The departure is
 * remembered so the answer can name where the wearer actually is. It is a hint
 * with a horizon, not state: a returning companion clears it, and a wearer who
 * never comes back stops being reported as in Mol* after this.
 */
const DETAILED_VIEW_AWAY_MS = 10 * 60_000;
/**
 * Why a headset page cannot draw right now, read from its own
 * check-ins.
 *
 * On 2026-09-28 a Quest 2 asleep on a desk took an agent's colour edit while
 * its page was hidden, could not draw a frame, and rejected it thirty seconds
 * later as `render_failed`; the saved scene kept the old colours. New users do
 * exactly this: put the headset down, type on the Mac, put it back on.
 *
 * - `page-hidden`: the flat page says its document is hidden and it is not
 *   presenting. Quest Browser hides it when the headset sleeps.
 * - `headset-hidden`: the page is presenting and says the immersive session is
 *   hidden: the headset is off the head, or a prompt such as Confirm boundary
 *   is in front of it.
 * - `silent`: the page has stopped checking in (see `WEARER_SILENT_MS`).
 *
 * A blurred session is not a pause. A system dialog blurs it for two to five
 * seconds with the wearer still inside, and `poll` already holds a command
 * through that.
 */
export type WearerPause = 'page-hidden'|'headset-hidden'|'silent';
/**
 * What the host can say about the wearer's page without asking the person.
 *
 * `page-open` is a page drawing the scene on the flat browser page, which is
 * where a launched page waits for Enter VR. `in-vr` is a page presenting an
 * immersive session whose frame count moved in a visible session; see
 * `XR_FRAME_FRESH_MS`. `entering-vr` is a page presenting without that
 * evidence: the session started and its render loop has not drawn a frame, or
 * a system dialog blurs it. `unknown` is a page the registry dropped after its
 * grace, which the host cannot tell apart from a closed tab.
 */
export type WearerPageState = 'no-page'|'page-open'|'entering-vr'|'in-vr'|'paused'|'unknown';
/**
 * `checkedInAt` is the page's last check-in on the host's clock, in epoch
 * milliseconds. It is absolute rather than an age so that the same state read
 * twice, or a retried call, answers the same; only the one-line state text
 * turns it into "checked in N s ago".
 */
export type WearerPage = {state:WearerPageState; panelId?:string; checkedInAt?:number; pausedBecause?:WearerPause};
/**
 * How long a headset page may go without checking in before it counts as paused.
 *
 * A visible headset page checks in every 250 ms, and a hidden one about once a
 * second while its browser still runs timers (`armPoll` in inspector.ts). Five
 * seconds is twenty visible beats: a slow Wi-Fi answer does not read as a
 * sleeping headset, and an edit sent just after the headset went dark is still
 * kept inside the call that sent it.
 */
export const WEARER_SILENT_MS = 5_000;
/**
 * How long a headset page dropped for silence is still kept edits for.
 *
 * The registry drops a silent headset panel after its grace, but a page frozen
 * by a sleeping headset runs again when the headset is put on, re-attaches and
 * loads the saved scene. Until then the host keeps its last check-in, so an
 * edit sent meanwhile is saved for it rather than refused for want of a panel.
 * A closed tab sends no parting message, so this cannot tell one from a
 * sleeping headset, and the page reads as `unknown` rather than `paused`;
 * thirty minutes bounds how long the host keeps waiting for it.
 */
const QUIET_WEARER_MEMORY_MS = 30 * 60_000;
/**
 * How recent the last moving frame count must be for a presenting page to
 * read as `in-vr`, measured at the host's current time.
 *
 * The page counts an immersive frame only when Mol* drew it into a visible
 * session (`installHeadFrameObserver` in immersive-session.mjs), and it
 * reports the count on every check-in. `presenting` alone is true from the
 * moment the browser grants the session, before the render loop starts, and
 * through a blurred session. Two seconds holds a Quest 2 drawing 3 fps on the
 * microtubule wall, which moves the count at least every 333 ms.
 */
const XR_FRAME_FRESH_MS = 2_000;
/**
 * The edits the host can save for a paused headset page by itself.
 *
 * Each turns the saved scene into exactly the scene the page saves after
 * drawing it, so saving it here and letting the page draw it on waking gives
 * the same picture. The rest need the page: a focus and a placement are solved
 * against the wearer's head and room, a tour, spin or detail level is page
 * state, and a comparison structure has to be loaded.
 */
const KEPT_WHILE_PAUSED = new Set<string>(['appearance','styles','selection','visibility','emphasis']);
const keptWhilePaused = (change:CommandChange) => change.kind==='compound'
  ? change.patch.ops.every(op=>KEPT_WHILE_PAUSED.has(op.kind)) : KEPT_WHILE_PAUSED.has(change.kind);
const KIND_WORDS:Record<string,string> = {'render-quality':'detail level','companion-structure':'comparison structure',
  motion:'spin',compound:'combined','save-view':'saved view','restore-view':'saved view'};
const secondsText = (ms:number) => `${ms<10_000?(ms/1000).toFixed(1):Math.round(ms/1000)} s`;
/**
 * Why a paused headset page cannot draw, in words a person can act on. A
 * sentence in a structured field leaves out the age of the last check-in, so
 * that it reads the same on every call; only a one-off answer carries it.
 */
export function wearerPauseReason(pause:{reason:WearerPause;checkedInMsAgo?:number}) {
  return pause.reason==='headset-hidden'
    ? 'the headset is not showing the VR view, because it is off the wearer\'s head or a headset prompt such as Confirm boundary is in front of it'
    : pause.reason==='page-hidden'
      ? 'the headset browser has hidden the page, because the headset is asleep or another app is in front'
      : `the headset page ${pause.checkedInMsAgo===undefined?'stopped checking in':`has not checked in for ${secondsText(pause.checkedInMsAgo)}`}; `
        +'the headset is asleep, or the page was closed';
}
/**
 * What a waking page does with the saved placement.
 *
 * A page follows a saved scene with `restoreShared`, which keeps a placement
 * the wearer made by hand (`wearerPlacement.holdsPlacement` in viewer.mjs):
 * that placement is local by design, so a shared update never moves the
 * molecule out from under the wearer. A molecule moved on this Mac while the
 * headset slept therefore stays where the wearer left it, and the saved scene
 * and the headset disagree about placement until the wearer moves it again.
 */
const WEARER_PLACEMENT_STAYS = 'If the wearer moved the molecule by hand, it stays where they put it; a placement saved on this Mac does not move it.';
/** The answer to an edit the host saved for a paused headset page. */
export function wearerKeptSentence(pause:{reason:WearerPause;checkedInMsAgo:number}) {
  return `Saved, not drawn: ${wearerPauseReason(pause)}. The headset page draws the saved change by itself when it is showing again; `
    +`nothing needs resending. ${WEARER_PLACEMENT_STAYS} Status "saved" is not "rendered", so do not say the wearer has seen it.`;
}
/** The wearer's page state as the one-line state answer carries it, with its age at `now`. */
export function wearerStateText(page:Pick<WearerPage,'state'|'checkedInAt'>, now:number) {
  return `wearer.state ${page.state}${page.checkedInAt===undefined?'':`, checked in ${secondsText(Math.max(0,now-page.checkedInAt))} ago`}`;
}
/** What a paused page means for the agent reading it, and what to do meanwhile. */
export function wearerPausedNote(page:WearerPage) {
  return `The headset page is paused: ${wearerPauseReason({reason:page.pausedBecause??'silent'})}. `
    +`Edits sent now are saved and drawn when the page is showing again. ${WEARER_PLACEMENT_STAYS} `
    +'Wait for wearer.state to change instead of reconnecting, and do not describe anything as seen until it does.';
}
/** What a page dropped for silence means, when nothing says whether it sleeps or was closed. */
export function wearerUnknownNote() {
  return 'The headset page stopped checking in, and after its grace the host dropped it: '
    +'the headset may be asleep, or the page may be closed. Edits sent now are saved and drawn if the page comes back. '
    +'Do not tell the person the headset is asleep. If wearer.state stays unknown after they say the headset is on, read manage_companion action="status" and diagnose the current page. Use action="launch" for a fresh launch; call open_companion only when the share has closed.';
}
/**
 * Why an edit was not sent to a paused page. `kind` names an edit the host
 * cannot save for later; without it the caller simply had no way to keep one.
 */
export function wearerPausedRefusal(pause:{reason:WearerPause;checkedInMsAgo:number}, kind?:string) {
  return `Not sent: ${wearerPauseReason(pause)}. `
    +(kind?`Only the headset page can apply a ${KIND_WORDS[kind]??kind} change, so the host does not save it for later. `:'')
    +'Send it again when get_inspection_state reports wearer.state "page-open" or "in-vr".';
}

export type CompanionLoadState = {
  status:'loading'|'timed-out'; elapsedMs:number; budgetMs:number;
  lastPanel:{panelId:string;availability:string;stateRevision:number;inspectionRevision:number};
};

/**
 * What `control_tour` tells the agent it just did.
 *
 * The tool used to answer every action with the state sentence and a receipt
 * whose status is "queued". An agent sent `back` twice on a
 * lesson nobody had started, read "queued" both times, and had no way to know
 * the tour had not moved, so the press looked like nothing happening.
 * The receipt is unchanged; the sentence beside it now
 * names the outcome, including the one case a reader would otherwise get
 * wrong, where next or back has to start the lesson first.
 *
 * `tour` is the target panel's last heartbeat, so this is what the panel was
 * doing when the command was admitted, not a promise about the render.
 */
export function tourCommandSentence(action:string, tour?:TourState|null) {
  const check='Check get_inspection_state with this commandId for its rendered receipt.';
  const running=Boolean(tour?.active), at=(tour?.step??-1)+1, total=tour?.total??0;
  const scene=(n:number)=>total>0?`scene ${n} of ${total}`:`scene ${n}`;
  const scheduled='with the "Tour started." announcement scheduled; hearing is unconfirmed.';
  if(action==='next'||action==='back') {
    if(!running) return `No tour was running, so this starts the lesson at ${action==='next'?'scene 1':'its last scene'} ${scheduled} ${check}`;
    const target=action==='next'?at+1:at-1;
    if(target<1||(total>0&&target>total))
      return `This tour is already at ${scene(at)}, so the panel has no scene in that direction and will refuse this. ${check}`;
    return `Moving this tour from scene ${at} to ${scene(target)}. ${check}`;
  }
  if(action==='play') return running
    ? `Playing this tour from ${scene(at)}. ${check}`
    : `No tour was running, so this starts the lesson ${scheduled} ${check}`;
  if(action==='pause') return running
    ? `Pausing this tour at ${scene(at)}. ${check}`
    : `No tour is running in this panel, so this pause changes nothing on screen. ${check}`;
  if(action==='start') return `Starting the named lesson at its first scene ${scheduled} ${check}`;
  if(action==='rejoin') return running || at<1
    ? `Returning this tour to the chapter it stopped at. ${check}`
    : `Returning this tour to ${scene(at)}. ${check}`;
  if(action==='done') return `Restoring your pre-tour view. ${check}`;
  if(action==='restore-start') return `Restoring the view this lesson started from. ${check}`;
  if(action==='menu') return `Opening the lesson menu in this panel. ${check}`;
  return `Sending ${action} to this panel's tour. ${check}`;
}

// A bounded, panel-specific delivery mailbox. This does not reserve scientific
// state: manual saves may win the CAS while a command is in flight.
export class InspectionCommands {
  // A successful undo with no history is still an outcome. A transport retry
  // must not take back a manual edit made after that answer.
  private toolNoops=new Map<string,{tool:string;fingerprint:string;originalBinding:Expected & {panelId:string}}>();
  // A pruned receipt or a replaced queue must not make an implicitly bound
  // retry a fresh edit. Only IDs are shared for the session's lifetime.
  private toolRequestFingerprint(input:Record<string,unknown>) {
    const {commandId:_id,...request}=input;
    return createHash('sha256').update(inspectionJson(request)).digest('hex');
  }
  private assertReceiptRetained(commandId:string) {
    if(this.usedToolCommandIds.has(commandId) && !this.commands.has(commandId) && !this.toolNoops.has(commandId))
      throw Error('This command receipt has expired from history. The request was not repeated. Read the current inspection state and use a new commandId only for a new edit.');
  }
  private assertNotToolNoop(commandId:string) {
    if(this.toolNoops.has(commandId)) throw Error('This commandId was already used for a different request.');
  }
  rememberToolNoop(tool:string,input:Record<string,unknown>,binding:Expected & {panelId:string;commandId:string}) {
    this.assertReceiptRetained(binding.commandId);
    const fingerprint=this.toolRequestFingerprint(input),previous=this.toolNoops.get(binding.commandId);
    if(previous?.tool===tool && previous.fingerprint===fingerprint) return;
    if(this.commands.has(binding.commandId) || this.controls.has(binding.commandId) || previous)
      throw Error('This commandId was already used for a different request.');
    if(this.toolNoops.size>=32) this.toolNoops.delete(this.toolNoops.keys().next().value!);
    const {serverEpoch,sourceToken,baseStateRevision,baseInspectionRevision,panelId}=binding;
    this.toolNoops.set(binding.commandId,{tool,fingerprint,
      originalBinding:{serverEpoch,sourceToken,baseStateRevision,baseInspectionRevision,panelId}});
    this.usedToolCommandIds.add(binding.commandId);
  }
  rememberToolRequest(tool:string,input:Record<string,unknown>,commandId:string) {
    const command=this.commands.get(commandId);
    if(command && !command.toolRequest) {
      command.toolRequest={tool,fingerprint:this.toolRequestFingerprint(input)};
      this.usedToolCommandIds.add(commandId);
    }
  }
  /** Replay the receipt before optional bindings or selection are resolved again. */
  retryToolRequest(tool:string,input:Record<string,unknown>,binding:InspectionBinding) {
    if(typeof input.commandId!=='string') return undefined;
    this.assertReceiptRetained(input.commandId);
    this.refresh(binding);
    const noop=this.toolNoops.get(input.commandId);
    if(noop) {
      if(noop.tool!==tool || noop.fingerprint!==this.toolRequestFingerprint(input))
        throw Error('This commandId was already used for a different request.');
      return {commandId:input.commandId,outcome:{undone:false as const},originalBinding:{...noop.originalBinding}};
    }
    const command=this.commands.get(input.commandId);
    if(!command?.toolRequest) return undefined;
    if(command.toolRequest.tool!==tool || command.toolRequest.fingerprint!==this.toolRequestFingerprint(input))
      throw Error('This commandId was already used for a different request.');
    const {serverEpoch,sourceToken,baseStateRevision,baseInspectionRevision,panelId}=command.input;
    return {command:{...command.receipt},originalBinding:{serverEpoch,sourceToken,baseStateRevision,baseInspectionRevision,panelId}};
  }
  private pruneCommand(id:string,command:Command) {
    if(command.toolRequest) this.usedToolCommandIds.add(id);
    this.commands.delete(id);
  }
  private receiptListeners=new Map<string,Set<()=>void>>();
  /** Wake a host waiting for the panel's committed receipt. */
  onReceiptChange(commandId:string,listener:()=>void):()=>void {
    let listeners=this.receiptListeners.get(commandId);
    if(!listeners)this.receiptListeners.set(commandId,listeners=new Set());
    listeners.add(listener);
    return ()=>{listeners!.delete(listener);if(!listeners!.size)this.receiptListeners.delete(commandId);};
  }
  private receiptChanged(commandId:string) {
    for(const listener of this.receiptListeners.get(commandId)??[])listener();
  }
  // One order for attachments and commands, independent of the clock.
  private serial=0;
  private utteranceSerial=0;
  private utterances=new Map<string,Utterance>();
  /** Saved revisions a playing lesson drew for itself, per source. */
  private tourRevisions=new Map<string,Set<number>>();
  private controls=new Map<string,{signature:string;result:any}>();
  private sourceOperations=new Map<InspectionSourceOperation,AbortController>();
  /** A fetch has request ownership before it can produce a render command. */
  beginSourceOperation(input:Expected & {panelId:string;utteranceId?:string;commandId?:string},binding:InspectionBinding,
    continuation?:SourceUtteranceContinuation):InspectionSourceOperation {
    if(continuation && input.utteranceId!==continuation.utteranceId)
      throw Error('This source recovery does not own the active utterance continuation.');
    const checkUtterance=()=>{
      if(!input.utteranceId) return;
      const utteranceBinding=continuation?.binding??binding;
      // A recovery fetch belongs to the still-active request that began on the
      // previous source. Its transport binding is current, but its conversational
      // owner remains the exact prior binding until the replacement renders.
      const utteranceInput={...input,serverEpoch:utteranceBinding.serverEpoch,sourceToken:utteranceBinding.sourceToken,
        baseStateRevision:utteranceBinding.stateRevision,baseInspectionRevision:utteranceBinding.inspectionRevision};
      this.checkUtterance(utteranceInput,utteranceBinding);
    };
    checkUtterance();
    if(!same(input,binding)) throw Error('Read the current inspection before loading a source.');
    const controller=new AbortController();
    const operation:InspectionSourceOperation={signal:controller.signal,panelId:input.panelId,
      commandId:input.commandId??randomUUID(),...(input.utteranceId?{utteranceId:input.utteranceId}:{}),
      assertCurrent:()=>{controller.signal.throwIfAborted();checkUtterance();},
      release:()=>{this.sourceOperations.delete(operation);}};
    this.sourceOperations.set(operation,controller);
    return operation;
  }
  /** Only the owner of an accepted render may advance its conversational binding. */
  continueUtterance(utteranceId:string|undefined,panelId:string,previous:InspectionBinding,next:InspectionBinding,replacementPanelId=panelId) {
    if(!utteranceId) return false;
    const u=this.utterances.get(utteranceId);
    if(!u || u.supersededBy || !u.panelIds.includes(panelId)
      || u.binding.serverEpoch!==previous.serverEpoch || u.binding.sourceToken!==previous.sourceToken
      || u.binding.stateRevision!==previous.stateRevision || u.binding.inspectionRevision!==previous.inspectionRevision
      || next.serverEpoch!==previous.serverEpoch) return false;
    u.binding={...next};
    if(replacementPanelId!==panelId) u.panelIds=u.panelIds.map(id=>id===panelId?replacementPanelId:id);
    return true;
  }
  /**
   * A chapter the lesson drew for itself.
   *
   * An autoplaying tour saves a scene for every chapter, so the saved revision
   * moves while the wearer is only watching. The panel acknowledges each
   * rendered step on the revision that step committed, and that acknowledgement
   * is the only proof the server has that a particular advance came from the
   * player rather than from a hand. Recording them here is what lets a stop
   * bound to words spoken two chapters ago still be about this same scene; an
   * advance with no acknowledgement behind it is never forgiven.
   */
  recordTourRevision(panelId:string,binding:InspectionBinding) {
    const panel=this.panels.get(panelId);
    if(!panel || !same(panel,binding) || panel.surface==='desktop') return false;
    this.addTourRevision(binding,binding.inspectionRevision);
    return true;
  }
  private addTourRevision(binding:InspectionBinding,revision:number) {
    const key=revisionKey(binding);
    let revisions=this.tourRevisions.get(key);
    if(!revisions) {
      revisions=new Set();
      this.tourRevisions.set(key,revisions);
      while(this.tourRevisions.size>MAX_TOUR_REVISION_SOURCES) this.tourRevisions.delete(this.tourRevisions.keys().next().value!);
    }
    revisions.add(revision);
    while(revisions.size>MAX_TOUR_REVISIONS) revisions.delete(Math.min(...revisions));
  }
  /**
   * A chapter an authored lesson drew for itself.
   *
   * An authored tour runs entirely in the wearer's panel: it renders a chapter
   * and saves it, and the host sees only a bumped revision. What tells that
   * apart from a hand on the scene is the heartbeat's chapter number, which
   * only the player moves. One step forward and exactly one new saved revision
   * is a chapter. Anything else — a manual edit sharing the beat, a second
   * revision, a different lesson, a beat that carries no tour — is left
   * unrecorded, so a stop reaching across it is refused as before.
   */
  private noteTourChapter(panel:Panel,input:Expected & {tourState?:TourState;experience?:ExperienceChapter},binding:InspectionBinding) {
    if(panel.surface==='desktop') return;
    // A beat that carries no lesson ends the one this panel was showing. The
    // field is deleted rather than left behind, so a finished journey cannot
    // go on standing in for a lesson that is still playing.
    if(input.experience) panel.experience={...input.experience}; else delete panel.experience;
    const lesson=lessonOf(panel);
    if(!lesson) { delete panel.tourChapter; return; }
    if(!same(input,binding)) return;
    const previous=panel.tourChapter;
    const revision=binding.inspectionRevision;
    const current={...(lesson.selectedId===undefined?{}:{selectedId:lesson.selectedId}),step:lesson.step,inspectionRevision:revision};
    if(!previous || previous.selectedId!==lesson.selectedId) { panel.tourChapter=current; return; }
    if(previous.step!==lesson.step) {
      // An authored lesson is forgiven only FORWARD.
      //
      // The tour player's own `back` redraws a chapter it already drew, and it
      // is the same lesson either way. A journey's chapter number is the only
      // thing separating its autoplay from a hand, so it is held to the one
      // shape autoplay actually produces: the next chapter, once.
      const forward=!input.experience || lesson.step===previous.step+1;
      if(forward && revision===previous.inspectionRevision+1) { panel.tourChapter=current; this.addTourRevision(binding,revision); return; }
      // A device session lead check found that the page announces the next chapter
      // on the beat it sends BEFORE that chapter's save, so the step moves on
      // one beat and the revision on a later one. Hold the step as pending
      // and recognise the one revision the chapter commits when it arrives.
      panel.tourChapter={...current,pending:forward && revision===previous.inspectionRevision};
      return;
    }
    if(previous.pending && revision===previous.inspectionRevision+1) { panel.tourChapter=current; this.addTourRevision(binding,revision); return; }
    if(revision!==previous.inspectionRevision) panel.tourChapter=current;
  }
  /**
   * A stop keeps its utterance through the chapters.
   *
   * "Stop, go back to my view." was refused because chapters 6
   * and 7 had drawn while the model was reading the transcript, and the wearer
   * waited 60.9 s and two more chapters for an unbound resend. The words are
   * re-homed to the scene they are about only when every saved revision
   * between them and now was a chapter this same panel acknowledged, the
   * lesson is still the one that was playing, and the source, epoch and host
   * revision are unchanged. A manual edit leaves a revision no chapter claims,
   * so a stop across one still refuses, and so does every other tour action.
   */
  private rehomeTourStop(utteranceId:string|undefined,panelId:string,binding:InspectionBinding) {
    if(!utteranceId) return false;
    const u=this.utterances.get(utteranceId);
    if(!u || u.supersededBy || !u.tour || !u.panelIds.includes(panelId)) return false;
    if(u.binding.serverEpoch!==binding.serverEpoch || u.binding.sourceToken!==binding.sourceToken
      || u.binding.stateRevision!==binding.stateRevision) return false;
    if(u.binding.inspectionRevision>=binding.inspectionRevision) return false;
    const playing=lessonOf(this.panels.get(panelId));
    if(!playing || playing.selectedId!==u.tour.selectedId) return false;
    const revisions=this.tourRevisions.get(revisionKey(binding));
    if(!revisions) return false;
    for(let revision=u.binding.inspectionRevision+1;revision<=binding.inspectionRevision;revision++)
      if(!revisions.has(revision)) return false;
    u.binding={...binding};
    return true;
  }
  /**
   * Words spoken while a source swap was still loading.
   *
   * The swap's own utterance is carried over by `continueUtterance`. A
   * correction spoken after it and before its render was left bound to the old
   * source token and the old panel, so "No, cancel that, show me
   * crambin" could neither cancel, correct nor be echoed once 1JB0 drew: three
   * refusals, and the model acted unbound. Those utterances are moved to the
   * binding the swap produced. Only their conversational place moves: a bound
   * edit still carries referent keys from the old structure, and
   * `referentSelection` still refuses it against the new one.
   */
  continueSwapUtterances(panelId:string,previous:InspectionBinding,next:InspectionBinding,replacementPanelId=panelId,afterSequence?:number) {
    const moved:string[]=[];
    if(next.serverEpoch!==previous.serverEpoch) return moved;
    for(const u of this.utterances.values()) {
      if(u.supersededBy || !u.panelIds.includes(panelId)) continue;
      if(!u.swapPending && !(afterSequence!==undefined && u.sequence>afterSequence)) continue;
      if(u.binding.serverEpoch!==previous.serverEpoch || u.binding.sourceToken!==previous.sourceToken
        || u.binding.stateRevision!==previous.stateRevision || u.binding.inspectionRevision!==previous.inspectionRevision) continue;
      u.binding={...next};
      if(replacementPanelId!==panelId) u.panelIds=u.panelIds.map(id=>id===panelId?replacementPanelId:id);
      moved.push(u.utteranceId);
    }
    return moved;
  }
  /** The order a recording took, used to tell words spoken during a swap from words spoken before it. */
  utteranceSequenceOf(utteranceId:string|undefined) {
    return utteranceId?this.utterances.get(utteranceId)?.sequence:undefined;
  }
  beginUtterance(utteranceId:string,panelIds:string[],binding:InspectionBinding) {
    const previous=this.utterances.get(utteranceId);
    if(previous) {
      if(JSON.stringify(previous.panelIds)!==JSON.stringify(panelIds) || previous.binding.serverEpoch!==binding.serverEpoch || previous.binding.sourceToken!==binding.sourceToken)
        throw Error('This utterance belongs to a different inspection or panel.');
      return {...previous};
    }
    if(this.utteranceSerial===Number.MAX_SAFE_INTEGER) throw Error('Utterance sequence exhausted; open a new session.');
    // What the wearer's panel was already doing when the words started. A
    // lesson playing and a source swap in flight are the two mid-action cases
    // where the binding recorded here is overtaken before the words arrive.
    const playing=panelIds.map(id=>lessonOf(this.panels.get(id))).find(Boolean);
    const swapping=[...this.sourceOperations.keys()].some(operation=>panelIds.includes(operation.panelId));
    const utterance:Utterance={utteranceId,sequence:++this.utteranceSerial,panelIds:[...panelIds],binding:{...binding},
      ...(playing?{tour:playing.selectedId===undefined?{}:{selectedId:playing.selectedId}}:{}),
      ...(swapping?{swapPending:true as const}:{}),
      renderingCommandIds:[...this.commands.values()].filter(c=>c.receipt.status==='rendering'
        && panelIds.includes(c.input.panelId) && same(c.input,binding)).map(c=>c.input.commandId)};
    this.utterances.set(utteranceId,utterance);
    return {...utterance};
  }
  utterance(utteranceId:string) {
    const u=this.utterances.get(utteranceId);
    return u?{utteranceId:u.utteranceId,sequence:u.sequence,supersededBy:u.supersededBy}:undefined;
  }
  /** Replies follow verified source continuations, but ordinary view edits do not retire them. */
  utteranceSourceMatchesPanel(utteranceId:string,panelId:string):boolean {
    const u=this.utterances.get(utteranceId),panel=this.panels.get(panelId);
    return Boolean(u && panel && u.panelIds.includes(panelId)
      && u.binding.serverEpoch===panel.serverEpoch && u.binding.sourceToken===panel.sourceToken);
  }
  private checkUtterance(input:Expected & {utteranceId?:string;panelId:string;change?:{kind:string;patch?:unknown}},binding:InspectionBinding) {
    if(!input.utteranceId) return;
    const u=this.utterances.get(input.utteranceId);
    if(!u || !u.panelIds.includes(input.panelId)) throw Error('This utterance does not belong to the targeted inspection panel.');
    if(u.supersededBy) throw Error('This utterance was superseded by a newer correction or cancellation.');
    if(u.binding.serverEpoch!==binding.serverEpoch || u.binding.sourceToken!==binding.sourceToken || u.binding.stateRevision!==binding.stateRevision || u.binding.inspectionRevision!==binding.inspectionRevision) throw new UtteranceBindingError('The scene or saved revision changed since this utterance began. Ask again; the request will not be retargeted.');
    // Words spoken before the wearer moved the structure cannot move it
    // again. That includes "undo that", which would now take back the move.
    if(u.wearerMoved && movesPlacement(input.change)) throw new UtteranceBindingError('The wearer moved the structure since this utterance began. Ask again; the request will not be retargeted.');
  }
  controlUtterance(input:Expected & {panelId:string;commandId:string;utteranceId?:string;change:{kind:'utterance';patch:{action:'begin'|'correct'|'cancel'}}},binding:InspectionBinding,
    handoff?:{panelId:string;previous:InspectionBinding;controlled:(action:'correct'|'cancel',utteranceId:string)=>void}) {
    this.assertReceiptRetained(input.commandId);
    this.assertNotToolNoop(input.commandId);
    this.refresh(binding);
    const signature=JSON.stringify(input),previous=this.controls.get(input.commandId);
    if(previous) {
      if(previous.signature!==signature) throw Error('This commandId was already used for a different request.');
      return structuredClone(previous.result);
    }
    if(this.commands.has(input.commandId)) throw Error('This commandId was already used for a different request.');
    const panel=this.panels.get(input.panelId);
    // A committed source may still be hydrating in its selected renderer. The
    // host can authorize cancellation of that exact pending continuation even
    // after the old panel detached. This never authorizes an edit or rollback.
    const tourHandoff=[...this.commands.values()].find(c=>pending(c) && c.tourTransition
      && (input.panelId===c.input.panelId || input.panelId===c.tourTransition.panelId)
      && (same(input,binding) || same(input,{serverEpoch:c.input.serverEpoch,sourceToken:c.input.sourceToken,
        stateRevision:c.input.baseStateRevision,inspectionRevision:c.input.baseInspectionRevision})));
    const tourBinding=tourHandoff ? {serverEpoch:tourHandoff.input.serverEpoch,sourceToken:tourHandoff.input.sourceToken,
      stateRevision:tourHandoff.input.baseStateRevision,inspectionRevision:tourHandoff.input.baseInspectionRevision}:undefined;
    const sourceHandoff=handoff && input.change.patch.action!=='begin' && input.panelId===handoff.panelId
      && (same(input,handoff.previous)||same(input,binding));
    const inHandoff=sourceHandoff || (tourHandoff && input.change.patch.action!=='begin');
    if(!inHandoff && (!same(input,binding)||!panel||!same(panel,binding))) throw new UtteranceBindingError('The targeted inspection or panel changed. Read get_inspection_state; cancellation will not be retargeted.');
    const ownerBinding=sourceHandoff?handoff!.previous:inHandoff?tourBinding!:binding;
    // Recording precedes transcription. Only the exact render observed at
    // recording start can explain this correction's saved-revision advance.
    // Manual saves, different sources/panels and ordinary begins still fail.
    const recorded=input.utteranceId?this.utterances.get(input.utteranceId):undefined;
    const correctedRender=!inHandoff && input.change.patch.action==='correct' && recorded && !recorded.supersededBy
      && recorded.panelIds.includes(input.panelId) && recorded.binding.serverEpoch===binding.serverEpoch
      && recorded.binding.sourceToken===binding.sourceToken && recorded.binding.stateRevision===binding.stateRevision
      ? recorded.renderingCommandIds.map(id=>this.commands.get(id)).find(c=>c?.receipt.status==='rendered'
        && c.input.panelId===input.panelId && same(c.input,recorded.binding)
        && c.receipt.renderedRevision===binding.inspectionRevision) : undefined;
    if(correctedRender) recorded!.binding={...binding};
    // A cancel spoken over a playing lesson is the same request as the stop it
    // precedes, and the chapters that drew while it was transcribed are the
    // same forgiven advance.
    if(!inHandoff && input.change.patch.action==='cancel') this.rehomeTourStop(input.utteranceId,input.panelId,binding);
    this.checkUtterance(input,ownerBinding);
    const u=input.utteranceId?this.utterances.get(input.utteranceId)!:this.beginUtterance(randomUUID(),[input.panelId],ownerBinding);
    const changed:Receipt[]=[];
    const sourceOperations:Array<{commandId:string;status:'cancelled';supersededBy:string}>=[];
    if(correctedRender) {
      correctedRender.receipt.status='superseded';
      correctedRender.receipt.supersededBy=u.utteranceId;
      correctedRender.receipt.reason='A newer correction superseded this already rendered request.';
      changed.push({...correctedRender.receipt});
    }
    if(input.change.patch.action!=='begin') {
      const supersedes=(id:string|undefined)=>!id || (this.utterances.get(id)?.sequence??Infinity)<u.sequence
        || (input.change.patch.action==='cancel' && id===u.utteranceId);
      for(const old of this.utterances.values()) if(supersedes(old.utteranceId)) old.supersededBy=u.utteranceId;
      for(const c of this.commands.values()) if(pending(c) && supersedes(c.input.utteranceId)) {
        c.renderFence=c.receipt.status==='rendering';
        c.receipt.status=input.change.patch.action==='correct'||c.renderFence?'superseded':'cancelled';
        c.receipt.supersededBy=u.utteranceId;
        if(c.receipt.status==='superseded') c.receipt.fenceReleased='pending';
        c.receipt.reason='A newer utterance dropped this earlier request. This is not a rendered confirmation.';
        if(!c.renderFence) delete c.expected;delete c.localBase;
        changed.push({...c.receipt});
      }
      for(const [operation,controller] of this.sourceOperations) {
        if(!supersedes(operation.utteranceId)) continue;
        controller.abort(Error('A newer utterance cancelled this source operation; its result was discarded.'));
        sourceOperations.push({commandId:operation.commandId,status:'cancelled',supersededBy:u.utteranceId});
        this.sourceOperations.delete(operation);
      }
    }
    if(sourceHandoff) handoff!.controlled(input.change.patch.action as 'correct'|'cancel',u.utteranceId);
    const result={utterance:this.utterance(u.utteranceId),commands:changed,...(sourceOperations.length?{sourceOperations}:{}),action:input.change.patch.action,rendered:false};
    this.controls.set(input.commandId,{signature,result:structuredClone(result)});
    return result;
  }
  private claimed(input:Expected & {panelId:string;commandId:string;claimToken:string}) {
    const c=this.commands.get(input.commandId);
    if(!c || c.input.panelId!==input.panelId || c.claimToken!==input.claimToken
      || input.serverEpoch!==c.input.serverEpoch || input.sourceToken!==c.input.sourceToken
      || input.baseStateRevision!==c.input.baseStateRevision || input.baseInspectionRevision!==c.input.baseInspectionRevision)
      throw Error('This receipt does not belong to the claimed panel command.');
    return c;
  }
  admit(input:Expected & {panelId:string;commandId:string;claimToken:string},binding:InspectionBinding,historyScene?:InspectionScene) {
    this.refresh(binding);
    const c=this.claimed(input);
    if(c.receipt.status!=='rendering'||c.admitted) return {admitted:false,command:{...c.receipt},reason:c.receipt.reason??'This command was already admitted; it cannot mutate twice.'};
    if(historyScene) {
      // The host supplies this only for a claimed Undo/Redo. Following panels
      // retain their own camera and placement while sharing scientific edits.
      // Check all other fields against the queued scene, then bind the view
      // for completion. A placement op still overrides it through the usual
      // expectedInspection rule; later unrequested movement cannot slip in.
      const local=c.localBase && structuredClone(c.localBase);
      if(local) { local.camera=structuredClone(historyScene.camera);local.inspection.placement=structuredClone(historyScene.inspection.placement); }
      if(!local || inspectionJson(local)!==inspectionJson(historyScene)
        || c.input.change.kind==='save-view' || c.input.change.kind==='restore-view')
        return {admitted:false,command:{...c.receipt},reason:'The local scene changed before the history command arrived.'};
      c.expected=expectedInspection(local,c.input.change);
    }
    c.admitted=true;
    return {admitted:true,command:{...c.receipt}};
  }
  settled(input:Expected & {panelId:string;commandId:string;claimToken:string;recoveryFailed?:boolean}) {
    const c=this.claimed(input);
    this.refreshFences();
    const pendingRecovery=c.renderFence || [...this.commands.values()].some(old=>old.renderFence && old.replacementCommandId===c.input.commandId);
    const reason=input.recoveryFailed?'recovery-failed':'rolled-back';
    if(c.receipt.status==='superseded'||c.receipt.status==='cancelled') this.releaseFence(c,reason);
    this.releasePredecessors(c,reason);
    if(input.recoveryFailed && pendingRecovery) for(const queued of this.commands.values()) {
      if(queued.input.panelId!==c.input.panelId || queued.input.sourceToken!==c.input.sourceToken
        || queued.input.serverEpoch!==c.input.serverEpoch || queued.input.baseStateRevision!==c.input.baseStateRevision
        || queued.input.baseInspectionRevision!==c.input.baseInspectionRevision || queued.receipt.status!=='queued') continue;
      queued.receipt.status='rejected';queued.receipt.reason='recovery_failed';
      queued.receipt.detail='The previous change could not be restored. Load the saved view before trying again.';
      delete queued.expected;
    }
    return {settled:!c.renderFence,command:{...c.receipt}};
  }

  private releaseFence(c:Command,reason:FenceRelease,at=this.now()) {
    if(!c.renderFence) return;
    c.renderFence=false;
    c.fenceReleasedAt=at;
    c.receipt.fenceReleased=reason;
    delete c.expected;delete c.localBase;
  }
  private releasePredecessors(c:Command,reason:FenceRelease|'replacement-rendered') {
    for(let id=c.replacesCommandId;id;) {
      const old=this.commands.get(id);if(!old)break;
      if(old.renderFence) {old.renderFence=false;old.fenceReleasedAt=this.now();old.receipt.fenceReleased=reason;delete old.expected;}
      id=old.replacesCommandId;
    }
  }
  /** Queued supersessions have no render claim to roll back or block delivery.
   * Their receipt stays pending until the named correction (or its successor)
   * actually renders. Claimed renders retain their existing release reasons. */
  private releaseQueuedSupersessions(replacement:Command) {
    if(!replacement.input.utteranceId) return;
    for(const old of this.commands.values()) {
      if(old.claimToken || old.receipt.status!=='superseded' || old.receipt.fenceReleased!=='pending'
        || old.input.panelId!==replacement.input.panelId || old.input.serverEpoch!==replacement.input.serverEpoch
        || old.input.sourceToken!==replacement.input.sourceToken) continue;
      const seen=new Set<string>();
      for(let id=old.receipt.supersededBy;id && !seen.has(id);id=this.utterances.get(id)?.supersededBy) {
        if(id===replacement.input.utteranceId) { old.receipt.fenceReleased='replacement-rendered';break; }
        seen.add(id);
      }
    }
  }
  /** Superseded receipts are terminal, but their render claims still expire. */
  private refreshFences(binding?:InspectionBinding) {
    const now=this.now();
    for(const c of this.commands.values()) {
      if(!c.renderFence) continue;
      const panel=this.panels.get(c.input.panelId);
      const lostAt=panel?panel.seen+graceFor(panel):-Infinity;
      // Preserve whichever bound elapsed first, even if the host was asleep
      // through both. A late settlement must not rewrite that release reason.
      if(now>=Math.min(c.deadline,lostAt)) this.releaseFence(c,c.deadline<=lostAt?'deadline':'panel-lost',
        Number.isFinite(lostAt)?Math.min(c.deadline,lostAt):now);
      else if(binding && (c.input.serverEpoch!==binding.serverEpoch || c.input.sourceToken!==binding.sourceToken))
        this.releaseFence(c,'panel-lost');
    }
  }
  /** A tour may transfer its admitted claim through the experience renderer.
   * The original claim and deadline stay immutable; only host-verified commits
   * advance this separate binding. Ordinary scene receipts remain source-bound. */
  beginTourTransition(input:TourCommandClaim,binding:InspectionBinding) {
    this.refresh(binding);
    const c=this.claimed(input);
    if(c.input.change.kind!=='tour' || !c.admitted || c.receipt.status!=='rendering' || c.tourTransition)
      throw Error('Only one current admitted tour command may prepare a journey.');
    c.tourTransition={binding:{...binding},panelId:input.panelId};
    return c.input.change.patch;
  }
  assertTourTransition(input:TourCommandClaim,binding:InspectionBinding) {
    this.refresh(binding);
    const c=this.claimed(input);
    if(c.receipt.status!=='rendering' || !c.tourTransition || c.renderFence)
      throw Error('This journey command expired or was superseded; it cannot change the scene.');
    return c;
  }
  advanceTourTransition(input:TourCommandClaim,previous:InspectionBinding,next:InspectionBinding) {
    const c=this.assertTourTransition(input,previous);
    c.tourTransition!.binding={...next};
  }
  restoringTourTransition(input:TourCommandClaim,binding:InspectionBinding) {
    this.assertTourTransition(input,binding).tourTransition!.restoring=true;
  }
  tourTransitionRestoring(input:TourCommandClaim,binding:InspectionBinding) {
    return this.assertTourTransition(input,binding).tourTransition!.restoring===true;
  }
  failTourTransition(input:TourCommandClaim,binding:InspectionBinding,failure:string,failureReason?:string) {
    const c=this.claimed(input);
    if(c.input.change.kind!=='tour')throw Error('Only a tour claim may settle a journey transition.');
    return this.complete({...input,failure,failureReason},binding);
  }
  tourTransitionReady(input:TourCommandClaim,panelId:string,binding:InspectionBinding) {
    const c=this.assertTourTransition(input,binding),panel=this.panels.get(panelId);
    return Boolean(panel && same(panel,binding) && panel.availability==='ready'
      && c.tourTransition!.panelId===panelId
      && ![...this.commands.values()].some(other=>other!==c && (pending(other)||other.renderFence)));
  }
  completeTourTransition(input:TourCommandClaim,panelId:string,binding:InspectionBinding) {
    const c=this.assertTourTransition(input,binding);
    if(c.tourTransition!.restoring)throw Error('Restoring a failed journey is not a rendered tour command.');
    if(!this.tourTransitionReady(input,panelId,binding))throw Error('The journey must render and save in its claimed panel before confirmation.');
    c.receipt.status='rendered';c.receipt.renderedAt=this.now();c.receipt.renderedRevision=binding.inspectionRevision;
    this.releaseQueuedSupersessions(c);
    this.continueUtterance(c.input.utteranceId,input.panelId,
      {serverEpoch:input.serverEpoch,sourceToken:input.sourceToken,stateRevision:input.baseStateRevision,inspectionRevision:input.baseInspectionRevision},binding,panelId);
    delete c.expected;delete c.localBase;
    this.receiptChanged(c.input.commandId);
    return {...c.receipt};
  }

  private panels = new Map<string,Panel>();
  private commands = new Map<string,Command>();
  /** When a companion panel last left for the full Mol* viewer. */
  private detailedViewDeparture?:number;
  /** When a companion panel last detached to load a structure. */
  private loadingDeparture?:{at:number;budgetMs:number;lastPanel:CompanionLoadState['lastPanel']};
  private reclaimedPanels:{panelId:string;surface:Panel['surface'];inspectionRevision:number;reclaimedAt:number;reason:string}[]=[];
  /**
   * One sentence waiting for the wearer's Mol* tab.
   *
   * While the wearer is in the full Mol* viewer there is no companion panel,
   * so every route the agent has to the headset — `say_to_headset`, a queued
   * command, the caption plate — has nobody to deliver to. This is the one
   * mailbox that page can reach: it polls `poll_detailed_view` on the same
   * bearer it already holds, takes the sentence, shows it and navigates home.
   *
   * One slot, not a queue. A second recall replaces the first: the agent is
   * asking for the same thing, and a wearer who is already on the way back
   * must not be sent back again when they next open the viewer.
   */
  private detailedViewRecall?:{at:number; text:string; recallId:string};
  /**
   * The receipt for one recall, which is not the same thing as the
   * mailbox above.
   *
   * `recall_headset` used to answer `{queued:true}` and nothing afterwards
   * could say whether the wearer's tab had ever read it. The agent's only
   * follow-up was to poll for a companion panel and guess, which reads a wearer
   * who took their headset off exactly like a page that never polled. That gap
   * was the whole of a device defect: nothing on the Mac
   * could move the headset and nothing could prove it had not.
   *
   * So one recall leaves one receipt, and the receipt advances only on
   * evidence: `read` when the Mol* page takes the sentence out of the mailbox,
   * `returned` when a companion panel attaches after that. `expired` is the
   * recall nobody ever read. The mailbox is still one slot — a second recall
   * replaces the first and starts a new receipt.
   */
  private recallReceipt?:{recallId:string; text:string; queuedAt:number; takenAt?:number; returnedAt?:number};
  private recallSerial=0;
  /**
   * Whether a headset page has ever registered against this inspection.
   *
   * It decides whether a detailed page opening counts as the wearer walking
   * into the full viewer or as somebody on the Mac opening a second window.
   * Both are the same page and the same surface; only the history tells them
   * apart, and getting it wrong sends an agent to recall a wearer who is not
   * wearing anything.
   */
  private sawCompanion=false;
  /** The last headset page dropped for silence. See `QUIET_WEARER_MEMORY_MS`. */
  private quietCompanion?:Panel;
  private sourceLoadPanels=new Set<string>();
  /**
   * The host's stated budget for one command to be rendered.
   *
   * `get_inspection_state` has published `renderBudgetMs` for the loaded source
   * since tabs and waits were added — 130 s for 4HHB — and no receipt carried it,
   * so a caller following one command had to read the budget off a different
   * answer and hope the two meant the same source. A device run
   * confirmed the gap: every receipt in the run had `acceptedAt`, `commandId`,
   * `operation`, `panelId`, `renderedAt`, `renderedRevision` and `status`, and
   * none had a budget.
   *
   * 120 s is the default because that is `PANEL_SAVE_WAIT.baseMs`, the floor of
   * the host's own formula and the deadline a rendering claim has always had.
   * The server sets the real number per source; a queue nobody told keeps the
   * old behaviour exactly.
   */
  private renderBudgetMs=120000;
  /** The host states its per-source budget once, and every later receipt carries it. */
  setRenderBudget(ms:number) {
    if(Number.isFinite(ms) && ms>0) this.renderBudgetMs=Math.round(ms);
  }
  /** The budget this queue is stating, for the host that has to publish the same number. */
  renderBudget() { return this.renderBudgetMs; }
  constructor(private now:()=>number=Date.now,private usedToolCommandIds=new Set<string>()) {}
  private holdForEntry(c:Command, now:number) {
    if(c.receipt.status!=='queued')return;
    const panel=this.panels.get(c.input.panelId), xr=panel?.xrStartup?.value;
    if(!c.entryHold && panelEntering(xr) && now<c.deadline) {
      c.entryHold={until:now+PANEL_ENTRY_HOLD_MS,ready:false};
      c.deadline=c.deliveryDeadline=c.entryHold.until;
      c.receipt.heldForPanel=true;
    }
    if(!c.entryHold || c.entryHold.ready)return;
    const failed=xr && !panelEntering(xr) && (xr.phase==='idle' || xr.presenting===false || xr.reloadRequired || xr.errorName);
    if(!panel || failed || now>=c.entryHold.until) {
      c.receipt.status=failed?'rejected':!panel?'conflict':'expired';
      c.receipt.reason=failed?'panel_entry_failed':!panel?'panel_closed':'panel_entry_timeout';
      c.receipt.detail=failed?`VR entry ended before the panel was ready${xr.errorName?` (${xr.errorName})`:''}. The change was not sent.`
        :!panel?'The targeted panel closed before VR entry finished. The change was not sent.'
        :'The panel did not finish VR entry and become ready within 45 seconds. The change was not sent.';
      delete c.expected;delete c.localBase;
      this.receiptChanged(c.input.commandId);
      return;
    }
    // Active XR can still be busy rebuilding the edited scene. Keep holding
    // until both entry and readiness finish, even if diagnostic beats stop.
    if(!panelEntering(xr) && panel.availability==='ready' && !this.pauseOf(panel,now)) {
      c.entryHold.ready=true;
      c.deadline=c.deliveryDeadline=now+15000;
    }
  }
  private refresh(binding:InspectionBinding) {
    const now=this.now();
    this.refreshFences(binding);
    for(const c of this.commands.values()) if(pending(c)) {
      this.holdForEntry(c,now);
      if(!pending(c))continue;
      // Lesson geometry needs this exact page. A hidden page may keep waiting
      // while it checks in, but host reads and other pages' polls are not proof
      // that it survived. Keep the full busy Quest grace before giving up.
      if(c.receipt.status==='queued' && c.input.change.kind==='lesson') {
        const panel=this.panels.get(c.input.panelId);
        if(!panel || now-panel.seen>=graceFor(panel)) {
          c.receipt.status='expired';c.receipt.reason='panel_lost';
          c.receipt.detail='The targeted page stopped checking in beyond its heartbeat allowance. The lesson was not sent. Retry on the current page.';
          delete c.expected;delete c.localBase;
          this.receiptChanged(c.input.commandId);
          continue;
        }
        if(this.pauseOf(panel,now)) c.deadline=c.deliveryDeadline=now+15000;
      }
      const held=c.tourTransition?.binding;
      // A queued edit whose page had already paused when its
      // deadline came is not expired here. Nothing may have asked the host
      // since, and the next call saves it for the page (`keepQueuedForPausedWearer`);
      // until then it holds the queue like any pending command. A render fence
      // standing at the deadline blocked that save then, so the edit expires
      // as it always did.
      const stale=held ? held.serverEpoch!==binding.serverEpoch || held.sourceToken!==binding.sourceToken
        || held.stateRevision!==binding.stateRevision || held.inspectionRevision!==binding.inspectionRevision : !same(c.input,binding),
        expired=now>=c.deadline && !(this.keepablePause(c,binding,c.deadline) && !this.fencedAt(c.deadline));
      if(stale || expired) {
        c.receipt.status=c.receipt.status==='rendering'?'unconfirmed':stale?'conflict':'expired';
        c.receipt.reason=stale?'The saved view changed.':'The panel did not confirm this command before its deadline.';
        if(!stale && c.receipt.status==='expired' && c.receipt.heldForPanel) {
          c.receipt.reason='panel_hold_expired';
          c.receipt.detail=c.holdReason ?? 'The change was not sent because the panel did not become ready. Try again when the view is ready.';
        }
        delete c.expected;delete c.localBase;
      }
    }
    for(const [id,p] of this.panels) {
      // Waiting for a sleeping renderer does not waive its liveness allowance.
      if(now-p.seen<graceFor(p) && this.pauseOf(p,now) && (this.sourceLoadPanels.has(id)
        || [...this.commands.values()].some(c=>c.input.panelId===id && c.input.change.kind==='lesson' && c.receipt.status==='queued')))continue;
      if(p.sourceRecoveryUntil!==undefined && now>=p.sourceRecoveryUntil) {
        if(p.availability==='unsaved') p.unsavedSince=p.sourceRecoveryUntil;
        delete p.sourceRecoveryUntil;
      }
      const stranded=p.availability==='unsaved' && p.unsavedSince!==undefined && now-p.unsavedSince>=this.renderBudgetMs
        && !(p.sourceRecoveryUntil!==undefined && now<p.sourceRecoveryUntil);
      if(stranded) {
        this.reclaimPanel(p,now,'The panel made no saved revision progress within its render budget. Its unsaved work remains local; reopen the saved view.');
        continue;
      }
      if(now-p.seen<graceFor(p)) continue;
      // A claimed render may legitimately suspend this panel's JavaScript
      // heartbeat while Mol* builds expensive geometry. Retain only the exact
      // same-binding panel and only until that rendering claim's deadline.
      const rendering=[...this.commands.values()].some(c=>c.receipt.status==='rendering' && now<c.deadline
        && (c.tourTransition ? c.tourTransition.panelId===id
          && same({serverEpoch:c.tourTransition.binding.serverEpoch,sourceToken:c.tourTransition.binding.sourceToken,
            baseStateRevision:c.tourTransition.binding.stateRevision,baseInspectionRevision:c.tourTransition.binding.inspectionRevision},binding)
          : c.input.panelId===id && same(c.input,binding)));
      // Source hydration has no command claim. If its last report was busy
      // and visible, give its geometry the same full source render budget.
      // An explicitly hidden page cannot be building that geometry yet.
      const sourceRendering=this.sourceLoadPanels.has(id) && p.availability==='busy'
        && this.pauseOf(p,now)==='silent' && now-p.seen<this.renderBudgetMs;
      if(!rendering && !sourceRendering) {
        if(p.availability==='unsaved')this.reclaimPanel(p,now,'The unsaved panel stopped heartbeating and its panel grace expired. Its unsaved work remains local; reopen the saved view.');
        else {
          this.panels.delete(id);
          this.sourceLoadPanels.delete(id);
          if(p.surface==='companion') this.quietCompanion=p;
        }
      }
    }
  }
  private reclaimPanel(panel:Panel,at:number,reason:string) {
    this.panels.delete(panel.panelId);
    this.sourceLoadPanels.delete(panel.panelId);
    this.reclaimedPanels.push({panelId:panel.panelId,surface:panel.surface,inspectionRevision:panel.baseInspectionRevision,reclaimedAt:at,reason});
    if(this.reclaimedPanels.length>8)this.reclaimedPanels.shift();
  }
  private supersededPanels=new Set<string>();
  private preferredPanels(panels:Panel[]) {
    const now=this.now();
    return panels.sort((a,b)=>Number(Boolean(this.pauseOf(a,now)))-Number(Boolean(this.pauseOf(b,now)))
      || (b.visibleAt??0)-(a.visibleAt??0) || b.attachedAt-a.attachedAt);
  }
  /** Device identities come from the authenticated LAN pairing, never page arguments. */
  retireDuplicatePanels(devices:ReadonlyMap<string,string>,binding:InspectionBinding) {
    this.refresh(binding);
    const groups=new Map<string,Panel[]>();
    for(const panel of this.panels.values()) {
      const device=devices.get(panel.panelId);
      if(!device || panel.surface!=='companion' || !same(panel,binding))continue;
      const group=groups.get(device)??[];group.push(panel);groups.set(device,group);
    }
    for(const group of groups.values()) {
      const [preferred,...older]=this.preferredPanels(group);
      if(!preferred || this.pauseOf(preferred,this.now()))continue;
      for(const panel of older) {
        // A remembered foreground claim predating a new tab is not evidence
        // that the wearer rejected that tab. Let it report visibility first;
        // otherwise its first background heartbeat permanently retires it while
        // its renderer can subsequently enter XR with no host connection.
        if(preferred.visibleAt===undefined || preferred.visibleAt<=panel.attachedAt)continue;
        // Local work and admitted operations retain their exact owner and fences.
        if(panel.availability==='unsaved' || (panel.availability==='busy' && !this.pauseOf(panel,this.now()))
          || [...this.sourceOperations.keys()].some(op=>op.panelId===panel.panelId)
          || [...this.commands.values()].some(c=>(pending(c)||c.renderFence)
            && (c.input.panelId===panel.panelId || c.tourTransition?.panelId===panel.panelId)))continue;
        this.supersededPanels.add(panel.panelId);
        this.reclaimPanel(panel,this.now(),'Another visible tab on this paired headset replaced this page.');
      }
    }
  }
  attach(expected:Expected & {surface?:Panel['surface'];replacesPanelId?:string;pageBuild?:string;renderedSourceSha256?:string},binding:InspectionBinding,preserveTransitionPanel=false) {
    this.refresh(binding);
    if(!same(expected,binding)) throw Error('The panel must save or load the current inspection before attaching.');
    const surface=expected.surface??'desktop';
    const retiring=expected.replacesPanelId ? this.panels.get(expected.replacesPanelId) : undefined;
    if(retiring && (retiring.serverEpoch!==binding.serverEpoch || retiring.surface!==surface))
      throw Error('The replacement panel must belong to the same inspection and surface.');
    // Only the server's verified journey or source save can authorize this rebind.
    // It keeps the mounted renderer and its admitted command on one ID.
    if(preserveTransitionPanel) {
      if(!retiring)throw Error('The transition panel is no longer attached. Reopen the saved view.');
      this.sourceLoadPanels.delete(retiring.panelId);
      Object.assign(retiring,expected,{seen:this.now(),availability:'ready'});
      delete retiring.unsavedSince;
      return retiring.panelId;
    }
    if(this.panels.size-(retiring?1:0)>=8) throw Error('Eight inspection panels are already attached. Close one and wait ten seconds for a desktop panel, or a minute for a headset panel.');
    const panelId=randomUUID();
    // A bearer has already moved to the new source, so its old detach may
    // have been refused. Retire precisely the old capability, including its
    // pending commands, without redirecting any command to the new panel.
    if(retiring) this.detach({...retiring,panelId:retiring.panelId,
      ...([...this.commands.values()].some(c=>pending(c)&&c.tourTransition?.panelId===retiring.panelId)?{reason:'loading' as const}:{})},binding);
    // A companion that came back is no longer in the Mol* detail view, and is
    // no longer loading: it cannot attach until its structure has rendered.
    // A recall that is still waiting when the wearer is already back has been
    // answered by whatever brought them, so it is dropped rather than saved
    // for their next visit to the viewer.
    if(surface==='companion') {
      this.sawCompanion=true; this.detailedViewDeparture=undefined; this.loadingDeparture=undefined; this.detailedViewRecall=undefined;
      this.quietCompanion=undefined;
      // The receipt closes only on a recall the page actually read. A companion
      // attaching without that is a wearer who came back some other way, and
      // saying "the recall brought them" about it would be a claim nothing
      // supports.
      if(this.recallReceipt?.takenAt!==undefined && this.recallReceipt.returnedAt===undefined)
        this.recallReceipt.returnedAt=this.now();
    }
    // A detailed page attaching IS the wearer arriving in
    // the full viewer, and it is better evidence than the companion's parting
    // message. That message is posted from a page the browser is already
    // unloading, so it is lost often enough that "where is the wearer" used to
    // answer "gone" while they sat in Mol*.
    //
    // Only where a companion has actually been here, though. The same page
    // opens on the Mac beside a desktop panel, and saying "the headset is in
    // the full Mol* viewer" about a session that has never had a headset in it
    // would send an agent looking for somebody to recall who does not exist.
    if(surface==='detailed' && this.sawCompanion) this.detailedViewDeparture=this.now();
    this.panels.set(panelId,{...expected,panelId,seen:this.now(),attachedAt:++this.serial,availability:'ready',surface});
    for(const c of this.commands.values()) if(pending(c) && c.tourTransition && c.tourTransition.panelId===expected.replacesPanelId)
      c.tourTransition!.panelId=panelId;
    return panelId;
  }
  detach(input:Expected & {panelId:string; reason?:'detailed-view'|'loading'},binding:InspectionBinding) {
    this.refresh(binding);
    const panel=this.panels.get(input.panelId);
    if(!panel || panel.serverEpoch!==input.serverEpoch || panel.sourceToken!==input.sourceToken) return false;
    // A page that said it is leaving is not asleep.
    if(panel.surface==='companion') this.quietCompanion=undefined;
    if(input.reason==='detailed-view' && panel.surface==='companion') this.detailedViewDeparture=this.now();
    if(input.reason==='loading' && panel.surface==='companion') {
      const claim=[...this.commands.values()].find(c=>pending(c) && c.tourTransition?.panelId===panel.panelId);
      this.loadingDeparture={at:this.now(),budgetMs:Math.max(0,Math.min(this.renderBudgetMs,claim?claim.deadline-this.now():Infinity)),
        lastPanel:{panelId:panel.panelId,availability:panel.availability,
          stateRevision:panel.baseStateRevision,inspectionRevision:panel.baseInspectionRevision}};
    }
    this.panels.delete(input.panelId);this.sourceLoadPanels.delete(input.panelId);
    for(const c of this.commands.values()) if(c.input.panelId===input.panelId) {
      // A tour transferring its claim through a source load keeps it;
      // every other command on the lost panel drops its fence.
      if(input.reason==='loading' && c.tourTransition)continue;
      this.releaseFence(c,'panel-lost');
      if(pending(c)) {
        c.receipt.status=c.receipt.status==='rendering'?'unconfirmed':'conflict';
        c.receipt.reason='The targeted panel detached.';delete c.expected;delete c.localBase;
      }
    }
    return true;
  }
  summary(binding:InspectionBinding, commandId?:string) {
    this.refresh(binding);
    const now=this.now();
    return {reclaimedPanels:this.reclaimedPanels.map(panel=>({...panel})),panels:[...this.panels.values()].map(p=>({panelId:p.panelId,surface:p.surface,availability:p.availability,
      availabilityCause:availabilityCauseSchema.parse(p.availability==='busy'?classifyPanelAvailability(p.xrStartup?.value):null),
      current:same(p,binding),...(p.referenceOnly?{referenceOnly:true}:{}),...(p.registeringRevision && same(p,binding)?{registeringRevision:true}:{}),inspectionRevision:p.baseInspectionRevision,tour:p.tourState??null,animation:p.animation??null,
      xrStartup:p.xrStartup?{...p.xrStartup.value,ageMs:Math.max(0,now-p.xrStartup.receivedAt),stale:now-p.xrStartup.receivedAt>=SPATIAL_STALE_MS}:null,
      spatialContext:p.spatial?{...p.spatial.value,reference:'molecule-center',axes:'molecule-local',units:'molecular-radius',
        ageMs:Math.max(0,now-p.spatial.receivedAt),stale:now-p.spatial.receivedAt>=SPATIAL_STALE_MS}:null})),
      pendingCommand:[...this.commands.values()].filter(c=>pending(c)||c.renderFence).map(c=>({...c.receipt,renderFence:Boolean(c.renderFence)})),
      utterances:[...this.utterances.values()].map(u=>this.utterance(u.utteranceId)),
      commands:[...this.commands.values()].map(c=>({...c.receipt})),
      companionInDetailedView:this.companionInDetailedView(),
      companionRegistered:this.sawCompanion,
      companionLoading:this.companionLoading(),
      companionLoad:this.companionLoad()??null,
      detailedViewRecallPending:this.detailedViewRecallPending(),
      ...(()=>{const receipt=this.detailedRecallReceipt();return receipt?{detailedRecallReceipt:receipt}:{};})(),
      ...(commandId?{command:this.published(commandId,now)}:{})};
  }
  /**
   * One command's receipt, plus how long this host is
   * still prepared to wait for it.
   *
   * A queued command has a 15 s deadline to reach a panel (up to 45 s for
   * reported VR entry and readiness); one that a panel
   * has claimed and is rendering has its captured source budget from the claim
   * (120 s by default). A caller following
   * the receipt used to guess its own cap — 60 s in the agent CLI — which is
   * both longer than the queue deadline and shorter than the render deadline.
   * `budgetMs` is the host's remaining deadline in milliseconds, so a follower
   * stops exactly when the host stops caring and no sooner.
   */
  private published(commandId:string,now:number) {
    const c=this.commands.get(commandId);
    if(!c) return {commandId,status:'unknown'};
    return {...c.receipt,...(pending(c)?{budgetMs:Math.max(0,c.deadline-now)}:{})};
  }
  /**
   * Whether the wearer is over in the full Mol* viewer rather than gone.
   *
   * True only while no companion panel is attached: a companion that polls
   * again is the wearer back on the headset page, whatever this remembered.
   */
  companionInDetailedView() {
    if(this.detailedViewDeparture===undefined) return false;
    if(this.now()-this.detailedViewDeparture>=DETAILED_VIEW_AWAY_MS) { this.detailedViewDeparture=undefined; return false; }
    return ![...this.panels.values()].some(p=>p.surface==='companion');
  }
  /**
   * Whether the headset page is between "I am loading a structure" and its
   * first saved scene, rather than gone.
   *
   * True only while no companion panel is attached: a companion that registered
   * again has finished its load, whatever this remembered. `refresh` has
   * already run in `summary`, so an expired panel counts as absent here too.
   */
  companionLoading() {
    return this.companionLoad()?.status==='loading';
  }
  companionLoad():CompanionLoadState|undefined {
    const left=this.loadingDeparture;
    if(!left || [...this.panels.values()].some(p=>p.surface==='companion'))return;
    const elapsedMs=Math.max(0,this.now()-left.at);
    return {status:elapsedMs<left.budgetMs?'loading':'timed-out',elapsedMs,budgetMs:left.budgetMs,lastPanel:{...left.lastPanel}};
  }
  /** Why this headset panel cannot draw now, from its last check-in. */
  private pauseOf(panel:Panel, now:number):WearerPause|undefined {
    if(panel.surface!=='companion') return undefined;
    const xr=panel.xrStartup?.value;
    // Entry may hide the flat page or block heartbeat timers while building.
    // Its commands have their own bounded hold, not a sleeping-page save.
    if(panelEntering(xr))return undefined;
    if(xr?.presenting===true && xr.sessionVisibility==='hidden') return 'headset-hidden';
    if(xr?.presenting!==true && xr?.visible===false) return 'page-hidden';
    // A busy page can freeze when the headset sleeps, so silence still pauses it.
    if(now-panel.seen>=WEARER_SILENT_MS) return 'silent';
    return undefined;
  }
  private quietWearer(now:number) {
    const quiet=this.quietCompanion;
    if(!quiet || [...this.panels.values()].some(panel=>panel.surface==='companion')) return undefined;
    if(now-quiet.seen>=QUIET_WEARER_MEMORY_MS) { this.quietCompanion=undefined; return undefined; }
    return quiet;
  }
  /**
   * The pause of the panel a command names at `at`, including a headset page
   * dropped for silence. A page that checked in after `at` says nothing about
   * `at`, so it reads as not paused then.
   */
  private pausedTarget(panelId:string, at:number):{reason:WearerPause;checkedInMsAgo:number}|undefined {
    const panel=this.panels.get(panelId);
    if(panel) {
      const reason=panel.seen<=at?this.pauseOf(panel,at):undefined;
      return reason?{reason,checkedInMsAgo:at-panel.seen}:undefined;
    }
    const quiet=this.quietWearer(at);
    return quiet?.panelId===panelId && at-quiet.seen>=WEARER_SILENT_MS?{reason:'silent',checkedInMsAgo:at-quiet.seen}:undefined;
  }
  /**
   * Why a queued edit can be saved for its page at `at`, or
   * undefined when it cannot. Only an edit the host can save by itself, still
   * waiting, on the current revisions, for a page without unsaved work of its
   * own, and only while that page is paused.
   */
  private keepablePause(c:Command,binding:InspectionBinding,at:number) {
    if(c.receipt.status!=='queued' || !c.expected || c.tourTransition || !same(c.input,binding)
      || (c.entryHold && !c.entryHold.ready)
      || !keptWhilePaused(c.input.change) || this.panels.get(c.input.panelId)?.availability==='unsaved') return undefined;
    return this.pausedTarget(c.input.panelId,at);
  }
  /** Whether a superseded render still held its fence at `at`. */
  private fencedAt(at:number) {
    return [...this.commands.values()].some(c=>c.renderFence || (c.fenceReleasedAt!==undefined && c.fenceReleasedAt>at));
  }
  /**
   * The wearer's page, so an agent can wait on it instead of
   * asking the person, who would have to take the headset off to answer.
   *
   * Prefer a visible page, then its latest visibility transition or attachment.
   * With none attached,
   * a page dropped for silence is `unknown`, and a wearer over in the full
   * Mol* viewer has a page open.
   */
  wearerPage(binding:InspectionBinding):WearerPage {
    this.refresh(binding);
    const now=this.now(), panels=[...this.panels.values()];
    const latest=(surface:Panel['surface'])=>this.preferredPanels(panels.filter(panel=>panel.surface===surface))[0];
    const page=latest('companion');
    if(page) {
      const pausedBecause=this.pauseOf(page,now), report=page.xrStartup;
      const drawing=report?.value.presenting===true && page.xrDrawnAt!==undefined && now-page.xrDrawnAt<XR_FRAME_FRESH_MS;
      return {state:pausedBecause?'paused':report?.value.presenting===true?drawing?'in-vr':'entering-vr':'page-open',
        panelId:page.panelId,checkedInAt:page.seen,...(pausedBecause?{pausedBecause}:{})};
    }
    const quiet=this.quietWearer(now);
    if(quiet) return {state:'unknown',panelId:quiet.panelId,checkedInAt:quiet.seen};
    // A page that detached to load a structure is still open, drawing it.
    if(this.companionLoading()) return {state:'page-open'};
    const detailed=latest('detailed');
    if(detailed && this.sawCompanion) return {state:'page-open',panelId:detailed.panelId,checkedInAt:detailed.seen};
    return {state:'no-page'};
  }
  /**
   * The headset page the host keeps edits for, when it has paused or been
   * dropped for silence. A page with unsaved work of its own is left out:
   * saving over that work would take it.
   */
  pausedWearerPanel(binding:InspectionBinding):string|undefined {
    const page=this.wearerPage(binding);
    return (page.state==='paused' || page.state==='unknown') && this.panels.get(page.panelId!)?.availability!=='unsaved'?page.panelId:undefined;
  }
  /** Sharing ended, so a silent headset page is no longer anyone's to wait for. */
  forgetQuietWearer() { this.quietCompanion=undefined; }
  /**
   * Save an edit for a paused headset page instead of queueing it.
   *
   * A queued edit waits for a page that cannot draw: it expired at fifteen
   * seconds, or the hidden page claimed it and rejected it after thirty, and
   * either way it was lost. Here the edit becomes a `saved` receipt and its
   * scene is returned for the caller to commit as the next revision. The page
   * follows that revision when it next checks in awake, which is how it follows
   * an edit made on the Mac. Nothing is drawn yet, so this never says `rendered`.
   *
   * Undefined when the named panel is not a paused headset page, or the
   * commandId was used before: the caller enqueues as usual. Throws for an edit
   * only the page can apply. `check` sees the scene before anything is
   * recorded, so a scene it refuses leaves no receipt behind.
   */
  keepForPausedWearer(input:Request,binding:InspectionBinding,scene:InspectionScene|null,tool='update_inspection',
    check:(scene:InspectionScene)=>void=()=>{}) {
    this.assertReceiptRetained(input.commandId);
    this.assertNotToolNoop(input.commandId);
    this.refresh(binding);
    const now=this.now(), pause=this.pausedTarget(input.panelId,now);
    if(!pause || this.commands.has(input.commandId) || this.controls.has(input.commandId)
      || this.panels.get(input.panelId)?.availability==='unsaved') return undefined;
    this.checkUtterance(input,binding);
    if(!scene || !same(input,binding)) throw Error('Read get_inspection_state and use its current saved revisions before changing the inspection.');
    if(binding.inspectionRevision===Number.MAX_SAFE_INTEGER) throw Error('Inspection revision exhausted; open a new session.');
    if(!keptWhilePaused(input.change)) throw Error(wearerPausedRefusal(pause,input.change.kind));
    if([...this.commands.values()].some(c=>pending(c)||c.renderFence)) throw Error('An inspection command is already in progress. Check its status first.');
    const kept=expectedInspection(scene,input.change as InspectionChange);
    check(kept);
    for(const [id,c] of this.commands) {
      if(this.commands.size<32) break;
      if(this.canPruneReceipt(c,binding)) this.pruneCommand(id,c);
    }
    if(this.commands.size>=32) throw Error('This saved revision has too many failed commands. Make a deliberate manual edit or open a new session before trying again.');
    const receipt:Receipt={commandId:input.commandId,panelId:input.panelId,status:'saved',operation:visualOperation(input.change as InspectionChange,tool),
      acceptedAt:now,renderBudgetMs:this.renderBudgetMs,savedRevision:binding.inspectionRevision+1,wearerPaused:pause.reason,
      ...(input.appliedTo?{appliedTo:structuredClone(input.appliedTo)}:{}),
      ...(input.focus?{focus:{...input.focus}}:{}),
      ...(input.actionPostedAt!==undefined?{actionPostedAt:input.actionPostedAt}:{}),
      ...(input.utteranceId?{utteranceId:input.utteranceId,utteranceSequence:this.utterance(input.utteranceId)?.sequence}:{})};
    this.commands.set(input.commandId,{input:structuredClone(input),signature:JSON.stringify(input.requestIdentity ?? input),
      receipt,deadline:now,issuedAt:++this.serial});
    return {command:{...receipt},scene:kept,pause};
  }
  /**
   * The same save for an edit queued just before its page paused.
   *
   * The page can go dark between the edit and the beat that would have claimed
   * it. `poll` no longer hands a hidden page anything, and this turns the edit
   * it holds into a saved one, so the 15 s deadline cannot drop it: `refresh`
   * holds an edit whose page paused before its deadline until this runs, and
   * the server runs this at the start of every call (`current` in
   * inspection-server.ts). Only a queued edit is taken; one a page has already
   * claimed is left to its render.
   *
   * With nothing queued this returns before `refresh`. A call made in the
   * middle of a journey or a source load can see a binding that the claim it
   * serves has not caught up with yet, and refreshing then would mark that
   * claim stale; a queued edit never waits beside a claim.
   */
  keepQueuedForPausedWearer(binding:InspectionBinding,check:(scene:InspectionScene)=>void=()=>{}) {
    if(![...this.commands.values()].some(c=>c.receipt.status==='queued')) return undefined;
    this.refresh(binding);
    const commands=[...this.commands.values()];
    if(commands.some(c=>c.receipt.status==='rendering' || c.renderFence)) return undefined;
    const now=this.now();
    for(const c of commands) {
      const pause=this.keepablePause(c,binding,now);
      if(!pause) continue;
      const kept=c.expected!;
      // A scene the host refuses to save stays queued until its deadline. One
      // already past it loses the scene `refresh` holds it by, so the next
      // refresh expires it as it would have expired at the deadline.
      try { check(kept); } catch { if(now>=c.deadline) delete c.expected;delete c.localBase; continue; }
      c.receipt.status='saved'; c.receipt.savedRevision=binding.inspectionRevision+1; c.receipt.wearerPaused=pause.reason;
      delete c.receipt.heldForPanel; delete c.holdReason; delete c.expected;delete c.localBase;
      this.receiptChanged(c.input.commandId);
      return {command:{...c.receipt},scene:kept,pause};
    }
    return undefined;
  }
  /**
   * Leave one recall for the wearer's Mol* tab.
   *
   * It is written whether or not the page is believed to be over there: the
   * departure marker expires after ten minutes and a wearer can sit in a
   * structure much longer than that, and the mailbox is harmless when nobody
   * reads it — it is dropped the moment a companion panel attaches, and it
   * expires on its own the same way the departure does.
   */
  recallFromDetailedView(text:string) {
    const at=this.now(), recallId=`recall-${++this.recallSerial}`;
    this.detailedViewRecall={at,text,recallId};
    this.recallReceipt={recallId,text,queuedAt:at};
    return {queued:true,away:this.companionInDetailedView(),recallId,status:'queued' as const};
  }
  /**
   * Take the waiting recall, if it is still worth acting on.
   *
   * Consumed exactly once: the page navigates on it, and a second delivery to
   * a page that has already left would only be read by a wearer who opened
   * the viewer again, minutes later, and be yanked straight back out of it.
   */
  takeDetailedViewRecall() {
    const recall=this.detailedViewRecall;
    if(!recall) return undefined;
    this.detailedViewRecall=undefined;
    if(this.now()-recall.at>=DETAILED_VIEW_AWAY_MS) return undefined;
    if(this.recallReceipt?.recallId===recall.recallId) this.recallReceipt.takenAt=this.now();
    return recall;
  }
  /**
   * What became of the last recall, in the words an agent may repeat.
   *
   * `queued` is a sentence nobody has read yet; `read` is the wearer's Mol* tab
   * having taken it and navigated; `returned` is a companion panel attached
   * after that, which is the only reading that means the wearer is back and
   * reachable again. `expired` is the ten-minute trip running out unread.
   */
  detailedRecallReceipt():{recallId:string; status:'queued'|'read'|'returned'|'expired'; text:string;
    queuedMsAgo:number; takenMsAgo?:number; returnedMsAgo?:number}|undefined {
    const receipt=this.recallReceipt;
    if(!receipt) return undefined;
    const now=this.now();
    const status=receipt.returnedAt!==undefined?'returned' as const
      :receipt.takenAt!==undefined?'read' as const
      :now-receipt.queuedAt>=DETAILED_VIEW_AWAY_MS?'expired' as const:'queued' as const;
    return {recallId:receipt.recallId,status,text:receipt.text,
      queuedMsAgo:Math.max(0,now-receipt.queuedAt),
      ...(receipt.takenAt===undefined?{}:{takenMsAgo:Math.max(0,now-receipt.takenAt)}),
      ...(receipt.returnedAt===undefined?{}:{returnedMsAgo:Math.max(0,now-receipt.returnedAt)})};
  }
  /** Whether a recall is still waiting to be taken. For the state summary. */
  detailedViewRecallPending() {
    if(!this.detailedViewRecall) return false;
    if(this.now()-this.detailedViewRecall.at>=DETAILED_VIEW_AWAY_MS) { this.detailedViewRecall=undefined; return false; }
    return true;
  }
  /**
   * The surface of one polling panel, without building a whole summary. The
   * headset caption route runs on every heartbeat and only ever answers a
   * companion page, so it needs this one field and nothing else.
   */
  surfaceOf(panelId:string) { return this.panels.get(panelId)?.surface; }
  /** A map and its reference atoms are different drawings. The host derives
   * this status from the verified density/catalog identities, never a page flag. */
  setDensityReferenceSource(sourceSha256:string|undefined) {
    for(const panel of this.panels.values()) panel.referenceOnly=Boolean(sourceSha256
      && (panel.surface==='desktop' || panel.surface==='detailed') && panel.renderedSourceSha256===sourceSha256);
  }
  /**
   * The tour one panel last reported on its heartbeat.
   *
   * `control_tour` answers with what the command will do, because a
   * next and a back on a lesson nobody had started were both answered "queued".
   * This is how the tool knows which sentence is true before the panel has
   * rendered anything.
   */
  reportTourState(panelId:string,state:TourState) {
    const panel=this.panels.get(panelId);if(panel)panel.tourState=structuredClone(state);
  }
  animationStateOf(panelId:string,binding?:InspectionBinding):AnimationState|null {
    if(binding)this.refresh(binding);
    const panel=this.panels.get(panelId);
    // A caller selecting a panel for a scientific read must not borrow a
    // clock from an older source/revision, even if custom chapter IDs recur.
    if(binding && (!panel || !same(panel,binding)))
      throw Error('The measurement panel is not showing the current saved inspection. Read current state and choose a current panel, or omit panelId to measure the saved scene.');
    return structuredClone(panel?.animation ?? null);
  }
  tourStateOf(panelId:string):TourState|undefined { return this.panels.get(panelId)?.tourState; }
  /**
   * What kind of edit one command was.
   *
   * The shared scene history names the operation it can take back, and the
   * receipt does not carry the kind. This is that one field, read from the
   * command the caller has just confirmed.
   */
  changeKindOf(commandId:string):string|undefined { return this.commands.get(commandId)?.input.change.kind; }
  hasCommand(commandId:string):boolean { return this.commands.has(commandId); }
  lessonChangeOf(commandId:string) {
    const change=this.commands.get(commandId)?.input.change;
    return change?.kind==='lesson'?structuredClone(change):undefined;
  }
  viewChangeOf(commandId:string):InspectionViewChange|undefined {
    const change=this.commands.get(commandId)?.input.change;
    return change?.kind==='save-view'||change?.kind==='restore-view'?structuredClone(change):undefined;
  }
  /**
   * A delivered command hands its claim back while the page saves local work.
   *
   * An unbound command can follow any save its inputs survive. A bound one
   * (explicit revisions, or a voice utterance) follows only a placement save,
   * and `canSettleLocalSave` is where that is enforced: a page that defers
   * over scientific work has its save refused, reports `unsaved`, and the
   * command conflicts as before.
   */
  deferForLocalSave(input:Expected & {panelId:string;commandId:string;claimToken:string},binding:InspectionBinding) {
    this.refresh(binding);
    const c=this.commands.get(input.commandId);
    if(!c || c.claimToken!==input.claimToken || c.input.panelId!==input.panelId || !same(input,binding)
      || !same(c.input,binding) || !(c.input.deferLocalSave || c.localBase) || c.admitted || c.receipt.status!=='rendering')
      return {deferred:false};
    c.receipt.status='queued';c.receipt.heldForPanel=true;c.deadline=c.deliveryDeadline??this.now();
    c.holdReason='The panel is finishing its local save.';delete c.claimToken;
    this.refresh(binding);this.receiptChanged(c.input.commandId);
    return {deferred:c.receipt.status==='queued',command:{...c.receipt}};
  }
  /**
   * Whether this panel's save may commit while commands wait for it.
   *
   * Every waiting command must still be queued on this panel, with no render
   * claimed or fenced. A placement save (`placementOnly`: only the camera and
   * the structure's placement moved) may commit under any of them; anything
   * else only under unbound commands, which compare their inputs afterwards.
   */
  canSettleLocalSave(panelId:string|undefined,binding:InspectionBinding,placementOnly=false) {
    this.refresh(binding);
    const pendingCommands=[...this.commands.values()].filter(c=>pending(c)||c.renderFence);
    return pendingCommands.length>0 && pendingCommands.every(c=>c.receipt.status==='queued' && !c.renderFence
      && c.input.panelId===panelId && (c.input.deferLocalSave || (placementOnly && c.localBase!==undefined)));
  }
  /**
   * Move the commands waiting on this panel past its committed save.
   *
   * `previous` is the saved scene the save replaced. A placement save is the
   * wearer's, so every queued command whose inputs it left alone follows it,
   * bound or not; a scientific save carries only unbound commands, and the
   * rest conflict here with the cause rather than later as merely stale.
   */
  settleLocalSave(panelId:string|undefined,before:InspectionBinding,after:InspectionBinding,scene:InspectionScene,previous?:InspectionScene|null) {
    const placementOnly=Boolean(previous) && sameEntryScene(previous,scene);
    for(const c of this.commands.values()) {
      if(c.receipt.status!=='queued' || c.renderFence || c.input.panelId!==panelId || !same(c.input,before))continue;
      const change=c.input.change;
      if(!(c.input.deferLocalSave || placementOnly) || !c.localBase || change.kind==='save-view' || change.kind==='restore-view'
        || !compatibleLocalSave(c.localBase,scene,change)) {
        c.receipt.status='conflict';c.receipt.reason=localSaveConflictReason(placementOnly);delete c.expected;delete c.localBase;
      } else {
        c.input.baseInspectionRevision=after.inspectionRevision;
        c.localBase=structuredClone(scene);c.expected=expectedInspection(scene,change);
        c.receipt.heldForPanel=true;
        const panel=this.panels.get(c.input.panelId);
        if(panel) {panel.registrationFrom={...before};panel.baseInspectionRevision=after.inspectionRevision;panel.registeringRevision=true;}
      }
      this.receiptChanged(c.input.commandId);
    }
    if(placementOnly && previous) this.followWearerPlacement(panelId,before,after,previous,scene);
  }
  /**
   * Words the wearer is still speaking survive their own placement save.
   *
   * An utterance is bound to the revision at which the words began, so a
   * grab, a stick nudge or the VR entry seat between the words and the
   * command used to refuse it: "The scene or saved revision changed since
   * this utterance began." Moving the structure does not change what the
   * words are about, so the binding follows the save. One that moved the
   * structure is marked, and `checkUtterance` then refuses a command from
   * those words that would move it again — "undo that" spoken before the move
   * would otherwise take back the move. Never across a render in flight.
   */
  private followWearerPlacement(panelId:string|undefined,before:InspectionBinding,after:InspectionBinding,previous:InspectionScene,scene:InspectionScene) {
    if(panelId===undefined || [...this.commands.values()].some(c=>c.receipt.status==='rendering' || c.renderFence)) return;
    const moved=inspectionJson(previous.inspection.placement)!==inspectionJson(scene.inspection.placement);
    for(const u of this.utterances.values()) {
      if(u.supersededBy || !u.panelIds.includes(panelId) || u.binding.serverEpoch!==before.serverEpoch
        || u.binding.sourceToken!==before.sourceToken || u.binding.stateRevision!==before.stateRevision
        || u.binding.inspectionRevision!==before.inspectionRevision) continue;
      u.binding={...after};
      if(moved) u.wearerMoved=true;
    }
  }
  hasPending(binding:InspectionBinding) { this.refresh(binding);return [...this.commands.values()].some(c=>pending(c)||c.renderFence); }
  /** A source-changing experience transition cannot target a dirty or stale panel. */
  readyPanel(panelId:string,binding:InspectionBinding) {
    this.refresh(binding);
    const panel=this.panels.get(panelId);
    return Boolean(panel && same(panel,binding) && panel.availability==='ready' && !this.hasPending(binding));
  }
  holdSourceLoad(panelId:string) {
    if(!this.panels.has(panelId) && this.quietCompanion?.panelId===panelId)
      this.panels.set(panelId,this.quietCompanion);
    this.sourceLoadPanels.add(panelId);
  }
  /** A host replacement owns the next source, even during input or sleep. */
  sourceLoadRefusal(panelId:string,binding:InspectionBinding,requireReady=false):string|undefined {
    this.refresh(binding);
    let panel=this.panels.get(panelId);
    if(!panel && !requireReady && this.quietWearer(this.now())?.panelId===panelId) {
      panel=this.quietCompanion;
      if(panel)this.panels.set(panelId,panel);
    }
    if(!panel)return 'The source-load panel is no longer attached. Reconnect its page before loading.';
    if(panel.serverEpoch!==binding.serverEpoch || panel.sourceToken!==binding.sourceToken
      || (requireReady && !same(panel,binding)))return 'The source-load panel is showing an older source or revision. Wait for its current load to finish.';
    if(this.hasPending(binding))return 'An inspection command is already in progress. Wait for its render receipt before loading a source.';
    if(requireReady && panel.availability!=='ready')return panel.availability==='unsaved'
      ? 'The comparison panel has unsaved local work. Save it before adding a comparison.'
      : `The comparison panel is busy (${classifyPanelAvailability(panel.xrStartup?.value)??'busy'}). Wait for it before adding a comparison.`;
    return undefined;
  }
  /**
   * A receipt belongs to the source it was rendered on.
   *
   * `replace_inspection_source` carries the whole queue over to the new
   * attachment deliberately, so panel registrations and the utterance lifecycle
   * survive the swap. The receipts in that queue must not survive it. Each one
   * names a revision of coordinates the session no longer holds, and on
   * A device run the last of them -- 1CRN's hide-water at r6 -- was drawn
   * again on the wearer's plate 118 ms after 4HHB's own load receipt at r1, so
   * the acknowledgement of the load was the second-to-last thing the wearer
   * could read. A tour command that carried its claim across the boundary is
   * still reported, because `advanceTourTransition` moves that command's
   * binding to the source it is now rendering on.
   */
  private canPruneReceipt(c:Command,binding:InspectionBinding) {
    // Revisions restart when a source is replaced. Terminal receipts from the
    // previous source must not fill the new source's admission limit forever.
    // Keep pending work and its independent render fence until settled.
    return !pending(c) && !c.renderFence && (!this.boundToSource(c,binding)
      || c.input.baseInspectionRevision<binding.inspectionRevision);
  }
  private boundToSource(c:Command,binding:InspectionBinding) {
    const held=c.tourTransition?.binding??c.input;
    return held.serverEpoch===binding.serverEpoch && held.sourceToken===binding.sourceToken;
  }
  latestOutcome(binding:InspectionBinding, panelId?:string) {
    this.refresh(binding);
    // A replacement page must not inherit a terminal receipt
    // from before it existed. A poller sees its own commands and any command
    // issued since it attached, so the desktop app still reads out what it
    // asked the headset to do, and a reloaded page starts with a clean slate.
    const since=panelId===undefined?undefined:this.panels.get(panelId)?.attachedAt;
    const c=[...this.commands.values()].filter(command=>this.boundToSource(command,binding)
      && (panelId===undefined || command.input.panelId===panelId
        || (since!==undefined && command.issuedAt>since))).at(-1);
    // A turntable command is read out as "motion", not as its field name "state".
    // A compound is read out as the kinds it carries, not as the
    // one field name "ops" that would tell a reader nothing about the picture.
    return c?{...c.receipt,change:c.input.change.kind,fields:c.input.change.kind==='animation'?['animation']:c.input.change.kind==='motion'?['motion']
      :c.input.change.kind==='compound'?c.input.change.patch.ops.map(op=>op.kind)
      :Object.keys(c.input.change.patch)}:null;
  }
  /** A resolved selection edit must not rebind its target on an exact retry. */
  retryUpdate(input:{commandId:string},binding:InspectionBinding) {
    this.refresh(binding);
    const previous=this.commands.get(input.commandId);
    if(!previous) return undefined;
    if(previous.signature!==JSON.stringify(input)) throw Error('This commandId was already used for a different request.');
    return {...previous.receipt};
  }
  /** A correction waits for its own superseded render to discard local work.
   * Matching revisions alone cannot make dirty work safe: the exact panel's
   * superseded claim must still hold its fence, and name this correction. */
  private awaitingSupersededRender(input:Expected & {panelId:string;utteranceId?:string},binding:InspectionBinding) {
    if(!input.utteranceId || !same(input,binding)) return false;
    return [...this.commands.values()].some(old=>old.renderFence && old.receipt.status==='superseded'
      && old.input.panelId===input.panelId && same(old.input,binding)
      && (old.receipt.supersededBy===input.utteranceId
        || (old.receipt.supersededBy && this.utterances.get(old.receipt.supersededBy)?.supersededBy===input.utteranceId)));
  }
  enqueue(input:Request,binding:InspectionBinding,scene:InspectionScene|null,tool = 'update_inspection') {
    this.assertReceiptRetained(input.commandId);
    this.assertNotToolNoop(input.commandId);
    this.refresh(binding);
    if(this.controls.has(input.commandId)) throw Error('This commandId was already used for a different request.');
    const signature=JSON.stringify(input.requestIdentity ?? input), previous=this.commands.get(input.commandId);
    if(previous) {
      if(previous.signature!==signature) throw Error('This commandId was already used for a different request.');
      return {...previous.receipt};
    }
    if(input.change.kind==='tour' && TOUR_STOP_ACTIONS.has(input.change.patch.action))
      this.rehomeTourStop(input.utteranceId,input.panelId,binding);
    this.checkUtterance(input,binding);
    if(!scene || !same(input,binding)) throw Error('Read get_inspection_state and use its current saved revisions before changing the inspection.');
    if(binding.inspectionRevision===Number.MAX_SAFE_INTEGER) throw Error('Inspection revision exhausted; open a new session.');
    const panel=this.panels.get(input.panelId);
    // A paused headset page cannot draw anything, so a command
    // queued for it only waits out its deadline. Say so now instead.
    // `keepForPausedWearer` has already saved every edit that can be saved.
    const pause=panel?.availability==='unsaved'?undefined:this.pausedTarget(input.panelId,this.now());
    if(pause && input.change.kind!=='lesson') throw Error(wearerPausedRefusal(pause,keptWhilePaused(input.change)?undefined:input.change.kind));
    // `busy` is queued, not refused.
    //
    // A Quest 2 panel goes `busy` for two to five seconds every time the system
    // puts a 2D dialog in front of the wearer, and a `control_tour
    // play` that lands inside one of those windows used to be refused outright. The
    // wearer was in the headset the whole time. `poll` below already holds a
    // `queued` command until the panel answers `ready`, so admitting it here is
    // all that was missing: the command is delivered on the first unblurred
    // heartbeat, and the 15 s deadline is the bound on how long it can wait.
    // A correction can also arrive while its superseded render is rolling
    // back. Hold it until that claim settles and the panel reports ready.
    // Implicit commands wait for a local save and compare its inputs before
    // rebasing. Explicit revisions, missing panels and stale sources still refuse.
    if(!panel || (!same(panel,binding) && !(pause && input.change.kind==='lesson'
      && panel.serverEpoch===binding.serverEpoch && panel.sourceToken===binding.sourceToken)) || (panel.availability==='unsaved' && !input.deferLocalSave && !this.awaitingSupersededRender(input,binding)))
      throw Error(input.change.kind==='lesson'
        ? !panel?'The lesson panel is no longer attached. Reconnect its page before installing the lesson.'
          :'The lesson panel is showing an older source or revision. Wait for its current load to finish.'
        :'The target panel is unavailable, busy, or has unsaved work. Read get_inspection_state.');
    if([...this.commands.values()].some(pending)) throw Error('An inspection command is already in progress. Check its status first.');
    if(input.change.kind==='save-view'||input.change.kind==='restore-view') throw Error('Use the named-view command path.');
    const expected=expectedInspection(scene,input.change);
    // Eviction is safe only when the old expected revision can no longer be
    // admitted. Failed/expired commands at this same revision must not replay.
    for(const [id,c] of this.commands) {
      if(this.commands.size<32) break;
      if(this.canPruneReceipt(c,binding)) this.pruneCommand(id,c);
    }
    if(this.commands.size>=32) throw Error('This saved revision has too many failed commands. Make a deliberate manual edit or open a new session before trying again.');
    const receipt:Receipt={commandId:input.commandId,panelId:input.panelId,status:'queued',operation:visualOperation(input.change,tool),acceptedAt:this.now(),
      renderBudgetMs:this.renderBudgetMs,
      assistantName:input.assistantName, action:actionText(input.change),
      ...(input.appliedTo?{appliedTo:structuredClone(input.appliedTo)}:{}),
      ...(input.focus?{focus:{...input.focus}}:{}),
      ...(input.actionPostedAt!==undefined?{actionPostedAt:input.actionPostedAt}:{}),
      ...(input.utteranceId?{utteranceId:input.utteranceId,utteranceSequence:this.utterance(input.utteranceId)?.sequence}:{}),
      ...(panel.availability==='ready' && ![...this.commands.values()].some(c=>c.renderFence)?{}:{heldForPanel:true})};
    const holdReason=receipt.heldForPanel ? [...this.commands.values()].some(c=>c.renderFence)
      ? 'The change was not sent because the previous cancelled change was still being restored. Try again when the view is ready.'
      : 'The change was not sent because the panel stayed busy. Try again when the view is ready.' : undefined;
    // Every queued command keeps the scene it was admitted against, so a
    // placement save can carry a bound command too (`settleLocalSave`).
    this.commands.set(input.commandId,{input:structuredClone(input),signature,expected,localBase:structuredClone(scene),receipt,holdReason,deliveryDeadline:this.now()+15000,deadline:this.now()+15000,issuedAt:++this.serial});
    this.holdForEntry(this.commands.get(input.commandId)!,this.now());
    return {...receipt};
  }
  enqueueView(input:Expected & {panelId:string;commandId:string;utteranceId?:string;change:InspectionViewChange},binding:InspectionBinding,scene:InspectionScene|null) {
    this.assertReceiptRetained(input.commandId);
    this.assertNotToolNoop(input.commandId);
    this.refresh(binding);
    if(this.controls.has(input.commandId)) throw Error('This commandId was already used for a different request.');
    const signature=JSON.stringify(input), previous=this.commands.get(input.commandId);
    if(previous) {
      if(previous.signature!==signature) throw Error('This commandId was already used for a different request.');
      return {...previous.receipt};
    }
    this.checkUtterance(input,binding);
    if(!scene || !same(input,binding)) throw Error('Read get_inspection_state and use its current saved revisions before managing a view.');
    const panel=this.panels.get(input.panelId);
    const pause=panel?.availability==='unsaved'?undefined:this.pausedTarget(input.panelId,this.now());
    if(pause) throw Error(wearerPausedRefusal(pause,input.change.kind));
    if(!panel || !same(panel,binding) || panel.availability!=='ready')
      throw Error('The target panel is unavailable, busy, or has unsaved work. Read get_inspection_state.');
    if([...this.commands.values()].some(pending)) throw Error('An inspection command is already in progress. Check its status first.');
    // A named capture deliberately leaves inspectionRevision unchanged. Keep
    // its command tombstone so the same ID cannot later capture different
    // panel state; only commands from an older committed revision are safe to
    // evict. At one revision the bounded alternative is an explicit refusal.
    for(const [id,c] of this.commands) {
      if(this.commands.size<32) break;
      if(this.canPruneReceipt(c,binding)) this.pruneCommand(id,c);
    }
    if(this.commands.size>=32) throw Error('This saved revision already has 32 completed named-view commands. Make a deliberate shared edit or open a new session before saving another.');
    const expected=structuredClone(input.change.kind==='restore-view'?input.change.patch.scene:scene);
    const receipt:Receipt={commandId:input.commandId,panelId:input.panelId,status:'queued',
      operation:visualEdit([input.change.kind],'manage_inspection_view'),acceptedAt:this.now(),
      renderBudgetMs:this.renderBudgetMs,
      ...(input.utteranceId?{utteranceId:input.utteranceId,utteranceSequence:this.utterance(input.utteranceId)?.sequence}:{})};
    this.commands.set(input.commandId,{input:structuredClone(input),signature,expected,receipt,deadline:this.now()+15000,issuedAt:++this.serial});
    return {...receipt};
  }
  assertDesktopTarget(panelId:string,binding:InspectionBinding) {
    this.refresh(binding);
    const panel=this.panels.get(panelId);
    if(!panel||!same(panel,binding)||panel.surface!=='desktop'||panel.availability!=='ready'||panel.xrStartup?.value.presenting===true)
      throw Error('The requested panel is not a current ready desktop inspection. Read get_inspection_state and choose that exact panelId.');
  }
  /** Only the host's validated failed-source owner heartbeat may renew this hold. */
  holdSourceRecovery(panelId:string, until:number|undefined) {
    const panel=this.panels.get(panelId);
    if(!panel)return;
    // Recovery time is not unsaved-edit time. On a live lease's one-time
    // revocation, allow the normal bounded busy/manual interval to start now.
    if(until===undefined && panel.sourceRecoveryUntil!==undefined && panel.availability==='unsaved')
      panel.unsavedSince=Math.min(this.now(),panel.sourceRecoveryUntil);
    panel.sourceRecoveryUntil=until;
  }
  pageBuildOf(panelId:string) { return this.panels.get(panelId)?.pageBuild; }
  poll(input:Expected & {panelId:string; availability:Panel['availability']; pageBuild?:string;spatialContext?:SpatialContext|null;animation?:AnimationState|null;tourState?:TourState;experience?:ExperienceChapter;xrStartup?:XrStartup},binding:InspectionBinding) {
    this.refresh(binding);
    const panel=this.panels.get(input.panelId);
    if(!panel) return {attached:false,...(this.supersededPanels.has(input.panelId)?{superseded:true}:{})};
    // A panel capability is never rebound to a different source or epoch.
    if(panel.serverEpoch!==input.serverEpoch || panel.sourceToken!==input.sourceToken) return {attached:false};
    const {spatialContext,xrStartup,...heartbeat}=input;
    const now=this.now();
    // Completion has already proved the next saved revision on this panel.
    // A heartbeat sent during that render must not overwrite the proof or
    // conflict a queued correction. Wait for registration at the new revision.
    if(panel.registrationFrom && same(panel,binding) && same(input,panel.registrationFrom) && (input.availability!=='unsaved'
      || [...this.commands.values()].some(c=>c.receipt.status==='queued' && c.input.panelId===input.panelId && c.input.deferLocalSave))) {
      panel.seen=now;
      panel.pageBuild=input.pageBuild;
      if(panel.registeringRevision && input.availability==='busy') panel.availability='busy';
      return {attached:true};
    }
    // Keep the receipt proof after a current heartbeat: an even later old
    // heartbeat must not make this now-ready panel stale again.
    if(!same(input,binding) || input.availability==='unsaved') delete panel.registrationFrom;
    delete panel.registeringRevision;
    if(input.availability!=='unsaved')delete panel.unsavedSince;
    else if(panel.unsavedSince===undefined || panel.baseStateRevision!==input.baseStateRevision || panel.baseInspectionRevision!==input.baseInspectionRevision)
      panel.unsavedSince=now;
    Object.assign(panel,heartbeat,{seen:now,pageBuild:input.pageBuild});
    this.noteTourChapter(panel,input,binding);
    // Panel liveness is not a new XR observation. Omitted diagnostics and
    // command receipts must not make an old native-session sample look fresh.
    if(xrStartup!==undefined) {
      // The page counts only frames Mol* drew into a visible
      // session, so a count that moved since the last report is the evidence
      // `wearerPage` needs for `in-vr`. A new session restarts the count, so
      // a lower number clears the old session's evidence.
      const before=panel.xrStartup?.value.frameCount;
      if(xrStartup.presenting!==true || xrStartup.sessionVisibility!=='visible') delete panel.xrDrawnAt;
      else if(before!==undefined && (xrStartup.frameCount??0)<before) delete panel.xrDrawnAt;
      else if(before!==undefined && (xrStartup.frameCount??0)>before) panel.xrDrawnAt=now;
      const visible=xrStartup.visible!==false && (!xrStartup.presenting || xrStartup.sessionVisibility!=='hidden');
      const previous=panel.xrStartup?.value;
      if(visible && (!previous || previous.visible===false || previous.sessionVisibility==='hidden')) panel.visibleAt=++this.serial;
      panel.xrStartup={value:xrStartup,receivedAt:now};
    }
    // Omission keeps legacy panels compatible. A non-XR heartbeat must send
    // null so stale wearer context cannot outlive immersive mode.
    if(Object.hasOwn(input,'spatialContext')) panel.spatial=spatialContext?{value:spatialContext,receivedAt:now}:undefined;
    const c=[...this.commands.values()].find(c=>c.input.panelId===input.panelId && c.receipt.status==='queued');
    if(!c) return {attached:true};
    // Wake-up may first need to follow saved edits on this source. Do not
    // reject its queued lesson before that shared-scene restore can run.
    if(c.input.change.kind==='lesson' && !same(input,binding)
      && input.serverEpoch===binding.serverEpoch && input.sourceToken===binding.sourceToken)return {attached:true};
    if(!same(input,binding) || (input.availability==='unsaved' && !c.input.deferLocalSave
      && !this.awaitingSupersededRender({...input,utteranceId:c.input.utteranceId},binding))) {
      c.receipt.status='conflict'; c.receipt.reason='The target panel has newer or unsaved local work.';
      delete c.expected;delete c.localBase;
      return {attached:true};
    }
    this.holdForEntry(c,now);
    if(c.receipt.status!=='queued' || (c.entryHold && !c.entryHold.ready))return {attached:true};
    // A hidden page that says `ready` would claim the command and
    // then wait thirty seconds for a frame the browser never draws. Hold it,
    // and the host saves it for the page if it can be saved. The hold reason
    // can reach the wearer's status plate, so it is written for them too.
    if(this.pauseOf(panel,now)) {
      c.receipt.heldForPanel=true;
      c.holdReason='The change was not sent because the headset page was paused. Try again when the view is showing.';
      return {attached:true};
    }
    const fenced=[...this.commands.values()].some(c=>c.renderFence);
    if((input.availability!=='ready' && !(c.input.change.kind==='lesson' && classifyPanelAvailability(panel.xrStartup?.value)==='busy')) || fenced) {
      c.receipt.heldForPanel=true;
      c.holdReason=fenced
        ? 'The change was not sent because the previous cancelled change was still being restored. Try again when the view is ready.'
        : 'The change was not sent because the panel stayed busy. Try again when the view is ready.';
      return {attached:true};
    }
    // Use the bounded host allowance captured at enqueue, not a later source's
    // budget. `published` reports the remaining time from this fixed claim;
    // heartbeats and receipt retries never extend it.
    c.claimToken=randomUUID(); c.receipt.status='rendering'; c.deadline=this.now()+(c.receipt.renderBudgetMs??120000);
    // Receipt waiting is a caller preference, not a deadline for panel readiness.
    return {attached:true,delivery:{commandId:c.input.commandId,panelId:input.panelId,claimToken:c.claimToken,queueWaitMs:Math.max(0,now-c.receipt.acceptedAt),deferLocalSave:c.input.deferLocalSave===true,settleBudgetMs:Math.min(15000,Math.max(0,(c.deliveryDeadline??now+15000)-now)),
      ...(c.input.utteranceId?{utteranceId:c.input.utteranceId}:{}),change:structuredClone(c.input.change)}};
  }
  /**
   * `catalog` is what lets the receipt read a returned scene
   * rather than diff it. A focus command's panel may lift the lesson's fade off
   * the region it framed, and only the rows a colour key names say whether the
   * scene that came back actually lights that region. Omitting it keeps the
   * older exact comparison, which is what every caller without a catalog wants.
   */
  complete(input:Expected & {panelId:string;commandId:string;claimToken:string;scene?:InspectionScene;allowReplacement?:boolean;failure?:string;failureReason?:string;scaleAppliesOnNextEntry?:boolean;placementAdjusted?:boolean;placementFit?:PlacementFitEvidence;wearerPlacement?:boolean;recenterCompletion?:RecenterCompletion;geometryBudget?:GeometryBudgetReceipt;animation?:AnimationState|null},binding:InspectionBinding,catalog?:EmphasisCatalog) {
    this.refresh(binding);
    const c=this.commands.get(input.commandId);
    if(!c || c.input.panelId!==input.panelId || c.claimToken!==input.claimToken
      || input.serverEpoch!==c.input.serverEpoch || input.sourceToken!==c.input.sourceToken
      || input.baseStateRevision!==c.input.baseStateRevision || input.baseInspectionRevision!==c.input.baseInspectionRevision)
      throw Error('This receipt does not belong to the claimed panel command.');
    if(c.receipt.status!=='rendering') {
      // The page still owns the workspace queue after this frame. Transfer only
      // a complete overwrite of the same appearance fields, on this exact
      // source/revision/panel, after validating the older drawn scene.
      if(input.allowReplacement && input.scene && c.renderFence && c.receipt.status==='superseded'
        && ![...this.commands.values()].some(other=>other.renderFence && other.input.panelId!==c.input.panelId)
        && c.admitted && c.expected && same(c.input,binding) && c.input.change.kind==='appearance'
        && matchesInspectionChange(input.scene,c.expected,c.input.change,catalog)) {
        const next=c.replacementCommandId ? this.commands.get(c.replacementCommandId)
          : [...this.commands.values()].find(next=>next.receipt.status==='queued'
            && next.input.panelId===c.input.panelId && same(next.input,binding)
            && next.input.utteranceId===c.receipt.supersededBy && next.input.change.kind==='appearance'
            && Object.keys(c.input.change.patch).every(field=>Object.hasOwn(next.input.change.patch,field)));
        if(next && (next.receipt.status==='queued' || (next.receipt.status==='rendering' && !next.admitted))) {
          if(next.receipt.status==='queued') {
            next.claimToken=randomUUID();next.receipt.status='rendering';next.deadline=this.now()+(next.receipt.renderBudgetMs??120000);
            next.replacesCommandId=c.input.commandId;c.replacementCommandId=next.input.commandId;
          }
          return {accepted:false,command:{...c.receipt},replacement:{commandId:next.input.commandId,
            panelId:next.input.panelId,claimToken:next.claimToken!,utteranceId:next.input.utteranceId,
            change:structuredClone(next.input.change)}};
        }
      }
      return {accepted:c.receipt.status==='rendered',command:{...c.receipt}};
    }
    if(input.failure) {
      c.receipt.status='rejected';c.receipt.reason=input.failure;
      if(input.failureReason) c.receipt.detail=input.failureReason;
      delete c.expected;delete c.localBase;
      this.receiptChanged(c.input.commandId);
      return {accepted:false,command:{...c.receipt}};
    }
    if(c.tourTransition)throw Error('A journey command needs its rendered experience acknowledgement.');
    const viewChange=c.input.change.kind==='save-view'||c.input.change.kind==='restore-view'?c.input.change:undefined;
    const scientificMatch=(a:InspectionScene,b:InspectionScene)=>inspectionJson({sourceSha256:a.sourceSha256,modelNumber:a.modelNumber,
      assemblyId:a.assemblyId,selectionKeys:a.selectionKeys,inspection:a.inspection})===inspectionJson({sourceSha256:b.sourceSha256,
      modelNumber:b.modelNumber,assemblyId:b.assemblyId,selectionKeys:b.selectionKeys,inspection:b.inspection});
    const recenter=c.input.change.kind==='placement' && c.input.change.patch.recenter===true;
    const resetConfirmed=!recenter || Boolean(input.recenterCompletion?.structureReset && input.scene
      && inspectionJson(input.recenterCompletion.placement)===inspectionJson(input.scene.inspection.placement));
    const animationChange=c.input.change.kind==='animation'?c.input.change:undefined;
    const animation=input.animation;
    const animationConfirmed=!animationChange || Boolean(animation
      && (!animationChange.target || (animation.id===animationChange.target.id && animation.chapterId===animationChange.target.chapterId))
      && animationReceiptMatches(animationChange.patch, animation, Math.max(0, this.now() - c.receipt.acceptedAt) / 1000)
      && (!input.scene?.inspection.animation || inspectionJson(input.scene.inspection.animation.playback) === inspectionJson(animation)));
    // A lesson chapter is drawn whole only with its clock. A tour or lesson
    // receipt whose scene carries an animation must report the state of that
    // same animation.
    const lessonChange=c.input.change.kind==='tour' || c.input.change.kind==='lesson';
    const sceneAnimation=input.scene?.inspection.animation?.playback;
    const lessonClockConfirmed=!lessonChange || !sceneAnimation
      || (Boolean(animation) && animation!.id===sceneAnimation.id && animation!.chapterId===sceneAnimation.chapterId);
    const matched=animationConfirmed && resetConfirmed && lessonClockConfirmed && input.scene && (viewChange?.kind==='restore-view' && c.expected ? scientificMatch(input.scene,c.expected)
      : c.expected ? matchesInspectionChange(input.scene,c.expected,c.input.change as InspectionChange,catalog,
        input.placementAdjusted===true,input.placementFit,input.wearerPlacement===true) : false);
    // A capture may differ from the host's last shared scene, but its immutable
    // source identity must remain the one this command was admitted against.
    const captured=input.scene && c.expected && viewChange?.kind==='save-view'
      && input.scene.sourceSha256===c.expected.sourceSha256 && input.scene.modelNumber===c.expected.modelNumber
      && input.scene.assemblyId===c.expected.assemblyId && c.input.sourceToken===binding.sourceToken;
    if(!input.scene || (!matched && !captured)) {
      c.receipt.status='unconfirmed';c.receipt.reason='The returned scene did not match the requested change.';
      if(c.input.change.kind==='placement' || (c.input.change.kind==='compound'
        && c.input.change.patch.ops.some(op=>op.kind==='placement')))
        c.receipt.detail='The placement was not rendered as requested.';
      delete c.expected;delete c.localBase;
      this.receiptChanged(c.input.commandId);
      return {accepted:false,command:{...c.receipt}};
    }
    // The caller validates the scene and byte budget before this synchronous
    // transition, then commits it with this revision before yielding.
    c.receipt.status='rendered';c.receipt.renderedAt=this.now();
    if(recenter && input.recenterCompletion?.menuReseated===false)
      c.receipt.detail='The structure reset, but the menu did not move.';
    if(input.placementAdjusted) c.receipt.detail='Moved or resized the structure to clear the headset menu and reply plate.';
    this.releaseQueuedSupersessions(c);
    this.releasePredecessors(c,'replacement-rendered');
    if(input.scene.inspection.companionStructure) { const companion=input.scene.inspection.companionStructure;
      c.receipt.comparison={alignment:'side-by-side',sourceSha256:companion.sourceSha256,modelNumber:companion.modelNumber,assemblyId:companion.assemblyId}; }
    c.receipt.renderedRevision=viewChange?.kind==='save-view'?binding.inspectionRevision:binding.inspectionRevision+1;
    // Only a render-quality command can leave half of itself pending, and only
    // the panel that rendered it knows whether it did.
    if(input.scaleAppliesOnNextEntry && c.input.change.kind==='render-quality') c.receipt.scaleAppliesOnNextEntry=true;
    if(animationChange && animation) c.receipt.animation=structuredClone(animation);
    if(input.geometryBudget) c.receipt.geometryBudget=structuredClone(input.geometryBudget);
    // Completing an expensive render is itself proof that this claimed panel
    // is alive. Give it one normal heartbeat grace period to poll using the
    // newly committed revision without forcing a replacement panel identity.
    const panel=this.panels.get(input.panelId);
    if(panel) {
      panel.seen=this.now();
      if(animationChange && animation) panel.animation=structuredClone(animation);
      else if((c.input.change.kind==='tour'||c.input.change.kind==='lesson') && input.animation!==undefined) panel.animation=structuredClone(input.animation);
      // The report arrives after the panel saved the committed scene, so it is
      // already on the revision the host is about to publish. Advancing its
      // base here keeps the next request from being refused as stale in the
      // second before its heartbeat says the same thing; the other panels
      // still have to say so themselves.
      panel.baseStateRevision=binding.stateRevision;
      panel.baseInspectionRevision=c.receipt.renderedRevision!;
      if(panel.baseInspectionRevision!==binding.inspectionRevision) {
        panel.registrationFrom={...binding};
        panel.registeringRevision=true;
      }
    }
    delete c.expected;delete c.localBase;
    this.receiptChanged(c.input.commandId);
    return viewChange?.kind==='save-view'
      ? {accepted:true,command:{...c.receipt},capturedScene:input.scene}
      : {accepted:true,command:{...c.receipt},scene:input.scene};
  }
}

function actionText(change:CommandChange):string {
  if(change.kind==='animation')return change.patch.state==='pause'?'paused animation':change.patch.state==='play'?'played animation':'updated animation';
  if(change.kind==='tour')return `${change.patch.action==='pause'?'paused':change.patch.action==='start'?'started':change.patch.action} tour`;
  if(change.kind==='motion')return change.patch.state==='stop'?'stopped spinning':'started spinning';
  return `updated ${change.kind}`;
}
