/**
 * Deterministic commands recognised from an OAuth transcription.
 *
 * This is deliberately a small grammar, not a local language-model prompt:
 * spoken words only select a known experience, tour, or placement action.
 * Unknown speech stays unknown and is never turned into a molecular edit.
 */
import { resolveEmphasisPartIds } from './lesson-emphasis.mjs';

export const VOICE_COMMAND_MAX_CHARS = 240;

export const VOICE_COMMANDS = Object.freeze([
  'show-molecule', 'show-tubulin', 'show-cas9', 'show-telomerase', 'assemble-filament', 'assemble-microtubule', 'add-eb-protein', 'add-eb3-protein', 'move-overhead',
  'scale-larger', 'scale-smaller', 'tour-next', 'tour-back', 'tour-play', 'tour-pause',
  // Size as a word rather than as a direction. "make it small" matched nothing,
  // and when a size word did land it moved the structure by fifteen per cent —
  // too little to see, so the phrase gets repeated. A size word is a size, so
  // these carry several steps at once (`steps` in voice-command-runner.mjs).
  'scale-small', 'scale-big', 'scale-tiny', 'scale-huge',
  // Framing what is already selected. These name a region and an angular size,
  // never a camera or a pose.
  'focus-selection', 'show-whole',
  // The wearer's own room, behind the structure. Passthrough is a headline
  // feature, so it has to be reachable by voice and not only by menu.
  'passthrough-on', 'passthrough-off',
  // The render budget. Forcing a sharper picture is a menu row, an agent
  // command and these three phrases.
  'quality-best', 'quality-balanced', 'quality-fast',
  // The slow turntable spin, in the fixed table rather than only in the
  // immersive runner's own phrase map. The runner answers these; naming them
  // here is what lets the capability map in
  // plugin/skills/stereo-structure/SKILL.md quote them, because that map may
  // only quote phrases this grammar matches.
  'motion-spin', 'motion-stop',
  // Growing the staged lesson one tier at a time, in the session the wearer is
  // already standing in. The Mac grammar (plugin/src/inspection-voice.ts) has
  // these four; without them in this table, the one the headset itself reads,
  // a wearer saying "grow it" got "Sent to Claude" and nothing grew. These are
  // the same four command names, so whichever of the two grammars matches
  // first asks `grow_structure` for the same tier.
  'grow-structure', 'shrink-structure', 'grow-wall', 'grow-tip',
  // Paging the open sequence browser to a named residue. It carries a
  // number, so it is resolved by `sequenceGotoVoiceCommand` rather than by the
  // phrase table, and only while the browser is open.
  'sequence-goto',
]);

