import { createHash, randomUUID } from 'node:crypto';
// @ts-ignore Shared JavaScript science module: one default context opacity, so
// a cleared emphasis restores the same faintness the lesson and the tools use.
import { DEFAULT_CONTEXT_OPACITY } from '../../lab/browser-roundtrip/lesson-emphasis.mjs';
import { inspectionJson, COMPOUND_MIN_OPS, REFERENT_PRONOUNS, normalizeVisibility, normalizeStyles, applyScopedStyle, type InspectionChange, type InspectionCompoundOp,
  validateScene, emphasisSelectionKeys, type InspectionScene, type RequestPointing, type RequestReferent } from './inspection-contract.js';

/**
 * WHAT THE PERSON MEANT BY "THIS".
 *
 * The referent is read once, when the request starts, and then carried. The
 * request start is the moment the wearer squeezes the grip or presses the talk
 * orb, which is seconds before the transcript exists and longer still before a
 * model has answered. Everything after that instant belongs to the next
 * request.
 */
export function captureRequestReferent(input:{sourceToken:string; scene:InspectionScene|null;
  pointing?:RequestPointing; at:number}):RequestReferent {
  const emphasis=input.scene?.inspection.emphasis;
  const partId=input.pointing?.partId ?? (!input.scene?.selectionKeys.length && !input.pointing?.residueKey ? emphasis?.focus[0] : undefined);
  return {
    sourceToken:input.sourceToken,
    capturedAt:input.at,
    ...(input.scene?{modelNumber:input.scene.modelNumber,assemblyId:input.scene.assemblyId}:{}),
    selectionKeys:input.scene?[...input.scene.selectionKeys]:[],
    // Explicit pointing wins; a lit part is only a fallback without a residue
    // target. A selected residue must not silently become a different lit part.
    ...(partId?{partId}:{}),
    ...(input.pointing?.residueKey ? {residueKey:input.pointing.residueKey} : {}),
  };
}

/**
 * The referents of requests that have started and not yet been answered.
 *
 * One open referent per session: a wearer holds one grip at a time. Opening
 * again while one is open keeps the first, because the request that is running
 * started then and the second press is the same press being reported twice.
 */
export function createRequestReferentStore({now=Date.now, ttlMs=300_000, maxSessions=16}:{
  now?:()=>number; ttlMs?:number; maxSessions?:number} = {}) {
  const open=new Map<string,{referent:RequestReferent; at:number}>();
  const prune=()=>{const cutoff=now()-ttlMs; for(const [id,held] of open) if(held.at<=cutoff) open.delete(id);};
  return {
    /** Record where the wearer was when this request began. */
    capture(sessionId:string, referent:RequestReferent) {
      prune();
      const held=open.get(sessionId);
      if(held && held.referent.sourceToken===referent.sourceToken) return held.referent;
      if(!open.has(sessionId) && open.size>=maxSessions) open.delete(open.keys().next().value!);
      open.set(sessionId,{referent,at:now()});
      return referent;
    },
    /** What the open request was captured against, if one is still open. */
    read(sessionId:string):RequestReferent|undefined { prune(); return open.get(sessionId)?.referent; },
    /** The request has been answered; the next press captures afresh. */
    release(sessionId:string) { return open.delete(sessionId); },
    size() { prune(); return open.size; },
  };
}
export type RequestReferentStore = ReturnType<typeof createRequestReferentStore>;

/**
 * The keys a referent does NOT carry to a model.
 *
 * A referent captured during a tour chapter held 574 canonical keys, which is
 * about 100 KB of JSON. `listen_voice` put it beside the transcript, the model
 * client refused a result that size outright and wrote it to a file, and the
 * wearer's "stop, go back to my view" cost 15.6 s and a shell command to read.
 *
 * The keys are host state, not model state: an agent never reads them, it only
 * gives them back. So beyond this many they stay here under a digest of
 * themselves and the referent travels as a sample plus a count. A referent
 * echoed back is filled in again before any validation or targeting runs, so
 * every rule about the captured selection is enforced against the whole
 * capture and nothing downstream can tell the difference.
 */
export const REFERENT_INLINE_KEY_LIMIT = 16;

/** Name a captured key set by its content, so an echo cannot claim another. */
export function referentKeyDigest(keys:readonly string[]):string {
  return createHash('sha256').update(JSON.stringify([...keys])).digest('hex').slice(0,32);
}

