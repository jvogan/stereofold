/**
 * The pure half of a lesson chapter's emphasis.
 *
 * A taught chapter says "here is the guide RNA" and has to make the guide RNA
 * look like the guide RNA. Appearance in this viewer is whole-structure by
 * construction, so before this the only honest answer was a global recolour and
 * the wearer was left to find the named part themselves.
 *
 * Two decisions make the emphasis, and both of them are arithmetic over row
 * keys rather than anything Mol* has to be running for, so they live here where
 * they can be tested directly:
 *
 * - which rows get which colour, from the lesson's colour key; and
 * - which rows fade, which is every row the focused parts do not claim.
 *
 * Fading rather than hiding is the point. An isolated part with nothing around
 * it cannot be placed back in the complex it came from, so the context stays on
 * screen at a low opacity and the emphasised part is the only opaque thing.
 * A chapter with no focus fades nothing: that is the whole colour key at full
 * strength, which is what an opening or a recap chapter wants.
 */
import { applyWallStrandShades } from './strand-shade.mjs';

/**
 * Faint, but still legible against the background.
 *
 * Raised from 0.12 after Quest 2 wearer-view captures. Twelve per cent
 * survives a crop on a monitor; through the headset, against a lit room in
 * passthrough, the rest is so faint it reads as an empty room and the isolated
 * part has nothing to be isolated FROM. Eighteen keeps the complex's outline
 * findable while the emphasised part is still the only solid thing in the
 * room.
 */
export const DEFAULT_CONTEXT_OPACITY = 0.18;

/**
 * The floor the ghost may not fall below while passthrough is on.
 *
 * Eighteen per cent was measured against a LIT WALL: a bright, even, mid-grey
 * background, where a grey ghost at 0.18 still carries an outline. Over a dark
 * desk the same ghost is gone — it reads as visual noise rather than the rest
 * of the wall, because a 0.18 grey over a near-black room is within a few
 * counts of the room itself.
 *
 * A passthrough session cannot know what the room looks like, so the rule is
 * the worst case rather than a measurement: while the frame is composited over
 * a camera feed, the ghost is raised to this floor. An opaque (plain VR)
 * session draws over the lesson's own dark background, which is the case 0.18
 * was chosen for, and keeps whatever the chapter authored.
 *
 * It is a FLOOR, never a cap: a chapter that authored a stronger ghost keeps
 * it, and the colour rule still does the ranking, because one coloured subject
 * over a grey ghost has one subject at any ghost strength.
 */
export const PASSTHROUGH_CONTEXT_OPACITY_FLOOR = 0.35;

/** The blend modes that mean "the wearer's room is behind this frame". */
const PASSTHROUGH_BLEND_MODES = new Set(['alpha-blend', 'additive']);

/**
 * The ghost strength to actually paint, given what the session composites over.
 *
 * Stated here, once, so the lesson path, an agent's `emphasize` and a rebuild
 * that repaints the live key all reach the same number.
 *
 * @param contextOpacity the opacity the chapter or the caller authored
 * @param blendMode      `XRSession.environmentBlendMode`, or null off-headset
 */
export function contextOpacityForBlendMode(contextOpacity = DEFAULT_CONTEXT_OPACITY, blendMode = null) {
  const authored = Number.isFinite(contextOpacity) ? Math.min(1, Math.max(0, contextOpacity)) : DEFAULT_CONTEXT_OPACITY;
  return PASSTHROUGH_BLEND_MODES.has(blendMode) ? Math.max(authored, PASSTHROUGH_CONTEXT_OPACITY_FLOOR) : authored;
}

/**
 * The elevation a LESSON chapter frames at, in degrees.
 *
 * `focus-placement.mjs` lifts a focused target eight degrees above the horizon,
 * which suits a one-off "bring that into view" and does not suit a lesson the
 * wearer sits through. Measured on the nine hardware captures, every chapter's
 * subject sat 12 to 19 per cent of the lens height above the lens centre while
 * the menu, seated from the same head pose, sat level; chapters 2 and 6 lost the
 * top of the guide RNA off the frame edge. A lesson frames level, so the subject
 * lands on the wearer's own convergence centre.
 */