const phrases = new Map([
  ['show molecule', 'show-molecule'], ['show the molecule', 'show-molecule'], ['show structure', 'show-molecule'],
  ['show tubulin', 'show-tubulin'], ['show a tubulin dimer', 'show-tubulin'],
  ['show cas9', 'show-cas9'], ['show cas 9', 'show-cas9'], ['show the cas9 molecule', 'show-cas9'],
  // Whisper writes the demo's own name as "CRISPR Cas9", which
  // normalizes with the digit split off, and nobody says the bare enzyme name
  // when the experience is called CRISPR. Measured on all five voices.
  ['show crispr cas 9', 'show-cas9'], ['show crispr cas9', 'show-cas9'], ['crispr cas 9', 'show-cas9'],
  ['show me cas 9', 'show-cas9'], ['show me crispr cas 9', 'show-cas9'], ['show crispr', 'show-cas9'],
  ['show telomerase', 'show-telomerase'], ['show the telomerase molecule', 'show-telomerase'],
  ['assemble filament', 'assemble-filament'], ['assemble a filament', 'assemble-filament'], ['build filament', 'assemble-filament'], ['show protofilament', 'assemble-filament'],
  ['assemble microtubule', 'assemble-microtubule'], ['assemble a microtubule', 'assemble-microtubule'], ['build a microtubule', 'assemble-microtubule'], ['show microtubule', 'assemble-microtubule'],
  ['add eb protein', 'add-eb-protein'], ['add an eb protein', 'add-eb-protein'], ['add eb', 'add-eb-protein'], ['decorate filament', 'add-eb-protein'],
  // Every voice that said "EB" was transcribed "E-B", which
  // normalizes to two words, so the one-word spelling never arrived.
  ['add an e b protein', 'add-eb-protein'], ['add e b protein', 'add-eb-protein'], ['add e b', 'add-eb-protein'],
  ['add eb3', 'add-eb3-protein'], ['add eb3 protein', 'add-eb3-protein'],
  ['add e b 3', 'add-eb3-protein'], ['add e b 3 protein', 'add-eb3-protein'],
  ['move overhead', 'move-overhead'], ['view overhead', 'move-overhead'], ['overhead view', 'move-overhead'], ['put it above us', 'move-overhead'], ['put it above me', 'move-overhead'],
  // The runner drops a trailing "me", so "put it above me"
  // arrived as "put it above" and matched nothing; and "move it overhead" is
  // the same request with the object named. Both failed on all five voices.
  ['put it above', 'move-overhead'], ['move it overhead', 'move-overhead'], ['put it overhead', 'move-overhead'],
  ['above me', 'move-overhead'], ['over my head', 'move-overhead'], ['put it over my head', 'move-overhead'],
  ['scale up', 'scale-larger'], ['scale larger', 'scale-larger'], ['make it larger', 'scale-larger'], ['make it bigger', 'scale-larger'], ['zoom in', 'scale-larger'],
  ['scale down', 'scale-smaller'], ['scale smaller', 'scale-smaller'], ['make it smaller', 'scale-smaller'], ['make it smaller please', 'scale-smaller'], ['zoom out', 'scale-smaller'],
  // The shortest form. A wearer who has said "make it bigger" once then says
  // just "bigger".
  ['bigger', 'scale-larger'], ['larger', 'scale-larger'], ['smaller', 'scale-smaller'],
  // "scale up" was in the table and "scale it up" was not, so
  // the one word a wearer naturally puts in the middle lost the command. The
  // same hole sat under "make it spin"; see voice-command-runner.mjs.
  ['scale it up', 'scale-larger'], ['scale it down', 'scale-smaller'],
  ['a bit bigger', 'scale-larger'], ['a bit smaller', 'scale-smaller'],
  // "Make it small" did nothing, because the table held the comparative and
  // not the adjective. The comparatives above stay one step;
  // these are a size, so they are several. ("Smaller please" already arrives
  // as "smaller": `normalizeVoiceTranscript` drops a trailing "please".)
  ['make it small', 'scale-small'], ['small', 'scale-small'], ['make this small', 'scale-small'],
  ['too big', 'scale-small'], ['it s too big', 'scale-small'], ['thats too big', 'scale-small'], ['that s too big', 'scale-small'],
  ['make it big', 'scale-big'], ['big', 'scale-big'], ['make this big', 'scale-big'],
  ['too small', 'scale-big'], ['it s too small', 'scale-big'],
  ['make it tiny', 'scale-tiny'], ['tiny', 'scale-tiny'], ['really small', 'scale-tiny'],
  ['much smaller', 'scale-tiny'], ['way smaller', 'scale-tiny'], ['a lot smaller', 'scale-tiny'],
  ['make it huge', 'scale-huge'], ['huge', 'scale-huge'], ['really big', 'scale-huge'],
  ['much bigger', 'scale-huge'], ['way bigger', 'scale-huge'], ['a lot bigger', 'scale-huge'],
  ['make it massive', 'scale-huge'], ['massive', 'scale-huge'],
  ['next', 'tour-next'], ['next scene', 'tour-next'], ['next step', 'tour-next'], ['next one', 'tour-next'],
  // "keep going" was spoken by every voice in the corpus and
  // matched nothing. A wearer watching a step finish says it instead of "next".
  ['keep going', 'tour-next'], ['carry on', 'tour-next'], ['move on', 'tour-next'],
  ['back', 'tour-back'], ['previous', 'tour-back'], ['previous scene', 'tour-back'],
  // "previous step" is the spoken pair of "next step".
  ['previous step', 'tour-back'], ['back a step', 'tour-back'], ['back one step', 'tour-back'],
  // "go back one" reaches here as "back one" once the leading `go` is dropped.
  ['back one', 'tour-back'], ['one back', 'tour-back'], ['go back a step', 'tour-back'],
  ['play', 'tour-play'], ['play tour', 'tour-play'], ['start tour', 'tour-play'], ['resume', 'tour-play'],
  // "start the tour" is the natural phrasing, and the one word `the` made it
  // unrecognized, because a leading `start` ends the filler search before the
  // article can be dropped.
  ['start the tour', 'tour-play'], ['play the tour', 'tour-play'], ['begin the tour', 'tour-play'],
  ['start a tour', 'tour-play'], ['tour', 'tour-play'],
  // Demo and continue phrases for cinematic tour autoplay.
  ['start the demo', 'tour-play'], ['start demo', 'tour-play'], ['start a demo', 'tour-play'],
  ['play the demo', 'tour-play'], ['play demo', 'tour-play'], ['demo', 'tour-play'],
  ['begin demo', 'tour-play'], ['begin the demo', 'tour-play'],
  ['continue', 'tour-play'], ['continue tour', 'tour-play'], ['continue the tour', 'tour-play'],
  ['continue demo', 'tour-play'], ['continue the demo', 'tour-play'],
  // A wearer asks to be shown around rather than telling a player to play. All
  // five voices spoke these cleanly and matched nothing.
  ['take me on the tour', 'tour-play'], ['take me on a tour', 'tour-play'],
  ['give me the tour', 'tour-play'], ['give me a tour', 'tour-play'],
  ['show me around', 'tour-play'], ['walk me through it', 'tour-play'],
  ['pause', 'tour-pause'], ['pause tour', 'tour-pause'],
  // A wearer stops a tour by saying "stop", not "pause".
  ['pause the tour', 'tour-pause'], ['stop the tour', 'tour-pause'], ['stop tour', 'tour-pause'], ['stop', 'tour-pause'],
  // Whisper writes "pause" as "pass" or "cause" on several
  // voices. Only the forms that still name the tour are accepted — a bare
  // homophone would let an unrelated sentence stop a running tour.
  ['pass the tour', 'tour-pause'], ['cause the tour', 'tour-pause'], ['paws the tour', 'tour-pause'],
  // The bare homophones too, but only as the whole utterance: the table is an
  // exact lookup, so "because" or "a pass at it" never reaches these. Pausing
  // a tour is one press to undo, which is what makes the risk acceptable here
  // and not on reset, VR mode, or the Mol* handoff.
  ['pass', 'tour-pause'], ['cause', 'tour-pause'], ['causes', 'tour-pause'], ['paws', 'tour-pause'],
  ['hold the tour', 'tour-pause'],
  ['focus on the selection', 'focus-selection'], ['focus on selection', 'focus-selection'], ['focus the selection', 'focus-selection'],
  ['zoom to selection', 'focus-selection'], ['zoom to the selection', 'focus-selection'], ['zoom in on the selection', 'focus-selection'],
  // Whisper writes "the selection" as "this election" often
  // enough to cost the command. Nothing in a molecular viewer is an election,
  // so the mis-hearing is unambiguous and framing what is selected is safe.
  ['zoom in on this election', 'focus-selection'], ['focus on this election', 'focus-selection'],
  ['zoom to this election', 'focus-selection'], ['focus this election', 'focus-selection'],
  ['show the whole thing', 'show-whole'], ['show me the whole thing', 'show-whole'], ['show the whole structure', 'show-whole'],
  // Two names for the same switch. "Passthrough" is what the
  // feature is called; "my room" is what a wearer says when they want to see
  // where they are standing.
  ['passthrough on', 'passthrough-on'], ['turn on passthrough', 'passthrough-on'], ['enable passthrough', 'passthrough-on'],
  ['show my room', 'passthrough-on'], ['show the room', 'passthrough-on'], ['let me see my room', 'passthrough-on'],
  ['passthrough off', 'passthrough-off'], ['turn off passthrough', 'passthrough-off'], ['disable passthrough', 'passthrough-off'],
  ['hide my room', 'passthrough-off'], ['hide the room', 'passthrough-off'],
  // Nobody says "passthrough off" when what they mean is that they want to be
  // somewhere else. The opaque session is called VR, so those are the phrases,
  // including "go dark". The mirrored names for the room are here for the same
  // reason — a wearer in the opaque session asks for mixed reality, not for a
  // setting on the session they are in.
  ['vr mode', 'passthrough-off'], ['virtual reality', 'passthrough-off'], ['go to vr', 'passthrough-off'],
  ['go dark', 'passthrough-off'], ['plain vr', 'passthrough-off'], ['take me to vr', 'passthrough-off'],
  ['passthrough mode', 'passthrough-on'], ['mixed reality', 'passthrough-on'], ['back to my room', 'passthrough-on'],
  // How good the picture is, in the words a wearer uses for it. "Better" and
  // "best" are the same request — not a choice of tier, but a request for the
  // most the headset can give — and both land on `best`. The other direction
  // is asked for as frame rate rather than as quality:
  // nobody says "lower quality", they say "smoother" or "faster".
  ['better quality', 'quality-best'], ['best quality', 'quality-best'], ['higher quality', 'quality-best'],
  ['improve the quality', 'quality-best'], ['make it look better', 'quality-best'], ['sharper', 'quality-best'],
  ['balanced quality', 'quality-balanced'], ['normal quality', 'quality-balanced'], ['default quality', 'quality-balanced'],
  ['smoother', 'quality-fast'], ['faster', 'quality-fast'], ['lower quality', 'quality-fast'], ['fast quality', 'quality-fast'],
  // Motion. Each of these resolves to the same two actions the
  // immersive runner's own map already gave them, so the wearer hears the same
  // two words whichever table matched first. Bare "stop" is deliberately absent
  // and stays bound to `tour-pause` above: only the runner can see whether the
  // structure is turning, and it claims "stop" for the spin only while it is.
  ['spin', 'motion-spin'], ['spin it', 'motion-spin'], ['rotate', 'motion-spin'], ['rotate it', 'motion-spin'],
  ['do a rotation', 'motion-spin'], ['a rotation', 'motion-spin'], ['rotation', 'motion-spin'],
  ['start spinning', 'motion-spin'], ['keep spinning', 'motion-spin'],
  ['spin the molecule', 'motion-spin'], ['spin the structure', 'motion-spin'],
  ['rotate the molecule', 'motion-spin'], ['rotate the structure', 'motion-spin'],
  ['stop spinning', 'motion-stop'], ['stop rotating', 'motion-stop'], ['stop the rotation', 'motion-stop'],
  ['stop the spin', 'motion-stop'], ['stop moving', 'motion-stop'], ['hold still', 'motion-stop'], ['freeze', 'motion-stop'],
  // The microtubule tiers, spoken. Copied phrase for phrase
  // from the Mac grammar so one sentence cannot mean two different tiers
  // depending on which side heard it first. The bare stems are here because
  // the immersive runner drops a trailing "it" before it looks a phrase up, so
  // "grow it", "shrink it" and "cap it" arrive as `grow`, `shrink` and `cap`.
  ['grow it', 'grow-structure'], ['grow', 'grow-structure'], ['grow the microtubule', 'grow-structure'],
  ['keep growing', 'grow-structure'], ['grow it more', 'grow-structure'], ['make it grow', 'grow-structure'],
  ['add tubulin', 'grow-structure'], ['add a tubulin', 'grow-structure'],
  ['add another tubulin', 'grow-structure'], ['add more tubulin', 'grow-structure'],
  ['grow the filament', 'grow-structure'], ['grow the structure', 'grow-structure'],
  ['bigger tier', 'grow-structure'], ['next tier', 'grow-structure'],
  ['shrink it', 'shrink-structure'], ['shrink', 'shrink-structure'], ['go back a tier', 'shrink-structure'],
  ['back a tier', 'shrink-structure'], ['take one away', 'shrink-structure'],
  ['remove a tubulin', 'shrink-structure'], ['shrink the microtubule', 'shrink-structure'],
  ['shrink the structure', 'shrink-structure'],
  ['build the wall', 'grow-wall'], ['show the wall', 'grow-wall'],
  ['make the wall', 'grow-wall'], ['build a wall', 'grow-wall'],
  ['cap it', 'grow-tip'], ['cap', 'grow-tip'], ['cap the end', 'grow-tip'],
  ['show the tip', 'grow-tip'], ['show the cap', 'grow-tip'], ['add the cap', 'grow-tip'],
]);