export function createReferentKeyStore({now=Date.now, ttlMs=600_000, maxCaptures=32}:{
  now?:()=>number; ttlMs?:number; maxCaptures?:number} = {}) {
  const held=new Map<string,{keys:readonly string[]; at:number}>();
  const prune=()=>{const cutoff=now()-ttlMs; for(const [digest,entry] of held) if(entry.at<=cutoff) held.delete(digest);};
  return {
    /** The form a model reads: small enough to arrive, exact enough to echo. */
    compact(referent:RequestReferent):RequestReferent {
      if(referent.selectionKeys.length<=REFERENT_INLINE_KEY_LIMIT) return referent;
      prune();
      const selectionDigest=referentKeyDigest(referent.selectionKeys);
      held.set(selectionDigest,{keys:[...referent.selectionKeys],at:now()});
      while(held.size>maxCaptures) held.delete(held.keys().next().value!);
      return {...referent,selectionKeys:referent.selectionKeys.slice(0,REFERENT_INLINE_KEY_LIMIT),
        selectionCount:referent.selectionKeys.length,selectionDigest,truncated:true};
    },
    /**
     * Put the captured keys back. A referent for another structure is handed
     * on untouched, so `referentSelection` refuses it in its own words rather
     * than this reporting a capture it was never going to accept.
     */
    expand<T extends RequestReferent|undefined>(referent:T, sourceToken:string):T {
      if(!referent?.truncated || referent.sourceToken!==sourceToken) return referent;
      prune();
      const keys=referent.selectionDigest?held.get(referent.selectionDigest)?.keys:undefined;
      if(!keys) throw Error('The selection that request captured is no longer held on this Mac. Read get_inspection_state and ask again.');
      const {truncated:_truncated,selectionCount:_count,selectionDigest:_digest,...rest}=referent;
      return {...rest,selectionKeys:[...keys]} as T;
    },
    size() { prune(); return held.size; },
  };
}
export type ReferentKeyStore = ReturnType<typeof createReferentKeyStore>;

/** Whether a caller wrote "this" or "that" where a part name belongs. */
export function isReferentPronoun(name:string):boolean {
  return REFERENT_PRONOUNS.includes(name.trim().toLowerCase());
}

/**
 * The region a request means, given what it named and what it carried.
 *
 * A referent from another structure describes nothing here and is refused: the
 * keys in it were resolved against coordinates this session no longer has.
 */
export function referentSelection(referent:RequestReferent|undefined, sourceToken:string,
  fallback:readonly string[]):readonly string[] {
  if(!referent) return fallback;
  if(referent.sourceToken!==sourceToken)
    throw Error('That request was captured on a different structure. Read get_inspection_state and ask again.');
  return referent.selectionKeys;
}

/** Target metadata is intent while queued; only a rendered receipt confirms it. */
export type ReferentAppliedTo = {capturedAt:number; scene?:true; selectionKeys?:string[]};

/** Validate even informational referents and explicit-target calls. */
export function validateRequestReferent(referent:RequestReferent|undefined, sourceToken:string,
  scene:InspectionScene|null, catalog:any, density?:{sha256:string}):void {
  if(!referent) return;
  referentSelection(referent,sourceToken,[]);
  if(!scene) throw Error('The scene that request was captured on is no longer available. Load and save the intended inspection.');
  if((referent.modelNumber!==undefined && referent.modelNumber!==scene.modelNumber)
    || (referent.assemblyId!==undefined && referent.assemblyId!==scene.assemblyId))
    throw Error('That request was captured on a different model or assembly. Read get_inspection_state and ask again.');
  // Reuse the canonical source/model/copy membership validator, including maps.
  validateScene({...scene,selectionKeys:referent.selectionKeys},catalog,density);
  if(referent.residueKey) validateScene({...scene,selectionKeys:[referent.residueKey]},catalog,density);
}

const sameKeys=(a:readonly string[],b:readonly string[]) => {
  const keys=new Set(b);
  return a.length===b.length && keys.size===a.length && new Set(a).size===a.length && a.every(key=>keys.has(key));
};

/** Pin selection-relative visibility in the same render, including exact retries. */
export function bindVisibilitySelection(change:Extract<InspectionChange,{kind:'compound'|'visibility'}>,
  referent:RequestReferent):InspectionChange {
  const ops=change.kind==='compound'?change.patch.ops:[change];
  // Always carry the selection, even if it currently matches: deriving the
  // command shape from live state would change its signature after rendering.
  // Reuse an existing selection slot, so the compound op bound holds.
  return {kind:'compound',patch:{ops:[
    {kind:'selection',patch:{selectionKeys:[...referent.selectionKeys]}},
    ...ops.filter(op=>op.kind!=='selection'),
  ]}};
}

