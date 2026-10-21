import { assistantStatus } from './assistant-status.mjs';
import { geometryBudgetChanged } from './geometry-advisory.mjs';
import { geometryBudgetConfirmation } from './representation-budget.mjs';
import { recordLoopStage } from './loop-timing.mjs';
/**
 * Make a spoken command change the structure the wearer is looking at.
 *
 * Version 2 of push-to-talk records the headset microphone, posts it to the
 * Mac, and the Mac transcribes it locally. The finished text comes back on the
 * `push_to_talk_audio` result and is published as a `heard` event on the
 * page-wide streamer emitter. Until this module existed, nothing subscribed to
 * that event: the wearer said "make it bigger", the caption plate showed
 * `Heard: make it bigger`, and the molecule did not move. The whole of the
 * local voice loop was a display.
 *
 * This is the missing consumer. It resolves the text against the same bounded
 * grammar the OAuth route uses, maps the result onto one of the spatial
 * actions the toolbar already dispatches, and runs it. Four properties are
 * deliberate:
 *
 * - The grammar is closed. An unknown sentence stays unknown: it is never
 *   turned into a molecular edit, and it never reaches a language model from
 *   here. This is the same rule `voice-command.mjs` states, and this module
 *   only widens it by allowing a bounded list of leading and trailing filler
 *   words, so "ok, make it bigger please" resolves the way "make it bigger"
 *   already did.
 * - Every action goes through the caller's dispatcher, which on the companion
 *   is the same `onSpatialAction` a toolbar press uses. A spoken command can
 *   therefore do exactly what a pressed button can do, and nothing else.
 * - Except for host-dependent workbench opens, the caption precedes the action,
 *   so commands appear at transcription latency rather than render latency.
 * - Speech is best effort and never blocks. Rendering a spoken line costs an
 *   OAuth round trip on the Mac; making the molecule wait for it would undo
 *   the point of the caption above.
 *
 * Each utterance records one `voice-command` diagnostics entry with the
 * phrase, the action and the outcome, so `read_headset_log` on the Mac can
 * tell a command that was never recognized from one that was recognized and
 * then failed to draw.
 */

import { pushToTalkAudioEvents } from './push-to-talk-audio.mjs';
import { normalizeVoiceTranscript, voiceCommandFromTranscript, lessonPartVoiceCommand,
  sequenceGotoVoiceCommand } from './voice-command.mjs';
// The spoken half of the Mol* handoff, imported rather than
// retyped, so the phrase and the menu row promise the wearer the same thing.
import { WORKBENCH_TRANSFER_SPOKEN } from './workbench-handoff.mjs';

/** Longest phrase kept in a diagnostics entry. The grammar itself is far shorter. */
export const VOICE_COMMAND_MAX_PHRASE_CHARS = 240;

/**
 * Words a wearer puts in front of a command without meaning anything by them.
 *
 * Only a leading run of these is dropped, and only while the remainder still
 * has to be an exact known phrase, so no negation or qualifier can be removed
 * on the way to a match: "don't make it bigger" stops at `don`, finds no
 * phrase, and stays unrecognized.
 */
const LEADING_FILLERS = new Set(['ok', 'okay', 'hey', 'hi', 'so', 'um', 'uh', 'well', 'right', 'now', 'please',
  'can', 'could', 'would', 'you', 'jarvis', 'computer', 'stereofold', 'lets', 'let', 'us', 'and', 'then', 'just',
  'go', 'i', 'want', 'to', 'like', 'the', 'a',
  // "do a rotation" and "let's have a rotate" are the same request as "rotate".
  // `do` and `have` carry no meaning in front of a verb, and the normalizer
  // splits "let's" into `let` `s`, so the stray `s` has to be skippable too or
  // every contraction ends the search on its second word. None of the three
  // can strip a negation: "do not spin" stops at `not`.
  'do', 'have', 's']);

/** Words a wearer trails a command with. Dropped from the end for the same reason. */
const TRAILING_FILLERS = new Set(['please', 'now', 'thanks', 'thank', 'you', 'ok', 'okay', 'for', 'me', 'it']);

/**
 * What the headset says to a sentence it has no command for.
 *
 * Offer a next attempt without repeating the wearer's sentence.
 */
export const UNRECOGNIZED_REPLY = 'Not a command. Try show, tour, or smaller.';
export const HELP_REPLY = 'Say show, tour, smaller, bigger, or open Mol*.';
export const NOTHING_TO_RETURN_REPLY = 'Nothing to return from. You are already here.';

/** Prefer a complete lesson line; bound even an unusually long authored title. */
function lessonReply(lesson) {
  const lines = [lesson?.title, lesson?.summary].filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim());
  return lines.find(line => line.split(/\s+/).length <= 12)
    ?? (lines.length ? `${lines[0].split(/\s+/).slice(0, 12).join(' ')}…` : 'No lesson is loaded. Try show, tour, or smaller.');
}

/**
 * What the headset says instead when an agent is attached.
 *
 * The Mac transcribes every press whether or not the page has a command for
 * it, and the agent reads that queue with `poll_voice_transcripts`, so a
 * sentence this grammar cannot act on has already gone to Claude by the time
 * the wearer hears an answer. "Not a command" therefore describes the page and
 * not the system: it tells the wearer their sentence died when it was in fact
 * delivered.
 *
 * These two lines are the same event told truthfully, and they are the only
 * thing in the headset that says the agent exists. They are used only while an
 * agent is attached; with nobody listening on the Mac, "Not a command" is
 * still the honest answer.
 */
export const AGENT_FORWARD_CAPTION = 'Sent to Claude';
export const AGENT_FORWARD_REPLY = 'Asking Claude.';

const FIT = Object.freeze({ kind: 'fit' });
const RESET = Object.freeze({ kind: 'reset' });
const FRONT = Object.freeze({ kind: 'room-placement', target: 'front' });
const OVERHEAD = Object.freeze({ kind: 'room-placement', target: 'overhead' });
const MOVE_MENU = Object.freeze({ kind: 'recenter-menu' });
// `fit` resets the desktop camera, which a headset does not use, so routing
// "recenter" through it spoke a confirmation over a structure that had not
// moved. This is the placement the Y button writes.
const RECENTER = Object.freeze({ kind: 'recenter-structure' });
// Both actions already exist on a menu row or a button; these are the spoken
// routes to them.
const OPEN_WORKBENCH = Object.freeze({ kind: 'open-workbench' });
/**
 * "open in Mol*" means where the wearer is, and the Mac is the other request.
 *
 * The spoken phrase and the menu row of the same name must not lead to
 * different places: one answering "Opening on the Mac." while the other
 * transferred the wearer to `/detailed` in Quest Browser gave the wearer the
 * destination they could not see. Mol* opens in the headset, so the bare
 * action is the headset handoff and a Mac monitor has to be asked for by name.
 */