export const LESSON_ELEVATION_DEGREES = 0;

/**
 * The smallest share of the structure a lesson may frame.
 *
 * A framing is solved from the framed region's radius, so framing a very small
 * region scales the whole structure up around it. The first emulator capture of
 * chapter 6 framed two single alanines — 16 A inside an 89 A complex — and put
 * the wearer half a metre inside the molecule, looking at every colour of the
 * key at once. This fraction is the floor that keeps the complex clear of the
 * wearer. It bounds the lesson path only; an agent asked to zoom to the PAM
 * still gets the tight framing focus was built for.
 *
 * Raised from 0.5 to 0.68, together with moving the lesson's
 * chapters from the `context` framing (30 degrees) to `fill` (60 degrees).
 * Only the ratio of the two matters, because the solver puts the framed sphere
 * at `tan(angle/2) = radius/distance`: the whole structure ends up at
 * `radius/distance = tan(angle/2) / fraction`, which was 0.54 and is now 0.85.
 * That is the same "wearer stays outside the complex" guarantee at a framing
 * 1.6x closer, which is what the wearer view needs — the
 * emphasised part was 16 to 33 per cent of a Quest 2's field and had to reach
 * 40 to 60. Going further would put the bounding sphere over the wearer, and
 * that is the failure this constant exists to prevent.
 */
export const LESSON_MIN_TARGET_FRACTION = 0.68;

/**
 * The share of the focus distance the whole structure may fill.
 *
 * Documented rather than used directly: it is the number the fraction above is
 * derived from, and the one to change if the complex crowds the wearer. `LESSON_MIN_TARGET_FRACTION = tan(framing/2) / this`.
 */
export const LESSON_MAX_ENCLOSURE = 0.85;

/**
 * The share of a structure's rows a focus may cover before it is the whole
 * structure.
 *
 * A chapter that lights every chain of its tier — "the whole wall" — leaves
 * only the ligand and water rows out, so its bounding sphere IS the structure's
 * own. Framing it by selecting every row and solving that sphere again costs
 * thousands of row keys through the selection for an answer already to hand.
 */
export const WHOLE_STRUCTURE_ROW_SHARE = 0.9;

const focusList = (focus) => focus == null ? [] : (Array.isArray(focus) ? focus : [focus]);

/**
 * The colour key as the fewest Mol* overpaint layers that draw
 * exactly the same picture.
 *
 * One authored part was one overpaint layer, so the wall tier's fourteen named
 * chains asked Mol* for fourteen layers over a 40,908-atom representation, and
 * every one of them carries its own bundle-to-loci conversion and its own pass
 * over the overpaint buffer. The picture those fourteen layers draw has only
 * TWO colours in it — alpha blue and beta amber — because a lesson teaches a
 * key, not a palette.
 *
 * The merge is exact rather than approximate. A later part paints over an
 * earlier one, so the colour a row ends up wearing is the colour of the LAST
 * part that claims it; group the rows by that colour and the groups are
 * disjoint, which makes layer order irrelevant and lets one layer carry every
 * row of one colour. A key that lists the PAM after the strand containing it
 * still comes out with the PAM in its own colour, because the PAM's rows were
 * claimed last.
 *
 * @param colours `planLessonEmphasis().colours` — [{ id, color, keys }]
 * @returns one `{ color, keys }` per distinct colour, keys disjoint
 */
export function mergeEmphasisColourLayers(colours = []) {
  const winner = new Map();
  for (const part of colours) for (const key of part.keys) winner.set(key, part.color);
  const byColour = new Map();
  for (const [key, color] of winner) {
    const kept = byColour.get(color);
    if (kept) kept.push(key); else byColour.set(color, [key]);
  }
  return [...byColour].map(([color, keys]) => ({ color, keys }));
}

