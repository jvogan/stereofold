import { describe, expect, it } from 'vitest';
import { voiceLines } from '../scripts/converse.js';
// @ts-ignore The command path's chain resolver, asserted against the normalizer's.
import { chainReferent } from '../../lab/browser-roundtrip/inspection-visibility.mjs';
import { transcriptJsonLine } from '../scripts/voice-transcript-consumer.js';
import { CATALOG_ENTRY_CODES, CATALOG_ENTRY_NAMES } from '../src/molecular-experience.js';
import { buildSpeechVocabulary, createSpeechSceneReader, isSpeechVocabularyEcho, normalizeSpeechText, WHISPER_DOMAIN_HINT,
  SPEECH_MAX_PHRASES, SPEECH_MAX_PHRASE_CHARS, SPEECH_MAX_VOCABULARY_CHARS,
  type SpeechSceneContext } from '../src/speech-vocabulary.js';

function scene(overrides: Partial<SpeechSceneContext> = {}): SpeechSceneContext {
  return { chains: ['A', 'B', 'C'].map(labelChain => ({ labelChain, authorChain: labelChain, copyId: 'copy-1' })),
    entityNames: ['Crambin'], componentIds: ['ATP'], residueNumbers: [8, 840], pdbId: '1CRN', entryCodes: [], entryNames: [],
    journeyTitles: ['Fold Detective'], representations: ['cartoon', 'ball-and-stick'], ...overrides };
}

describe('scene speech vocabulary', () => {
  it('includes commands, representations, colour schemes, every chain letter and number words without a scene', () => {
    const { phrases } = buildSpeechVocabulary();
    expect(phrases).toEqual(expect.arrayContaining(['hide', 'select', 'show', 'focus', 'assembly', 'residue',
      'cartoon', 'surface', 'ball and stick', 'colour by chain', 'color by element', 'sequence-id', 'one', 'hundred']));
    // "select residues 10 to 20" came back "Select 10 to 20" with the
    // only noun in the sentence gone. The plural and the verb it follows are primed together, because the
    // singular alone never appears beside a range.
    expect(phrases).toEqual(expect.arrayContaining(['residues', 'select residues', 'highlight residues',
      'hide residues', 'show residues']));
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') expect(phrases).toContain(`chain ${letter}`);
  });

  it('uses the same per-press terms for Apple hints and the Whisper initial prompt', () => {
    const vocabulary = buildSpeechVocabulary(scene({ chains: [{ labelChain: 'AA', authorChain: 'X', copyId: '1' }] }));
    expect(vocabulary.phrases).toEqual(expect.arrayContaining(['chain AA', 'chain X', 'Crambin', 'ATP', '1CRN', 'Fold Detective', 'residue 840']));
    for (const phrase of vocabulary.phrases) expect(vocabulary.whisperPrompt.toLowerCase()).toContain(phrase.toLowerCase());
    expect(vocabulary.whisperPrompt.startsWith('Spin it. Stop spinning.')).toBe(true);
    expect(vocabulary.whisperPrompt).toContain('Residue 840.');
  });

  it('deduplicates and sanitizes hints without altering the scene', () => {
    const context = scene({ entityNames: [' ATP ', 'ATP', 'hello,\nworld', 'x'.repeat(121)] });
    const { phrases } = buildSpeechVocabulary(context);
    expect(phrases.filter(term => term.toLowerCase() === 'atp')).toHaveLength(1);
    expect(phrases).toContain('hello world');
    expect(phrases.every(term => !/[\n,]/u.test(term))).toBe(true);
    expect(context.entityNames[2]).toBe('hello,\nworld');
    expect(phrases.every(term => term.length <= SPEECH_MAX_PHRASE_CHARS)).toBe(true);
  });

  it('bounds crowded hints while retaining terms from each live category', () => {
    const vocabulary = buildSpeechVocabulary(scene({
      chains: Array.from({ length: 1000 }, (_, i) => ({ labelChain: `X${i}`, authorChain: null, copyId: '1' })),
      entityNames: Array.from({ length: 1000 }, (_, i) => `Entity ${i}`),
    }));
    expect(vocabulary.phrases.length).toBeLessThanOrEqual(SPEECH_MAX_PHRASES);
    expect(vocabulary.whisperPrompt.length).toBeLessThanOrEqual(SPEECH_MAX_VOCABULARY_CHARS);
    expect(vocabulary.phrases).toEqual(expect.arrayContaining(['chain X0', 'Entity 0', 'ATP', '1CRN', 'Fold Detective', 'residue 840']));
  });
});

