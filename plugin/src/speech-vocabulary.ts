import { CIF } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { REPRESENTATION_WORDS, representationWordKey } from './inspection-contract.js';
// @ts-ignore The one chain resolver, shared with the visibility command path.
import { uniqueNamedChain } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

/** Semantic terms only: no coordinates, source bytes, paths or tracked poses. */
export type SpeechSceneContext = {
  chains: { labelChain: string; authorChain: string | null; copyId: string }[];
  entityNames: string[];
  componentIds: string[];
  residueNumbers: number[];
  pdbId?: string;
  /**
   * The four-character entry codes this scene already knows — the
   * structure that is loaded, the ones this session has loaded before, and the
   * shipped demo catalog. Nothing is inferred from them beyond the codes
   * themselves, and a code the product has never named is never proposed.
   */
  entryCodes?: string[];
  /**
   * What a person calls those entries, and the entry each name
   * belongs to. The host reads them from the shipped catalog; a name is never
   * invented here, and one that names no reachable entry never arrives.
   */
  entryNames?: { entryCode: string; spellings: string[] }[];
  journeyTitles: string[];
  representations: string[];
};

// Keep the measured imperative-first ordering: silent Whisper clips can
// continue their prompt. The existing energy gate remains the primary guard.
export const SPEECH_COMMAND_VOCABULARY = Object.freeze([
  'spin it', 'stop spinning', 'rotate the molecule', 'reset the view',
  'start the tour', 'pause the tour', 'next step', 'previous step', 'go back',
  'show the whole thing', 'zoom in', 'zoom to the selection', 'focus on the selection',
  'make it bigger', 'make it smaller', 'bigger', 'smaller',
  'show the molecule', 'show cas9', 'show tubulin', 'show telomerase',
  'assemble a microtubule', 'assemble a filament', 'add an eb protein', 'add eb3',
  'move overhead', 'show the menu', 'open in Mol star',
  'turn on passthrough', 'turn off passthrough', 'show my room', 'hide my room', 'vr mode',
  'load', 'open', 'select', 'highlight', 'hide', 'show', 'focus', 'compare',
  // The recognizer wrote "Select 10 to 20" for "select residues 10
  // to 20" and dropped the only noun in the sentence
  // Priming the verb and the
  // noun together is what tells Apple the word belongs where it was spoken;
  // the singular alone never appears next to a range.
  'select residues', 'highlight residues', 'hide residues', 'show residues',
  // The recognizer wrote "Go to resident 141" for "go to residue
  // 141" and the sentence matched none of the sequence-browser shapes
  // The verb and the noun are primed
  // together for the same reason an earlier run primed "select residues": the singular on
  // its own never appears next to a number in this vocabulary, and "resident"
  // is a far commoner English word than "residue".
  'go to residue', 'go to residues', 'jump to residue', 'show residue', 'find residue',
  'hide chain A', 'show chain A', 'select chain A', 'focus chain A',
  'colour by chain', 'color by chain', 'colour by element', 'color by element',
  'colour by residue', 'color by residue', 'colour by sequence', 'color by sequence',
  'uniform colour', 'uniform color', 'save view', 'restore view', 'undo', 'cancel',
]);

export const SPEECH_MOLECULAR_VOCABULARY = Object.freeze([
  'cartoon', 'surface', 'molecular surface', 'sticks', 'ball and stick', 'spacefill',
  'chain', 'residue', 'residues', 'assembly', 'model', 'copy', 'entity', 'ligand', 'water', 'ion',
  'chain-id', 'element-symbol', 'residue-name', 'sequence-id', 'uniform',
  ...Array.from({ length: 26 }, (_, i) => `chain ${String.fromCharCode(65 + i)}`),
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty',
  'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'minus',
  'CRISPR', 'Cas9', 'guide RNA', 'PAM', 'microtubule', 'tubulin', 'protofilament', 'protein', 'helix',
]);

/** The current structure and every entry code the scene knows, uppercased, without repeats. */
export function knownEntryCodes(scene?: SpeechSceneContext): string[] {
  const codes = new Set<string>();
  for (const code of [scene?.pdbId, ...(scene?.entryCodes ?? [])]) {
    if (typeof code === 'string' && /^[1-9][A-Za-z0-9]{3}$/u.test(code)) codes.add(code.toUpperCase());
  }
  return [...codes];
}

/** How many entry codes a session remembers having loaded. Codes only, never coordinates. */
export const MAX_REMEMBERED_ENTRY_CODES = 12;

export const SPEECH_MAX_PHRASES = 256;
export const SPEECH_MAX_PHRASE_CHARS = 120;
export const SPEECH_MAX_VOCABULARY_CHARS = 6_000;