/**
 * The one family of phrases a fixed table cannot hold.
 *
 * Every other command here is a phrase the page knows before it loads anything.
 * "Show me the guide RNA" is not: the nouns come from the lesson in front of the
 * wearer, and they change with the lesson. So the phrase shapes are fixed and
 * the noun is matched against the colour key the structure is actually wearing —
 * a lesson that does not name a part cannot have that part asked for, and an
 * unnamed noun stays unrecognised rather than becoming a molecular edit.
 *
 * A part goes past in a chapter, and "show me that part again" brings it back
 * without hunting for the chapter that had it.
 *
 * @param {string} value    the raw transcript
 * @param {{id:string,label?:string}[]} parts the loaded lesson's named parts
 */
const PART_PHRASES = [
  /^show me the (.+?)(?: again)?$/, /^show me (.+?)(?: again)?$/,
  /^show the (.+?)(?: again)?$/, /^show (.+?)(?: again)?$/,
  /^where is the (.+?)$/, /^where is (.+?)$/,
  /^highlight the (.+?)$/, /^highlight (.+?)$/,
  /^(.+?)$/,
];
export function lessonPartVoiceCommand(value, parts = []) {
  const transcript = normalizeVoiceTranscript(value);
  if (!transcript || !parts.length) return undefined;
  // The fixed table wins: "show me the whole thing" and "show me crispr cas 9"
  // are commands about the session, not about a part of the loaded lesson.
  if (phrases.has(transcript)) return undefined;
  for (const shape of PART_PHRASES) {
    const spoken = shape.exec(transcript)?.[1];
    const partIds = spoken ? resolveEmphasisPartIds(parts, spoken) : [];
    if (!partIds.length) continue;
    const [partId] = partIds;
    const part = parts.find(candidate => candidate.id === partId);
    const group = partIds.length > 1;
    const base = label => String(label ?? '').replace(/\([^)]*\)/g, '')
      .replace(/,?\s*(first|second) copy\b/gi, '').trim().toLowerCase();
    const name = base(part?.label);
    const copies = group && parts.filter(candidate => partIds.includes(candidate.id))
      .every(candidate => /\b(first|second) copy\b/i.test(candidate.label ?? '') && base(candidate.label) === name);
    let say = copies ? `${partIds.length === 2 ? 'Both' : 'All'} ${name} copies.`
      : group ? `Showing ${partIds.length} matching parts.` : `${part?.label ?? partId}.`;
    if (say.split(/\s+/).length > 12) say = group ? 'Showing matching parts.' : 'Showing that part.';
    return Object.freeze({ command: 'emphasize-part', ...(group ? { partIds } : { partId }), transcript,
      action: Object.freeze({ kind: 'emphasize-part', ...(group ? { parts: Object.freeze(partIds) } : { part: partId }), framing: 'context' }), say });
  }
  return undefined;
}