describe('scene-checked speech normalization', () => {
  it('proposes hide chain A for Hi Jane only with an unambiguous chain A', () => {
    expect(normalizeSpeechText('Hi Jane', scene())).toEqual({ normalizedText: 'hide chain A',
      normalizationRules: [{ rule: 'hi-jane-chain-a', from: 'Hi Jane', to: 'hide chain A', sceneTerm: 'chain A' }] });
  });

  it.each([
    ['no scene', undefined],
    ['no A', scene({ chains: [{ labelChain: 'B', authorChain: 'B', copyId: '1' }] })],
    ['an entity called Jane', scene({ entityNames: ['Jane binding protein'] })],
    ['a ligand called JANE', scene({ componentIds: ['JANE'] })],
    ['a journey called Jane', scene({ journeyTitles: ['Jane’s structure'] })],
    ['multiple copies', scene({ chains: [{ labelChain: 'A', authorChain: 'A', copyId: '1' }, { labelChain: 'A', authorChain: 'A', copyId: '2' }] })],
    ['no chain A of its own', scene({ chains: [{ labelChain: 'B', authorChain: 'A', copyId: '1' }, { labelChain: 'C', authorChain: 'A', copyId: '1' }] })],
    ['case-sensitive IDs collide', scene({ chains: [{ labelChain: 'A', authorChain: 'A', copyId: '1' }, { labelChain: 'a', authorChain: 'a', copyId: '1' }] })],
  ] as const)('keeps Hi Jane raw with %s', (_name, context) => {
    expect(normalizeSpeechText('Hi Jane', context)).toEqual({ normalizedText: 'Hi Jane', normalizationRules: [] });
  });

  // On the headset, four
  // injections of "hide chain A" against 4HHB came back `Hi`, `Hi Jane`,
  // `Hi Jane` and `Hide the chain N`, every one with no rule recorded, while
  // the same request sent as a command hid the protein chain A. The letter was
  // called ambiguous because the hemes are label chains E to H carrying author
  // chains A to D; the plate and the hide command never read the author letters
  // at all, so they never saw a second A.
  const hemoglobin = scene({ pdbId: '4HHB', entityNames: ['Hemoglobin subunit alpha'], componentIds: ['HEM'],
    chains: [...['A', 'B', 'C', 'D'].map(labelChain => ({ labelChain, authorChain: labelChain, copyId: 'copy-1' })),
      ...[['E', 'A'], ['F', 'B'], ['G', 'C'], ['H', 'D']].map(([labelChain, authorChain]) =>
        ({ labelChain, authorChain, copyId: 'copy-1' }))] });

  it('proposes hide chain A on a 4HHB-shaped scene whose hemes share the author letter', () => {
    expect(normalizeSpeechText('Hi Jane', hemoglobin)).toEqual({ normalizedText: 'hide chain A',
      normalizationRules: [{ rule: 'hi-jane-chain-a', from: 'Hi Jane', to: 'hide chain A', sceneTerm: 'chain A' }] });
  });

  it('proposes hide chain A on a single-chain 1CRN scene', () => {
    const crambin = scene({ chains: [{ labelChain: 'A', authorChain: 'A', copyId: 'copy-1' }] });
    expect(normalizeSpeechText('Hi Jane', crambin)).toEqual({ normalizedText: 'hide chain A',
      normalizationRules: [{ rule: 'hi-jane-chain-a', from: 'Hi Jane', to: 'hide chain A', sceneTerm: 'chain A' }] });
  });

  it('reads a spoken chain letter on 4HHB the way the hide command reads it', () => {
    expect(normalizeSpeechText('hide chain eh', hemoglobin)).toEqual({ normalizedText: 'hide chain A',
      normalizationRules: [{ rule: 'spoken-chain-letter', from: 'chain eh', to: 'chain A', sceneTerm: 'chain A' }] });
  });

  // On the Quest 2 "hide chain bee" came back `Hi Jane B` with an empty rule
  // list, so chain A was the only chain of 4HHB a wearer could hide by voice: the
  // three spoken letters need the word `chain`, which the recogniser had
  // already rewritten, and `hi-jane-chain-a` carries no letter at all.
  const SPOKEN_LETTERS = [['eh', 'A'], ['bee', 'B'], ['see', 'C'], ['dee', 'D'],
    ['ee', 'E'], ['eff', 'F'], ['gee', 'G'], ['aitch', 'H']] as const;

  it.each(SPOKEN_LETTERS)('reads the spoken chain letter %s as chain %s on 4HHB', (spoken, letter) => {
    expect(normalizeSpeechText(`hide chain ${spoken}`, hemoglobin)).toEqual({ normalizedText: `hide chain ${letter}`,
      normalizationRules: [{ rule: 'spoken-chain-letter', from: `chain ${spoken}`, to: `chain ${letter}`, sceneTerm: `chain ${letter}` }] });
  });

  it.each(SPOKEN_LETTERS)('recovers chain %s from the Hi Jane the recogniser wrote', (spoken, letter) => {
    // The sentence's own punctuation is left where it was, exactly as
    // `hi-jane-chain-a` leaves it: the rule replaces the words, not the stop.
    for (const said of [`Hi Jane ${letter}`, `Hi Jane ${letter.toLowerCase()}.`, `Hi Jane, ${spoken}`]) {
      const heard = said.replace(/[.!?]$/u, ''), tail = said.slice(heard.length);
      expect(normalizeSpeechText(said, hemoglobin)).toEqual({ normalizedText: `hide chain ${letter}${tail}`,
        normalizationRules: [{ rule: 'hi-jane-chain-letter', from: heard,
          to: `hide chain ${letter}`, sceneTerm: `chain ${letter}` }] });
    }
  });

  it.each([
    ['a letter the scene has no chain for', 'Hi Jane Z', hemoglobin],
    ['a word the scene has its own name for', 'hide chain bee', scene({ chains: [{ labelChain: 'B', authorChain: 'B', copyId: '1' }], entityNames: ['Bee venom phospholipase'] })],
    ['an ambiguous letter', 'Hi Jane A', scene({ chains: [{ labelChain: 'A', authorChain: 'A', copyId: '1' }, { labelChain: 'A', authorChain: 'A', copyId: '2' }] })],
    ['no scene', 'Hi Jane B', undefined],
    ['a sentence that does not end at the letter', 'Hi Jane B is the one', hemoglobin],
  ] as const)('keeps the letter raw with %s', (_name, said, context) => {
    expect(normalizeSpeechText(said, context)).toEqual({ normalizedText: said, normalizationRules: [] });
  });

  it('primes the recogniser with the hide request for every label chain the scene has', () => {
    const { phrases, whisperPrompt } = buildSpeechVocabulary(hemoglobin);
    for (const letter of 'ABCDEFGH') expect(phrases).toContain(`hide chain ${letter}`);
    expect(whisperPrompt).toContain('Hide chain H.');
    // Author letters are not primed as hides: the plate prints label chains and
    // the hide command resolves label chains, so nothing else is a request.
    expect(phrases.filter(phrase => phrase.startsWith('hide chain'))).toHaveLength(8);
  });

  it('resolves a heard letter to the same chain the visibility command resolves it to', () => {
    const available = hemoglobin.chains.map(({ labelChain, copyId }) => ({ labelChain, copyId }));
    expect(chainReferent('A', available)).toEqual({ labelChain: 'A', copyId: 'copy-1' });
    expect(normalizeSpeechText('Hi Jane', hemoglobin).normalizedText).toBe('hide chain A');
    // A letter the command refuses is a letter the normalizer must not propose.
    expect(() => chainReferent('Z', available)).toThrow(/This structure has no chain Z/u);
    expect(normalizeSpeechText('hide chain Z', hemoglobin).normalizationRules).toEqual([]);
  });

  it('uses the full scene to guard competing names even after the hint cap', () => {
    const context = scene({ entityNames: [...Array.from({ length: 300 }, (_, i) => `Entity ${i}`), 'Jane'] });
    expect(buildSpeechVocabulary(context).phrases).not.toContain('Jane');
    expect(normalizeSpeechText('Hi Jane', context).normalizationRules).toEqual([]);
  });

  it('does not turn a greeting within a longer sentence into a command', () => {
    expect(normalizeSpeechText('Hi Jane, how are you?', scene()).normalizationRules).toEqual([]);
  });

  it.each(['Load one CERN', 'load one crn'])('maps %s to the loaded PDB identity', text => {
    const result = normalizeSpeechText(text, scene());
    expect(result.normalizedText).toBe(`${text.split(' ')[0]} 1CRN`);
    expect(result.normalizationRules[0]).toMatchObject({ rule: 'spoken-entry-code', sceneTerm: '1CRN' });
  });

  it.each([scene({ pdbId: '4HHB' }), scene({ pdbId: undefined }), scene({ entityNames: ['CERN'] }), scene({ componentIds: ['CRN'] })])(
    'does not guess an unloaded or competing PDB term', context => {
      expect(normalizeSpeechText('load one CERN', context)).toEqual({ normalizedText: 'load one CERN', normalizationRules: [] });
    });

  /**
   * The transcripts both device sessions came back with. "Load one CERN" was
   * the one phrase the priming did not cover, and an empty `normalizationRules` array is what the
   * headset logged for it.
   */
  describe('the eight device transcripts that carry an entry code or look like one', () => {
    const loaded = (pdbId: string | undefined, entryCodes: string[] = []) =>
      scene({ pdbId, entryCodes, entityNames: [], componentIds: [], journeyTitles: [] });

    it.each([
      ['Load one CERN', 'Load 1CRN', loaded('1CRN')],
      ['Load one CERN', 'Load 1CRN', loaded('4HHB', ['1CRN'])],
      ['load one C R N', 'load 1CRN', loaded('4HHB')],
      ['go back to four H H B', 'go back to 4HHB', loaded('1CRN')],
      ['load four hhb', 'load 4HHB', loaded('1CRN')],
    ] as const)('turns %s into %s', (heard, said, context) => {
      const result = normalizeSpeechText(heard, context);
      expect(result.normalizedText).toBe(said);
      expect(result.normalizationRules).toHaveLength(1);
      expect(result.normalizationRules[0]).toMatchObject({ rule: 'spoken-entry-code', to: said.split(' ').at(-1) });
    });

    it.each([
      ['Show it is ball and stick', loaded('1CRN')],
      ['Select residue 10 to 20', loaded('1CRN')],
      ['Select 10 to 20', loaded('1CRN')],
      ['Load the structure from http://example.com/model.pdb', loaded('1CRN')],
    ] as const)('leaves %s exactly as it was heard', (heard, context) => {
      expect(normalizeSpeechText(heard, context)).toEqual({ normalizedText: heard, normalizationRules: [] });
    });

    it('proposes nothing when two known codes are spelled inside one word', () => {
      const context = loaded(undefined, ['1CRN', '1ERN']);
      expect(normalizeSpeechText('load one CERN', context).normalizationRules).toEqual([]);
    });

    it('keeps counting and measuring out of the rule', () => {
      for (const heard of ['one two three four', 'load one two three four apples', 'there is one big one here',
        'count to one hundred', 'residue one four one']) {
        expect(normalizeSpeechText(heard, loaded('1CRN')).normalizationRules,
          `"${heard}" must not be read as an entry code`).toEqual([]);
      }
    });

    it('knows 1CRN and 4HHB from the shipped catalog, which is what the device asked for', () => {
      expect(CATALOG_ENTRY_CODES).toEqual(expect.arrayContaining(['1CRN', '4HHB']));
      for (const code of CATALOG_ENTRY_CODES) expect(code).toMatch(/^[1-9][A-Z0-9]{3}$/);
      // 4HHB was on screen and 1CRN had never been loaded, which is the state
      // the headset was in when "load 1CRN" came back as "Load one CERN".
      const cold = loaded('4HHB', [...CATALOG_ENTRY_CODES]);
      expect(normalizeSpeechText('Load one CERN', cold).normalizedText).toBe('Load 1CRN');
    });

    it('primes the recognizer with the codes the scene knows, not only the loaded one', () => {
      const { phrases, whisperPrompt } = buildSpeechVocabulary(loaded('1CRN', ['4HHB', '9KJ6']));
      expect(phrases).toEqual(expect.arrayContaining(['1CRN', '4HHB', '9KJ6']));
      expect(whisperPrompt).toContain('4HHB.');
      // A code the product has never named is never offered to the recognizer.
      expect(phrases).not.toContain('1ABC');
    });
  });

  it('maps spoken letters only after chain and records each matched rule', () => {
    const result = normalizeSpeechText('show chain eh, chain bee and chain see', scene());
    expect(result.normalizedText).toBe('show chain A, chain B and chain C');
    expect(result.normalizationRules.map(rule => rule.sceneTerm)).toEqual(['chain A', 'chain B', 'chain C']);
    expect(normalizeSpeechText('see the bee, eh?', scene()).normalizationRules).toEqual([]);
  });

  it('preserves absent, competing, or ambiguous spoken chain letters', () => {
    expect(normalizeSpeechText('hide chain bee', scene({ chains: [] })).normalizationRules).toEqual([]);
    expect(normalizeSpeechText('hide chain bee', scene({ entityNames: ['Bee protein'] })).normalizationRules).toEqual([]);
    const context = scene({ chains: [{ labelChain: 'B', authorChain: 'B', copyId: '1' }, { labelChain: 'B', authorChain: 'B', copyId: '2' }] });
    expect(normalizeSpeechText('hide chain bee', context).normalizationRules).toEqual([]);
  });

  it('corrects cartoons only for a supported representation request', () => {
    expect(normalizeSpeechText('show cartoons', scene())).toMatchObject({ normalizedText: 'show cartoon',
      normalizationRules: [{ rule: 'cartoon-plural', sceneTerm: 'cartoon' }] });
    for (const [text, context] of [['watch cartoons', scene()], ['show cartoons', scene({ representations: [] })],
      ['show cartoons', scene({ entityNames: ['Cartoons'] })]] as const)
      expect(normalizeSpeechText(text, context)).toEqual({ normalizedText: text, normalizationRules: [] });
  });

  /**
   * The request still selected eleven residues on the
   * device, because the model reads a bare range against a scene whose only
   * numbered things are residues — so the intent survived and only the
   * transcript lied about what was said. These cases make it honest, and keep
   * the rule off every sentence where the range means something else.
   */
  it('writes the residues a bare range names, grounded in the scene, and records the rule', () => {
    const context = scene({ residueNumbers: [10, 15, 20] });
    const result = normalizeSpeechText('Select 10 to 20', context);
    expect(result.normalizedText).toBe('Select residues 10 to 20');
    expect(result.normalizationRules).toEqual([{ rule: 'bare-residue-range', from: '10 to 20',
      to: 'residues 10 to 20', sceneTerm: 'residue 10' }]);
    for (const [text, written] of [['highlight 10-20', 'highlight residues 10-20'],
      ['focus on 10 through 20', 'focus on residues 10 through 20'],
      ['hide 10 and 20', 'hide residues 10 and 20']] as const)
      expect(normalizeSpeechText(text, context).normalizedText).toBe(written);
  });

  it('proposes no residues for a range the scene does not have, or one another noun already owns', () => {
    const context = scene({ residueNumbers: [10, 15, 20] });
    for (const text of [
      'select residues 10 to 20',   // the recognizer already heard the noun
      'select model 1 to 2',        // a different noun stands between verb and range
      'show chain 10 to 20',
      'count 10 to 20',             // no verb this rule answers to
      'Select 10 to 21',            // 21 is not a residue in this scene
      'Select 9 to 20',
      'Select 20 to 10',            // a range that does not ascend is not one
    ]) expect(normalizeSpeechText(text, context)).toEqual({ normalizedText: text, normalizationRules: [] });
    expect(normalizeSpeechText('Select 10 to 20', scene({ residueNumbers: [] })))
      .toEqual({ normalizedText: 'Select 10 to 20', normalizationRules: [] });
  });

  it('leaves correct, unrelated and empty transcripts unchanged', () => {
    for (const text of ['hide chain A', 'load 1CRN', 'show cartoon', 'actually the other copy', ''])
      expect(normalizeSpeechText(text, scene())).toEqual({ normalizedText: text, normalizationRules: [] });
  });
});