const OPEN_WORKBENCH_ON_MAC = Object.freeze({ kind: 'open-workbench', target: 'mac' });
const REPEAT_REPLY = Object.freeze({ kind: 'repeat-reply' });

/** How far one spoken nudge moves the structure, in metres. */
export const VOICE_MOVE_METRES = 0.3;
/** How far a spoken yaw turns it, in degrees. */
export const VOICE_TURN_DEGREES = 90;

/**
 * The bounded grammar's commands, as spatial actions.
 *
 * The experience commands (`show-cas9`, `assemble-microtubule` and the rest)
 * are deliberately absent: they replace the coordinate source, which the
 * ExperiencePlayer on the page owns and an immersive session cannot reach. A
 * wearer who asks for one is told so rather than being given a confirmation
 * for a change that never happened.
 *
 * The four growth commands are the exception, and they are one because
 * `grow_structure` was built to be. It swaps the coordinates AND the
 * authored lesson under a live session and leases the transition to this panel,
 * so the structure rebuilds where the wearer left it without leaving VR. That
 * is a coordinate change an immersive session CAN reach, so it is here.
 */
export const SPATIAL_VOICE_ACTIONS = Object.freeze({
  'scale-larger': Object.freeze({ action: Object.freeze({ kind: 'scale', direction: 1 }), say: 'Bigger.' }),
  'scale-smaller': Object.freeze({ action: Object.freeze({ kind: 'scale', direction: -1 }), say: 'Smaller.' }),
  // A size word is several steps of the comparative above, so "make it small"
  // is a change the wearer can see. `steps` is bounded in
  // `runFaceAction`; the shared numerical placement envelope still applies, so no
  // number here can take the structure outside the size the viewer allows.
  'scale-small': Object.freeze({ action: Object.freeze({ kind: 'scale', direction: -1, steps: 3 }), say: 'Smaller.' }),
  'scale-big': Object.freeze({ action: Object.freeze({ kind: 'scale', direction: 1, steps: 3 }), say: 'Bigger.' }),
  'scale-tiny': Object.freeze({ action: Object.freeze({ kind: 'scale', direction: -1, steps: 6 }), say: 'Tiny.' }),
  'scale-huge': Object.freeze({ action: Object.freeze({ kind: 'scale', direction: 1, steps: 6 }), say: 'Huge.' }),
  'move-overhead': Object.freeze({ action: OVERHEAD, say: 'Overhead.' }),
  // Spoken play/pause carries an explicit target. The toolbar's play button
  // remains a toggle, but repeating a spoken command must not invert state.
  'tour-play': Object.freeze({ action: Object.freeze({ kind: 'tour-play', playing: true }), say: 'Tour started.' }),
  'tour-pause': Object.freeze({ action: Object.freeze({ kind: 'tour-play', playing: false }), say: 'Tour paused.' }),
  'tour-next': Object.freeze({ action: Object.freeze({ kind: 'tour-next' }), say: 'Next step.' }),
  'tour-back': Object.freeze({ action: Object.freeze({ kind: 'tour-back' }), say: 'Back one step.' }),
  // The same framing move `focus_selection` asks a panel for, over whatever
  // the wearer already has selected, without a round trip to the Mac.
  // With nothing selected the target is the whole structure, which is what
  // "show the whole thing" means.
  'focus-selection': Object.freeze({ action: Object.freeze({ kind: 'focus-selection', framing: 'fill' }), say: 'Zoomed in.' }),
  'show-whole': Object.freeze({ action: Object.freeze({ kind: 'focus-selection', framing: 'context' }), say: 'Whole structure.' }),
  // Passthrough by voice, because a wearer who has lost track of the room is
  // not going to find a menu row to press.
  'passthrough-on': Object.freeze({ action: Object.freeze({ kind: 'passthrough', on: true }), say: 'Room shown.' }),
  'passthrough-off': Object.freeze({ action: Object.freeze({ kind: 'passthrough', on: false }), say: 'Room hidden.' }),
  // The render budget by voice. The level is explicit, the same way spoken
  // play and pause are, so saying "best quality" twice cannot cycle past it the
  // way a second tap on the menu row would. The two words the wearer hears are
  // the ones the menu row and the agent's command speak: "Max quality." and not
  // "Best quality.", because the menu row the wearer reads says `Quality: max`.
  // One setting, one word for its top level, whichever of the three routes
  // asked for it.
  'quality-best': Object.freeze({ action: Object.freeze({ kind: 'render-quality', level: 'best' }), say: 'Max quality.' }),
  'quality-balanced': Object.freeze({ action: Object.freeze({ kind: 'render-quality', level: 'balanced' }), say: 'Balanced.' }),
  'quality-fast': Object.freeze({ action: Object.freeze({ kind: 'render-quality', level: 'fast' }), say: 'Fast.' }),
  // The shared grammar names the turntable spin too, so the two command names
  // have to land on the same actions the local phrase map below gives them.
  // Without these a motion phrase that reached the fixed table first would
  // resolve to a known command with no action, and the wearer would be told to
  // ask on the Mac for something the page can do itself.
  'motion-spin': Object.freeze({ action: Object.freeze({ kind: 'toggle-motion', paused: false }), say: 'Spinning.' }),
  'motion-stop': Object.freeze({ action: Object.freeze({ kind: 'toggle-motion', paused: true }), say: 'Stopped.' }),
  // The one family above that is NOT "the ExperiencePlayer owns it".
  // `grow_structure` replaces the coordinates and the authored lesson
  // together inside the running session, which is the whole reason it exists,
  // so a spoken tier is something an immersive session CAN do. These four say a
  // short line at the press because the rebuild takes seconds; the sentence the
  // wearer hears at the end is the host's own, through `spokenConfirmation`.
  'grow-structure': Object.freeze({ action: Object.freeze({ kind: 'grow-structure', stage: 'next' }), say: 'Growing.' }),
  'shrink-structure': Object.freeze({ action: Object.freeze({ kind: 'grow-structure', stage: 'back' }), say: 'Going back one.' }),
  'grow-wall': Object.freeze({ action: Object.freeze({ kind: 'grow-structure', stage: 'wall' }), say: 'Building the wall.' }),
  'grow-tip': Object.freeze({ action: Object.freeze({ kind: 'grow-structure', stage: 'tip' }), say: 'Capping the tip.' }),
});

