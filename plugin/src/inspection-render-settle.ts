/**
 * Only entry's camera/room placement may change an otherwise identical scene.
 *
 * This is also the test for placement-only local work: a grab, a stick nudge
 * or a seat moves nothing else. Key order is ignored, because the host
 * compares a scene it validated with one a panel captured.
 *
 * A lesson chapter's own turn is camera too. The saved lesson cursor records
 * how far the turn has run and whether it is still running, so the save that
 * settles a turn changes those two fields with the camera. Counted as an
 * edit, that save refused the wearer's queued "next" and left their spoken
 * request on a stale revision.
 */
export function sameEntryScene(before:any, after:any) {
  const stable = (scene:any) => {
    const {camera, inspection, ...identity} = scene ?? {};
    const {placement, ...content} = withoutChapterTurn(inspection ?? {});
    return stableJson({...identity, inspection:content});
  };
  return stable(before) === stable(after);
}
/** The inspection without the lesson cursor's record of its chapter turn. */
export function withoutChapterTurn<T extends {lessonPlayback?:unknown}>(inspection:T):T {
  const playback=inspection.lessonPlayback as Record<string,unknown>|undefined;
  if(!playback || typeof playback!=='object') return inspection;
  const {motionProgress, motionPlaying, ...cursor} = playback;
  return {...inspection, lessonPlayback:cursor};
}
const stableJson = (value:unknown) => JSON.stringify(value, (_key, item) =>
  item && typeof item==='object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
/** A refused lesson command never leaves these behind, whoever changed them since. */
const LESSON_OWNED = new Set(['lessonPlayback','animation','lessonFigure']);
/**
 * The scene a refused command puts back, with the wearer's later edits kept.
 *
 * `checkpoint` is the scene the command was admitted on, `drawn` what its
 * draw left before anything queued behind it landed, and `now` what is on
 * screen. A field the wearer changed after the draw keeps the wearer's value,
 * appearance field by field; every other field goes back to the checkpoint.
 * The lesson's cursor, clock and figure always go back. Its colour key goes
 * back unless the wearer changed the emphasis or focus after the draw. The
 * camera is not merged: head tracking owns it.
 */
export function withWearerEdits(checkpoint:any, drawn:any, now:any) {
  const same = (a:unknown, b:unknown) => stableJson(a) === stableJson(b);
  const merged = structuredClone(checkpoint);
  const keep = (target:any, key:string, from:any) => {
    if(Object.hasOwn(from, key)) target[key] = structuredClone(from[key]); else delete target[key];
  };
  const before = drawn?.inspection ?? {}, after = now?.inspection ?? {};
  merged.inspection ??= {};
  // Ownership and keys are one selection, including picking the same rows by
  // hand after the lesson drew. Never combine one visit's keys with another's owner.
  if(!same(drawn?.selectionKeys, now?.selectionKeys) || !same(before.lessonSelection, after.lessonSelection)) {
    keep(merged, 'selectionKeys', now ?? {});
    keep(merged.inspection, 'lessonSelection', after);
  }
  for(const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if(key==='lessonSelection' || LESSON_OWNED.has(key) || same(before[key], after[key])) continue;
    if(key==='appearance' && before.appearance && after.appearance && merged.inspection.appearance) {
      for(const field of new Set([...Object.keys(before.appearance), ...Object.keys(after.appearance)]))
        if(!same(before.appearance[field], after.appearance[field])) keep(merged.inspection.appearance, field, after.appearance);
    } else keep(merged.inspection, key, after);
  }
  return merged;
}
export function panelEntering(value:{pending?:boolean;phase?:string}|undefined) {
  return Boolean(value && (value.pending ||
    ['requesting-headset','locating-headset','connecting-display','starting-presentation','preparing-menu'].includes(value.phase ?? '')));
}
/** Close the ready-heartbeat/render-start race before touching a scene. */
export async function waitForPanelRender<T = void>(options:{ready:()=>boolean;current:()=>boolean;waitMs?:number;
  presentation?:()=>{presenting?:boolean;phase?:string;pending?:boolean;drawCount?:number};
  onEntryWait?:(elapsedMs:number)=>void; onReady?:()=>T;
  now?:()=>number;sleep?:(ms:number)=>Promise<void>}) {
  const now=options.now??Date.now, sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  let deadline=now()+Math.min(options.waitMs??15000,15000);
  const initial = options.presentation?.();
  const entering = panelEntering;
  let entrySeen = Boolean(entering(initial));
  const canDraw = (value:ReturnType<NonNullable<typeof options.presentation>>|undefined) => {
    entrySeen ||= Boolean(entering(value));
    // Presentation begins before the entry seat, quality rebuild and menu
    // finish. Their saves belong to entry, so admission must wait for all of it.
    return !entrySeen || (!entering(value) && (value?.presenting === true
      || (value?.drawCount !== undefined && initial?.drawCount !== undefined && value.drawCount > initial.drawCount)));
  };
  while(true) {
    const value = options.presentation?.();
    const drawable = canDraw(value);
    if(!options.current())throw Object.assign(Error('The local view changed while waiting for rendering.'),{code:'local_changed'});
    if(options.ready() && drawable) return options.onReady?.();
    // The immersive lifecycle owns its entry timeout and clears pending on
    // completion/failure. Entry is not molecular render work: do not spend the
    // command's settle budget while that lifecycle is still running.
    const entryPending = entering(value), began = now();
    if(!entryPending && began>=deadline)throw Error('The panel stayed busy while waiting for the molecular render.');
    await sleep(entryPending ? 50 : Math.min(50,deadline-began));
    if(entryPending) {
      const elapsed = now()-began;
      deadline += elapsed;
      options.onEntryWait?.(elapsed);
    }
  }
}
