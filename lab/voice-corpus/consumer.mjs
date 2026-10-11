/**
 * The scripted consumer: a fixed grammar, not a model.
 *
 * Something has to stand where the agent stands — read the transcript, decide
 * what it names, and either dispatch a tool call or ask. A model there would
 * make every run unreproducible and would let a lucky paraphrase count as
 * evidence that the command path works. So this is a table: a list of patterns
 * taken from the corpus's own utterances, and a target resolver that asks the
 * host which canonical rows a region names. Both halves are deterministic, and
 * an utterance no pattern claims comes back as `needs-model` rather than as a
 * failure, because a table not covering a sentence says nothing about the host.
 *
 * The resolver is the part that carries real weight. "Author chain X residue
 * fifteen with no insertion code" is answered by `get_inspection_state`, over
 * the saved model, in canonical keys — so a wrong target here is a wrong target
 * in the product, and an ambiguous one is ambiguous for a model too.
 */
import { residues } from './session.mjs';

export const CONSUMER_VERSION = 1;

/**
 * How old a pointer may be and still be what "this" means.
 *
 * The host keeps an open referent for five minutes so a slow answer still acts
 * on the right thing. That is a different question from whether a deictic word
 * may reach back that far, and the corpus asks the second one (V19). This is
 * the consumer's own declared limit, recorded in every run record.
 */
export const REFERENT_FRESHNESS_MS = 10_000;

const NUMBER_WORDS = new Map(Object.entries({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100,
}));

/** "one hundred twenty-five" -> 125. Only the shapes the corpus actually says. */
export function spokenNumber(text) {
  const cleaned = String(text).toLowerCase().replace(/-/gu, ' ').trim();
  if (/^\d+$/u.test(cleaned)) return Number(cleaned);
  const words = cleaned.split(/\s+/u).filter(word => word !== 'and');
  let total = 0; let current = 0; let seen = false;
  for (const word of words) {
    const value = NUMBER_WORDS.get(word);
    if (value === undefined) return undefined;
    seen = true;
    if (value === 100) current = (current || 1) * 100;
    else current += value;
  }
  total += current;
  return seen ? total : undefined;
}

const REPRESENTATIONS = new Map(Object.entries({
  'ball and stick': 'ball-and-stick', 'ball-and-stick': 'ball-and-stick', cartoon: 'cartoon',
  'molecular surface': 'molecular-surface', spacefill: 'spacefill',
}));

/**
 * The pattern table. Order matters: the frames that say "I am not asking for
 * anything" and the frames that name two candidates are read before the
 * selectors they otherwise look like.
 */