describe('host scene speech capture', () => {
  const structureText = `data_test
_entry.id 1CRN
loop_
_entity.id
_entity.pdbx_description
1 'Crambin'
2 'Jane binding protein'
`;
  const row = (entityId = '1', modelNumber = 1, assemblyId = '1') => ({ entityType: 'polymer', identity: {
    modelNumber, assemblyId, entityId, labelChain: entityId === '1' ? 'A' : 'B', authorChain: 'X', copyId: '1',
    componentId: entityId === '1' ? 'THR' : 'ATP', authorResidue: 840,
  } });
  const catalog = { modelNumbers: [1, 2], assemblyId: '1', rows: [row(), row(), row('2', 2), row('2', 1, '2')] };

  it('reads mmCIF entity names and PDB identity and filters by the current model and assembly', async () => {
    const context = await createSpeechSceneReader()({ source: { structureText }, catalog,
      scene: { modelNumber: 1, assemblyId: '1' }, journeyTitles: ['Fold Detective'] });
    expect(context).toEqual(scene({ chains: [{ labelChain: 'A', authorChain: 'X', copyId: '1' }],
      componentIds: ['THR'], residueNumbers: [840], representations: ['cartoon', 'ball-and-stick', 'molecular-surface', 'spacefill'] }));
  });

  it('does not borrow seed coordinates or PDB identity for a density map', async () => {
    const context = await createSpeechSceneReader()({ source: { structureText }, catalog, scene: null, density: {}, journeyTitles: ['Map journey'] });
    expect(context).toEqual({ chains: [], entityNames: [], componentIds: [], residueNumbers: [], entryCodes: [], entryNames: [],
      journeyTitles: ['Map journey'], representations: [] });
    expect(normalizeSpeechText('Hi Jane', context).normalizationRules).toEqual([]);
  });

  /** The codes the host says this session can reach ride on the scene. */
  it('carries the entry codes it was given, and is not the place they are invented', async () => {
    const context = await createSpeechSceneReader()({ source: { structureText }, catalog,
      scene: { modelNumber: 1, assemblyId: '1' }, journeyTitles: [], entryCodes: ['4HHB', '9KJ6'] });
    expect(context.entryCodes).toEqual(['4HHB', '9KJ6']);
    expect(context.pdbId).toBe('1CRN');
    expect(buildSpeechVocabulary(context).phrases).toEqual(expect.arrayContaining(['1CRN', '4HHB', '9KJ6']));
    // A density-only scene borrows no identity from the seed coordinates, but
    // the codes came from the host, not from the seed, and a wearer looking at a
    // map can still ask for one by name.
    const map = await createSpeechSceneReader()({ source: { structureText }, catalog, scene: null, density: {},
      journeyTitles: [], entryCodes: ['4HHB'] });
    expect(map.entryCodes).toEqual(['4HHB']);
    expect(map.pdbId).toBeUndefined();
  });

  it('freezes the model and journey terms before asynchronous metadata parsing', async () => {
    const active = { modelNumber: 1, assemblyId: '1' }, journeyTitles = ['First journey'];
    const pending = createSpeechSceneReader()({ source: { structureText }, catalog, scene: active, journeyTitles });
    active.modelNumber = 2; journeyTitles[0] = 'Changed journey';
    const context = await pending;
    expect(context.entityNames).toEqual(['Crambin']);
    expect(context.journeyTitles).toEqual(['First journey']);
  });
});

