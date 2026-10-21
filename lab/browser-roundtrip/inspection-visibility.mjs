/**
 * "hide chain B", "show only the ligand", as saved scene state.
 *
 * The acceptance test names hiding components, and until now the only thing
 * that could hide anything was `setGroupVisible` in viewer.mjs: two hard-coded
 * nouns, water and ligands, held in a page-lifetime state ref that no saved
 * scene knew about. Reload the panel, restore a named view, or ask a second
 * panel what the wearer is looking at, and the hidden water was back.
 *
 * So visibility becomes a field of the scene, next to appearance, placement and
 * emphasis, and this file is its one definition. Both ends read it: the host
 * decides what a request means and what the panel must come back with, and the
 * page decides which rows to take off the screen. A second implementation on
 * either side would let the two disagree about the same picture, which is
 * exactly what the receipt comparison exists to catch.
 *
 * WHAT A HIDDEN THING IS NAMED BY. A chain is named by label chain AND copy id,
 * the pair the selection catalog already carries on every row — never by a bare
 * chain letter. An assembly can hold the same label chain several times, so "B"
 * on its own is a guess between copies, and a guess is how the wearer ends up
 * watching the wrong half of a dimer disappear. A component class — water,
 * ligand, ion, polymer — is named by the class, because a wearer saying "hide
 * the water" means all of it.
 *
 * There is no coordinate, no atom and no residue key on this wire: a hidden set
 * is identities the caller read back from `get_inspection_state`, and the rows
 * they stand for are resolved inside the page against the structure it loaded.
 */

/** The four classes a wearer has a word for. `polymer` is protein/nucleic. */
export const VISIBILITY_COMPONENT_CLASSES = Object.freeze(['water', 'ligand', 'ion', 'polymer']);
/** A bound, not a target: a request naming more chains than this is a filter, not a request. */
export const MAX_HIDDEN_CHAINS = 64;
/**
 * How many chains a saved scene may hide. `only` saves the rest of the
 * structure, so this bounds the structure rather than what anyone named: the
 * kinesin flipbook loads all seven poses as 95 chains and each page keeps 8 to
 * 24 of them. Capped at MAX_HIDDEN_CHAINS, every page was refused and the
 * lesson never finished loading.
 */
export const MAX_SCENE_HIDDEN_CHAINS = 512;
export const VISIBILITY_OPS = Object.freeze(['hide', 'show', 'only', 'reset']);
/** Copy ids are structured JSON strings, so they are longer than a chain letter. */
export const MAX_VISIBILITY_IDENTIFIER = 256;

/**
 * Monatomic ions, which a wearer calls ions rather than ligands.
 *
 * mmCIF has no entity type for "ion": a magnesium and a bound inhibitor are
 * both `non-polymer`, so a catalog row alone cannot tell them apart. This list
 * is the separation, and anything outside it that is non-polymer or branched is
 * a ligand. It is deliberately only the common monatomic ones: guessing wider
 * would start calling small cofactors ions, and a wearer who says "hide the
 * ions" and loses the heme has been told a lie about what they asked for.
 *
 * It lives on the page side of the wire only. The host never expands a class
 * into rows — it carries the class name — so the two ends cannot disagree.
 */
const ION_COMPONENT_IDS = Object.freeze(new Set(['LI', 'NA', 'K', 'RB', 'CS', 'MG', 'CA', 'SR', 'BA',
  'MN', 'FE', 'FE2', 'CO', 'NI', 'CU', 'CU1', 'ZN', 'CD', 'HG', 'AG', 'AU', 'AL', 'PB', 'PT',
  'F', 'CL', 'BR', 'IOD', 'IUM', 'OH', 'NH4', 'CS1']));

/** Nothing hidden: what every scene saved before this change says, written out. */
export function emptyVisibility() {
  return { hiddenChains: [], hiddenClasses: [], showOnlySelection: false };
}

/** The one comparable form of a chain identity. Order-free, so a Set can hold it. */
export function chainIdentityKey(chain) {
  return JSON.stringify([chain.labelChain, chain.copyId]);
}

/**
 * How a chain identity is said out loud: "chain B (copy 1)".
 *
 * The copy NUMBER is its position among the copies of that same label chain in
 * the loaded assembly, counted from one — not the copy id, which is a JSON
 * operator tuple no wearer would ever say. A structure with one copy of the
 * chain drops the parenthetical, because "chain B (copy 1)" where there is only
 * one B is a distinction the listener has to work out is meaningless.
 */