const RULES = [
  { id: 'quotation', pattern: /quoting it,? not asking you to change/iu, intent: () => ({ kind: 'quotation' }) },
  { id: 'incomplete', pattern: /^\s*hide\s*[….]{1,3}\s*$/iu, intent: () => ({ kind: 'incomplete' }) },
  { id: 'stop-speaking', pattern: /^\s*stop speaking/iu, intent: () => ({ kind: 'stop-speaking' }) },
  { id: 'cancel', pattern: /^\s*cancel that\b/iu, intent: () => ({ kind: 'cancel' }) },
  { id: 'undo', pattern: /^\s*undo my last change/iu, intent: () => ({ kind: 'undo' }) },
  { id: 'delivery-query', pattern: /^\s*did that reach the headset/iu, intent: () => ({ kind: 'delivery-query' }) },
  { id: 'selection-query', pattern: /^\s*which residue is selected/iu, intent: () => ({ kind: 'selection-query' }) },
  {
    id: 'reconnect-query', pattern: /^\s*reconnect and tell me whether author chain (\S+) is hidden/iu,
    intent: m => ({ kind: 'reconnect-query', authorChain: m[1] }),
  },
  {
    id: 'correction-hide-chain', pattern: /^\s*no,\s*hide author chain (\S+) instead/iu,
    intent: m => ({ kind: 'hide-chain', authorChain: m[1], correction: true }),
  },
  // Two candidates named in one breath. Read before the selectors so the
  // disjunction is never silently resolved to its first branch.
  {
    id: 'disjoint-chain', pattern: /select residue (\w+(?: \w+)*) in author chain (\S+?) or (\S+?)\.?$/iu,
    intent: m => ({ kind: 'ambiguous', reason: 'two author chains were named', field: 'authorChain',
      candidates: [m[2], m[3]], authorResidue: spokenNumber(m[1]) }),
  },
  {
    id: 'disjoint-residue', pattern: /in author chain (\S+),\s*select residue (\w+(?: \w+)*) or (\w+(?: \w+)*)\.?$/iu,
    intent: m => ({ kind: 'ambiguous', reason: 'two residue numbers were named', field: 'authorResidue',
      candidates: [spokenNumber(m[2]), spokenNumber(m[3])], authorChain: m[1] }),
  },
  {
    id: 'named-annotation', pattern: /^\s*show the (\w+(?: \w+)*) site\b/iu,
    intent: m => ({ kind: 'named-annotation', name: `${m[1]} site` }),
  },
  {
    id: 'alternate-site', pattern: /select the alternate site for author chain (\S+) residue (\w+(?: \w+)*),?\s*insertion code (\w+)/iu,
    intent: m => ({ kind: 'alternate-site', authorChain: m[1], authorResidue: spokenNumber(m[2]), insertionCode: m[3].toUpperCase() }),
  },
  // "position N" without saying which numbering. Deliberately distinct from
  // "author residue N" and from "sequence position N", both of which are clear.
  {
    id: 'ambiguous-position', pattern: /select position (\w+(?: \w+)*) in author chain (\S+)/iu,
    intent: m => ({ kind: 'ambiguous-numbering', number: spokenNumber(m[1]), authorChain: m[2].replace(/\.$/u, '') }),
  },
  {
    id: 'sequence-position-focus', pattern: /select sequence position (\w+(?: \w+)*) in author chain (\S+) and focus it/iu,
    intent: m => ({ kind: 'select-sequence', labelSequenceId: spokenNumber(m[1]), authorChain: m[2], thenFocus: true }),
  },
  {
    id: 'select-with-insertion', pattern: /select author chain (\S+),\s*residue (\w+(?: \w+)*),\s*insertion code (\w+)/iu,
    intent: m => ({ kind: 'select-residue', authorChain: m[1], authorResidue: spokenNumber(m[2]), insertionCode: m[3].toUpperCase() }),
  },
  {
    id: 'select-no-insertion', pattern: /select author residue (\w+(?: \w+)*) with no insertion code in chain (\S+)/iu,
    intent: m => ({ kind: 'select-residue', authorChain: m[2].replace(/\.$/u, ''), authorResidue: spokenNumber(m[1]), insertionCode: '' }),
  },
  {
    id: 'focus-residue-no-insertion', pattern: /focus author chain (\S+),\s*residue (\w+(?: \w+)*) with no insertion code/iu,
    intent: m => ({ kind: 'focus-residue', authorChain: m[1], authorResidue: spokenNumber(m[2]), insertionCode: '' }),
  },
  { id: 'select-referent', pattern: /^\s*select this residue/iu, intent: () => ({ kind: 'select-referent' }) },
  { id: 'focus-referent', pattern: /^\s*focus this\b/iu, intent: () => ({ kind: 'focus-referent' }) },
  { id: 'focus-selection', pattern: /^\s*focus the selected residue/iu, intent: () => ({ kind: 'focus-selection' }) },
  { id: 'fit', pattern: /^\s*fit the molecule/iu, intent: () => ({ kind: 'fit' }) },
  { id: 'reset-orientation', pattern: /^\s*reset the molecule.s orientation/iu, intent: () => ({ kind: 'reset-orientation' }) },
  {
    id: 'scale', pattern: /display scale to (\w+(?:[ -]\w+)*) percent/iu,
    intent: m => ({ kind: 'scale', percent: spokenNumber(m[1]) }),
  },
  {
    id: 'rotate', pattern: /rotate the molecule (\w+(?:[ -]\w+)*) degrees around its vertical axis/iu,
    intent: m => ({ kind: 'rotate', degrees: spokenNumber(m[1]) }),
  },
  {
    id: 'save-view', pattern: /save this view as (.+?)\.?$/iu,
    intent: m => ({ kind: 'save-view', name: m[1].trim() }),
  },
  {
    id: 'representation', pattern: /(?:show this molecule as|change the molecule to) (.+?)\.?$/iu,
    intent: m => ({ kind: 'representation', representation: REPRESENTATIONS.get(m[1].trim().toLowerCase()) }),
  },
  {
    id: 'hide-chain-in-session', pattern: /hide author chain (\S+) in inspection (\S+?)\.?$/iu,
    intent: m => ({ kind: 'hide-chain', authorChain: m[1], otherInspection: m[2] }),
  },
  {
    id: 'hide-chain-on-device', pattern: /hide author chain (\S+) (?:in|on) (quest[^.]*?)\.?$/iu,
    intent: m => ({ kind: 'hide-chain', authorChain: m[1], device: m[2].trim() }),
  },
  { id: 'hide-chain', pattern: /hide author chain (\S+?)\.?$/iu, intent: m => ({ kind: 'hide-chain', authorChain: m[1] }) },
  {
    id: 'show-component', pattern: /show ligand (\S+?)\.?$/iu,
    intent: m => ({ kind: 'show-component', componentId: m[1].toUpperCase() }),
  },
  { id: 'show-chain', pattern: /show author chain (\S+?)\.?$/iu, intent: m => ({ kind: 'show-chain', authorChain: m[1] }) },
  { id: 'restore-view', pattern: /^\s*restore (.+?)\.?$/iu, intent: m => ({ kind: 'restore-view', name: m[1].trim() }) },
];