/**
 * The confirmation a wearer hears after the render actually ran, rather than
 * the one the grammar guessed before it.
 *
 * Half of a level is the framebuffer scale, and an XRWebGLLayer's scale is fixed
 * when the layer is built (mol-gl/webgl/context.js `webgl.xr.set`), so changing
 * it cannot touch the session the wearer is already in — it lands on the next
 * entry. Saying "Max quality." over a picture that did not get sharper is a
 * false confirmation. `scaleAppliesOnNextEntry` is the renderer's own answer,
 * true only when a session is presenting and the new scale really differs from
 * the live layer's, so the extra three words appear only when something is
 * genuinely pending.
 *
 * Which three words depends on which way the scale is going, and the level says
 * that without a second reading: only `best` raises it (xr-render-budget.mjs
 * gives fast and balanced the same tier), so `best` is the one that promises a
 * sharper picture and the other two promise a smoother one.
 *
 * The agent's own `render-quality` command is confirmed through this same
 * function (plugin/src/inspector.ts imports it), so the three routes to one
 * setting cannot say different things about the same pending change.
 *
 * @param {string|undefined} level fast | balanced | best
 * @param {string|undefined} say the level's two words
 * @param {{scaleAppliesOnNextEntry?:boolean}|undefined} applied the renderer's answer
 * @returns {string|undefined} what to show and speak
 */
export function renderQualityConfirmation(level, say, applied) {
  if (!say || applied?.scaleAppliesOnNextEntry !== true) return say;
  return `${say} ${level === 'best' ? 'Sharper' : 'Smoother'} after re-entry.`;
}

/**
 * How many words the headset may read out at a wearer.
 *
 * The bound on spoken replies, the same one `molecular-growth.ts` asserts on
 * every refusal it can produce. It is applied here as a filter and not as a
 * truncation: a sentence this long is a bug on the Mac, and
 * cutting it in half would hide that while still talking over the wearer. The
 * grammar's own short line is spoken instead, and the long one is recorded.
 */
export const SPOKEN_REPLY_MAX_WORDS = 11;

/**
 * Said once while grow_structure is waiting out a busy panel.
 * Same two sentences plugin/src/command-in-flight.ts names. Kept here so this
 * module stays loadable as plain JavaScript under `node --test`.
 */
export const GROW_NOT_YET_SPOKEN = 'One moment.';
export const GROW_STILL_BUSY_SPOKEN = 'Still busy. Try again.';

/**
 * What the wearer hears once a grow has actually landed.
 *
 * `grow_structure` answers with one sentence for both outcomes — "Grown to one
 * tubulin dimer." and "Too big for this headset. Staying here." arrive through
 * the same return — because from the wearer's side both are the answer to the
 * question they asked. The page cannot compose either one: it does not know
 * which tier is next, what that tier is called, or what this headset can hold.
 *
 * @param {string|undefined} say the grammar's line, spoken at the press
 * @param {unknown} outcome whatever the dispatcher returned
 * @returns {string|undefined} the sentence to show and speak
 */
export function spokenGrowthLine(say, outcome) {
  const spoken = typeof outcome === 'object' && outcome !== null && typeof outcome.spoken === 'string'
    ? outcome.spoken.trim() : '';
  if (!spoken || spoken.split(/\s+/).length > SPOKEN_REPLY_MAX_WORDS) return say;
  return spoken;
}

/**
 * The confirmation for any resolved phrase, refined by what the dispatcher
 * returned. Only the render budget and a grown tier have an answer that can
 * differ from the request; every other command is confirmed in the grammar's
 * own words.
 *
 * @param {{say?:string, action?:{kind?:string, level?:string}}} resolved the grammar's match
 * @param {unknown} outcome whatever the dispatcher returned
 * @returns {string|undefined} what to show and speak
 */
export function spokenConfirmation(resolved, outcome) {
  const say = resolved?.say;
  if (!say) return say;
  // The Mol* handoff says its own line after acceptance, then
  // holds the wearer in the scene for a moment before the session ends. A
  // second confirmation here spoke over that hold — and said "Opening on the
  // Mac." while the transfer was going to the headset. A dispatcher that has
  // already announced the outcome owns the words.
  if (outcome && typeof outcome === 'object' && outcome.announced === true) return undefined;
  // "next" with no lesson running starts the lesson, and the wearer hears what
  // a start is answered with rather than "Next step." over a
  // tour that was not running a moment ago. The player decides; this reads it.
  if ((resolved.action?.kind === 'tour-next' || resolved.action?.kind === 'tour-back') && outcome?.started === true)
    return SPATIAL_VOICE_ACTIONS['tour-play'].say;
  // A grow is the one spoken command whose answer the page cannot know when it
  // hears the phrase. Which tier "grow it" means, whether
  // this headset can hold it, and what that tier is called are all decided by
  // `molecular-growth.ts` on the Mac, and a refusal comes back through the same
  // return as a landing — "Too big for this headset. Staying here." is an
  // answer, not an error. So the host's sentence wins over the grammar's, and
  // the grammar's "Growing." is only what the wearer heard at the press.
  if (resolved.action?.kind === 'grow-structure') return spokenGrowthLine(say, outcome);
  if (outcome?.applied?.geometryBudget && outcome.applied.geometryBudgetChanged !== false) return geometryBudgetConfirmation(outcome.applied, say);
  if (resolved.action?.kind !== 'render-quality') return say;
  return renderQualityConfirmation(resolved.action.level, say, outcome?.applied);
}

/**
 * Placement phrases the shared grammar has no command for.
 *
 * Recentring is the one a wearer needs most: a molecule nudged out of reach has
 * no spoken way back without it.
 */
const RECENTRING = { action: RECENTER, say: 'View reset.' };
// One definition for both routes into the spin. The entries
// above are what a phrase from the shared fixed table resolves to; these names
// are what the local phrase map uses, and they are the same two objects, so the
// two tables cannot drift into saying different words for one action.
const SPIN_ON = SPATIAL_VOICE_ACTIONS['motion-spin'];
const SPIN_OFF = SPATIAL_VOICE_ACTIONS['motion-stop'];
const WORKBENCH = { action: OPEN_WORKBENCH, say: WORKBENCH_TRANSFER_SPOKEN };
const MAC_WORKBENCH = { action: OPEN_WORKBENCH_ON_MAC, say: 'Opening on the Mac.' };
const REPEAT = { action: REPEAT_REPLY, say: 'Again.' };
// The menu answer and the half-turn, named once because a dozen spoken shapes
// resolve to each of them.
const MOVE_MENU_SAY = { action: MOVE_MENU, say: 'Menu moved.' };
const TURN_AROUND = { action: Object.freeze({ kind: 'turn', degrees: 180 }), say: 'Turning it around.' };