/**
 * The emphasis as a value, so it can be saved and read.
 *
 * Until this, emphasis was a rendering layer and nothing else: the chapter that
 * painted it was the only record that it existed. A wearer who left the lesson
 * and came back, a desktop panel reading the same saved scene, and an agent
 * asked "what is he looking at" all saw a plain structure, because the saved
 * scene described appearance, placement, selection and camera and had no word
 * for the colour key in front of the wearer's eyes.
 *
 * This is that word. It is the request, canonicalised — the key, the focused
 * ids, the context opacity — and never the resolved row keys, which belong to
 * one loaded structure and would put thousands of strings on the wire. Framing
 * is deliberately absent: a framing is something a chapter does once, not a
 * property of the emphasis a scene is wearing.
 */
export function normalizeEmphasisState({ parts = [], focus, contextOpacity = DEFAULT_CONTEXT_OPACITY, strandShades = false } = {}) {
  const ids = new Set(parts.map(part => part.id));
  const wanted = focusList(focus).filter(id => ids.has(id));
  return {
    parts: parts.map(part => ({
      id: part.id,
      label: part.label ?? part.id,
      color: part.color,
      ...(Array.isArray(part.aliases) ? { aliases: [...part.aliases] } : {}),
      ...(part.chain === undefined ? {} : { chain: part.chain }),
      ...(part.residues === undefined ? {} : { residues: { from: part.residues.from, to: part.residues.to } }),
    })),
    focus: wanted,
    contextOpacity: Math.min(1, Math.max(0, contextOpacity)),
    // The wall tier's whole-structure chapters shade one
    // lightness step per protofilament, so the flag travels with the key.
    ...(strandShades === true ? { strandShades: true } : {}),
  };
}

/** Nothing emphasised: the plain structure, and what an empty request saves. */
export const NO_EMPHASIS = Object.freeze({ parts: [], focus: [], contextOpacity: DEFAULT_CONTEXT_OPACITY });

/**
 * The colour key the wearer has learned, which outlives the layers that drew
 * it.
 *
 * The live emphasis is a picture, and a takeover repaints that picture plain.
 * That is right for the molecule and wrong for the words: the names a lesson
 * taught are the wearer's vocabulary for the rest of the session, and until now
 * they lived only in the layers. So a wearer who reached the ninth CRISPR
 * chapter, grabbed the structure, and then said "show me the guide RNA" was
 * told it was not a command — the nouns had been deleted with the paint.
 *
 * This is the key kept as a memory instead. An empty emphasis never overwrites
 * it, because clearing is what a takeover, a stop and the end of a tour all do;
 * only a new structure drops it, because a different molecule is a different
 * lesson with different names. `parts` prefers whatever is painted right now
 * and falls back to the memory, so nothing changes while a chapter is running.
 */
export function createLessonKeyMemory() {
  let remembered = NO_EMPHASIS;
  const copy = () => remembered.parts.map(part => ({ ...part,
    ...(part.aliases ? { aliases: [...part.aliases] } : {}),
    ...(part.residues === undefined ? {} : { residues: { ...part.residues } }) }));
  return {
    /** Internal source rollback; preserve the learned key independently of live paint. */
    checkpoint: () => structuredClone(remembered),
    restoreCheckpoint(value) { remembered = structuredClone(value); },
    /** Keep this emphasis if it names anything; an empty one is not a key. */
    remember(state) { if (state?.parts?.length) remembered = normalizeEmphasisState(state); },
    /** A new source: the previous lesson's names mean nothing on it. */
    forget() { remembered = NO_EMPHASIS; },
    /** The live key when something is painted, the remembered one otherwise. */
    parts(live) { return live?.parts?.length ? live.parts : copy(); },
    /** The context opacity belonging to whichever key `parts` just returned. */
    contextOpacity(live) { return live?.parts?.length ? live.contextOpacity : remembered.contextOpacity; },
  };
}