/** The one intent a transcript names, or nothing at all. */
export function interpret(transcript) {
  const text = String(transcript ?? '');
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) return { rule: rule.id, ...rule.intent(match) };
  }
  return { rule: null, kind: 'unmatched' };
}

/** Every canonical row of the saved model, so "the molecule" has an extent. */
async function wholeModel(session) {
  const rows = [];
  for (let offset = 0; ; offset += 128) {
    const page = await residues(session, { offset, limit: 128 });
    rows.push(...page);
    if (page.length < 128) break;
  }
  return rows;
}

const copyOf = row => row.identity.copyId;

/**
 * Which rows a region names, and whether naming it left anything open.
 *
 * Two rows that differ only by assembly copy are two answers, not one, and the
 * corpus has a case for exactly that (V16). So the shape of the ambiguity is
 * reported rather than collapsed.
 */
async function resolveResidue(session, { authorChain, authorResidue, insertionCode, labelSequenceId }) {
  const query = { ...(authorChain === undefined ? {} : { authorChain }) };
  if (authorResidue !== undefined) query.authorResidueRange = [authorResidue, authorResidue];
  if (labelSequenceId !== undefined) query.labelSequenceRange = [labelSequenceId, labelSequenceId];
  let rows = await residues(session, { ...query, limit: 128 });
  if (insertionCode !== undefined) rows = rows.filter(row => (row.identity.insertionCode ?? '') === insertionCode);
  const copies = new Set(rows.map(copyOf));
  return { rows, copies: [...copies] };
}

const ask = (question, candidates = []) => ({ action: 'clarification', question, candidates });

/**
 * Intent plus the live model, in: one decision, out.
 *
 * `command` entries carry the tool and the arguments that are the consumer's —
 * the runner adds the binding, the panel and the command ID, which belong to
 * the session rather than to the sentence.
 */