const SPATIAL_PHRASES = new Map([
  // Every recentring phrase writes a placement rather than resetting a camera
  // the headset never looks through.
  ['recenter', RECENTRING], ['re center', RECENTRING], ['recentre', RECENTRING], ['re centre', RECENTRING],
  ['center', RECENTRING], ['centre', RECENTRING], ['center it', RECENTRING], ['centre it', RECENTRING],
  ['bring it back', RECENTRING], ['come back', RECENTRING], ['where did it go', RECENTRING],
  // Another way to ask for the same thing: "put it in front of me".
  ['put it in front of', RECENTRING], ['in front of', RECENTRING], ['put it back', RECENTRING],
  ['fit', { action: FIT, say: 'Fitted.' }], ['fit it', { action: FIT, say: 'Fitted.' }],
  ['fit the structure', { action: FIT, say: 'Fitted.' }],
  ['reset', { action: RESET, say: 'Reset.' }], ['reset the view', { action: RESET, say: 'Reset.' }],
  ['start over', { action: RESET, say: 'Reset.' }],
  ['bring it closer', { action: FRONT, say: 'Closer.' }],
  ['bring it here', { action: FRONT, say: 'Closer.' }],
  ['within reach', { action: FRONT, say: 'Closer.' }],
  ['above us', { action: OVERHEAD, say: 'Overhead.' }],
  ['move the menu', { action: MOVE_MENU, say: 'Menu moved.' }],
  ['move menu', { action: MOVE_MENU, say: 'Menu moved.' }],
  ['bring the menu', { action: MOVE_MENU, say: 'Menu moved.' }],
  ['stop spinning', SPIN_OFF], ['stop the spin', SPIN_OFF], ['stop turning', SPIN_OFF],
  // `trimFillers` drops a trailing "it", so the bare verb is the phrase that
  // actually arrives here. Both spellings are kept for a reader.
  ['spin', SPIN_ON], ['spin it', SPIN_ON], ['rotate', SPIN_ON], ['rotate it', SPIN_ON],
  ['keep spinning', SPIN_ON],
  // Utterances recorded in the headset, and the shapes around them. Every one
  // of these is the same request — start the slow yaw the presentation layer
  // already owns — and every one of them answered "Not a command". The nouns
  // matter as much as the verbs: "a rotation" is a request for the same motion
  // as an imperative "rotate".
  ['rotation', SPIN_ON], ['a rotation', SPIN_ON], ['rotating', SPIN_ON], ['spinning', SPIN_ON],
  ['turn', SPIN_ON], ['turn it', SPIN_ON], ['turning', SPIN_ON],
  ['do a rotation', SPIN_ON], ['do a rotate', SPIN_ON], ['do a spin', SPIN_ON],
  ['keep turning', SPIN_ON], ['keep rotating', SPIN_ON],
  ['keep it spinning', SPIN_ON], ['keep it turning', SPIN_ON], ['keep it rotating', SPIN_ON],
  ['start spinning', SPIN_ON], ['start rotating', SPIN_ON], ['start turning', SPIN_ON],
  ['start the spin', SPIN_ON], ['start a spin', SPIN_ON], ['start the rotation', SPIN_ON],
  ['let it spin', SPIN_ON], ['let it rotate', SPIN_ON], ['let it turn', SPIN_ON],
  ['spin the molecule', SPIN_ON], ['spin the structure', SPIN_ON],
  ['rotate the molecule', SPIN_ON], ['rotate the structure', SPIN_ON],
  ['turn the molecule', SPIN_ON], ['turn the structure', SPIN_ON],
  // The other half of the same pair. "stop" on its own is handled below,
  // because with no spin running it still means the tour.
  ['stop rotating', SPIN_OFF], ['stop the rotation', SPIN_OFF], ['stop rotation', SPIN_OFF],
  ['stop the spinning', SPIN_OFF], ['stop spin', SPIN_OFF], ['stop the turning', SPIN_OFF],
  ['hold', SPIN_OFF], ['hold it', SPIN_OFF], ['hold still', SPIN_OFF], ['stay still', SPIN_OFF],
  ['freeze', SPIN_OFF], ['freeze it', SPIN_OFF], ['stop moving', SPIN_OFF],
  // "freeze it" comes back as "freezes" on some voices, and
  // the inflections of the same verb cost nothing to accept.
  ['freezes', SPIN_OFF], ['frozen', SPIN_OFF], ['hold on', SPIN_OFF], ['stay there', SPIN_OFF],
  ['that s enough', SPIN_OFF], ['thats enough', SPIN_OFF], ['enough', SPIN_OFF],
  // The Mol* row exists on the menu and the host route behind it works; these
  // are the spoken ways in.
  ['open in mol', WORKBENCH], ['open mol', WORKBENCH], ['open in molstar', WORKBENCH],
  ['open molstar', WORKBENCH], ['open in mole star', WORKBENCH], ['open mole star', WORKBENCH],
  ['switch to mol', WORKBENCH], ['switch to molstar', WORKBENCH], ['switch to mole star', WORKBENCH],
  ['open the workbench', WORKBENCH], ['open workbench', WORKBENCH],
  // The Mac is a different place from the headset, so it is a different
  // phrase. Nothing without "the mac" in it leaves the headset.
  ['open it on the mac', MAC_WORKBENCH], ['open on the mac', MAC_WORKBENCH],
  ['open this on the mac', MAC_WORKBENCH], ['show it on the mac', MAC_WORKBENCH],
  ['show me on the mac', MAC_WORKBENCH], ['on the mac', MAC_WORKBENCH],
  ['open mol star on the mac', MAC_WORKBENCH], ['open molstar on the mac', MAC_WORKBENCH],
  ['open mol on the mac', MAC_WORKBENCH], ['open mole star on the mac', MAC_WORKBENCH],
  // `xr-buttons.mjs` says repeat-reply lives on "say that again" rather than a
  // face button; this is that binding.
  ['say that again', REPEAT], ['say it again', REPEAT], ['repeat that', REPEAT], ['repeat', REPEAT],
  ['what did you say', REPEAT], ['i missed that', REPEAT],
  // Everything below was measured, not guessed. 520 clips — 107 phrases spoken
  // by five macOS voices, transcribed by the same whisper-cli call the Mac
  // makes — were run through this resolver; each line here is a transcript that
  // arrived clean and matched nothing.
  //
  // The menu. A wearer who loses it asks where it went, in either of two
  // shapes, and neither was a phrase. `recenter-menu` is the answer to both: it
  // puts the menu back in front of the wearer.
  ['where s the menu', MOVE_MENU_SAY], ['where is the menu', MOVE_MENU_SAY], ['wheres the menu', MOVE_MENU_SAY],
  ['show me the menu', MOVE_MENU_SAY], ['show the menu', MOVE_MENU_SAY], ['menu', MOVE_MENU_SAY],
  ['the menu', MOVE_MENU_SAY], ['find the menu', MOVE_MENU_SAY], ['open the menu', MOVE_MENU_SAY],
  ['i can t find the menu', MOVE_MENU_SAY], ['bring the menu back', MOVE_MENU_SAY], ['bring back the menu', MOVE_MENU_SAY],
  // "Mol star" is two words to whisper, every time, on every voice. These are
  // the exact transcripts of the exact phrase — not loose matching on a
  // command that moves the wearer off the headset.
  ['open in mol star', WORKBENCH], ['open mol star', WORKBENCH], ['switch to mol star', WORKBENCH],
  ['open this in mol star', WORKBENCH], ['open it in mol star', WORKBENCH],
  // Recentring homophones. "Recenter" is heard as "resenter" or "resent her"
  // on three of the five voices, and "push it back" is how the phrase already
  // in the table gets spoken half the time.
  ['resenter', RECENTRING], ['resent her', RECENTRING], ['re enter', RECENTRING],
  ['push it back', RECENTRING], ['move it back', RECENTRING], ['send it back', RECENTRING],
  // Repeat, as whisper hears it: "say" becomes "save", and the past tense goes.
  ['save that again', REPEAT], ['save it again', REPEAT], ['i miss that', REPEAT],
  // The far side of the structure. `turnPhrase` already turns it 180 degrees;
  // this is the way a person asks for that without naming a rotation.
  ['the other side', TURN_AROUND], ['show me the other side', TURN_AROUND], ['show the other side', TURN_AROUND],
  ['other side', TURN_AROUND], ['show me the back', TURN_AROUND], ['show me behind it', TURN_AROUND],
  // `trimFillers` eats a trailing "me", so "put it above me" arrives as "put
  // it above" and "above me" arrives as bare "above".
  ['above', { action: OVERHEAD, say: 'Overhead.' }],
]);