function cleanTerm(value: string): string {
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f,]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** One bounded phrase list shared by Apple and Whisper; never shell syntax. */
export function buildSpeechVocabulary(scene?: SpeechSceneContext) {
  const phrases: string[] = [], seen = new Set<string>();
  let chars = 0;
  const add = (value: string) => {
    const phrase = cleanTerm(value), key = phrase.toLowerCase();
    if (!phrase || phrase.length > SPEECH_MAX_PHRASE_CHARS || seen.has(key)
      || phrases.length >= SPEECH_MAX_PHRASES || chars + phrase.length + 2 > SPEECH_MAX_VOCABULARY_CHARS) return;
    seen.add(key); phrases.push(phrase); chars += phrase.length + 2;
  };
  SPEECH_COMMAND_VOCABULARY.forEach(add);
  SPEECH_MOLECULAR_VOCABULARY.forEach(add);
  if (scene) {
    if (scene.pdbId) add(scene.pdbId);
    // Round-robin categories so many chains cannot crowd out every ligand or title.
    //
    // Entry codes ride here too. "1CRN" came back as "one CERN" on
    // both device sessions
    // because the recognizer had never been told the codes exist; four
    // characters each, so the whole catalog costs less than two chain names.
    //
    // The whole request, not the noun phrase alone. "hide chain A"
    // is the only hide the shipped list primes, and on the Quest 2 on
    // "hide chain bee" came back `Hi Jane B` — the recogniser had
    // been told this scene has a chain B but never that anyone says "hide
    // chain B". Priming the
    // sentence the wearer actually says is what an earlier run did for "select residues".
    // Only the LABEL chains, because those are the letters the plate prints
    // and the hide command resolves.
    const categories = [
      scene.chains.flatMap(chain => [chain.labelChain, chain.authorChain].filter((id): id is string => !!id).map(id => `chain ${id}`)),
      scene.chains.map(chain => `hide chain ${chain.labelChain}`),
      // The names as well as the codes. "Show me crambin" came back
      // `Show me Crandon` from a recogniser that had been told 1CRN exists but never what
      // it is called; a name it has been offered is a name it can write.
      (scene.entryNames ?? []).flatMap(entry => entry.spellings),
      scene.entityNames, scene.componentIds, knownEntryCodes(scene), scene.journeyTitles,
      scene.residueNumbers.map(number => `residue ${number}`),
    ];
    for (let i = 0; i < Math.max(...categories.map(terms => terms.length)); i++) {
      for (const terms of categories) if (terms[i]) add(terms[i]);
      if (phrases.length >= SPEECH_MAX_PHRASES) break;
    }
  }
  return { phrases, whisperPrompt: phrases.map(phrase => phrase === 'vr mode' ? 'VR mode.'
    : `${phrase[0].toUpperCase()}${phrase.slice(1)}.`).join(' ') };
}

type CatalogRow = { entityType: string; identity: {
  modelNumber: number; assemblyId: string; labelChain: string; authorChain: string | null;
  copyId: string; entityId: string; componentId: string; authorResidue: number | null;
} };
type SpeechCatalog = { modelNumbers: number[]; assemblyId: string; rows: readonly CatalogRow[] };
type SpeechSource = { structureText: string; pdbId?: string };
type SourceTerms = { pdbId?: string; entities: Map<string, string> };