export async function plan(session, intent, context = {}) {
  switch (intent.kind) {
    case 'unmatched':
      return { action: 'needs-model', reason: 'No scripted pattern claims this utterance. A model would have to interpret it.' };
    case 'quotation':
      return { action: 'none', reason: 'The speaker framed the phrase as a quotation, so it names no command.' };
    case 'incomplete':
      return { action: 'none', reason: 'The request names no target. Nothing can be dispatched from half a sentence.' };
    case 'ambiguous': {
      if (intent.field !== 'authorChain') return ask('Which residue did you mean?', intent.candidates.map(String));
      // "chain A or eight" names a letter and a digit, and those are two
      // different chains, not two pronunciations of one. Each branch is
      // resolved against the model before the question is asked, so the
      // candidates are identifiers the wearer can actually choose between.
      const resolved = [];
      for (const spoken of intent.candidates) {
        const digits = spokenNumber(spoken);
        for (const identifier of new Set([spoken, digits === undefined ? spoken : String(digits)])) {
          const rows = await residues(session, { authorChain: identifier, limit: 1 });
          if (rows.length) resolved.push(identifier);
        }
      }
      return ask('Which author chain did you mean? They are different chains, not two readings of one.',
        resolved.length ? resolved : intent.candidates.map(String));
    }
    case 'ambiguous-numbering': {
      const byAuthor = await resolveResidue(session, { authorChain: intent.authorChain, authorResidue: intent.number });
      const bySequence = await resolveResidue(session, { authorChain: intent.authorChain, labelSequenceId: intent.number });
      const authorKeys = byAuthor.rows.map(row => row.key);
      const sequenceKeys = bySequence.rows.map(row => row.key);
      if (authorKeys.length && sequenceKeys.length && JSON.stringify(authorKeys) !== JSON.stringify(sequenceKeys)) {
        return ask(`Does position ${intent.number} mean the author residue number or the sequence position? They are different residues here.`,
          [`author residue ${intent.number}`, `sequence position ${intent.number}`]);
      }
      return { action: 'needs-model', reason: 'The two numbering readings did not separate in this model, so the ambiguity rule does not apply.' };
    }
    case 'named-annotation':
      return ask(`This scene carries no ${intent.name} annotation, so nothing here names one. Which residues do you mean, or which source should the annotation come from?`, []);
    case 'alternate-site': {
      const { rows } = await resolveResidue(session, intent);
      const sites = context.alternateSites ?? [];
      if (rows.length !== 1) return ask('That residue did not resolve to one row, so its alternate sites cannot be named.', rows.map(row => row.key));
      return ask(`Residue ${intent.authorResidue}${intent.insertionCode} in author chain ${intent.authorChain} has more than one alternate site, and a selection here is residue-level. Which alternate site did you mean?`,
        sites);
    }
    case 'select-residue': case 'focus-residue': {
      const { rows, copies } = await resolveResidue(session, intent);
      if (rows.length === 0) return ask('No residue in the saved model matches that description.', []);
      if (copies.length > 1) {
        return ask(`The displayed assembly shows ${copies.length} copies of that residue. Which copy did you mean?`, copies);
      }
      if (rows.length > 1) return ask('That description matches more than one residue.', rows.map(row => row.key));
      const row = rows[0];
      return intent.kind === 'select-residue'
        ? { action: 'command', tool: 'update_inspection', args: { change: { kind: 'selection', patch: { selectionKeys: [row.key] } } }, target: [row.key] }
        : { action: 'command', tool: 'focus_selection', args: { selectionKeys: [row.key], framing: 'context' }, target: [row.key] };
    }
    case 'select-sequence': {
      const { rows, copies } = await resolveResidue(session, { authorChain: intent.authorChain, labelSequenceId: intent.labelSequenceId });
      if (rows.length === 0) return ask('No sequence position in the saved model matches that description.', []);
      if (copies.length > 1) return ask('That sequence position appears in more than one assembly copy. Which copy did you mean?', copies);
      const row = rows[0];
      const unresolved = row.coordinateState !== 'resolved';
      return {
        action: 'command', tool: 'update_inspection',
        args: { change: { kind: 'selection', patch: { selectionKeys: [row.key] } } },
        target: [row.key],
        // The second half of the sentence is refused on its own terms: a
        // residue with no coordinates has no place to frame.
        ...(intent.thenFocus && unresolved
          ? { withhold: { step: 'focus', reason: `Sequence position ${intent.labelSequenceId} in author chain ${intent.authorChain} has no resolved coordinates, so there is nothing to bring into view. The sequence selection stands; the molecular view is unchanged.` } }
          : {}),
      };
    }
    case 'select-referent': case 'focus-referent': {
      const referent = context.referent;
      if (!referent) return ask('Nothing was pointed at or selected when that request began. Point at the residue again, or name it.', []);
      const age = context.now - referent.capturedAt;
      if (!(age <= REFERENT_FRESHNESS_MS)) {
        return ask(`The last thing pointed at is ${Math.round(age / 1000)} seconds old, past this consumer's ${REFERENT_FRESHNESS_MS / 1000}-second limit for "this". Point at the target again, or name it.`, []);
      }
      const key = referent.residueKey ?? referent.selectionKeys[0];
      if (!key) return ask('The request began with nothing under the pointer, so "this" names no residue.', []);
      return intent.kind === 'select-referent'
        ? { action: 'command', tool: 'update_inspection', args: { change: { kind: 'selection', patch: { selectionKeys: [key] } }, referent }, target: [key] }
        : { action: 'command', tool: 'focus_selection', args: { framing: 'context', referent }, target: [key] };
    }
    case 'focus-selection': {
      const selected = session.scene.selectionKeys;
      if (!selected.length) return ask('Nothing is selected, so there is no region to bring into view.', []);
      return { action: 'command', tool: 'focus_selection', args: { selectionKeys: [...selected], framing: 'context' }, target: [...selected] };
    }
    case 'fit': {
      const rows = (await wholeModel(session)).filter(row => row.coordinateState === 'resolved');
      return {
        action: 'command', tool: 'focus_selection',
        args: { selectionKeys: rows.map(row => row.key), framing: 'context' },
        target: rows.map(row => row.key),
        caveat: 'This host has no fit command. Framing the whole model is the nearest supported thing, and it replaces the selection, which "fit" should not do.',
      };
    }
    case 'reset-orientation':
      return { action: 'command', tool: 'update_inspection', args: { change: { kind: 'placement', patch: { rotation: [0, 0, 0] } } } };
    case 'scale':
      if (intent.percent === undefined) return { action: 'needs-model', reason: 'The spoken percentage did not parse.' };
      return { action: 'command', tool: 'update_inspection', args: { change: { kind: 'placement', patch: { scale: intent.percent / 100 } } } };
    case 'rotate':
      if (intent.degrees === undefined) return { action: 'needs-model', reason: 'The spoken angle did not parse.' };
      return { action: 'command', tool: 'update_inspection', args: { change: { kind: 'placement', patch: { rotation: [0, intent.degrees, 0] } } } };
    case 'representation':
      if (!intent.representation) return { action: 'needs-model', reason: 'That representation name is not one of the four this host draws.' };
      return { action: 'command', tool: 'update_inspection', args: { change: { kind: 'appearance', patch: { representation: intent.representation } } } };
    case 'save-view':
      return { action: 'command', tool: 'manage_inspection_view', args: { action: 'save', name: intent.name } };
    case 'restore-view': {
      const entries = session.state?.namedViews?.entries ?? [];
      const wanted = entries.filter(entry => entry.name.toLowerCase() === intent.name.toLowerCase());
      if (wanted.length === 0) return ask(`No view called "${intent.name}" is saved in this session.`, entries.map(entry => entry.name));
      if (wanted.length > 1) return ask(`More than one saved view is called "${intent.name}".`, wanted.map(entry => entry.id));
      return { action: 'command', tool: 'manage_inspection_view', args: { action: 'restore', viewId: wanted[0].id } };
    }
    case 'hide-chain': case 'show-chain': case 'show-component': {
      // Named part visibility exists only inside a lesson colour key. Ask the
      // host rather than deciding here, so the refusal is its own sentence.
      const name = intent.authorChain ? `chain ${intent.authorChain}` : intent.componentId;
      return {
        action: 'command', tool: 'emphasize',
        args: { parts: [name], ...(intent.kind === 'hide-chain' ? { context: 0 } : {}) },
        expectRefusal: 'This host expresses per-part visibility only through a lesson colour key.',
      };
    }
    case 'undo':
      return { action: 'command', tool: 'undo_last_change', args: {} };
    case 'cancel':
      return { action: 'lifecycle', lifecycle: 'cancel' };
    case 'stop-speaking':
      return { action: 'lifecycle', lifecycle: 'cancel', speech: true };
    case 'delivery-query': case 'reconnect-query':
      return { action: 'query', tool: 'get_inspection_state', args: {} };
    case 'selection-query':
      return { action: 'query', tool: 'get_inspection_state', args: { residues: { selectedOnly: true, limit: 128 } } };
    default:
      return { action: 'needs-model', reason: `The scripted consumer has no plan for intent "${intent.kind}".` };
  }
}