/**
 * The phrases whose meaning depends on what is moving.
 *
 * A bare "stop" has meant "pause the tour" since the grammar had tours, and it
 * must keep meaning that. But a wearer watching the structure turn and saying
 * "stop" means the turn, and telling them the tour is paused would be a lie
 * about the thing they are looking at. So while the presentation is actually
 * spinning, and only then, these resolve to the spin instead. Nothing else in
 * the grammar is context-sensitive: every other phrase means one thing.
 */
const STOP_WHILE_SPINNING = new Set(['stop', 'halt', 'stop it', 'stop that', 'stop the molecule', 'stop the structure']);

/** Which way a spoken nudge pushes the structure, in the wearer's own basis. */
const MOVE_DIRECTIONS = new Map([
  ['up', 'up'], ['higher', 'up'], ['down', 'down'], ['lower', 'down'],
  ['left', 'left'], ['right', 'right'],
  // "move it to the left" is how the direction is actually spoken; the bare
  // "move it left" is the rarer form.
  ['to the left', 'left'], ['to the right', 'right'], ['to my left', 'left'], ['to my right', 'right'],
  ['over to the left', 'left'], ['over to the right', 'right'],
  ['closer', 'closer'], ['nearer', 'closer'], ['towards me', 'closer'], ['toward me', 'closer'], ['forward', 'closer'],
  ['away', 'away'], ['further', 'away'], ['farther', 'away'], ['further away', 'away'], ['farther away', 'away'], ['backwards', 'away'],
]);

/**
 * "move it up": moving the structure in space without a controller.
 *
 * One step is `VOICE_MOVE_METRES`, the same order as a second of thumbstick.
 * "a lot" doubles it and "a bit" halves it, because a wearer who says a
 * direction twice means it went the right way and not far enough.
 */
function movePhrase(phrase) {
  const match = phrase.match(/^(?:(?:move|push|nudge|shift|slide|pull|send|bring|take|put) )?(?:it |this |that |the structure |the molecule )?([a-z ]+?)(?: (a lot|a little|a bit|more|a long way|way))?$/);
  if (!match) return undefined;
  const direction = MOVE_DIRECTIONS.get(match[1].trim());
  if (!direction) return undefined;
  const amount = match[2];
  const metres = amount === 'a little' || amount === 'a bit' ? VOICE_MOVE_METRES / 2
    : amount ? VOICE_MOVE_METRES * 2 : VOICE_MOVE_METRES;
  return { action: Object.freeze({ kind: 'move', direction, metres }),
    say: `Moving it ${direction === 'closer' ? 'closer' : direction === 'away' ? 'away' : direction}.` };
}

/**
 * A fixed turn, as opposed to a continuous spin.
 *
 * `spin it` starts the presentation's continuous rotation and stays that way.
 * A wearer who wants to see the far side asks for a turn, which is a fixed
 * yaw about the structure's own vertical and stops where it lands.
 */
function turnPhrase(phrase) {
  const match = phrase.match(/^(?:turn|rotate|spin|swing|flip) ?(?:it|this|the structure|the molecule)? ?(around|round|left|right|the other way|to the left|to the right)$/);
  if (!match) return undefined;
  const where = match[1];
  const degrees = where === 'left' || where === 'to the left' ? VOICE_TURN_DEGREES
    : where === 'right' || where === 'to the right' ? -VOICE_TURN_DEGREES : 180;
  return { action: Object.freeze({ kind: 'turn', degrees }),
    say: Math.abs(degrees) === 180 ? 'Turning it around.' : `Turning it ${degrees > 0 ? 'left' : 'right'}.` };
}

/**
 * "show me chain B" is the first thing anyone says to a structure.
 *
 * The chain letter and the residue range are resolved on the page, against the
 * same selection rows a trigger pick uses, and drive the same `focusSelection`
 * the host's `focus_selection` tool targets.
 */
function focusPhrase(phrase) {
  const chain = phrase.match(/^(?:show me |show |focus on |focus |go to |take me to |zoom to )?chain ([a-z0-9])$/);
  if (chain) {
    const id = chain[1].toUpperCase();
    return { action: Object.freeze({ kind: 'focus-selection', framing: 'fill', chain: id }), say: `Showing chain ${id}.` };
  }
  const residues = phrase.match(/^(?:show me |show |focus on |focus |go to |take me to |zoom to )?residues? (\d+)(?: to | through | until |[- ])(\d+)(?: (?:on|in|of) chain ([a-z0-9]))?$/);
  if (residues) {
    const [first, last] = [Number(residues[1]), Number(residues[2])].sort((a, b) => a - b);
    const id = residues[3] ? residues[3].toUpperCase() : undefined;
    return { action: Object.freeze({ kind: 'focus-selection', framing: 'fill', residues: Object.freeze([first, last]), ...(id ? { chain: id } : {}) }),
      say: `Focusing residues ${first} to ${last}${id ? ` on chain ${id}` : ''}.` };
  }
  const single = phrase.match(/^(?:show me |show |focus on |focus |go to |take me to |zoom to )?residue (\d+)(?: (?:on|in|of) chain ([a-z0-9]))?$/);
  if (!single) return undefined;
  const number = Number(single[1]), id = single[2] ? single[2].toUpperCase() : undefined;
  return { action: Object.freeze({ kind: 'focus-selection', framing: 'fill', residues: Object.freeze([number, number]), ...(id ? { chain: id } : {}) }),
    say: `Focusing residue ${number}${id ? ` on chain ${id}` : ''}.` };
}

/**
 * "hide the water".
 *
 * Nothing in the inspection command set could hide part of a structure, so
 * this is the smallest thing that can: a transparency layer over the water or
 * the ligands, added and removed by name. It is deliberately two nouns, not a
 * general query language.
 */