/** Cache source metadata by the immutable catalog, not by session or a disk file. */
export function createSpeechSceneReader() {
  const sources = new WeakMap<SpeechCatalog, Promise<SourceTerms>>();
  async function sourceTerms(source: SpeechSource): Promise<SourceTerms> {
    const terms: SourceTerms = { pdbId: source.pdbId, entities: new Map() };
    const parsed = await CIF.parse(source.structureText).run();
    if (parsed.isError) return terms;
    const frame = parsed.result.blocks[0];
    const id = terms.pdbId ?? frame?.categories.entry?.getField('id')?.str(0);
    if (id && /^[a-z0-9]{4}$/iu.test(id)) terms.pdbId = id.toUpperCase();
    const entities = frame?.categories.entity;
    for (let i = 0; i < (entities?.rowCount ?? 0); i++) {
      const entityId = entities?.getField('id')?.str(i);
      const name = entities?.getField('pdbx_description')?.str(i);
      if (entityId && name && name !== '?' && name !== '.') terms.entities.set(entityId, name);
    }
    return terms;
  }
  return async ({ source, catalog, scene, density, journeyTitles, entryCodes = [], entryNames = [] }: {
    source: SpeechSource; catalog: SpeechCatalog;
    scene: { modelNumber: number | null; assemblyId: string | null } | null;
    density?: unknown; journeyTitles: string[];
    /** The codes this build can reach, and the ones this session has already loaded. */
    entryCodes?: readonly string[];
    /** The names the catalog gives those codes. Read here, never invented here. */
    entryNames?: readonly { entryCode: string; spellings: readonly string[] }[];
  }): Promise<SpeechSceneContext> => {
    // Snapshot before the first await. A later chunk/source change cannot retarget it.
    const context: SpeechSceneContext = { chains: [], entityNames: [], componentIds: [], residueNumbers: [],
      entryCodes: [...entryCodes],
      entryNames: entryNames.map(entry => ({ entryCode: entry.entryCode, spellings: [...entry.spellings] })),
      journeyTitles: [...journeyTitles], representations: [] };
    if (density) return context; // Seed coordinates do not describe a density-only scene.
    const model = scene?.modelNumber ?? catalog.modelNumbers[0];
    const assembly = scene?.assemblyId ?? catalog.assemblyId;
    const chains = new Map<string, SpeechSceneContext['chains'][number]>();
    const entityIds = new Set<string>(), components = new Set<string>(), numbers = new Set<number>();
    for (const { identity: row } of catalog.rows) {
      if (row.modelNumber !== model || row.assemblyId !== assembly) continue;
      const chain = { labelChain: row.labelChain, authorChain: row.authorChain, copyId: row.copyId };
      chains.set(JSON.stringify([row.labelChain, row.authorChain, row.copyId]), chain);
      entityIds.add(row.entityId); components.add(row.componentId);
      if (row.authorResidue !== null) numbers.add(row.authorResidue);
    }
    context.chains = [...chains.values()]; context.componentIds = [...components]; context.residueNumbers = [...numbers];
    if (chains.size) context.representations = ['cartoon', 'ball-and-stick', 'molecular-surface', 'spacefill'];
    let pending = sources.get(catalog);
    if (!pending) { pending = sourceTerms(source); sources.set(catalog, pending); }
    const metadata = await pending;
    context.pdbId = metadata.pdbId;
    context.entityNames = [...entityIds].flatMap(id => metadata.entities.has(id) ? [metadata.entities.get(id)!] : []);
    return context;
  };
}

export type SpeechNormalizationRule = { rule: 'hi-jane-chain-a' | 'hi-jane-chain-letter' | 'spoken-entry-code' | 'spoken-chain-letter' | 'cartoon-plural' | 'bare-residue-range' | 'heard-resident' | 'representation-word' | 'heard-molecule-name';
  from: string; to: string; sceneTerm: string };