const spokenKey = (value) => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');
const COPY_NUMBERS = new Map([['first', 1], ['one', 1], ['1', 1],
  ['second', 2], ['two', 2], ['2', 2]]);

// These abbreviations name a complete part, never an arbitrary label word.
const NAMED_ALIASES = new Map([
  ['telomerase rna h aca domain', ['telomerase rna', 'rna', 'h/aca']],
  ['cas9 protein', ['cas9', 'protein']],
  ['single guide rna', ['guide rna', 'rna']],
  ['guide rna', ['rna']],
  ['alpha tubulin', ['alpha']],
  ['beta tubulin', ['beta']],
]);
const GENERIC_ALIASES = new Set('domain copy first second one two above below chain strand middle new the'.split(' '));
const copyName = label => spokenKey(label).replace(/\b(?:first|second) copy\b/g, '')
  .trim().replace(/^(?:first|second) /, '').trim();
const copyNumber = part => COPY_NUMBERS.get(spokenKey(part.label)
  .match(/^(first|second) |\b(first|second) copy\b/)?.slice(1).find(Boolean));

/** Full names, copy bases, parenthesized identifiers, and authored aliases. */
export function partAliases(part) {
  const base = copyName(part.label);
  const withoutIdentifier = copyName(String(part.label ?? '').replace(/\([^)]*\)/g, ''));
  const identifiers = [...String(part.label ?? '').matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
  return new Set([part.id, part.label, base, withoutIdentifier, ...identifiers,
    ...(Array.isArray(part.aliases) ? part.aliases : []), ...(NAMED_ALIASES.get(base) ?? [])]
    .map(spokenKey).filter(alias => alias && !GENERIC_ALIASES.has(alias)));
}

/** Human names group copies before an exact label can claim the first copy. */
export function resolveEmphasisPartIds(parts = [], name) {
  const wanted = spokenKey(name);
  if (!wanted || GENERIC_ALIASES.has(wanted)) return [];
  const named = parts.filter(part => partAliases(part).has(wanted));
  // EB3 is both the first id and the shared name. Human-name callers mean
  // both copies; singular id callers below retain precise machine addressing.
  if (named.length > 1 && named.some(part => copyNumber(part) !== undefined))
    return named.map(part => part.id);
  const exact = parts.filter(part => spokenKey(part.id) === wanted || spokenKey(part.label) === wanted);
  if (exact.length) return exact.map(part => part.id);
  // An authored alias is the lesson's own word for a part and wins whole, even
  // when it happens to end in a number: "alpha one" is hemoglobin's alias for
  // alpha-1, not "the first copy of something called alpha". The ordinal
  // parse below is only for names no part claims.
  if (named.length) return named.map(part => part.id);
  const ordinal = wanted.match(/^(first|second|one|two|1|2) (.+)$|^(.+?) (?:copy )?(first|second|one|two|1|2)$/);
  if (!ordinal) return named.map(part => part.id);
  const copy = COPY_NUMBERS.get(ordinal[1] ?? ordinal[4]);
  const noun = ordinal[2] ?? ordinal[3];
  const candidates = parts.filter(part => partAliases(part).has(noun));
  const hasCopies = candidates.some(part => copyNumber(part) !== undefined);
  return candidates.filter(part => (copyNumber(part) ?? (hasCopies ? 1 : undefined)) === copy)
    .map(part => part.id);
}

/**
 * Which named part someone meant, by its id or by the label a lesson shows.
 *
 * "Show me the guide RNA" and `emphasize {"parts":["guide RNA"]}` both arrive as
 * a human name rather than an id, from a wearer who is reading the colour key
 * and from an agent who read it out of `get_inspection_state`. Matching is over
 * letters and digits only, so "guide-rna", "Guide RNA" and "guide rna" are one
 * name, and an unmatched name stays unmatched rather than guessing a part.
 */