/**
 * Resolve the target once; delayed requests keep the captured keys. A named
 * region arrives as `regionKeys`, already resolved against the saved model, and
 * wins over both the referent and the live selection.
 */
export function resolveScopedAppearance(change:any, scene:InspectionScene, referent?:RequestReferent,
  scope?:'scene', regionKeys?:readonly string[]):InspectionChange {
  if(change.kind!=='appearance') return change;
  // A referent that captured nothing selected and nothing pointed
  // at means the whole scene. "Show it as a surface." with nothing selected is
  // a request about the molecule, and refusing it for having no selection told
  // the wearer to select residues they had never asked to style.
  const captured=referent!==undefined && (referent.residueKey!==undefined || referent.selectionKeys.length>0);
  const local=regionKeys!==undefined || change.scope==='selection' || (captured && scope!=='scene'
    && ['representation','color','uniformColor','opacity'].some(key=>change.patch[key]!==undefined));
  if(!local) return change;
  const selectionKeys=regionKeys?[...regionKeys]
    :referent?.residueKey?[referent.residueKey]:referent?[...referent.selectionKeys]:[...scene.selectionKeys];
  const fields=new Set(['representation','color','uniformColor','opacity','clear']);
  const style=Object.fromEntries(Object.entries(change.patch).filter(([key])=>fields.has(key)));
  const scenePatch=Object.fromEntries(Object.entries(change.patch).filter(([key])=>!fields.has(key)));
  const scoped:InspectionCompoundOp={kind:'styles',patch:{styles:applyScopedStyle(scene.inspection.styles,selectionKeys,style),
    selectionKeys,style:style as any}};
  return Object.keys(scenePatch).length
    ? {kind:'compound',patch:{ops:[{kind:'appearance',patch:scenePatch},scoped]}}
    : scoped;
}

/** Describe the validated captured target without broadening its scope. */
export function referentAppliedTo(change:InspectionChange, referent:RequestReferent|undefined,
  scene:InspectionScene, catalog:any, scope?:'scene', visibilitySelection=false):ReferentAppliedTo|undefined {
  if(!referent) return undefined;
  const captured=!visibilitySelection && referent.residueKey?[referent.residueKey]:referent.selectionKeys;
  const targets=new Set<string>();
  let whole=false;
  const ops=change.kind==='compound'?change.patch.ops:[change];
  for(const op of ops) {
    if(op.kind==='selection' || op.kind==='focus') {
      const keys=op.patch.selectionKeys;
      if(!sameKeys(keys,captured))
        throw Error('The requested selection differs from the captured canonical target. Use the captured selectionKeys or ask again; this request cannot target the newer selection.');
      keys.forEach(key=>targets.add(key));
    } else if(op.kind==='visibility' && visibilitySelection) {
      referent.selectionKeys.forEach(key=>targets.add(key));
    } else if(op.kind==='styles') {
      const keys=op.patch.selectionKeys ?? [];
      if(!sameKeys(keys,captured)) throw Error('The requested style differs from the captured canonical target.');
      keys.forEach(key=>targets.add(key));
    } else if(op.kind==='emphasis') {
      if(!op.patch.focus.length) whole=true;
      else emphasisSelectionKeys(op.patch,catalog,scene.modelNumber).forEach(key=>targets.add(key));
    } else {
      if(op.kind==='appearance' && (op.patch.labels===true || op.patch.highlightColor!==undefined)) {
        if(!captured.length || !sameKeys(scene.selectionKeys,captured))
          throw Error('Selection-relative labels or highlighting require the captured selection to remain selected. Select the captured canonical keys and confirm rendering before retrying.');
        captured.forEach(key=>targets.add(key));
      }
      // A placement moves the whole molecule whatever was pointed at when it was asked for.
      if(op.kind!=='appearance' || op.patch.labels===false || Object.keys(op.patch).some(key=>key!=='labels' && key!=='highlightColor')) whole=true;
    }
  }
  return {capturedAt:referent.capturedAt,...(whole?{scene:true as const}:{}),
    ...(!whole || targets.size?{selectionKeys:[...targets]}:{})};
}

/**
 * THE UNDO HISTORY BELONGS TO THE SCENE, NOT A TAB.
 *
 * A page keeps its own undo stack, and that stack is the tab's: it is stripped
 * out of every shared capture, it does not exist in a second panel, and it
 * knows nothing about an edit an agent made from the Mac. So "undo that" in
 * the headset could only ever take back what the headset itself had done.
 *
 * This is the shared version. The host sees every scene the session commits —
 * a rendered command from any surface, and a manual save from the desktop
 * panel or the headset toolbar — so it is the one place that can hold the
 * order they happened in. What it stores is the scene before and after each
 * operation, which is what an undo has to restore, and the surface it came
 * from, which is what keeps an assistant's change distinguishable from the
 * wearer's own.
 */
