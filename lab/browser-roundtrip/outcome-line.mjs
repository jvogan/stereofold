/**
 * Whether the wearer is shown a command receipt at all, and for how long.
 *
 * `outcome-copy.mjs` decides what a receipt would say on the status row. This
 * decides whether it should be said. In the microtubule lesson the same teal
 * line -- `Applied · tour · r8` -- used to sit beside the chapter for the whole
 * chapter, including the frames where the menu has already stood back for the
 * lesson. A learner watching a tubulin wall assemble is being shown the agent's
 * command log.
 *
 * Three rules come out of that, and all three are here rather than in
 * `immersive-session.mjs` so `node --test` can hold them without a Mol* bundle:
 *
 * 1. A lesson command draws nothing. The narration and the structure that just
 *    swapped are the feedback; a receipt for them is internal bookkeeping the
 *    wearer never asked for. (The spoken refusals a grow can produce -- "Too
 *    big for this headset. Staying here." -- are a different path entirely:
 *    they reach the wearer through the voice and caption plate, not here.)
 * 2. Every other receipt -- render quality, representation, colour -- is worth
 *    one glance and then it is litter. It is held for `OUTCOME_HOLD_MS` of
 *    presented frames and retired. Frames, not wall clock: Quest Browser stops
 *    servicing the window's timers and `requestAnimationFrame` for the length
 *    of an immersive session (see `scheduleViewFrame` in `viewer.mjs`), so a
 *    `setTimeout` expiry would never fire and the plate would hang exactly as
 *    it does today.
 * 3. A menu that has stood back for a lesson draws no receipt at all, and any
 *    receipt still up when it stands back goes with it. The status glass keeps
 *    a high alpha while the rest of the menu dims (`MENU_PLAY_ALPHA`) because
 *    that glass carries the lesson's own words; a receipt riding in on it is
 *    the brightest wrong thing in the room.
 *
 * Nothing here touches the other writers of that row. `Listening…`, the agent's
 * spoken reply and the voice errors are not receipts and never reach this
 * module; the caller only ever retires a line it put up itself.
 */

import { outcomeFields } from './outcome-copy.mjs';

/**
 * How long a receipt the wearer may care about stays up, in milliseconds of
 * presented frames.
 *
 * Four seconds is two comfortable reads of `Applied · quality · r31` at the
 * roughly 47 degrees off-axis the menu sits at, and short enough that it is
 * gone before the next chapter of a lesson can start behind it.
 */
export const OUTCOME_HOLD_MS = 4000;

/**
 * The change kinds whose receipt the wearer must never be shown.
 *
 * `tour` is every lesson step -- start, next, back, play, pause, stop -- which
 * the protocol carries as one kind with an `action` patch. `grow_structure` is
 * the staged rebuild; it replaces the source rather than enqueueing a change,
 * so it mints no receipt of its own today, but it is named here so that a
 * caller which ever does hand its kind over gets the same silence, and so the
 * rule reads as the product rule rather than as an accident of the wire.
 */
export const LESSON_OUTCOME_KINDS = new Set([
  'tour', 'grow', 'grow_structure', 'grow-structure', 'experience',
]);

/**
 * The wearer's word (`outcome-copy.mjs` `OUTCOME_FIELD_WORDS`) that means a
 * lesson command.
 *
 * The kind is not on the sentence the page hands to the headset: `inspector.ts
 * showOutcome` writes the protocol's own field names, so a `control_tour` step
 * arrives as `Applied · action · revision 8` and a start as `Applied · action,
 * tour id · revision 8`. Both of those fields are already collapsed to the one
 * word `tour` by the translation the plate uses, so this reads the translated
 * form rather than keeping a second, drifting list of wire names.
 */
export const LESSON_OUTCOME_WORDS = new Set(['tour']);

/** The leading word of a receipt, in the three forms `inspector.ts` writes. */
const RECEIPT = /^(?:applied|waiting|could not apply)\s*[·•]\s*([^·•]+)/i;

/**
 * Whether this receipt belongs to a lesson command.
 *
 * The kind wins when a caller has one. Otherwise the sentence is read, and only
 * a sentence that is a receipt at all: a spoken reply that happens to contain
 * the word tour never starts with one of the three receipt words, so it cannot
 * match, and nothing this module does can silence the wearer's own answers.
 */