function visibilityPhrase(phrase) {
  const match = phrase.match(/^(hide|show|bring back) (?:the )?(water|waters|solvent|ligand|ligands|hetero atoms|heteroatoms)$/);
  if (!match) return undefined;
  const visible = match[1] !== 'hide';
  const group = match[2].startsWith('water') || match[2] === 'solvent' ? 'water' : 'ligand';
  return { action: Object.freeze({ kind: 'visibility', group, visible }),
    say: `${visible ? 'Showing' : 'Hiding'} the ${group === 'water' ? 'water' : 'ligands'}.` };
}

/**
 * The causative shape of the spin, and the stem behind it.
 *
 * "Make it spin" was spoken by all five corpus voices, transcribed correctly by
 * all five, and matched nothing: the table held `spin` and `spin it` but not a
 * verb with an object in the middle. Rather than enumerate the cross product,
 * this reads one causative verb, an optional object, and a motion stem.
 *
 * It cannot strip a negation or a qualifier, because it is anchored at both
 * ends: "don't make it spin" and "stop making it spin" match nothing here and
 * the caller's leading-filler walk will not reach past `don` or `stop`.
 */
const MOTION_STEMS = /^(spin|spins|spinning|rotate|rotates|rotating|rotation|turn|turns|turning)$/;
function motionPhrase(phrase) {
  const match = phrase.match(
    /^(make|get|have|let|keep|start|begin|give) (?:it |this |that |the structure |the molecule |me )?(?:a |the )?([a-z]+)(?: going)?$/);
  if (!match || !MOTION_STEMS.test(match[2])) return undefined;
  return SPIN_ON;
}

/** Every parsed phrase family, in the order a spoken sentence is tried against them. */
const PHRASE_PARSERS = [focusPhrase, visibilityPhrase, turnPhrase, movePhrase, motionPhrase];

/** Diagnostics must never cost a command: a broken sink is not an error here. */
function recordVoiceCommand(kind, detail) {
  try { globalThis.__stereofoldDiagnostics?.record?.(kind, detail); }
  catch { /* The page may have no diagnostics buffer installed. */ }
}

function trimFillers(words) {
  let end = words.length;
  while (end > 1 && TRAILING_FILLERS.has(words[end - 1])) end--;
  return words.slice(0, end);
}

/**
 * Resolve one transcript into a spatial action the companion can run.
 *
 * Returns `undefined` for speech outside the grammar, and an entry with no
 * `action` for a command the grammar knows but an immersive session cannot
 * perform. Both are outcomes, not errors, and the caller reports them
 * differently.
 */
export function spatialVoiceAction(value, { spinning = false, lessonParts = [], lesson, sequenceOpen = false } = {}) {
  const normalized = normalizeVoiceTranscript(value);
  if (!normalized || normalized.length > VOICE_COMMAND_MAX_PHRASE_CHARS) return undefined;
  const words = trimFillers(normalized.split(' '));
  for (let index = 0; index < words.length; index++) {
    const phrase = words.slice(index).join(' ');
    // Checked ahead of the fixed table so a running spin can claim "stop"
    // before the tour grammar does. With nothing spinning this never fires.
    if (spinning && STOP_WHILE_SPINNING.has(phrase)) return Object.freeze({ ...SPIN_OFF, phrase, transcript: normalized });
    // These answer without a scene mutation. The detailed Mol* page owns its
    // separate return handler; here a return must not become a tour step.
    if (phrase === 'help' || phrase === 'what can i say')
      return Object.freeze({ reply: true, say: HELP_REPLY, phrase, transcript: normalized });
    if (phrase === 'return' || phrase === 'go back')
      return Object.freeze({ reply: true, say: NOTHING_TO_RETURN_REPLY, phrase, transcript: normalized });
    if (phrase === 'what am i looking at' || phrase === 'what is this')
      return Object.freeze({ reply: true, forward: true, say: lessonReply(lesson), phrase, transcript: normalized });
    const local = SPATIAL_PHRASES.get(phrase);
    if (local) return Object.freeze({ ...local, phrase, transcript: normalized });
    const recognized = voiceCommandFromTranscript(phrase);
    if (recognized) {
      const mapped = SPATIAL_VOICE_ACTIONS[recognized.command];
      return Object.freeze({ ...(mapped ?? {}), command: recognized.command, phrase, transcript: normalized });
    }
    // The loaded lesson's own nouns, between the two exact tables and the
    // value-carrying parsers. After the tables, so "show me
    // around" keeps its fixed meaning whatever a lesson calls its parts; before
    // the parsers, so a part named in the colour key beats a chain letter that
    // happens to read like one. With no lesson loaded this matches nothing.
    const part = lessonPartVoiceCommand(phrase, lessonParts);
    if (part) return Object.freeze({ ...part, phrase, transcript: normalized });
    // While the residue browser is open, "go to residue 141" is about
    // the browser. Checked before `focusPhrase`, which owns the same sentence
    // when the browser is shut and keeps it: the browser being open is the only
    // thing that moves the meaning, and it moves back when the browser closes.
    if (sequenceOpen) {
      const jump = sequenceGotoVoiceCommand(phrase);
      if (jump) return Object.freeze({ ...jump, phrase, transcript: normalized });
    }
    // The phrase families that carry a value — a chain letter, a
    // residue range, a direction, an angle. They are tried after the two exact
    // tables, so no fixed phrase can change meaning by acquiring a parser.
    for (const parse of PHRASE_PARSERS) {
      const parsed = parse(phrase);
      if (parsed) return Object.freeze({ ...parsed, phrase, transcript: normalized });
    }
    // Only a leading run of filler words may be skipped. The first word that
    // carries meaning ends the search, so a qualifier can never be dropped.
    if (!LEADING_FILLERS.has(words[index])) break;
  }
  return undefined;
}

function failureReason(error) {
  const text = error instanceof Error && error.message ? error.message : String(error ?? 'unknown');
  return text.trim().slice(0, 120) || 'unknown';
}

/**
 * Run every finished transcript against the grammar and dispatch what it means.
 *
 * @param {object} options
 * @param {{on:(listener:(event:object)=>void)=>()=>void}} [options.events] streamer emitter; defaults to the page-wide one
 * @param {(action:object)=>Promise<unknown>} options.dispatch the companion's spatial action runner
 * @param {(text:string)=>unknown} [options.caption] the toolbar's one caption line
 * @param {(text:string)=>unknown} [options.speak] optional spoken confirmation; never awaited
 * @param {(kind:string,detail:object)=>unknown} [options.record] diagnostics sink
 * @param {()=>boolean} [options.spinning] whether the presentation is turning right now
 * @param {()=>boolean} [options.agentAttached] whether a Mac-side agent is listening right now
 * @param {()=>{title?:string,summary?:string}} [options.lesson] the currently loaded lesson
 * @param {()=>boolean} [options.sequenceOpen] whether the residue sequence browser has the menu right now
 * @returns {{dispose:()=>void, settled:()=>Promise<void>}}
 */