/**
 * The noun the recognizer lost, and the look the wearer named.
 *
 * "go to residue 141" came back `Go to resident 141` and matched none of the
 * sequence browser's shapes, so the spoken route to a numbered residue was
 * lost to one letter.
 */
describe('transcript corrections', () => {
  const hemoglobin = () => scene({ residueNumbers: [1, 5, 141], pdbId: '4HHB',
    representations: ['cartoon', 'ball-and-stick', 'molecular-surface', 'spacefill'] });

  it('primes the verb and the noun together for a numbered residue', () => {
    const { phrases } = buildSpeechVocabulary(hemoglobin());
    expect(phrases).toEqual(expect.arrayContaining(['go to residue', 'jump to residue', 'show residue', 'find residue']));
    expect(phrases).toEqual(expect.arrayContaining(['residue 141']));
  });

  it('writes "resident N" as "residue N" after a movement verb, and records the rule', () => {
    const corrected = normalizeSpeechText('Go to resident 141', hemoglobin());
    expect(corrected.normalizedText).toBe('Go to residue 141');
    expect(corrected.normalizationRules).toEqual([{ rule: 'heard-resident', from: 'resident', to: 'residue',
      sceneTerm: 'residue 141' }]);
  });

  it('leaves the word alone without a verb, without a number, or off this scene', () => {
    for (const text of ['The residents of the city 141', 'Go to resident hall', 'Go to resident 999']) {
      const read = normalizeSpeechText(text, hemoglobin());
      expect(`${text}: ${read.normalizedText}`).toBe(`${text}: ${text}`);
      expect(read.normalizationRules).toEqual([]);
    }
  });

  it('writes a spoken look as the word the menu row and the contract both use', () => {
    const sticks = normalizeSpeechText('Use sticks', hemoglobin());
    expect(sticks.normalizedText).toBe('Use ball and stick');
    expect(sticks.normalizationRules).toEqual([{ rule: 'representation-word', from: 'sticks', to: 'ball and stick',
      sceneTerm: 'ball-and-stick' }]);
    expect(normalizeSpeechText('make it spheres', hemoglobin()).normalizedText).toBe('make it spacefill');
    // Ordinary speech about a surface is not a request for one.
    expect(normalizeSpeechText('the surface is charged', hemoglobin()).normalizedText).toBe('the surface is charged');
    // A scene with no representations at all proposes nothing.
    expect(normalizeSpeechText('Use sticks', scene({ representations: [] })).normalizationRules).toEqual([]);
  });

  /**
   * The two transcripts the recogniser actually wrote on the Quest 2
   *. The wearer said
   * "Show it as sticks" and "Make it sticks"; the words that arrived were
   * `Show me a sticks` and `Make a sticks`, and neither fired the rule, so the
   * record of what was heard kept the wearer's word instead of the canonical
   * look. "Switch to sticks" arrived intact and already worked.
   */
  it('reads the look through the filler the recogniser writes after a verb', () => {
    for (const [heard, written] of [
      ['Show me a sticks', 'Show me a ball and stick'],
      ['Make a sticks', 'Make a ball and stick'],
      ['Switch to sticks', 'Switch to ball and stick'],
      ['Show it as sticks', 'Show it as ball and stick'],
      ['Make it sticks', 'Make it ball and stick'],
      ['show me a surface', 'show me a molecular surface'],
      ['render it as a surface', 'render it as a molecular surface'],
      ['display the spheres', 'display the spacefill'],
    ] as const) {
      const read = normalizeSpeechText(heard, hemoglobin());
      expect(`${heard}: ${read.normalizedText}`).toBe(`${heard}: ${written}`);
      expect(read.normalizationRules.map(rule => rule.rule)).toEqual(['representation-word']);
    }
  });

  it('still leaves a sentence that is not asking for a look alone', () => {
    for (const text of [
      'the surface is charged',
      'make a note about the surface',
      'show me a picture of the sticks',
      'the spheres are the water molecules',
    ]) {
      const read = normalizeSpeechText(text, hemoglobin());
      expect(`${text}: ${read.normalizedText}`).toBe(`${text}: ${text}`);
      expect(read.normalizationRules).toEqual([]);
    }
  });
});