export function isLessonOutcome({ text, kind } = {}) {
  if (typeof kind === 'string' && LESSON_OUTCOME_KINDS.has(kind.trim().toLowerCase())) return true;
  if (typeof text !== 'string' || !RECEIPT.test(text)) return false;
  // `tour +1` is a tour plus something the wearer has no word for; the lesson
  // half is what decides, and a tour change patches nothing else in practice.
  return LESSON_OUTCOME_WORDS.has(outcomeFields(text).split(' ')[0]);
}

/**
 * What to do with one receipt from the page.
 *
 * `draw` is whether the sentence goes on the status row. `clear` is whether a
 * receipt already on that row should come down -- true in every case that does
 * not draw, so a suppressed receipt also takes the previous one with it rather
 * than leaving it stranded. The caller owns the check that the row still holds
 * its own receipt and not a voice line that has since overwritten it.
 *
 * `asleep` is the menu standing back for a lesson (dimmed) or taken out of the
 * frame for a grab (hidden). Both mean the wearer is not reading the menu.
 */
export function outcomeLineDecision({ text, status, kind, asleep = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { draw: false, clear: true, reason: 'retired', holdMs: 0 };
  }
  if (asleep) return { draw: false, clear: true, reason: 'asleep', holdMs: 0 };
  if (isLessonOutcome({ text, kind })) {
    return { draw: false, clear: true, reason: 'lesson', holdMs: 0 };
  }
  const failed = typeof status === 'string'
    && ['error', 'failed', 'failure'].includes(status.trim().toLowerCase());
  // A refusal is held exactly as long as a success. It is still a receipt, and
  // a sentence the wearer cannot dismiss is the thing being fixed here; the
  // page keeps its own copy on the flat panel to read afterwards.
  return { draw: true, clear: false, reason: failed ? 'failed' : 'applied', holdMs: OUTCOME_HOLD_MS };
}

/**
 * Whether retiring a receipt may clear the status row.
 *
 * The row has four writers and one of them is this module. `Listening…`, a
 * voice error and the agent's spoken reply all overwrite a receipt in place, so
 * a receipt that expires afterwards must find the row already changed and leave
 * it alone; clearing on a timer that does not check would take the wearer's
 * answer away mid-read.
 */
export function shouldClearOutcomeRow({ drawn, current } = {}) {
  return typeof drawn === 'string' && drawn !== '' && drawn === current;
}

/**
 * Hold a drawn receipt for `holdMs` of presented frames, then retire it.
 *
 * `scheduleFrame` must be the presenting session's `requestAnimationFrame`.
 * Its timestamps are the session's own clock, which is why the elapsed time is
 * measured from the first frame that arrives rather than from the call: a
 * receipt that lands during a visibility blur is held for four seconds of
 * frames the wearer can see, not four seconds of a blank headset.
 *
 * Returns the cancel function the caller keeps for the next receipt. Calling it
 * never retires anything; it only stops this hold from doing so.
 */
export function holdOutcomeLine({ scheduleFrame, holdMs = OUTCOME_HOLD_MS,
  asleep = () => false, now = () => Date.now(), onExpire = () => {} } = {}) {
  let cancelled = false;
  const finish = reason => {
    if (cancelled) return;
    cancelled = true;
    onExpire(reason);
  };
  if (typeof scheduleFrame !== 'function') {
    // No presented frames means no plate the wearer can read, and no clock this
    // module is allowed to use. Retire rather than leave a sentence with no
    // expiry behind it.
    finish('no-frames');
    return () => { cancelled = true; };
  }
  let started;
  const step = timestamp => {
    if (cancelled) return;
    const time = Number.isFinite(timestamp) ? timestamp : now();
    if (started === undefined) started = time;
    // The menu stood back mid-hold: the lesson took the room, so the receipt
    // goes now rather than at the end of its four seconds.
    if (asleep()) { finish('asleep'); return; }
    if (time - started >= holdMs) { finish('expired'); return; }
    try { scheduleFrame(step); } catch { finish('no-frames'); }
  };
  try { scheduleFrame(step); } catch { finish('no-frames'); }
  return () => { cancelled = true; };
}