/**
 * "go to residue 141", said while the sequence browser is open.
 *
 * Residue 141 of a hemoglobin chain was 47 presses of `Next` away. Paging is now the plate's own capacity rather than
 * three, and this is the other half — one sentence that lands on a named
 * residue with its neighbours still around it.
 *
 * It is deliberately NOT in the fixed table and not a general parser. While the
 * browser is shut, "go to residue 141" already means "frame residue 141 in the
 * molecule" (`focusPhrase` in voice-command-runner.mjs) and must keep meaning
 * that; the browser being open is what makes the sentence about the browser.
 * The caller decides, and passes `sequenceOpen`.
 *
 * @param {string} value the raw transcript
 */
const SEQUENCE_GOTO_SHAPES = [
  /^(?:go|jump|page|skip|take me|scroll) to (?:the )?(author )?residue (\d{1,6})$/,
  /^(?:go|jump|page|skip|take me|scroll) to (?:the )?sequence position (\d{1,6})$/,
  /^(?:go|jump|page|skip|take me|scroll) to (\d{1,6})$/,
  /^(?:show |find )?(author )?residue (\d{1,6})$/,
];
export function sequenceGotoVoiceCommand(value) {
  const transcript = normalizeVoiceTranscript(value);
  if (!transcript) return undefined;
  for (const shape of SEQUENCE_GOTO_SHAPES) {
    const match = shape.exec(transcript);
    if (!match) continue;
    const digits = match[match.length - 1];
    const residue = Number(digits);
    if (!Number.isInteger(residue)) continue;
    const numbering = /sequence position/.test(transcript) ? 'sequence' : 'author';
    return Object.freeze({ command: 'sequence-goto', residue, numbering, transcript,
      action: Object.freeze({ kind: 'sequence', op: 'goto', residue, numbering }),
      say: `Going to ${numbering === 'author' ? 'residue' : 'sequence position'} ${residue}.` });
  }
  return undefined;
}