export function attachVoiceCommandRunner({ events, dispatch, caption, speak, spinning, agentAttached, lessonParts, lesson,
  sequenceOpen, getGeometryBudget, record = recordVoiceCommand } = {}) {
  if (typeof dispatch !== 'function') throw new TypeError('A voice command runner needs an action dispatcher.');
  const stream = events ?? pushToTalkAudioEvents();
  if (typeof stream?.on !== 'function') throw new TypeError('A voice command runner needs a push-to-talk event stream.');

  const seenUtterances = new Set();
  let closed = false, priming = true, captionTurn = 0, chain = Promise.resolve();
  // The page's own reading of the spin, used when the caller offers none. Any
  // dispatched action that is not a spin start ends the turn on the viewer
  // side, because every one of them runs through a mutation that pauses
  // presentation motion, so this flag follows the same rule.
  let dispatchedSpin = false;
  const isSpinning = () => {
    if (typeof spinning !== 'function') return dispatchedSpin;
    try { return spinning() === true; }
    catch { return dispatchedSpin; }
  };
  // Read at the utterance, never cached. The colour key
  // changes with every chapter, so a lesson's nouns are only ever the ones the
  // structure is wearing when the wearer speaks. A throwing probe is no lesson.
  const parts = () => {
    if (typeof lessonParts !== 'function') return [];
    try { const value = lessonParts(); return Array.isArray(value) ? value : []; }
    catch { return []; }
  };
  const hasAgent = () => {
    if (typeof agentAttached !== 'function') return false;
    // Presence is an accessory to the answer, never a condition of it: a
    // throwing probe means the wearer hears the offline wording, not nothing.
    try { return agentAttached() === true; }
    catch { return false; }
  };
  const currentLesson = () => {
    try { return lesson?.(); } catch { return undefined; }
  };
  /** Whether the residue browser has the menu right now. A throwing probe is a shut browser. */
  const browserOpen = () => {
    if (typeof sequenceOpen !== 'function') return false;
    try { return sequenceOpen() === true; } catch { return false; }
  };

  const show = text => {
    if (typeof caption !== 'function' || typeof text !== 'string') return;
    try { const result = caption(text); if (result && typeof result.catch === 'function') result.catch(() => {}); }
    catch { /* The toolbar can be mid-teardown; the action still matters. */ }
  };
  // A refused spoken line must not vanish. A silent confirmation is still a
  // degraded command rather than a failed one, so the action stands
  // and the caption stays; the reason is recorded so the wearer's missing audio
  // can be read back instead of guessed at.
  const speechFailed = (text, error) => {
    try { record('speech-failed', { route: 'voice-confirmation', chars: text.length,
      status: typeof error?.status === 'number' ? error.status : null,
      reason: String(error?.message ?? error ?? 'unknown').slice(0, 120) }); }
    catch { /* Diagnostics are advisory. */ }
  };
  const announce = (text, timing) => {
    if (typeof speak !== 'function' || !text) return;
    // Dispatcher errors can contain arbitrary prose. Keep every spoken line
    // within the wearer's limit while retaining the full caption and record.
    if (text.trim().split(/\s+/).length > 12) text = 'Could not finish. Try again or ask on the Mac.';
    try { const result = speak(text, timing); if (result && typeof result.catch === 'function') result.catch(error => speechFailed(text, error)); }
    catch (error) { speechFailed(text, error); }
  };

  /**
   * Resolve one utterance against the grammar, raw text first.
   *
   * The Mac transcribes, then proposes a scene-checked reading of what it
   * wrote — "resident 141" is "residue 141" when this structure has a residue
   * 141, and the correction is recorded as a rule. The raw text is what the
   * wearer sees and is still what the grammar is tried against first, so no
   * sentence this page already understood can change meaning. Only a sentence
   * it understood as nothing gets the second reading, which is how "go to
   * residue 141" reaches the residue browser instead of being answered "Not a
   * command".
   */
  function resolve(text, event) {
    const context = { spinning: isSpinning(), lessonParts: parts(), lesson: currentLesson(), sequenceOpen: browserOpen() };
    const heard = spatialVoiceAction(text, context);
    if (heard) return heard;
    const proposed = typeof event?.normalizedText === 'string' ? event.normalizedText.trim()
      : typeof event?.transcript?.normalizedText === 'string' ? event.transcript.normalizedText.trim() : '';
    if (!proposed || proposed === text) return undefined;
    const corrected = spatialVoiceAction(proposed, context);
    if (!corrected) return undefined;
    // Which of the two readings acted is exactly what a reader of
    // `read_headset_log` needs when a command works for one wearer and not
    // another, so it is recorded rather than inferred from the phrase.
    try { record('voice-normalized', { heard: text.slice(0, VOICE_COMMAND_MAX_PHRASE_CHARS),
      read: proposed.slice(0, VOICE_COMMAND_MAX_PHRASE_CHARS) }); }
    catch { /* Diagnostics are advisory. */ }
    return corrected;
  }

  let deciding = Promise.resolve();
  function handle(event) {
    if (closed || event?.state !== 'heard') return;
    // `on` replays the emitter's latest event to a new subscriber. A transcript
    // from before this session started must not execute on attach.
    if (priming) { if (event.utteranceId) seenUtterances.add(event.utteranceId); return; }
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text) return;
    // One utterance runs once. A re-emitted `heard` is the same sentence.
    if (event.utteranceId && seenUtterances.has(event.utteranceId)) return;
    if (event.utteranceId) seenUtterances.add(event.utteranceId);
    const turn = ++captionTurn;

    const transcript = event.transcript && typeof event.transcript === 'object' ? event.transcript : undefined;
    const resolved = resolve(text, event);
    if (typeof event.decide === 'function') {
      // A grammar reply is not an action. Release it for the assistant, or
      // keep the existing offline reply when nobody is connected.
      const local = Boolean(resolved?.action);
      const pending = event.decide(local).then(granted => {
        if (closed) return;
        if (local && granted) execute(event, text, resolved, turn);
        else if (hasAgent()) forwarded();
        else if (!local) execute(event, text, resolved, turn);
      });
      deciding = Promise.all([deciding, pending]).then(() => {});
      return;
    }
    // Old hosts have already published this transcript. Never execute it twice.
    if (transcript && hasAgent()) { forwarded(); return; }
    execute(event, text, resolved, turn);

    function forwarded() {
      record('voice-command', { phrase: text.slice(0, VOICE_COMMAND_MAX_PHRASE_CHARS), action: null, outcome: 'forwarded' });
      show(AGENT_FORWARD_CAPTION);
      announce(AGENT_FORWARD_REPLY);
    }
  }

  function execute(event, text, resolved, turn) {
    if (!resolved) {
      // An unrecognized sentence is spoken as well as captioned: a wearer has
      // to be looking at the menu to read a caption.
      //
      // It does not read the sentence back. Hearing your own words returned
      // adds nothing a wearer did not already know, and it doubles the time
      // before they can try again. The phrase stays in the headset record
      // below, and the Mac still has the transcript — the Mac is what
      // transcribed it, and `listen_voice` hands the same text to the agent —
      // so a sentence the page cannot act on is still answerable.
      //
      // With an agent attached it is not a refusal at all. The sentence is
      // already on the Mac, in the queue the
      // agent polls, so the wearer is told where it went rather than that it
      // was rejected. The diagnostics outcome separates the two, because
      // `read_headset_log` has to be able to tell a sentence nobody could act
      // on from one that was handed to Claude.
      const attached = hasAgent();
      record('voice-command', { phrase: text.slice(0, VOICE_COMMAND_MAX_PHRASE_CHARS), action: null,
        outcome: attached ? 'forwarded' : 'unrecognized' });
      show(attached ? AGENT_FORWARD_CAPTION : UNRECOGNIZED_REPLY);
      announce(attached ? AGENT_FORWARD_REPLY : UNRECOGNIZED_REPLY);
      return;
    }
    if (resolved.reply) {
      // Transcription already queues the original sentence on the Mac for the
      // agent. Answering locally neither consumes nor replaces that queue.
      record('voice-command', { phrase: resolved.phrase, action: null,
        outcome: resolved.forward && hasAgent() ? 'forwarded' : 'answered' });
      show(resolved.say);
      announce(resolved.say);
      return;
    }
    if (!resolved.action) {
      // Spoken as well as shown. A wearer looking at the structure is not
      // looking at the menu, and a caption nobody reads is a command that
      // vanished. Every branch of this handler ends in something the wearer
      // hears.
      const unsupported = 'Ask on the Mac.';
      record('voice-command', { phrase: resolved.phrase, action: resolved.command ?? null, outcome: 'unsupported' });
      show(unsupported);
      announce(unsupported);
      return;
    }
    // Workbench opens can be refused by the host. Their outcome owns the
    // first line; other commands keep their immediate render acknowledgement.
    if (resolved.action.kind !== 'open-workbench') show(resolved.say);
    chain = chain.then(async () => {
      if (closed) return;
      try {
        const timing = { utteranceId: event.utteranceId };
        recordLoopStage('action-posted', timing);
        const previousGeometryBudget = getGeometryBudget?.();
        let outcome = await dispatch(resolved.action);
        if (typeof getGeometryBudget === 'function' && outcome?.applied?.geometryBudget)
          outcome = { ...outcome, applied: { ...outcome.applied, geometryBudgetChanged: geometryBudgetChanged(previousGeometryBudget, outcome.applied.geometryBudget) } };
        recordLoopStage('receipt-rendered', timing);
        // A host refusal resolves normally: the page already showed and spoke
        // its reason. Record that answer instead of treating every resolved
        // dispatch as applied; leave announced captions and speech alone.
        if (outcome?.outcome === 'refused') {
          record('voice-command', { phrase: resolved.phrase, action: resolved.action.kind,
            outcome: 'refused', reason: outcome.reason });
          if (!closed && turn === captionTurn && outcome.announced !== true) {
            show(outcome.reason);
            announce(outcome.reason, timing);
          }
          return;
        }
        dispatchedSpin = resolved.action.kind === 'toggle-motion' && resolved.action.paused === false;
        // A busy panel is not a failed grow. The page retries it and says "One
        // moment." during the wait; the log has to show retrying then applied
        // (or failed) so a wait can be told from a refusal afterwards.
        if (resolved.action.kind === 'grow-structure' && outcome && typeof outcome === 'object' && outcome.retrying === true) {
          record('voice-command', { phrase: resolved.phrase, action: resolved.action.kind, outcome: 'retrying' });
        }
        record('voice-command', { phrase: resolved.phrase, action: resolved.action.kind, outcome: 'applied' });
        // Record the rendered action even if a newer utterance owns the caption.
        const said = spokenConfirmation(resolved, outcome);
        if(!closed && outcome?.retrying!==true)assistantStatus.update({action:{status:'rendered',source:'Headset',text:said}});
        if (closed || turn !== captionTurn) return;
        if (outcome?.announced === true && outcome?.applied?.geometryBudget) return;
        // The scene clears its start receipt when emphasis lands. Do not revive it.
        show(said === SPATIAL_VOICE_ACTIONS['tour-play'].say ? '' : said);
        announce(said, timing);
      } catch (error) {
        // A refusal is the answer to a spoken question and has to be spoken
        // back. "There is no chain B in this structure." is the
        // message a wearer needs most, and it was reaching the menu only.
        // This page owns the sentence; report failure here instead of
        // handing an action that may already have started to a second executor.
        const reason = failureReason(error);
        if (resolved.action.kind === 'grow-structure' && error && typeof error === 'object' && error.retrying === true) {
          record('voice-command', { phrase: resolved.phrase, action: resolved.action.kind, outcome: 'retrying' });
        }
        record('voice-command', { phrase: resolved.phrase, action: resolved.action.kind, outcome: 'failed', reason });
        if (closed || turn !== captionTurn) return;
        show(reason);
        announce(reason);
      }
    }, () => { /* The previous command's failure was already reported. */ });
  }

  const unsubscribe = stream.on(handle);
  priming = false;

  /**
   * The only way to speak into a running page from a test.
   *
   * A headset transcript arrives from the Mac over the companion bridge, so an
   * automated check of what a spoken command does to the structure has no way
   * in without a microphone and a wearer. This hook is that way in: it feeds
   * one sentence to the same handler the bridge feeds, so the harness exercises
   * the real grammar, the real dispatcher and the real render. It runs nothing
   * a spoken sentence could not run. It sits beside the diagnostics buffer the
   * harness already installs, and it goes away with the session.
   */
  let hookUtterance = 0;
  const hook = {
    async say(text) {
      // Resolved against the spin state the handler is about to read, not the
      // one the dispatch leaves behind: "stop" said over a turning structure
      // must report the spin it stopped, not the tour it did not pause.
      const resolved = resolve(String(text ?? '').trim(), {});
      handle({ state: 'heard', utteranceId: `hook-${++hookUtterance}`, text: String(text ?? '') });
      await chain.catch(() => {});
      return resolved?.action?.kind ?? null;
    },
  };
  globalThis.__stereofoldVoice = hook;

  return {
    dispose() {
      closed = true;
      // Only ever remove our own hook: a later session may have installed its
      // own over this one, and a disposal must not take that with it.
      if (globalThis.__stereofoldVoice === hook) delete globalThis.__stereofoldVoice;
      try { unsubscribe?.(); } catch { /* The emitter may already be gone. */ }
    },
    /** Resolves once every dispatched command has settled. A test seam. */
    settled: async () => { await deciding; await chain; },
  };
}