export type SceneHistoryOrigin = 'command'|'manual';
export type SceneHistorySurface = 'desktop'|'companion' | 'detailed'|'agent'|'unknown';
export type SceneHistoryEntry = {
  id:string;
  at:number;
  origin:SceneHistoryOrigin;
  surface:SceneHistorySurface;
  /** The change kind, or 'manual' for an edit made in a panel by hand. */
  label:string;
  before:InspectionScene;
  after:InspectionScene;
};
/**
 * The scene fields an undo restores. The viewpoint is never one of them.
 *
 * These fields include the complete scoped-style and measurement arrays. Restoring them
 * also restores overlaps and earlier partial styles exactly.
 */
const FIELDS = ['appearance','placement','selection','emphasis','visibility','styles','companion-structure','measurement'] as const;
export type SceneField = (typeof FIELDS)[number];
const emphasisOf = (scene:InspectionScene) => scene.inspection.emphasis;
/** An emphasis as a COMMAND may carry it: the saved key without its origin. */
const commandEmphasis = (scene:InspectionScene) => {
  const emphasis=emphasisOf(scene);
  if(!emphasis) return {parts:[],focus:[],contextOpacity:DEFAULT_CONTEXT_OPACITY};
  const {origin:_origin,...rest}=emphasis as typeof emphasis & {origin?:string};
  return structuredClone(rest);
};
/**
 * A hidden set as a COMMAND may carry it: the saved one, or the empty one.
 *
 * A scene with nothing hidden leaves the field out, so reading it straight
 * would compare `undefined` against an explicit empty set and call a no-op a
 * change. Normalizing both ends means only a real difference in what is on
 * screen counts as something to undo.
 */
const commandVisibility = (scene:InspectionScene) => normalizeVisibility(scene.inspection.visibility);
const sameJson = (a:unknown,b:unknown) => inspectionJson(a ?? null)===inspectionJson(b ?? null);
/** Which saved scene fields moved between two scenes. */
export function movedFields(before:InspectionScene, after:InspectionScene):SceneField[] {
  return FIELDS.filter(field=>field==='appearance' ? !sameJson(before.inspection.appearance,after.inspection.appearance)
    : field==='placement' ? !sameJson(before.inspection.placement,after.inspection.placement)
    : field==='selection' ? !sameJson([...before.selectionKeys].sort(),[...after.selectionKeys].sort())
    : field==='styles' ? !sameJson(normalizeStyles(before.inspection.styles),normalizeStyles(after.inspection.styles))
    : field==='companion-structure' ? !sameJson(before.inspection.companionStructure,after.inspection.companionStructure)
    : field==='measurement' ? !sameJson(before.inspection.measurementLines ?? [],after.inspection.measurementLines ?? [])
    : field==='visibility' ? !sameJson(commandVisibility(before),commandVisibility(after))
    : !sameJson(commandEmphasis(before),commandEmphasis(after)));
}

export const MAX_SCENE_HISTORY = 32;