/**
 * The molecule name the recogniser wrote as a word that names nothing.
 *
 * Synthetic speech "Show me crambin" reached the host as `Show me Crandon`,
 * with `normalizedText` equal to the raw text and an empty rule list
 *"hemoglobin", "Hide the water"
 * and "Select residues 1 to 10" arrived exactly as spoken in the same session,
 * so the gap is the name, not the recogniser.
 */
describe('molecule names', () => {
  /** The scene a wearer asking for a structure by name is looking at: no name of its own yet. */
  const catalogScene = (overrides: Partial<SpeechSceneContext> = {}) => scene({
    entityNames: [], componentIds: [], journeyTitles: [], pdbId: undefined,
    entryCodes: [...CATALOG_ENTRY_CODES],
    entryNames: CATALOG_ENTRY_NAMES.map(entry => ({ entryCode: entry.entryCode, spellings: [...entry.spellings] })),
    ...overrides });

  it('names the entries the device asked for, and names only entries this build ships', () => {
    const named = new Map(CATALOG_ENTRY_NAMES.map(entry => [entry.entryCode, entry.spellings]));
    expect(named.get('1CRN')).toContain('crambin');
    expect(named.get('4HHB')).toEqual(expect.arrayContaining(['hemoglobin', 'haemoglobin']));
    for (const entry of CATALOG_ENTRY_NAMES) {
      expect(CATALOG_ENTRY_CODES).toContain(entry.entryCode);
      expect(entry.spellings.length).toBeGreaterThan(0);
    }
  });

  it('writes the name the wearer said and records where the name came from', () => {
    const heard = normalizeSpeechText('Show me Crandon', catalogScene());
    expect(heard.normalizedText).toBe('Show me crambin');
    expect(heard.normalizationRules).toEqual([{ rule: 'heard-molecule-name', from: 'Crandon',
      to: 'crambin', sceneTerm: 'crambin (1CRN)' }]);
  });

  it('leaves the name alone when the recogniser already wrote it', () => {
    for (const text of ['Show me crambin', 'Show me hemoglobin', 'Show me haemoglobin', 'show me the microtubule'])
      expect(normalizeSpeechText(text, catalogScene())).toEqual({ normalizedText: text, normalizationRules: [] });
  });

  it('leaves a word that is not close to any name this host knows', () => {
    for (const text of ['Show me transferrin', 'Show me the london', 'Show me collagen',
      'Show me crystals', 'the cabin is cramped', 'Show me Brandon'])
      expect(normalizeSpeechText(text, catalogScene())).toEqual({ normalizedText: text, normalizationRules: [] });
  });

  it('never resolves a word that is close to two names the host knows', () => {
    // The loaded structure names something the heard word is just as close to.
    const competing = catalogScene({ entityNames: ['Crandin'], pdbId: '1CRN' });
    expect(normalizeSpeechText('Show me Crandon', competing)).toEqual({
      normalizedText: 'Show me Crandon', normalizationRules: [] });
  });

  it('primes the recogniser with the names as well as the codes', () => {
    const { phrases, whisperPrompt } = buildSpeechVocabulary(catalogScene());
    expect(phrases).toEqual(expect.arrayContaining(['crambin', 'hemoglobin']));
    expect(whisperPrompt).toContain('Crambin.');
  });

  it('carries the names the host gave it onto the scene it captured', async () => {
    const context = await createSpeechSceneReader()({ source: { structureText: 'data_x\n_entry.id 1CRN\n' },
      catalog: { modelNumbers: [1], assemblyId: '1', rows: [] }, scene: null, journeyTitles: [],
      entryCodes: ['1CRN'], entryNames: [{ entryCode: '1CRN', spellings: ['crambin'] }] });
    expect(context.entryNames).toEqual([{ entryCode: '1CRN', spellings: ['crambin'] }]);
  });
});