/** Return a display-safe normalized utterance, or undefined for invalid audio text. */
export function normalizeVoiceTranscript(value) {
  if (typeof value !== 'string') return undefined;
  let normalized = value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  normalized = normalized.replace(/^(?:(?:jarvis|please|now|can you)\s+)+/, '');
  normalized = normalized.replace(/(?:\s+(?:please|now))+$/, '');
  return normalized && normalized.length <= VOICE_COMMAND_MAX_CHARS ? normalized : undefined;
}

/** Resolve only an exact, bounded command phrase. */
export function voiceCommandFromTranscript(value) {
  const transcript = normalizeVoiceTranscript(value);
  const command = transcript && phrases.get(transcript);
  return command ? Object.freeze({ command, transcript }) : undefined;
}

/** The ExperiencePlayer owns deterministic scientific scene changes. */
export function voiceExperienceAction(command) {
  switch (command) {
    case 'show-molecule': return { kind: 'openExperience', id: 'molecule' };
    case 'show-tubulin': return { kind: 'goToStage', stage: 'dimer' };
    case 'show-cas9': return { kind: 'openExperience', id: 'cas9' };
    case 'show-telomerase': return { kind: 'openExperience', id: 'telomerase' };
    case 'assemble-filament': return { kind: 'goToStage', stage: 'protofilament' };
    case 'assemble-microtubule': return { kind: 'goToStage', stage: 'lattice' };
    case 'add-eb-protein': return { kind: 'goToStage', stage: 'decorated' };
    case 'add-eb3-protein': return { kind: 'goToStage', stage: 'decorated', protein: 'EB3' };
    case 'move-overhead': return { kind: 'placement', value: 'overhead' };
    case 'scale-larger': return { kind: 'placement', value: 'larger' };
    case 'scale-smaller': return { kind: 'placement', value: 'smaller' };
    // The ExperiencePlayer has one step in each direction, so a
    // size word is that step on the desktop and several in the headset, where
    // the immersive runner reads `steps`. Both directions, never nothing.
    case 'scale-big': case 'scale-huge': return { kind: 'placement', value: 'larger' };
    case 'scale-small': case 'scale-tiny': return { kind: 'placement', value: 'smaller' };
    case 'tour-next': return { kind: 'tour', action: 'next' };
    case 'tour-back': return { kind: 'tour', action: 'back' };
    case 'tour-play': return { kind: 'tour', action: 'play' };
    case 'tour-pause': return { kind: 'tour', action: 'pause' };
    // focus-selection and show-whole are deliberately absent. They frame what
    // a panel is already showing; the ExperiencePlayer changes what it shows.
    // The immersive route in voice-command-runner.mjs owns them instead, and
    // it owns `motion-spin` and `motion-stop` for the same reason: the
    // turntable spin belongs to the panel that is drawing, not to the source
    // of coordinates.
    default: return undefined;
  }
}