/** Number words the recognizer writes where a code's leading digit was spoken. */
const SPOKEN_DIGITS: ReadonlyMap<string, string> = new Map(
  ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'].map((word, digit) => [word, String(digit)]));

/**
 * The words that make a spoken entry code a request for one.
 *
 * "Load one CERN" is somebody naming a structure; "one two three four" is
 * somebody counting. Requiring one of these in front is what keeps the rule off
 * ordinary speech, and every observed device transcript has one: both device
 * both recorded "Load one CERN", and "go back to hemoglobin" is the same shape
 * with `to`.
 */
const ENTRY_CODE_REQUEST = 'load|loads|open|opens|show|shows|display|compare|fetch|get|bring|view|switch|go|back|to|onto|into|entry|structure|code|pdb|from|with';
const ENTRY_CODE_PHRASE = new RegExp(
  `(?<=\\b(?:${ENTRY_CODE_REQUEST})\\s+)([1-9]|${[...SPOKEN_DIGITS.keys()].join('|')})((?:\\s+[A-Za-z0-9]{1,4}){1,3})\\b`, 'giu');

/**
 * The verbs after which a bare number range is a residue range.
 *
 * "select residues 10 to 20" came back "Select 10 to 20" on the
 * device pass, with an empty rule list. The request still selected eleven residues, because the model
 * reads the range against a scene whose only numbered things are residues — so
 * the intent survived and only the transcript lied about what was said.
 *
 * The lookbehind is what keeps the rule off ordinary speech. It requires the
 * verb immediately before the first number, so a transcript that already
 * carries the noun ("select residues 10 to 20"), or that names a different one
 * ("select model 1 to 2", "show chain 1 to 2"), never matches: the noun stands
 * between the verb and the digits. Nothing outside this list proposes anything.
 */
const RESIDUE_RANGE_VERB = 'select|selects|highlight|highlights|hide|hides|show|shows|focus|focus on|label|labels';
const RESIDUE_RANGE_PHRASE = new RegExp(
  `(?<=\\b(?:${RESIDUE_RANGE_VERB})\\s+)(\\d{1,6})(\\s+(?:to|through|thru|and)\\s+|\\s*[-\u2013\u2014]\\s*)(\\d{1,6})\\b`, 'giu');

/**
 * "resident 141", written where the wearer said "residue 141".
 *
 * On the Quest 2 "go to residue 141" came back `Go to resident
 * 141` and matched none of the sequence browser's four shapes, so the wearer's
 * only spoken route to a numbered residue was lost to one letter
 *"Resident" is ordinary English, so
 * the rule is bounded on both sides: a movement verb immediately before, a
 * number immediately after, and the scene has to actually have that residue.
 * Nothing else proposes anything, and the raw text is untouched.
 */
const HEARD_RESIDENT_VERB = 'go to|goes to|jump to|jumps to|page to|skip to|scroll to|take me to|show|shows|find|finds|select|selects|highlight|highlights|focus on';
const HEARD_RESIDENT_PHRASE = new RegExp(
  `(?<=\\b(?:${HEARD_RESIDENT_VERB})\\s+(?:the\\s+)?)(residents?)(?=\\s+(\\d{1,6})\\b)`, 'giu');

/**
 * The wearer's word for one of the four ways a structure is drawn.
 *
 * `REPRESENTATION_WORDS` in `inspection-contract.ts` is what ACCEPTS those
 * words; this is what RECORDS the reading, so a transcript that reads
 * "molecular surface" says where the word came from rather than implying the
 * wearer said it. Bounded the way `cartoon-plural` is: only where the sentence
 * is already asking for a representation, and only while this scene has one.
 */
const REPRESENTATION_REQUEST = 'show|shows|use|uses|make|makes|draw|draws|render|renders|display|displays'
  + '|switch to|switches to|change to|changes to|turn into|turns into|as|representation';
/**
 * The words the recogniser puts between the verb and the look.
 *
 * The filler used to be one article — `a`, `the` or `it` — and the verb list
 * carried the rest as fixed pairs (`make it`, `draw it as`). On the Quest 2 on
 * the recogniser rewrote both natural phrasings into shapes neither
 * half could match: "Show it as sticks" came back `Show me a sticks` and "Make
 * it sticks" came back `Make a sticks`, so the wearer's own word was recorded
 * as heard rather than as the canonical look
 *"Switch to sticks" survived.
 *
 * Splitting the filler out covers `me a`, `it as`, `it as a` and the bare
 * article from one place, and the verb list keeps only verbs. The rule still
 * fires nowhere else: the look has to follow the filler immediately, so an
 * ordinary sentence about a surface still has a word standing in between.
 */
const REPRESENTATION_FILLER = '(?:me\\s+)?(?:it\\s+|them\\s+|that\\s+|this\\s+)?(?:as\\s+|in\\s+|into\\s+)?(?:a\\s+|an\\s+|the\\s+)?';
const REPRESENTATION_WORD_PHRASE = new RegExp(
  `(?<=\\b(?:${REPRESENTATION_REQUEST})\\s+${REPRESENTATION_FILLER})(ribbons?|sticks?|ball and stick|balls and sticks|surfaces?|spheres?|space filling)\\b`, 'giu');

/**
 * The words a recogniser writes where a chain letter was spoken.
 *
 * An earlier run carried three — `eh`, `bee`, `see` — and on the Quest 2
 * that left "hide chain bee" as `Hi Jane B`, matching nothing, so chain A was
 * the only chain on 4HHB a wearer could hide by voice
 * The table is the whole
 * alphabet now, so a letter is lost to the spelling of its own name in no
 * scene rather than in all but three.
 *
 * Bare single letters are deliberately absent. `uniqueNamedChain` already
 * matches a letter without regard to case, so "chain b" reaches chain B on its
 * own and a rule for it would record a correction that corrected nothing. Only
 * a word that is not already the letter belongs here.
 *
 * Every entry is ordinary English on its own, which is why nothing reads this
 * table on its own: a word is a letter only directly after `chain`, or in the
 * `Hi Jane <letter>` shape below, and only while the scene has that chain and
 * has no name of its own for the word.
 */
export const SPOKEN_CHAIN_LETTERS: ReadonlyMap<string, string> = new Map(Object.entries({
  eh: 'A', ay: 'A', aye: 'A',
  bee: 'B', be: 'B',
  see: 'C', sea: 'C', cee: 'C',
  dee: 'D', de: 'D',
  ee: 'E',
  eff: 'F', ef: 'F',
  gee: 'G', jee: 'G',
  aitch: 'H', haitch: 'H', aych: 'H',
  eye: 'I',
  jay: 'J',
  kay: 'K', cay: 'K',
  el: 'L', ell: 'L',
  em: 'M', emm: 'M',
  en: 'N', enn: 'N',
  oh: 'O',
  pee: 'P', pea: 'P',
  cue: 'Q', queue: 'Q', kew: 'Q',
  ar: 'R', arr: 'R',
  ess: 'S', es: 'S',
  tee: 'T', tea: 'T',
  you: 'U', yoo: 'U',
  vee: 'V',
  'double u': 'W', 'double you': 'W',
  ex: 'X', ecks: 'X',
  wye: 'Y', why: 'Y',
  zee: 'Z', zed: 'Z',
}));

/**
 * "Hi Jane B", written where the wearer said "hide chain B".
 *
 * The recogniser rewrites "hide chain" as "Hi Jane" before any rule sees the
 * sentence, so `spoken-chain-letter` — which needs the word `chain` — never
 * gets its chance. An earlier run’s `hi-jane-chain-a` rescued the bare phrase and so
 * rescued chain A alone. This carries the letter the recogniser did keep,
 * whether it wrote the letter itself (`Hi Jane B`) or the spelling of its name
 * (`Hi Jane bee`), and the scene still has to have that chain.
 *
 * The longer spellings are offered before the bare letter so `double u` is not
 * read as a `d` with a word after it, and the whole sentence still has to end
 * at the letter: "hi Jane, before you go" names nobody's chain.
 */
const HI_JANE_CHAIN_PHRASE = new RegExp(
  `^hi\\s+jane,?\\s+(${[...SPOKEN_CHAIN_LETTERS.keys()].sort((a, b) => b.length - a.length).join('|')}|[a-z])(?=[.!?]?$)`, 'iu');

/** Whether every character of `code` appears in `heard`, in order. */
function spelledInside(code: string, heard: string): boolean {
  let at = 0;
  for (const character of code) {
    at = heard.indexOf(character, at) + 1;
    if (at === 0) return false;
  }
  return true;
}

/**
 * The characters a spoken tail stands for, or nothing if it is ordinary speech.
 *
 * A tail token is one character of the code spoken on its own ("C", "R", "N",
 * "six"), a number word standing for a digit, or the whole remainder heard as a
 * single word ("hhb", "CERN"). A word longer than four characters is not a
 * code's tail, and the regex above never offers one.
 */
function spokenEntryTail(tail: string): string {
  let characters = '';
  for (const token of tail.trim().split(/\s+/u)) {
    const digit = SPOKEN_DIGITS.get(token.toLowerCase());
    if (digit) { characters += digit; continue; }
    if (!/^[A-Za-z0-9]{1,4}$/u.test(token)) return '';
    characters += token.toUpperCase();
  }
  return characters;
}

/**
 * The entry code a spoken phrase names, or nothing.
 *
 * Two ways in, and no third. The characters may already spell a PDB id — "one C
 * R N", "four H H B", "four hhb" — in which case that is the answer. Or the
 * recognizer heard the spelled letters as a word, which is what "one CERN" is,
 * and then the only codes considered are the ones the scene already knows: the
 * structure that is loaded, what this session has loaded before, and the
 * shipped catalog. A word that could stand for two known codes stands for
 * neither.
 */
export function spokenEntryCode(digit: string, tail: string, known: readonly string[]): string | undefined {
  const characters = spokenEntryTail(tail);
  if (!characters) return undefined;
  const candidate = `${digit}${characters}`;
  if (/^[1-9][A-Z0-9]{3}$/u.test(candidate)) return candidate;
  if (characters.length < 4 || characters.length > 6) return undefined;
  const matches = known.filter(code => code[0] === digit && spelledInside(code.slice(1), characters));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The consonant skeleton of a spoken word.
 *
 * Synthetic speech "Show me crambin" reached the host as `Show me
 * Crandon`, passed through unchanged with no rule recorded, so the model was
 * handed a word that names nothing.
 * Letter for letter those two words are three edits apart — n/m, d/b, o/i —
 * which is as far apart as two unrelated words, so no threshold on the spelling
 * reaches one from the other without reaching half the dictionary as well. By
 * sound they are one edit apart: the vowels carry almost nothing a recogniser
 * gets right, m and n are the same nasal, and only the b/d actually differs.
 *
 * The classes are Soundex's, which is the one thing Soundex is good at. The
 * first letter is kept as itself, nothing is truncated, and equal classes are
 * never collapsed: "lysozyme" read as `L25` would lose a consonant the word
 * really has.
 */
const SPEECH_SOUND_CLASSES: ReadonlyMap<string, string> = new Map(Object.entries({
  b: '1', f: '1', p: '1', v: '1',
  c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
  d: '3', t: '3', l: '4', m: '5', n: '5', r: '6',
}));

export function speechSoundCode(word: string): string {
  const letters = word.normalize('NFKD').toLowerCase().replace(/[^a-z]/gu, '');
  if (!letters) return '';
  return letters[0]!.toUpperCase()
    + [...letters.slice(1)].map(letter => SPEECH_SOUND_CLASSES.get(letter) ?? '').join('');
}

/** Levenshtein distance, over sound codes rather than spellings. */
function soundEdits(heard: string, name: string): number {
  if (heard === name) return 0;
  let previous = [...Array(name.length + 1).keys()];
  for (let i = 0; i < heard.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < name.length; j++)
      current.push(Math.min(previous[j + 1]! + 1, current[j]! + 1, previous[j]! + (heard[i] === name[j] ? 0 : 1)));
    previous = current;
  }
  return previous[name.length]!;
}

/**
 * How near a heard word has to stand before it is read as a name this host knows.
 *
 * Five bounds, and a word passes only by clearing all of them. Six letters,
 * because a short word is more often itself than a mangled name. Four
 * characters of sound code, so a word that is nearly all vowels has too little
 * skeleton to match on. The first three letters shared, and the last consonant
 * class shared, because the onset and the coda are the parts a recogniser keeps
 * — the whole of that defect happened in the middle of the word. One sound edit
 * between the two skeletons, and no more.
 *
 * "Crandon" clears them against "crambin": `cra` and a final `n` on both sides,
 * skeletons `C6535` and `C6515`, one edit apart. "Cramped" shares the onset and
 * is one edit away too, and is turned down on its coda; "crystals" and
 * "Brandon" never reach the comparison, because a recogniser that heard the
 * first syllable wrong heard a different word.
 */
export const SPEECH_NAME_MIN_LETTERS = 6;
export const SPEECH_NAME_MIN_SOUND_CODE = 4;
export const SPEECH_NAME_SHARED_ONSET = 3;
export const SPEECH_NAME_MAX_SOUND_EDITS = 1;

const SPEECH_NAME_WORD = new RegExp(`^[A-Za-z]{${SPEECH_NAME_MIN_LETTERS},}$`, 'u');
const HEARD_WORD = new RegExp(`\\p{L}{${SPEECH_NAME_MIN_LETTERS},}`, 'gu');

/** Every word the product already puts in front of the wearer; its own words are not mishearings. */
const PRODUCT_WORDS: ReadonlySet<string> = new Set([...SPEECH_COMMAND_VOCABULARY, ...SPEECH_MOLECULAR_VOCABULARY]
  .flatMap(phrase => phrase.toLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(word => word.length > 0));

type SpokenName = { name: string; source: string; code: string; onset: string };

/**
 * The names this host can be asked for, each beside where the name came from.
 *
 * Three sources, all of them things the host already holds: the common names
 * the shipped catalog gives its entry codes, the entity names the loaded
 * structure declares, and the titles of the journeys this build can run.
 * Nothing is invented here and nothing is guessed, so a name the product has no
 * way of reaching is never proposed.
 *
 * One word only. A recogniser that mangles one word of "green fluorescent
 * protein" leaves the other two standing as context, and rewriting inside a
 * phrase would be a larger claim than this rule is entitled to make.
 *
 * Two spellings that sound alike and start alike are one name: "microtubule"
 * reached through 3JAK and through 5SYF is the same word, and the first entry
 * that carries it is the one recorded. "hemoglobin" and "haemoglobin" sound
 * alike but begin differently, so both stand, and a heard word can only ever be
 * near one of them.
 */
function spokenNames(scene: SpeechSceneContext): SpokenName[] {
  const named: SpokenName[] = [], sounds = new Set<string>();
  const offer = (value: string, source: string) => {
    const name = cleanTerm(value);
    if (!SPEECH_NAME_WORD.test(name)) return;
    const code = speechSoundCode(name), onset = name.toLowerCase().slice(0, SPEECH_NAME_SHARED_ONSET);
    if (code.length < SPEECH_NAME_MIN_SOUND_CODE || sounds.has(`${code} ${onset}`)) return;
    sounds.add(`${code} ${onset}`);
    named.push({ name, source, code, onset });
  };
  for (const entry of scene.entryNames ?? []) for (const spelling of entry.spellings) offer(spelling, entry.entryCode);
  for (const name of scene.entityNames) offer(name, scene.pdbId ?? 'the loaded scene');
  for (const title of scene.journeyTitles) offer(title, 'the tour list');
  return named;
}

/** Proposals alongside raw text, never commands or resolution of an ambiguous copy. */
export function normalizeSpeechText(text: string, scene?: SpeechSceneContext) {
  let normalizedText = text;
  const normalizationRules: SpeechNormalizationRule[] = [];
  if (!scene) return { normalizedText, normalizationRules };
  // Use the full scene terms here, not the capped recognizer vocabulary: a
  // crowded hint list must never hide a competing name from the normalizer.
  const sceneWords = new Set([...scene.entityNames, ...scene.componentIds, ...scene.journeyTitles,
    ...scene.chains.flatMap(chain => [chain.labelChain, chain.authorChain ?? ''])]
    .flatMap(term => term.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)));
  /**
   * The chain a heard letter names, decided the way the plate and the hide
   * command decide it.
   *
   * This used to match author chains as well as label chains, and on
   * 4HHB that made every protein letter ambiguous — the hemes are label chains
   * E to H carrying author chains A to D, so "A" found two identities and the
   * rule that repairs `Hi Jane` could not fire. Four injections on the headset
   * produced `Hi`, `Hi Jane`, `Hi Jane` and `Hide the chain N`, all with no
   * rule recorded, while `hide chain A` sent as a command hid the protein
   * chain A on the same model.
   *
   * `uniqueNamedChain` is the command path's own resolver, so the normalizer
   * can no longer propose a chain the command would refuse, or withhold one it
   * would accept. A ligand that shares a letter in the author numbering is not
   * a competing chain here, because it is not one the wearer can name.
   */
  const uniqueChain = (id: string): string | undefined =>
    (uniqueNamedChain(id, scene.chains) as { labelChain: string } | undefined)?.labelChain;
  const replace = (pattern: RegExp, rule: SpeechNormalizationRule['rule'], to: string, sceneTerm: string) => {
    normalizedText = normalizedText.replace(pattern, from => {
      normalizationRules.push({ rule, from, to, sceneTerm }); return to;
    });
  };
  // The letter the recogniser kept when it rewrote "hide chain" as
  // "Hi Jane". Tried before the
  // bare phrase below, which is the same sentence with no letter left in it.
  if (!sceneWords.has('jane')) {
    normalizedText = normalizedText.replace(HI_JANE_CHAIN_PHRASE, (from: string, said: string) => {
      const heard = said.toLowerCase();
      // A word the scene has its own name for is that name, not a letter.
      if (SPOKEN_CHAIN_LETTERS.has(heard) && sceneWords.has(heard)) return from;
      const chain = uniqueChain(SPOKEN_CHAIN_LETTERS.get(heard) ?? said);
      if (!chain) return from;
      const to = `hide chain ${chain}`;
      normalizationRules.push({ rule: 'hi-jane-chain-letter', from, to, sceneTerm: `chain ${chain}` });
      return to;
    });
  }
  const chainA = uniqueChain('A');
  if (chainA && !sceneWords.has('jane'))
    replace(/^hi\s+jane(?=[.!?]?$)/iu, 'hi-jane-chain-a', `hide chain ${chainA}`, `chain ${chainA}`);
  // Spoken entry codes. An earlier run’s priming taught the recognizer the scene's
  // words but not its codes, so "load 1CRN" came back "Load one CERN" on both
  // device sessions. The rule
  // below reads the digit and the characters the recognizer wrote for the rest,
  // and proposes a code only when the characters spell one or when exactly one
  // code the scene already knows is spelled inside what it heard.
  const entryCodes = knownEntryCodes(scene);
  normalizedText = normalizedText.replace(ENTRY_CODE_PHRASE, (from, digitWord: string, tail: string) => {
    const digit = SPOKEN_DIGITS.get(digitWord.toLowerCase()) ?? digitWord;
    const code = spokenEntryCode(digit, tail, entryCodes);
    // A scene that has its own word for what was heard, or for the code's own
    // characters, keeps the words: a ligand called CRN outranks a guess at an
    // entry nobody asked for. A single spoken character is part of a spelling,
    // never a competing name — every scene with a chain B would otherwise lose
    // "four H H B".
    const heardWords = tail.trim().split(/\s+/u).filter(token => token.length > 1 && !SPOKEN_DIGITS.has(token.toLowerCase()));
    if (!code || sceneWords.has(code.slice(1).toLowerCase())
      || heardWords.some(token => sceneWords.has(token.toLowerCase()))) return from;
    normalizationRules.push({ rule: 'spoken-entry-code', from, to: code, sceneTerm: code });
    return code;
  });
  // A bare range after one of the verbs above is a residue range, and
  // is written as one only when this scene actually has both endpoints as
  // author residue numbers. The proposal is recorded like every other rule, so
  // a transcript that reads "residues" says where the word came from rather
  // than implying the recognizer heard it.
  const sceneResidues = new Set(scene.residueNumbers);
  normalizedText = normalizedText.replace(RESIDUE_RANGE_PHRASE, (from, first: string, joiner: string, last: string) => {
    const low = Number(first), high = Number(last);
    if (!(low < high) || !sceneResidues.has(low) || !sceneResidues.has(high)) return from;
    const to = `residues ${first}${joiner}${last}`;
    normalizationRules.push({ rule: 'bare-residue-range', from, to, sceneTerm: `residue ${first}` });
    return to;
  });
  // "resident 141" after a movement verb is residue 141, and is
  // written as one only when this scene actually has that author residue
  // number. Recorded like every other rule, so the corrected word says where
  // it came from.
  normalizedText = normalizedText.replace(HEARD_RESIDENT_PHRASE, (from: string, _word: string, ...rest: unknown[]) => {
    const digits = typeof rest[0] === 'string' ? rest[0] : '';
    const residue = Number(digits);
    if (!Number.isInteger(residue) || !sceneResidues.has(residue)) return from;
    const to = from.toLowerCase().endsWith('s') ? 'residues' : 'residue';
    normalizationRules.push({ rule: 'heard-resident', from, to, sceneTerm: `residue ${residue}` });
    return to;
  });
  // The wearer's own word for a representation, written as the word
  // the contract and the menu row both use. The contract accepts either; this
  // is only the record of which one was heard.
  if (scene.representations.length) {
    normalizedText = normalizedText.replace(REPRESENTATION_WORD_PHRASE, (from: string) => {
      const canonical = REPRESENTATION_WORDS[representationWordKey(from)];
      if (!canonical || sceneWords.has(from.toLowerCase())) return from;
      const to = canonical === 'ball-and-stick' ? 'ball and stick'
        : canonical === 'molecular-surface' ? 'molecular surface' : canonical;
      if (to === from.toLowerCase()) return from;
      normalizationRules.push({ rule: 'representation-word', from, to, sceneTerm: canonical });
      return to;
    });
  }
  // Every letter of the alphabet, not just the first three. A word is a
  // letter only where `chain` stands immediately in front of it, only while
  // this scene has that chain, and only while the scene has no name of its own
  // for the word.
  for (const [spoken, id] of SPOKEN_CHAIN_LETTERS) {
    const chain = uniqueChain(id);
    if (chain && !sceneWords.has(spoken))
      replace(new RegExp(`\\bchain\\s+${spoken}\\b`, 'giu'), 'spoken-chain-letter', `chain ${chain}`, `chain ${chain}`);
  }
  if (scene.representations.includes('cartoon') && !sceneWords.has('cartoons')) {
    // Only a representation request, not an unrelated sentence about cartoons.
    replace(/(?<=\b(?:show|use|as|representation)\s)cartoons\b|^cartoons(?=[.!?]?$)/giu,
      'cartoon-plural', 'cartoon', 'cartoon');
  }
  // The name of a molecule, written as a word that names nothing.
  //
  // Runs last, on the sentence the rules above have already settled, so a word
  // one of them wrote is never read as a mishearing — every word they write is
  // a word the product itself says, and those are turned down below.
  const names = spokenNames(scene);
  if (names.length) {
    normalizedText = normalizedText.replace(HEARD_WORD, from => {
      const heard = from.normalize('NFKC').toLowerCase();
      // A word this scene or this product already uses is the word that was
      // meant. The singular behind a plural counts: "tubulins" is tubulin.
      if (sceneWords.has(heard) || PRODUCT_WORDS.has(heard) || PRODUCT_WORDS.has(heard.replace(/s$/u, ''))) return from;
      const code = speechSoundCode(heard);
      if (code.length < SPEECH_NAME_MIN_SOUND_CODE) return from;
      const matches = names.filter(name => name.onset === heard.slice(0, SPEECH_NAME_SHARED_ONSET)
        && name.code.at(-1) === code.at(-1)
        && soundEdits(code, name.code) <= SPEECH_NAME_MAX_SOUND_EDITS);
      // A word two names are equally near belongs to neither: the raw text stands.
      if (matches.length !== 1) return from;
      const [match] = matches, said = match!.name.toLowerCase();
      if (said === heard || said === heard.replace(/s$/u, '')) return from;
      normalizationRules.push({ rule: 'heard-molecule-name', from, to: match!.name,
        sceneTerm: `${match!.name} (${match!.source})` });
      return match!.name;
    });
  }
  return { normalizedText, normalizationRules };
}