describe('CLI transcript consumers', () => {
  it('preserves raw text and the scene-checked correction in both JSON line formats', () => {
    const text = 'Hi Jane', normalized = normalizeSpeechText(text, scene());
    const transcript = { text, ...normalized, cursor: 1, sequence: 1, utteranceSequence: 1,
      utteranceId: 'press-1', receivedAt: '2026-09-13T00:00:00.000Z', referent: { sourceToken: 'source-1' } };
    expect(voiceLines({ transcripts: [transcript] }, {})[0]).toMatchObject({ text, ...normalized,
      utteranceId: transcript.utteranceId, sequence: 1, referent: transcript.referent });
    expect(JSON.parse(transcriptJsonLine(transcript))).toMatchObject({ text, ...normalized,
      utteranceId: transcript.utteranceId, sequence: 1, referent: transcript.referent });
  });

  /** The corrected name and its source have to reach the wearer-facing line. */
  it('carries a molecule-name correction through the converse line and the JSON line', () => {
    const text = 'Show me Crandon';
    const normalized = normalizeSpeechText(text, scene({ entityNames: [], componentIds: [], journeyTitles: [],
      pdbId: undefined, entryNames: [{ entryCode: '1CRN', spellings: ['crambin'] }] }));
    expect(normalized.normalizedText).toBe('Show me crambin');
    const transcript = { text, ...normalized, cursor: 1, sequence: 1, utteranceSequence: 1,
      utteranceId: 'press-2', receivedAt: '2026-09-15T00:00:00.000Z' };
    expect(voiceLines({ transcripts: [transcript] }, {})[0]).toMatchObject({ type: 'voice', text,
      normalizedText: 'Show me crambin', normalizationRules: normalized.normalizationRules });
    expect(JSON.parse(transcriptJsonLine(transcript)).normalizationRules)
      .toEqual([{ rule: 'heard-molecule-name', from: 'Crandon', to: 'crambin', sceneTerm: 'crambin (1CRN)' }]);
  });
});


describe('hint-only transcript guard',()=>{
  it('rejects prompt lists and bare scene terms, before normalization',()=>{
    const context=scene({residueNumbers:[15]});
    expect(isSpeechVocabularyEcho(buildSpeechVocabulary(context).whisperPrompt,context)).toBe(true);
    expect(isSpeechVocabularyEcho(WHISPER_DOMAIN_HINT,context)).toBe(true);
    for(const text of ['Residue 15. Hide chain A.','residue 15 hide chain A','ATP. ATP.','Crambin.'])
      expect(isSpeechVocabularyEcho(text,context),text).toBe(true);
  });
  it('keeps acoustically decoded requests, including one repeated command',()=>{
    for(const text of ['Go back. Go back.','Hide chain A.','Pause the animation. Pause the animation.',
      'Highlight the ATP.','What is the role of ATP in the motor?'])
      expect(isSpeechVocabularyEcho(text,scene()),text).toBe(false);
  });
});