export function resolveEmphasisPartId(parts, name) {
  const exactId = (parts ?? []).find(part => part.id === name);
  if (exactId) return exactId.id;
  const ids = resolveEmphasisPartIds(parts ?? [], name);
  // Singular callers must never silently choose one of several copies.
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * Which named part covers the rows someone asked to be shown.
 *
 * "Show me chain B" while a chapter has faded everything but the nuclease
 * domains frames a part the fade is hiding, so the request has to be answered
 * inside the colour key rather than against it. This is the matcher for that:
 * the smallest part of the key whose rows contain every requested row, so a
 * sub-range (the PAM) wins over the chain that contains it. No part contains
 * the request — the wearer asked for something the lesson does not name — and
 * the answer is `undefined`, which the caller reads as "lift the whole fade".
 *
 * @param parts       the live emphasis state's parts
 * @param resolveKeys ({chain, residues:[first,last]}) => row keys, or undefined
 * @param keys        the row keys the wearer or agent asked to see
 */
export function emphasisFocusForKeys(parts, resolveKeys, keys) {
  const wanted = new Set(keys ?? []);
  if (!wanted.size || !(parts ?? []).length) return undefined;
  let best;
  for (const part of parts) {
    const rows = resolveKeys({
      chain: part.chain,
      residues: part.residues ? [part.residues.from, part.residues.to] : undefined,
    }) ?? [];
    if (!rows.length) continue;
    const covered = new Set(rows);
    let holds = true;
    for (const key of wanted) if (!covered.has(key)) { holds = false; break; }
    if (holds && (!best || rows.length < best.size)) best = { id: part.id, size: rows.length };
  }
  return best?.id;
}

/**
 * @param chapter    the chapter's `immersive.emphasis` block
 * @param resolveKeys ({chain, residues:[first,last]}) => row keys, or undefined
 * @param rowKeys    every selectable row key in the loaded structure
 */
export function planLessonEmphasis(chapter, resolveKeys, rowKeys = []) {
  const { parts: authored = [], focus, contextOpacity = DEFAULT_CONTEXT_OPACITY, strandShades = false } = chapter ?? {};
  // A whole-structure wall chapter steps one lightness per
  // protofilament at plan time, so the JSON keeps the base colours verbatim.
  const parts = applyWallStrandShades(authored, strandShades === true);
  // One part that does not resolve costs that part, and nothing
  // else.
  //
  // `resolveKeys` THROWS on a chain the loaded structure does not carry, and
  // this used to call it inside a `map`, so a single mistyped chain id threw
  // the WHOLE chapter's emphasis away. What the wearer then saw was not an
  // error: it was the previous chapter's paint, or a structure at full uniform
  // colour, which reads exactly like "everything is the subject". The operator
  // subsets are where this bites — their author chains are suffixed (A-2 .. B-7
  // for the wall tier), so a key written against the deposited ids resolves
  // nothing at all.
  //
  // So each part is resolved on its own, a failure is recorded by name, and the
  // caller gets a list it can put on the headset log.
  const unresolved = [];
  const resolved = [];
  for (const part of parts) {
    let keys;
    try {
      keys = resolveKeys({
        chain: part.chain,
        residues: part.residues ? [part.residues.from, part.residues.to] : undefined,
      }) ?? [];
    } catch (error) {
      unresolved.push({ id: part.id, chain: part.chain,
        reason: String(error?.message ?? error).slice(0, 120) });
      continue;
    }
    // A chain that answers with NO rows is not a resolved part.
    //
    // `resolveKeys` throws on a chain the structure does not carry and returns
    // an empty list for one it carries with nothing selectable in the requested
    // residue range — a ligand range written one residue off, a chain whose
    // rows are all waters. Counting that as resolved is what made a total
    // blackout reachable: the focus below then had a "resolved" part, so the
    // tier fallback did not fire, `lit` stayed empty and EVERY row of the
    // structure was faded to the ghost. Treated as missing, it is named on the
    // headset log and the chapter falls back to lighting the tier.
    if (!keys.length) { unresolved.push({ id: part.id, chain: part.chain, reason: 'No selectable row in this structure.' }); continue; }
    resolved.push({ id: part.id, color: part.color, keys });
  }

  const wanted = focusList(focus);
  // Checked against the AUTHORED parts, not the resolved ones: a focus naming a
  // part the key does not list is an authoring mistake and still fails loudly,
  // while a focus naming a part that merely failed to resolve is a data problem
  // on the structure and is handled by the fallback below.
  for (const id of wanted) {
    if (!parts.some(part => part.id === id)) {
      throw Error(`This chapter emphasises "${id}", which its colour key does not name.`);
    }
  }

  const focusedResolved = resolved.filter(part => wanted.includes(part.id));
  // Nothing the chapter meant to light survived, so light the
  // tier instead of lighting nothing — and say so. The wearer gets the whole
  // colour key at full strength, which is a recap frame rather than a lie, and
  // `unresolved` names every part that went missing.
  const fallback = wanted.length > 0 && focusedResolved.length === 0 ? 'tier' : undefined;
  const focused = fallback ? [] : focusedResolved;
  // A later part paints over an earlier one, so a lesson may list a sub-range
  // after the chain that contains it and the sub-range keeps its own colour.
  //
  // A chapter with a focus paints the KEY COLOURS ONLY ON THE
  // PART IT IS ABOUT. Everything else keeps the structure's own uniform colour
  // and is carried by the fade alone.
  //
  // Wearer-view captures are why. Recaps 7, 8 and 9 fade correctly —
  // one focus, everything else at the authored 35 per cent — and still read as
  // a flat wall with no hierarchy. Measured saturation says exactly why: the
  // guide RNA's #ff8a1f at
  // 35 per cent came through at 0.51, while the REC lobe's #5f35c4 at FULL
  // opacity came through at 0.42. A saturated context colour at a third of its
  // opacity outweighs a pale subject at all of it, so opacity alone cannot rank
  // them. Colour can: one coloured thing over a grey ghost has one subject at
  // any context opacity, which is what lets a recap keep its 35 per cent ghost.
  //
  // A chapter with no focus — the opening — still paints the whole key, because
  // that chapter IS the key.
  const colours = (focused.length > 0 ? focused : resolved).filter(part => part.keys.length > 0 && part.color);
  const lit = new Set(focused.flatMap(part => part.keys));
  const wouldFade = focused.length > 0 ? rowKeys.filter(key => !lit.has(key)) : [];
  // NO plan fades the whole structure.
  //
  // A fade with nothing lit behind it is not an emphasis, it is a blackout: in
  // passthrough over a dark room a structure at the ghost opacity is the room.
  // The rule is stated on the plan rather than trusted to the callers, because
  // three different paths build one of these (a chapter, an agent's emphasize,
  // a rebuild's repaint) and a wearer left looking at nothing cannot tell which
  // of them did it. Belt and braces over the empty-part rule above: whatever
  // the reason the lit set came out empty, the ghost does not go on.
  const faded = lit.size > 0 ? wouldFade : [];

  return {
    colours,
    /**
     * The parts this chapter is EXPLAINING, resolved, whether or
     * not they carry a colour of their own.
     *
     * `colours` is the paint list, so it drops a part with no colour — and an
     * agent's `emphasize` names parts by chain and authors no colours at all.
     * That took every name plate off the molecule, including the
     * plate for the very part the wearer had just asked about. The plate for
     * the part being explained is not paint; it is the answer to the question,
     * and it survives that filter.
     */
    explained: focused.filter(part => part.keys.length > 0),
    lit: [...lit],
    faded,
    /** Mol* transparency runs the other way from opacity. */
    transparency: Math.min(1, Math.max(0, 1 - contextOpacity)),
    /** The parts whose chains this structure does not carry. */
    unresolved,
    /** `'tier'` when the focus resolved to nothing and the whole key was lit. */
    ...(fallback ? { fallback } : {}),
  };
}