export class SceneHistory {
  #entries:SceneHistoryEntry[] = [];
  #redo:SceneHistoryEntry[] = [];
  /** commandId -> the entry that command is taking back. */
  #undoing = new Map<string,string>();
  #redoing = new Map<string,string>();
  constructor(private now:()=>number=Date.now) {}
  /**
   * Remember one operation, if it moved anything an undo could restore.
   *
   * A camera-only save is not an operation: a desktop panel writes one every
   * time the wearer looks around, and a history full of those would answer
   * "undo that" by putting the camera back rather than the change.
   */
  record(entry:Omit<SceneHistoryEntry,'id'|'at'>):SceneHistoryEntry|undefined {
    if(!movedFields(entry.before,entry.after).length) return undefined;
    const stored:SceneHistoryEntry={...entry,id:randomUUID(),at:this.now(),
      before:structuredClone(entry.before),after:structuredClone(entry.after)};
    this.#entries.push(stored);
    this.#redo=[];
    while(this.#entries.length>MAX_SCENE_HISTORY) this.#entries.shift();
    return stored;
  }
  /** The newest operation nobody is already taking back. */
  last():SceneHistoryEntry|undefined {
    const claimed=new Set(this.#undoing.values());
    for(let index=this.#entries.length-1;index>=0;index--) {
      const entry=this.#entries[index];
      if(!claimed.has(entry.id)) return entry;
    }
    return undefined;
  }
  size() { return this.#entries.length; }
  redoSize() { return this.#redo.length; }
  lastRedo():SceneHistoryEntry|undefined {
    const claimed=new Set(this.#redoing.values());
    for(let index=this.#redo.length-1;index>=0;index--) {
      const entry=this.#redo[index];
      if(!claimed.has(entry.id)) return entry;
    }
    return undefined;
  }
  entries():readonly SceneHistoryEntry[] { return this.#entries.map(entry=>structuredClone(entry)); }
  /** Scenes in either direction may still need their coordinate assets. */
  retainedEntries():readonly SceneHistoryEntry[] { return [...this.#entries,...this.#redo].map(entry=>structuredClone(entry)); }
  /** A cancelled, rejected or expired render must release its history claim. */
  releaseFinishedClaims(pending:(commandId:string)=>boolean) {
    for(const id of this.#undoing.keys()) if(!pending(id)) this.#undoing.delete(id);
    for(const id of this.#redoing.keys()) if(!pending(id)) this.#redoing.delete(id);
  }
  /**
   * Bind one queued command to the entry it is taking back.
   *
   * The entry is only dropped when the panel confirms the render. An undo that
   * is refused, expires or never reaches a panel leaves the history where it
   * was, so the next "undo that" still takes back the same thing.
   */
  claimUndo(commandId:string, entry:SceneHistoryEntry) { this.#undoing.set(commandId,entry.id); }
  isUndo(commandId:string) { return this.#undoing.has(commandId); }
  settleUndo(commandId:string, rendered:boolean) {
    const entryId=this.#undoing.get(commandId);
    if(entryId===undefined) return false;
    this.#undoing.delete(commandId);
    if(!rendered) return false;
    const entry=this.#entries.find(entry=>entry.id===entryId);
    if(!entry) return false;
    this.#entries=this.#entries.filter(entry=>entry.id!==entryId);
    this.#redo.push(entry);
    return true;
  }
  claimRedo(commandId:string,entry:SceneHistoryEntry) { this.#redoing.set(commandId,entry.id); }
  isRedo(commandId:string) { return this.#redoing.has(commandId); }
  settleRedo(commandId:string,rendered:boolean) {
    const entryId=this.#redoing.get(commandId);
    if(entryId===undefined) return false;
    this.#redoing.delete(commandId);
    if(!rendered) return false;
    const entry=this.#redo.find(entry=>entry.id===entryId);
    if(!entry) return false;
    this.#redo=this.#redo.filter(entry=>entry.id!==entryId);
    this.#entries.push(entry);
    while(this.#entries.length>MAX_SCENE_HISTORY) this.#entries.shift();
    return true;
  }
  /** A new structure has no history; the old scenes describe other coordinates. */
  clear() { this.#entries=[]; this.#redo=[]; this.#undoing.clear(); this.#redoing.clear(); }
}

/**
 * The change that takes one operation back.
 *
 * It restores the fields that operation moved and nothing else: one edit comes
 * back as that same kind of edit, several come back as one compound, and the
 * viewpoint is left alone because it belongs to whoever is looking through it.
 */
export function undoChangeFor(entry:SceneHistoryEntry):InspectionChange {
  const fields=movedFields(entry.before,entry.after);
  const ops=fields.map<InspectionCompoundOp>(field=>field==='appearance'
    ? {kind:'appearance',patch:structuredClone(entry.before.inspection.appearance)} as InspectionCompoundOp
    : field==='placement' ? {kind:'placement',patch:structuredClone(entry.before.inspection.placement)}
    : field==='selection' ? {kind:'selection',patch:{selectionKeys:[...entry.before.selectionKeys]}}
    : field==='styles' ? {kind:'styles',patch:{styles:normalizeStyles(entry.before.inspection.styles)}}
    : field==='companion-structure' ? {kind:'companion-structure',patch:structuredClone(entry.before.inspection.companionStructure ?? {remove:true as const})}
    : field==='measurement' ? {kind:'measurement',patch:{lines:structuredClone(entry.before.inspection.measurementLines ?? [])}}
    : field==='visibility' ? {kind:'visibility',patch:commandVisibility(entry.before)}
    : {kind:'emphasis',patch:commandEmphasis(entry.before)});
  if(!ops.length) throw Error('That operation changed nothing an undo could restore.');
  return ops.length<COMPOUND_MIN_OPS ? ops[0] : {kind:'compound',patch:{ops}};
}

/** Reapply exactly the fields this operation changed, preserving the viewpoint. */
export function redoChangeFor(entry:SceneHistoryEntry):InspectionChange {
  return undoChangeFor({...entry,before:entry.after,after:entry.before});
}