export function chainIdentityLabel(chain, available) {
  const siblings = (available ?? []).filter(candidate => candidate.labelChain === chain.labelChain);
  if (siblings.length < 2) return `chain ${chain.labelChain}`;
  const number = siblings.findIndex(candidate => candidate.copyId === chain.copyId);
  return number >= 0 ? `chain ${chain.labelChain} (copy ${number + 1})` : `chain ${chain.labelChain}`;
}

function assertIdentifier(value, what) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_VISIBILITY_IDENTIFIER)
    throw Error(`A visibility ${what} must be a short non-empty identifier.`);
  return value;
}

function normalizeChain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('A hidden chain names labelChain and copyId.');
  const extra = Object.keys(value).filter(key => key !== 'labelChain' && key !== 'copyId');
  if (extra.length) throw Error('A hidden chain names labelChain and copyId and nothing else.');
  return { labelChain: assertIdentifier(value.labelChain, 'label chain'), copyId: assertIdentifier(value.copyId, 'copy id') };
}

/** A list said out loud: "A, B, C and D". */
function spoken(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * What a written or spoken chain name matches, before anything decides what to
 * do about the count. One rule, shared: `chainReferent` turns a count of zero
 * or many into its own refusal, and `uniqueNamedChain` turns it into nothing at
 * all, so the command path and the speech normalizer cannot disagree about what
 * a letter means.
 */
export function namedChainMatches(said, available = []) {
  const name = String(said ?? '').trim();
  const rows = Array.isArray(available) ? available : [];
  // "chain A" and "A" are the same request. The prefix is only taken off when
  // the whole of what was said is not itself one of this model's chain names,
  // so a structure whose label chain really is `chain` keeps it.
  const named = value => rows.filter(chain => chain.labelChain.toLowerCase() === value.toLowerCase());
  const letter = named(name).length ? name : name.replace(/^chain\b\s*/iu, '').trim();
  return { letter, matches: letter ? named(letter) : [] };
}

/**
 * The one chain a spoken letter can only mean, or nothing.
 *
 * This is `chainReferent`'s own question without its refusals, for
 * the speech normalizer, which must not propose a word the command path would
 * then refuse. It answers on LABEL chains alone, because those are what the
 * plate prints, what a saved scene names and what the hide command resolves.
 *
 * On 4HHB that distinction is the whole defect. The heme chains are label E to
 * H and carry author chains A to D, so a rule that also matched author letters
 * found two identities for "A", called the letter ambiguous and left the wearer
 * with `Hi Jane` on the plate — while `hide chain A`, sent as a command in the
 * same session, rendered the protein chain A in 1152 ms
 * One resolver, one answer.
 */
export function uniqueNamedChain(said, available = []) {
  const { matches } = namedChainMatches(said, available);
  return matches.length === 1 ? { labelChain: matches[0].labelChain, copyId: matches[0].copyId } : undefined;
}

/**
 * The chain a caller NAMED, resolved against the chains there are.
 *
 * A saved scene names a chain by its label chain and copy id, because an
 * assembly can hold the same label chain several times and the receipt
 * comparison has to be exact. A person does not: they say "chain A", or "A".
 * `chains: ["A"]` came back as a zod dump — `expected object,
 * code invalid_type, path change.patch.chains.0` — which told the wearer
 * nothing and told the model less. The same request written as the pair rendered in 559 ms, so the limit
 * was a spelling, not a picture.
 *
 * So a bare letter is accepted wherever it can only mean one chain, and where
 * it cannot, the refusal is a sentence that names what this structure has. The
 * canonical pair is unchanged and is still the only thing that reaches a
 * receipt: this resolves a referent into one, it does not widen what is saved.
 *
 * @param {object|string} value a letter, "chain A", or `{labelChain, copyId}`
 * @param {{labelChain:string,copyId:string}[]} available the model's chains, in catalog order
 */
export function chainReferent(value, available = []) {
  const only = value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof value.labelChain === 'string';
  if (typeof value !== 'string' && !only) return normalizeChain(value);
  const said = String(only ? value.labelChain : value).trim();
  const { letter, matches } = namedChainMatches(said, available);
  const listed = available.length ? spoken([...new Set(available.map(chain => chain.labelChain))]) : 'none';
  if (!letter) throw Error(`Name a chain by its letter, or by its label chain and copy id. This structure has ${listed}.`);
  if (matches.length === 1) return { labelChain: matches[0].labelChain, copyId: matches[0].copyId };
  if (!matches.length) throw Error(`This structure has no chain ${letter}: its chains are ${listed}.`);
  throw Error(`This assembly holds ${matches.length} copies of chain ${matches[0].labelChain}, so the letter alone does not say which; name one of ${spoken(matches.map(chain => `${chainIdentityLabel(chain, available)} with copy id ${chain.copyId}`))}.`);
}

/**
 * The canonical form of a visibility value: deduplicated, and in one fixed order.
 *
 * The order matters because a receipt is an exact comparison of saved scenes.
 * Two panels that hid the same two chains in different orders would describe
 * the same picture with different bytes, the comparison would say the render
 * did not match the request, and the wearer would be told a change they are
 * looking at did not happen. So there is one spelling and both ends produce it.
 */
export function normalizeVisibility(value) {
  if (value === undefined || value === null) return emptyVisibility();
  if (typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid inspection visibility.');
  for (const key of Object.keys(value))
    if (!['hiddenChains', 'hiddenClasses', 'showOnlySelection'].includes(key))
      throw Error('Unknown inspection visibility field.');
  const rawChains = value.hiddenChains ?? [];
  const rawClasses = value.hiddenClasses ?? [];
  if (!Array.isArray(rawChains) || !Array.isArray(rawClasses)) throw Error('Hidden chains and classes are lists.');
  if (rawChains.length > MAX_SCENE_HIDDEN_CHAINS) throw Error(`At most ${MAX_SCENE_HIDDEN_CHAINS} chains can be hidden at once.`);
  const seen = new Set(); const hiddenChains = [];
  for (const raw of rawChains) {
    const chain = normalizeChain(raw); const key = chainIdentityKey(chain);
    if (seen.has(key)) continue;
    seen.add(key); hiddenChains.push(chain);
  }
  hiddenChains.sort((a, b) => a.labelChain.localeCompare(b.labelChain) || a.copyId.localeCompare(b.copyId));
  const classes = new Set();
  for (const name of rawClasses) {
    if (!VISIBILITY_COMPONENT_CLASSES.includes(name))
      throw Error(`A component class is one of ${VISIBILITY_COMPONENT_CLASSES.join(', ')}.`);
    classes.add(name);
  }
  const showOnlySelection = value.showOnlySelection ?? false;
  if (typeof showOnlySelection !== 'boolean') throw Error('showOnlySelection is true or false.');
  return { hiddenChains, hiddenClasses: VISIBILITY_COMPONENT_CLASSES.filter(name => classes.has(name)), showOnlySelection };
}

export function visibilityIsEmpty(value) {
  const state = normalizeVisibility(value);
  return !state.hiddenChains.length && !state.hiddenClasses.length && !state.showOnlySelection;
}

export function sameVisibility(a, b) {
  return JSON.stringify(normalizeVisibility(a)) === JSON.stringify(normalizeVisibility(b));
}

/**
 * What a request means, against the chains this structure actually has.
 *
 * `available` is the chain identities of the saved model, in catalog order. A
 * named chain outside it is refused here rather than sent to the panel, because
 * a panel asked to hide something it cannot find has no picture to come back
 * with and the command would time out as `unconfirmed` — the wearer waits, and
 * then hears nothing useful. The refusal lists what there is instead.
 *
 * `only` is an intersection, not a second kind of hide: what stays is what is
 * in a named chain AND in a named class, so "only the ligand" hides the other
 * three classes and "only chain A" hides every other chain. Naming both is how
 * a caller asks for the ligands of one chain.
 *
 * `contents` is the same question asked of the CLASSES — the ones
 * this loaded model has, and the structure's name for the sentence. A chain the
 * model does not have was always refused here; a class was not, so on one device session
 * "hide the water" on 1CRN, which is 327 atom sites of crambin and no HOH at
 * all, came back "Hidden the water" and drew `Applied · change · r6` over a
 * picture that had not moved. A request that names only classes
 * this structure has none of is now refused by name, and one that names some of
 * each hides what is there and leaves the rest for the caller to explain: a
 * saved hidden set must never claim a class the panel has nothing to take off
 * the screen for. Omit `contents` and nothing is checked, because a caller that
 * cannot say what the structure holds must not refuse out of its own ignorance.
 *
 * `only` reads `contents` too, and reads it harder. hide and show
 * drop an absent class and change what is left; `only` cannot, because it names
 * what to KEEP and hides the rest, so on one device session "show only the ligand" on
 * crambin hid water, ion and polymer and drew an empty panel under an `Applied`
 * receipt. An `only` whose every named class is absent is refused whether or
 * not it also names a chain: the intersection of a chain and a class this file
 * has none of is empty as well, and showing the chain on its own answers a
 * request nobody made. An `only` naming some of each keeps the present ones,
 * and its complement is taken over the classes the structure HAS, so no saved
 * set and no spoken sentence names a class the panel can draw nothing for.
 *
 * @param {{classes?:string[],structure?:string}} [contents] the classes this
 *   model has, and what to call it in a refusal
 */
export function resolveVisibility(current, patch, available = [], contents = undefined) {
  const state = normalizeVisibility(current);
  const op = patch?.op;
  if (!VISIBILITY_OPS.includes(op)) throw Error(`A visibility change is one of ${VISIBILITY_OPS.join(', ')}.`);
  if (op === 'reset') return emptyVisibility();
  const chains = (patch.chains ?? []).map(raw => chainReferent(raw, available));
  let classes = patch.classes ?? [];
  const availableKeys = available.map(chainIdentityKey);
  const known = new Set(availableKeys);
  const unknown = chains.filter(chain => !known.has(chainIdentityKey(chain)));
  if (unknown.length) {
    const listed = available.length
      ? available.map(chain => `${chain.labelChain} (copy ${chain.copyId})`).join(', ')
      : 'none';
    throw Error(`This model has no chain ${unknown[0].labelChain} with copy id ${unknown[0].copyId}. `
      + `Read get_inspection_state with residues and use one of: ${listed}.`);
  }
  for (const name of classes)
    if (!VISIBILITY_COMPONENT_CLASSES.includes(name))
      throw Error(`A component class is one of ${VISIBILITY_COMPONENT_CLASSES.join(', ')}.`);
  const selection = patch.selection === true;
  // A class this structure has none of. Refuse when that is the whole request,
  // and otherwise drop it: what is left is a hidden set the panel can draw, and
  // the caller still has `absentVisibilityClasses` to say what was not there.
  const absent = absentVisibilityClasses(classes, contents?.classes);
  const allAbsent = absent.length > 0 && absent.length === classes.length;
  if (op === 'only') {
    if (selection) return normalizeVisibility({ hiddenChains: [], hiddenClasses: [], showOnlySelection: true });
    if (!chains.length && !classes.length) throw Error('Name a chain or a component class to show only.');
    // `only` names what to KEEP, so an absent class is not the part
    // of a request that can be dropped — it is the part that decides what the
    // complement hides. On one device session "show only the ligand" on 1CRN, which is
    // crambin and holds no ligand, hid water, ion and polymer: an empty panel
    // under an `Applied` receipt, from the one request a wearer makes in order
    // to SEE something. Every named class absent is refused however the request
    // is written. A chain named beside those classes changes nothing, because
    // the intersection of that chain and a class this file has none of is empty
    // as well. Some present and some absent keeps the present ones.
    if (allAbsent) throw Error(absentClassRefusal(absent, op, contents?.structure));
    const kept = classes.filter(name => !absent.includes(name));
    const keep = new Set(chains.map(chainIdentityKey));
    // The complement is taken over the classes this structure HAS, so the set a
    // scene saves never names one the panel can take nothing off the screen
    // for — the rule hide and show have followed since then. On 4HHB, which
    // holds no monatomic ion, "only the ligand" hides the water and the polymer,
    // and `describeVisibility` says those two rather than naming ions as well.
    const hideable = Array.isArray(contents?.classes)
      ? VISIBILITY_COMPONENT_CLASSES.filter(name => contents.classes.includes(name))
      : VISIBILITY_COMPONENT_CLASSES;
    return normalizeVisibility({
      hiddenChains: chains.length ? available.filter(chain => !keep.has(chainIdentityKey(chain))) : [],
      hiddenClasses: kept.length ? hideable.filter(name => !kept.includes(name)) : [],
      showOnlySelection: false,
    });
  }
  if (!chains.length && !classes.length && !selection)
    throw Error(`Name a chain, a component class${op === 'show' ? ' or the selection' : ''} to ${op}.`);
  if (op === 'hide' && selection) throw Error('Use op="only" with selection=true to show only the selection.');
  if (absent.length) {
    if (allAbsent && !chains.length && !selection)
      throw Error(absentClassRefusal(absent, op, contents?.structure));
    classes = classes.filter(name => !absent.includes(name));
  }
  const held = new Set(state.hiddenChains.map(chainIdentityKey));
  const named = new Set(chains.map(chainIdentityKey));
  const heldClasses = new Set(state.hiddenClasses);
  if (op === 'hide') {
    for (const key of named) held.add(key);
    for (const name of classes) heldClasses.add(name);
  } else {
    for (const key of named) held.delete(key);
    for (const name of classes) heldClasses.delete(name);
  }
  const byKey = new Map([...available, ...state.hiddenChains].map(chain => [chainIdentityKey(chain), chain]));
  for (const chain of chains) byKey.set(chainIdentityKey(chain), chain);
  return normalizeVisibility({
    hiddenChains: [...held].map(key => byKey.get(key)).filter(Boolean),
    hiddenClasses: [...heldClasses],
    // A `show` naming the selection is the only way back out of show-only-selection
    // that keeps the rest of the hidden set; `reset` drops everything.
    showOnlySelection: op === 'show' && selection ? false : state.showOnlySelection,
  });
}

/**
 * Which spoken class a catalog row belongs to.
 *
 * This is the page's half of the wire: the host carries class NAMES and never
 * expands one, so only the renderer has to know that a magnesium is an ion.
 */
export function componentClassOf(row) {
  const type = row?.entityType;
  if (type === 'water') return 'water';
  if (type === 'polymer') return 'polymer';
  if (type === 'non-polymer' || type === 'branched')
    return ION_COMPONENT_IDS.has(String(row?.identity?.componentId ?? '').toUpperCase()) ? 'ion' : 'ligand';
  return undefined;
}

/**
 * The component classes this loaded model actually has.
 *
 * `componentClassOf` is the page's rule for what one row is; this is that rule
 * asked of a whole model, and it answers in class NAMES and never in rows. So
 * the host can tell a wearer their structure has no water without the host ever
 * having to learn that a magnesium is an ion, and the two ends still cannot
 * disagree about which rows a hidden class stands for.
 */
export function componentClassesPresent(rows, modelNumber) {
  const present = new Set();
  for (const row of rows ?? []) {
    if (modelNumber !== undefined && row?.identity?.modelNumber !== modelNumber) continue;
    const name = componentClassOf(row);
    if (name) present.add(name);
  }
  return VISIBILITY_COMPONENT_CLASSES.filter(name => present.has(name));
}

/**
 * Which of the classes a request named this structure has none of.
 *
 * `present` not being a list means nobody worked out what the structure holds,
 * and then nothing is absent. An unknown is not an absence: a caller that
 * cannot answer the question must not manufacture a refusal out of not knowing.
 */
export function absentVisibilityClasses(classes, present) {
  if (!Array.isArray(present)) return [];
  const has = new Set(present);
  const named = new Set(Array.isArray(classes) ? classes : []);
  return VISIBILITY_COMPONENT_CLASSES.filter(name => named.has(name) && !has.has(name));
}

/** "water", "water or ions". An absence is said with `or`, never with `and`. */
function absentNouns(absent) {
  const nouns = absent.map(name => CLASS_NOUN[name]);
  if (nouns.length <= 1) return nouns.join('');
  return `${nouns.slice(0, -1).join(', ')} or ${nouns[nouns.length - 1]}`;
}

/**
 * How each op is said in a refusal. Two of the three are already their own
 * verb; `only` is not, because "to only" is not a sentence and the wearer asked
 * to show one thing and nothing else.
 */
const CLASS_REFUSAL_VERB = Object.freeze({ hide: 'hide', show: 'show', only: 'show only' });

/** "1CRN has no water to hide." The request named nothing this model holds. */
export function absentClassRefusal(absent, op, structure) {
  return `${structure || 'This structure'} has no ${absentNouns(absent)} to ${CLASS_REFUSAL_VERB[op] ?? op}.`;
}

/** "1CRN has no water." Said beside what a part-answerable request did change. */
export function absentClassNote(absent, structure) {
  return `${structure || 'This structure'} has no ${absentNouns(absent)}.`;
}

/** The chain identities of one model, in catalog order and without repeats. */
export function availableChains(rows, modelNumber) {
  const seen = new Set(); const chains = [];
  for (const row of rows ?? []) {
    const identity = row?.identity;
    if (!identity || (modelNumber !== undefined && identity.modelNumber !== modelNumber)) continue;
    const chain = { labelChain: identity.labelChain, copyId: identity.copyId };
    const key = chainIdentityKey(chain);
    if (seen.has(key)) continue;
    seen.add(key); chains.push(chain);
  }
  return chains;
}

/**
 * Every row this visibility takes off the screen.
 *
 * A row is hidden if its chain is hidden, or its class is hidden, or the scene
 * is showing only the selection and this row is not in it. The union is what
 * makes `only` a single state rather than a mode: the complement it computes is
 * an ordinary hidden set, so undo restores it like any other.
 */
export function hiddenRowKeys(rows, visibility, selectionKeys = []) {
  const state = normalizeVisibility(visibility);
  if (!state.hiddenChains.length && !state.hiddenClasses.length && !state.showOnlySelection) return [];
  const chains = new Set(state.hiddenChains.map(chainIdentityKey));
  const classes = new Set(state.hiddenClasses);
  const selected = state.showOnlySelection ? new Set(selectionKeys) : undefined;
  const keys = [];
  for (const row of rows ?? []) {
    const identity = row?.identity ?? {};
    const hidden = chains.has(chainIdentityKey({ labelChain: identity.labelChain, copyId: identity.copyId }))
      || classes.has(componentClassOf(row))
      || (selected !== undefined && !selected.has(row.key));
    if (hidden) keys.push(row.key);
  }
  return keys;
}

/** Whether a row survives this visibility. The inverse of `hiddenRowKeys`. */
export function visibleRowKeys(rows, visibility, selectionKeys = []) {
  const hidden = new Set(hiddenRowKeys(rows, visibility, selectionKeys));
  return (rows ?? []).map(row => row.key).filter(key => !hidden.has(key));
}

/**
 * Whether a hidden set takes every row of a model off the screen.
 *
 * `resolveVisibility` refuses the named absence — "1CRN has no ligands to show
 * only." — and this is the same question asked of the picture rather than of
 * the words, for the empty scene no class name announces. "Only the ligands of
 * chain C" on an assembly whose chain C holds no ligand names a chain this
 * model has and a class this model has, and their intersection is still
 * nothing: a blank panel and a receipt saying the change was applied.
 *
 * It reads the hidden chains and classes alone. `showOnlySelection` over an
 * empty selection also draws nothing, and that is a state the wearer switched
 * on and can switch off, not a request that misread the structure.
 *
 * @param {object[]} rows the catalog rows of the loaded structure
 * @param {number} [modelNumber] only these rows count, as elsewhere in this file
 */
export function visibilityHidesEverything(rows, visibility, modelNumber) {
  const state = normalizeVisibility(visibility);
  if (!state.hiddenChains.length && !state.hiddenClasses.length) return false;
  const inModel = (rows ?? []).filter(row =>
    modelNumber === undefined || row?.identity?.modelNumber === modelNumber);
  if (!inModel.length) return false;
  const hidden = new Set(hiddenRowKeys(inModel, { ...state, showOnlySelection: false }));
  return inModel.every(row => hidden.has(row.key));
}

const CLASS_NOUNS = Object.freeze({ water: 'the water', ligand: 'the ligands', ion: 'the ions', polymer: 'the polymer' });
/** The same nouns without the article, for a sentence that says there are none. */
const CLASS_NOUN = Object.freeze({ water: 'water', ligand: 'ligands', ion: 'ions', polymer: 'polymer' });

/**
 * The plain-language line for what is hidden, which both ends say.
 *
 * The model reads this off the tool result so it can tell the wearer "Hidden
 * chain B (copy 1)" rather than reciting a copy id no human said out loud.
 */
export function describeVisibility(visibility, available) {
  const state = normalizeVisibility(visibility);
  if (!state.hiddenChains.length && !state.hiddenClasses.length && !state.showOnlySelection) return 'Everything is showing.';
  if (state.showOnlySelection && !state.hiddenChains.length && !state.hiddenClasses.length) return 'Showing only the selection.';
  const named = [...state.hiddenChains.map(chain => chainIdentityLabel(chain, available)),
    ...state.hiddenClasses.map(name => CLASS_NOUNS[name])];
  const listed = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return `Hidden ${listed}.${state.showOnlySelection ? ' Showing only the selection.' : ''}`;
}
