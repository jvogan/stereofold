import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planLessonEmphasis, normalizeEmphasisState, resolveEmphasisPartId, emphasisFocusForKeys, NO_EMPHASIS,
  DEFAULT_CONTEXT_OPACITY, LESSON_MIN_TARGET_FRACTION, createLessonKeyMemory,
  contextOpacityForBlendMode, PASSTHROUGH_CONTEXT_OPACITY_FLOOR,
  mergeEmphasisColourLayers } from './lesson-emphasis.mjs';

/** A stand-in structure: chain A residues 1-6, chain B residues 1-3. */
const ROWS = [
  ...Array.from({ length: 6 }, (_, i) => ({ key: `A:${i + 1}`, chain: 'A', residue: i + 1 })),
  ...Array.from({ length: 3 }, (_, i) => ({ key: `B:${i + 1}`, chain: 'B', residue: i + 1 })),
];
const ROW_KEYS = ROWS.map(row => row.key);

/** The same contract as the viewer's spokenSelectionKeys: a miss is named, not silent. */
const resolve = ({ chain, residues }) => {
  if (!chain && !residues) return undefined;
  const [first, last] = residues ?? [];
  const hit = ROWS.filter(row => (!chain || row.chain === chain)
    && (!residues || (row.residue >= first && row.residue <= last)));
  if (!hit.length) throw Error(`Nothing at ${chain ?? '?'} ${first}-${last} here.`);
  return hit.map(row => row.key);
};

const KEY = [
  { id: 'protein', label: 'Protein', color: '#9aa5b0', chain: 'A' },
  { id: 'site', label: 'Active site', color: '#ff3b30', chain: 'A', residues: { from: 2, to: 3 } },
  { id: 'rna', label: 'RNA', color: '#ff8a1f', chain: 'B' },
];

test('a focused part stays opaque and everything else fades, rather than disappearing', () => {
  const plan = planLessonEmphasis({ parts: KEY, focus: 'rna' }, resolve, ROW_KEYS);
  assert.deepEqual(plan.lit.sort(), ['B:1', 'B:2', 'B:3']);
  assert.deepEqual(plan.faded.sort(), ['A:1', 'A:2', 'A:3', 'A:4', 'A:5', 'A:6']);
  // Faded, not hidden: an isolated part with no surroundings cannot be placed
  // back in the complex it came from.
  assert.ok(plan.transparency < 1);
  assert.equal(plan.transparency, 1 - DEFAULT_CONTEXT_OPACITY);
});

// The whole key used to paint in every chapter. It no longer does, and Quest 2
// captures are why: a focused chapter's context came through as the full colour
// key at the authored opacity, and a saturated context colour at 35 per cent
// outweighed a pale subject at 100 (measured saturation 0.51 against 0.42).
// One coloured thing over a grey ghost
// is a hierarchy at any opacity; two coloured things are not.
test('a chapter with a focus paints its key colours on that part alone', () => {
  const plan = planLessonEmphasis({ parts: KEY, focus: 'rna' }, resolve, ROW_KEYS);
  assert.deepEqual(plan.colours.map(part => part.id), ['rna']);
});

// "The magenta target strand ... on the blue non-target strand": a caption may
// name a part beside its subject, and that part has to be findable in its
// colour. It is lit, not explained: the framing and the explained plate stay
// the focus's own, so the camera and the subject do not move.
test('a part lit beside the focus wears its key colour and does not fade', () => {
  const plan = planLessonEmphasis({ parts: KEY, focus: 'site', alsoLit: ['rna'] }, resolve, ROW_KEYS);
  assert.deepEqual(plan.colours.map(part => part.id), ['site', 'rna']);
  assert.deepEqual(plan.faded.sort(), ['A:1', 'A:4', 'A:5', 'A:6']);
  assert.deepEqual(plan.lit.sort(), ['A:2', 'A:3']);
  assert.deepEqual(plan.explained.map(part => part.id), ['site']);
});

test('parts lit beside the focus keep the key order, so a sub-range still paints over its chain', () => {
  // The closing recap recites the whole key while the nucleases stay the subject.
  const plan = planLessonEmphasis({ parts: KEY, focus: 'rna', alsoLit: ['site', 'protein'] }, resolve, ROW_KEYS);
  assert.deepEqual(plan.colours.map(part => part.id), ['protein', 'site', 'rna']);
  const layers = mergeEmphasisColourLayers(plan.colours);
  assert.equal(layers.find(layer => layer.keys.includes('A:2'))?.color, '#ff3b30');
  assert.deepEqual(plan.faded, []);
  assert.deepEqual(plan.explained.map(part => part.id), ['rna']);
});

test('lighting a part the colour key never listed is an authoring failure', () => {
  assert.throws(() => planLessonEmphasis({ parts: KEY, focus: 'site', alsoLit: ['ribosome'] }, resolve, ROW_KEYS),
    /ribosome/);
});

test('the opening chapter, which focuses nothing, still paints the whole key', () => {
  const plan = planLessonEmphasis({ parts: KEY }, resolve, ROW_KEYS);
  assert.deepEqual(plan.colours.map(part => part.id), ['protein', 'site', 'rna']);
  // A later part paints over an earlier one, so the active site keeps its own
  // colour inside the chain that contains it.
  assert.ok(plan.colours.findIndex(part => part.id === 'site')
    > plan.colours.findIndex(part => part.id === 'protein'));
  // And nothing is faded: an opening chapter is the key at full strength.
  assert.deepEqual(plan.faded, []);
});

test('a focus of several parts paints all of them, because RuvC is three stretches', () => {
  const plan = planLessonEmphasis({ parts: KEY, focus: ['protein', 'site'] }, resolve, ROW_KEYS);
  assert.deepEqual(plan.colours.map(part => part.id), ['protein', 'site']);
  assert.ok(plan.colours.findIndex(part => part.id === 'site')
    > plan.colours.findIndex(part => part.id === 'protein'));
});

test('several parts can be one focus, because RuvC is three stretches of one chain', () => {
  const plan = planLessonEmphasis({ parts: KEY, focus: ['site', 'rna'] }, resolve, ROW_KEYS);
  assert.deepEqual(plan.lit.sort(), ['A:2', 'A:3', 'B:1', 'B:2', 'B:3']);
  assert.deepEqual(plan.faded.sort(), ['A:1', 'A:4', 'A:5', 'A:6']);
});

test('a chapter with no focus fades nothing and shows the key at full strength', () => {
  const plan = planLessonEmphasis({ parts: KEY }, resolve, ROW_KEYS);
  assert.deepEqual(plan.faded, []);
  assert.equal(plan.colours.length, 3);
});

test('an empty emphasis clears back to the plain structure', () => {
  const plan = planLessonEmphasis({}, resolve, ROW_KEYS);
  assert.deepEqual(plan.colours, []);
  assert.deepEqual(plan.faded, []);
  assert.deepEqual(plan.lit, []);
});

test('a focus the colour key does not name is a named failure, not a blank scene', () => {
  assert.throws(() => planLessonEmphasis({ parts: KEY, focus: 'ligand' }, resolve, ROW_KEYS),
    /emphasises "ligand", which its colour key does not name/);
});

// The resolution once ran inside a `map`, so the throw
// below escaped `planLessonEmphasis` and took the chapter's WHOLE emphasis with
// it — and a chapter with no emphasis looks exactly like a chapter that means
// to light everything. These four fix the contract: a part that cannot resolve
// costs that part, is named, and never quietly lights the rest.
test('a part that names nothing in this structure is reported, not thrown', () => {
  const plan = planLessonEmphasis(
    { parts: [{ id: 'x', label: 'X', color: '#ffffff', chain: 'Z' }] }, resolve, ROW_KEYS);
  assert.deepEqual(plan.unresolved.map(part => ({ id: part.id, chain: part.chain })), [{ id: 'x', chain: 'Z' }]);
  assert.match(plan.unresolved[0].reason, /Nothing at Z/);
  assert.deepEqual(plan.colours, []);
  assert.deepEqual(plan.faded, []);
  assert.equal(plan.fallback, undefined);
});

test('one bad chain costs that part alone; the rest of the key still paints', () => {
  const key = [...KEY, { id: 'ghost-chain', label: 'Missing', color: '#ffffff', chain: 'Z' }];
  const plan = planLessonEmphasis({ parts: key, focus: 'rna' }, resolve, ROW_KEYS);
  assert.deepEqual(plan.unresolved.map(part => part.id), ['ghost-chain']);
  assert.deepEqual(plan.lit, ['B:1', 'B:2', 'B:3']);
  assert.deepEqual(plan.colours.map(part => part.id), ['rna']);
  assert.equal(plan.fallback, undefined);
});

test('a focus whose every part is missing lights the tier and says so', () => {
  const key = [...KEY, { id: 'ghost-chain', label: 'Missing', color: '#ffffff', chain: 'Z' }];
  const plan = planLessonEmphasis({ parts: key, focus: ['ghost-chain'] }, resolve, ROW_KEYS);
  // The whole key at full strength — a recap frame — rather than a structure
  // with nothing lit or, worse, the previous chapter's paint left standing.
  assert.equal(plan.fallback, 'tier');
  assert.deepEqual(plan.colours.map(part => part.id), ['protein', 'site', 'rna']);
  assert.deepEqual(plan.lit, []);
  assert.deepEqual(plan.faded, []);
  assert.deepEqual(plan.unresolved.map(part => part.id), ['ghost-chain']);
});

test('a focus naming a part the key never listed is still an authoring failure', () => {
  // Distinct from the case above: that one is a chain the structure lacks, this
  // one is a chapter pointing at a name its own key does not carry.
  assert.throws(() => planLessonEmphasis(
    { parts: [{ id: 'x', label: 'X', color: '#ffffff', chain: 'Z' }], focus: 'y' }, resolve, ROW_KEYS),
  /emphasises "y", which its colour key does not name/);
});

test('contextOpacity travels through as a transparency, the other way round', () => {
  assert.equal(planLessonEmphasis({ parts: KEY, focus: 'rna', contextOpacity: 0.35 }, resolve, ROW_KEYS)
    .transparency, 0.65);
  assert.equal(planLessonEmphasis({ parts: KEY, focus: 'rna', contextOpacity: 1 }, resolve, ROW_KEYS)
    .transparency, 0);
});

test('the viewer applies emphasis as layers over the representation, never as a rebuild', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  // A rebuild costs seconds on a Quest 2 and would drop the layers; these two
  // bundle transforms are additive and are reversed by deleting one ref each.
  assert.match(source, /OverpaintStructureRepresentation3DFromBundle/);
  assert.match(source, /TransparencyStructureRepresentation3DFromBundle[\s\S]{0,400}EMPHASIS_LAYER_REF/);
  assert.match(source, /planLessonEmphasis/);
  // Framing an emphasised part is a placement of the molecule, because the
  // wearer owns the camera in XR.
  assert.match(source, /focusSelection\(\{ selectionKeys: litKeys, framing/);
  // A chapter with a framing and no focus frames the whole
  // complex rather than declining to place it, which is how the opening
  // reference frame gets a size and a place of its own.
  // And it frames it at the enclosure the part chapters already
  // put the structure at, rather than at sixty degrees of it — which made the
  // one chapter whose subject is the whole tier the smallest thing the wearer
  // saw all lesson.
  assert.match(source, /focusSelection\(\{ framing, wholeStructure: true, enclosure: LESSON_MAX_ENCLOSURE,\n\s*elevationDegrees: LESSON_ELEVATION_DEGREES, liftEmphasis: false \}\)/);
  // And a lesson frames LEVEL. `focus-placement.mjs` lifts a focused target
  // eight degrees by default, which suits a one-off "bring that into view" and
  // put every chapter 12 to 19 per cent of a lens height above the wearer's own
  // centre.
  assert.match(source, /elevationDegrees: LESSON_ELEVATION_DEGREES/);
});

test('a lesson never frames tighter than the enclosure floor, so the wearer stays outside it', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  // Measured on the first emulator capture of chapter 6: its
  // focus was two single alanines, a 16 A sphere inside an 89 A complex, and
  // framing that at thirty degrees scaled the whole structure to a 1.8 m radius
  // at 1.2 m. The wearer was half a metre inside the molecule, looking at every
  // colour of the key at once. A floor under the framed radius is a ceiling on
  // that scale.
  assert.ok(LESSON_MIN_TARGET_FRACTION > 0 && LESSON_MIN_TARGET_FRACTION < 1);
  assert.match(source, /minTargetFraction: LESSON_MIN_TARGET_FRACTION/);
  assert.match(source, /Math\.max\(target\.radius, sphere\.radius \* minTargetFraction\)/);
  // Only the lesson path is bounded. An agent asked to zoom to the PAM still
  // gets the tight framing `focusSelection` was built for.
  assert.match(source, /focusSelection\(\{ selectionKeys, framing = 'context', minTargetFraction = 0, wholeStructure = false,/);
});

// The emphasis as a value the saved scene can carry.

test('the saved emphasis is the lesson’s own words, not the rows they resolve to', () => {
  const state = normalizeEmphasisState({ parts: KEY, focus: 'site' });
  assert.deepEqual(state, { parts: KEY, focus: ['site'], contextOpacity: DEFAULT_CONTEXT_OPACITY });
  // The colour key travels whole, so a part is lit inside the mapping the
  // wearer has learned rather than against a repaint of everything else.
  assert.deepEqual(state.parts.find(part => part.id === 'site'),
    { id: 'site', label: 'Active site', color: '#ff3b30', chain: 'A', residues: { from: 2, to: 3 } });
  // Row keys belong to one loaded structure and would put thousands of strings
  // on the wire; nothing here names one.
  assert.equal(JSON.stringify(state).includes('A:1'), false);
});

test('a focus the colour key does not name is dropped rather than saved', () => {
  assert.deepEqual(normalizeEmphasisState({ parts: KEY, focus: ['site', 'ribosome'] }).focus, ['site']);
  assert.deepEqual(normalizeEmphasisState({ parts: [], focus: 'site' }).focus, []);
  assert.deepEqual(normalizeEmphasisState().focus, []);
});

test('the saved emphasis keeps the parts lit beside its focus, and only real ones', () => {
  assert.deepEqual(normalizeEmphasisState({ parts: KEY, focus: 'site', alsoLit: ['rna', 'ribosome', 'site'] }).alsoLit,
    ['rna']);
  // A chapter that lights nothing beside its focus saves exactly what it saved before.
  assert.equal('alsoLit' in normalizeEmphasisState({ parts: KEY, focus: 'site' }), false);
  assert.equal('alsoLit' in normalizeEmphasisState({ parts: KEY, focus: 'site', alsoLit: [] }), false);
  // With no focus the whole key is lit already.
  assert.equal('alsoLit' in normalizeEmphasisState({ parts: KEY, alsoLit: ['rna'] }), false);
});

test('a part with no label of its own is saved under its id', () => {
  const [part] = normalizeEmphasisState({ parts: [{ id: 'pam', color: '#ffffff', chain: 'B' }] }).parts;
  assert.equal(part.label, 'pam');
});

test('context opacity is clamped, because a saved 2 would hide the complex', () => {
  assert.equal(normalizeEmphasisState({ parts: KEY, contextOpacity: 2 }).contextOpacity, 1);
  assert.equal(normalizeEmphasisState({ parts: KEY, contextOpacity: -1 }).contextOpacity, 0);
});

test('a part is found by the name a wearer or an agent says, not by exact spelling', () => {
  for (const spoken of ['Active site', 'active  site', 'ACTIVE-SITE', 'site']) {
    assert.equal(resolveEmphasisPartId(KEY, spoken), 'site', spoken);
  }
  assert.equal(resolveEmphasisPartId(KEY, 'the active site'), 'site');
  assert.equal(resolveEmphasisPartId(KEY, 'not the active site'), undefined);
  assert.equal(resolveEmphasisPartId(KEY, ''), undefined);
  assert.equal(resolveEmphasisPartId([], 'site'), undefined);
});

test('nothing emphasised is a value too, and it is the plain structure', () => {
  assert.deepEqual(planLessonEmphasis({ parts: NO_EMPHASIS.parts, focus: NO_EMPHASIS.focus }, resolve, ROW_KEYS),
    { colours: [], explained: [], lit: [], faded: [], transparency: 1 - DEFAULT_CONTEXT_OPACITY, unresolved: [] });
});

// "Show me chain B" during a chapter that has faded chain B.
// The request has to be answered inside the colour key the wearer has already
// learned, so the first question is which part of that key they just named.
test('the rows a wearer asks for are matched to the part of the key that covers them', () => {
  assert.equal(emphasisFocusForKeys(KEY, resolve, ['B:1', 'B:2']), 'rna');
  // The smallest part that covers the request wins, so a sub-range beats the
  // chain that contains it: A:2 is inside both the protein and the active site.
  assert.equal(emphasisFocusForKeys(KEY, resolve, ['A:2']), 'site');
  assert.equal(emphasisFocusForKeys(KEY, resolve, ['A:1']), 'protein');
});

test('rows no part of the key covers name no part at all', () => {
  // Half in the active site and half outside it is not the active site, and it
  // is not a part: the caller reads this as "lift the whole fade instead".
  assert.equal(emphasisFocusForKeys(KEY, resolve, ['A:3', 'A:6']), 'protein');
  assert.equal(emphasisFocusForKeys(KEY, resolve, ['A:1', 'B:1']), undefined);
  assert.equal(emphasisFocusForKeys(KEY, resolve, []), undefined);
  assert.equal(emphasisFocusForKeys([], resolve, ['A:1']), undefined);
  assert.equal(emphasisFocusForKeys(KEY, resolve, ['C:9']), undefined);
});

// The two viewer paths that need guarding, guarded at the source. Both live
// inside a running Mol* session, so the emulator is what proves they draw;
// these keep the shape of the fix from quietly going away.

// The takeover, the hydrate and the restore are exercised for real in
// `lesson-resting.test.mjs`, against the module all three of them decide
// through. What is left here is the one thing that cannot move into that
// module: the viewer must keep routing every caller into it, and must keep
// provenance out of the saved scene.
test('the viewer decides who owns the painted key in one place', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  // A key an agent or the wearer asked for by name is theirs: a tour stopping
  // is not an answer to that request, so the clear refuses rather than obeys.
  assert.match(source, /async function clearLessonEmphasis\(\)\s*\{\s*return lessonResting\.clear\(\);/);
  assert.match(source, /async function setLessonRestingState\(value, options\)[\s\S]{0,120}return lessonResting\.install\(value, options\);/);
  // A restored key carries its provenance, or the next hydrate's baseline
  // paint takes the scene the wearer just asked for straight back off. The
  // capture's own origin is the second argument because a reload restores in
  // the hydrate's `built` phase, before the baseline is installed in `placed`,
  // so the live baseline is not there yet to be compared against.
  assert.match(source, /const restoredOrigin = lessonResting\.noteRestoredKey\(emphasisState, restoredEmphasis\.origin\)/);
  // A validated lesson cursor preserves chapter ownership; ordinary restored
  // scenes keep the decision made by the resting-state owner.
  assert.match(source, /emphasisOrigin = next\.inspection\.lessonPlayback && restoredEmphasis\.origin === 'lesson'\s*\? 'lesson' : restoredOrigin \?\? emphasisOrigin/);
  // Provenance IS saved state, and only on the
  // saved scene. It is the one field a scene's emphasis has that a command's
  // may not, so no agent can claim a lesson's ownership of the molecule; read
  // `sceneEmphasisSchema`. It is still kept out of the normalized live key,
  // which is what every picture comparison is written against.
  assert.doesNotMatch(source, /normalizeEmphasisState\(\{[^}]*origin/);
  // The hidden set rides in the same object, and only when
  // something is hidden — `savedVisibility` spreads nothing otherwise, so a
  // scene with the whole structure showing has the bytes it always had.
  assert.match(source, /inspection: \{ \.\.\.inspectionSnapshot\(\), emphasis: savedEmphasis\(\), \.\.\.savedVisibility\(\)(?:,| \})/);
  assert.match(source, /visibilityIsEmpty\(visibilityState\) \? \{\} : \{ visibility: normalizeVisibility\(visibilityState\) \}/);
  assert.match(source, /emphasisOrigin === 'command' \? emphasisState : \{ \.\.\.emphasisState, origin: emphasisOrigin \}/);
  assert.match(source, /emphasisOrigin = origin === 'lesson' \? 'lesson' : origin === 'resting' \? 'resting' : 'command'/);
  // A failed paint restores both the key and its provenance. The rendered
  // observer now reads the newly painted key at the mutation boundary.
  assert.match(source, /catch \(error\) \{ emphasisOrigin = previousOrigin; emphasisState = previousEmphasis; throw error; \}/);
});

// The name plates have exactly one owner, and a session edge
// asks it whether plates are WANTED rather than counting refs that are empty
// for the whole of an in-flight rebuild. `component-labels.test.mjs` proves the
// serialization itself; this holds the viewer to using it.
test('every name-plate rebuild in the viewer goes through the one session', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  assert.match(source, /const componentLabels = createComponentLabelSession\(\{/);
  // The gate that let the defect through: a ref count, sampled while the list
  // was deliberately empty. It must not come back.
  assert.doesNotMatch(source, /if \(componentLabelRefs\.length\)/);
  assert.match(source, /if \(componentLabelsWanted\(\) \|\| componentLabels\.active\(\)\)/);
  // The session edge has ONE owner. The presentation hooks rebuild the
  // structure at the immersive quality and leave the plates to the subscriber.
  const onPresented = source.match(/async function onXrPresented\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  assert.match(onPresented, /await applyInspectionAppearance\(\{[^}]*componentLabels: false/);
  assert.match(source, /onLeavingPresentation: async \(\) => \{[\s\S]{0,160}componentLabels: false/);
  // Both offsets scale with the placement; a fixed desktop push buried plates
  // inside the cartoon at scale 2.4.
  assert.doesNotMatch(source, /offsetZ: presenting\s*\n?\s*\? componentLabelOffsetZ/);
  assert.match(source, /const standoff = componentLabelOffsetZ\(placement\.scale,/);
  assert.match(source, /const placement = inspectionSnapshot\(\)\.placement;/);
  // Every colour and alpha a plate is drawn with comes from
  // the one contract `component-labels.test.mjs` asserts, so the painter has no
  // second opinion about what a plate looks like. One backed primitive owns
  // both ink and contrast, rather than drawing two glyph copies.
  assert.match(source, /componentLabelPaint\(\{ presenting, placeAlpha: place\.alpha,\n\s*contextAlpha: contextAlpha\.get\(entry\.id\) \?\? 1,/);
  assert.doesNotMatch(source, /textColor: Color\(0x[0-9a-f]{6}\)/);
  assert.match(source, /for \(const \[layer, params\] of Object\.entries\(paint\)\) \{[\s\S]{0,300}textColor: Color\(params\.textColor\)/);
  // And the plate is fanned in the eye's own plane, through the
  // same corner offset that makes it a billboard, so it stays square to the
  // wearer and stays right in both eyes.
  assert.match(source, /offsetX: place\.offsetX, offsetY: place\.offsetY \+ lineOffset/);
  // The menu column and the caption card are both glass the plates keep off.
  assert.match(source, /obstacles: menuGlassObstacles\(\[toolbarRect, captionRect\]\)/);
  // And the structure's own silhouette reaches the solver,
  // which is the only thing that can keep a plate off the thing it names.
  assert.match(source, /subject: subject \?\? null/);
});

test('framing a part the fade is hiding lifts it, inside the key the wearer learned', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  assert.match(source, /async function liftFocusOutOfFade\(keys\)/);
  // Nothing is faded unless something is focused, so an unfocused key is left
  // exactly as it is: this must never repaint a chapter that fades nothing.
  assert.match(source, /liftFocusOutOfFade[\s\S]{0,300}!emphasisState\.focus\.length/);
  assert.match(source, /emphasisFocusForKeys\(emphasisState\.parts, spokenSelectionKeys, keys\)/);
  // The lift runs before the selection and long before the travel, so the
  // wearer never watches the fade come off a structure already in place.
  assert.match(source, /if \(liftEmphasis\) await liftFocusOutOfFade\(chosen\);\n(?:\s*\/\/.*\n)*\s*if \(named && marksSelection\) await select\(chosen, 'selection', \{ lesson: lessonSelection \}\);/);
  // `emphasize` frames what it just lit, so its own framing call must opt out
  // or the lift would call back into it forever.
  assert.match(source, /selectionKeys: litKeys, framing, minTargetFraction: LESSON_MIN_TARGET_FRACTION,\n\s*elevationDegrees: LESSON_ELEVATION_DEGREES, liftEmphasis: false/);
});

// The key the wearer learned outlives the layers that drew it.
//
// A takeover repaints the structure plain, and until now that also deleted the
// only list of part names the headset had, so "show me the guide RNA" stopped
// being a command the moment the wearer grabbed the molecule.

/** What the viewer's `emphasisState` looks like after a takeover clears it. */
const CLEARED = normalizeEmphasisState({ parts: [] });

test('the last painted key is remembered after a takeover clears the layers', () => {
  const memory = createLessonKeyMemory();
  assert.deepEqual(memory.parts(CLEARED), []);
  const chapter = normalizeEmphasisState({ parts: KEY, focus: 'rna', contextOpacity: 0.3 });
  memory.remember(chapter);
  // While a chapter is lit, the live key is the answer: it is the same key.
  assert.deepEqual(memory.parts(chapter).map(part => part.id), ['protein', 'site', 'rna']);
  assert.equal(memory.contextOpacity(chapter), 0.3);
  // After the takeover the live key is empty and the remembered one answers,
  // at the opacity the chapter that taught it was using.
  assert.deepEqual(memory.parts(CLEARED).map(part => part.id), ['protein', 'site', 'rna']);
  assert.equal(memory.contextOpacity(CLEARED), 0.3);
});

test('an empty emphasis never becomes the remembered key, and a new source drops it', () => {
  const memory = createLessonKeyMemory();
  memory.remember(normalizeEmphasisState({ parts: KEY }));
  // Clearing is what a takeover, a stop and the end of a tour all do. It must
  // not erase the names the wearer learned.
  memory.remember(CLEARED);
  assert.deepEqual(memory.parts(CLEARED).map(part => part.id), ['protein', 'site', 'rna']);
  // A different structure is a different lesson: its names do not carry over.
  memory.forget();
  assert.deepEqual(memory.parts(CLEARED), []);
  assert.equal(memory.contextOpacity(CLEARED), DEFAULT_CONTEXT_OPACITY);
});

test('the remembered key is a copy, so a caller cannot edit what the page remembers', () => {
  const memory = createLessonKeyMemory();
  memory.remember(normalizeEmphasisState({ parts: KEY }));
  memory.parts(CLEARED).pop();
  assert.equal(memory.parts(CLEARED).length, 3);
});

// The two viewer paths that read a part name, guarded at the source: both must
// read the remembered key rather than the live layers.
test('source rollback checkpoints the learned key without sharing mutable parts', () => {
  const memory = createLessonKeyMemory();
  memory.remember({ parts: KEY, focus: ['site'], contextOpacity: .23, strandShades: true });
  const saved = memory.checkpoint();
  memory.forget(); memory.restoreCheckpoint(saved);
  assert.deepEqual(memory.checkpoint(), saved);
  saved.parts[0].label = 'changed outside memory';
  assert.notEqual(memory.parts()[0].label, saved.parts[0].label);
  memory.forget(); const empty = memory.checkpoint();
  memory.remember({ parts: KEY }); memory.restoreCheckpoint(empty);
  assert.deepEqual(memory.parts(), []);
});

test('the spoken grammar and emphasize-part read the remembered key', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  assert.match(source, /const lessonKey = createLessonKeyMemory\(\)/);
  // The key the immersive grammar matches spoken nouns against.
  assert.match(source, /getLessonParts: \(\) => lessonKey\.parts\(emphasisState\)/);
  // "Show me the guide RNA" repaints the remembered key rather than refusing.
  assert.match(source, /const key = lessonKey\.parts\(emphasisState\);[\s\S]{0,240}resolveEmphasisPartId\(key, action\.part\)/);
  // Remembered on the way out of every non-empty emphasis, whoever asked.
  assert.match(source, /lessonKey\.remember\(nextEmphasis\)/);
  // A new structure is a new lesson: its names replace, never join, the old.
  assert.match(source, /lessonKey\.forget\(\)/);
});

// The ghost strength rule, stated once in lesson-emphasis.mjs and applied by
// the viewer at paint time.
//
// 0.18 was measured against a LIT WALL. Over a dark desk the same ghost reads
// as visual noise rather than the rest of the wall: a 0.18 grey composited over
// a near-black room is a few counts from the room. A passthrough session cannot
// see the room, so it takes the worst case.
test('a passthrough session floors the ghost; a plain VR one keeps what was authored', () => {
  assert.equal(contextOpacityForBlendMode(0.18, 'alpha-blend'), PASSTHROUGH_CONTEXT_OPACITY_FLOOR);
  assert.equal(contextOpacityForBlendMode(0.18, 'additive'), PASSTHROUGH_CONTEXT_OPACITY_FLOOR);
  // An opaque session draws over the lesson's own dark background, which is the
  // case 0.18 was chosen for.
  assert.equal(contextOpacityForBlendMode(0.18, 'opaque'), 0.18);
  // Off the headset entirely: a desktop panel is not a passthrough frame.
  assert.equal(contextOpacityForBlendMode(0.18, null), 0.18);
  assert.equal(contextOpacityForBlendMode(0.18), 0.18);
});

test('the floor never weakens a ghost a chapter asked to be stronger', () => {
  assert.equal(contextOpacityForBlendMode(0.6, 'alpha-blend'), 0.6);
  assert.equal(contextOpacityForBlendMode(1, 'alpha-blend'), 1);
  // Out-of-range and unusable inputs still land inside 0..1.
  assert.equal(contextOpacityForBlendMode(2, 'opaque'), 1);
  assert.equal(contextOpacityForBlendMode(-1, 'opaque'), 0);
  assert.equal(contextOpacityForBlendMode(Number.NaN, 'opaque'), DEFAULT_CONTEXT_OPACITY);
});

test('a floored ghost reaches the render plan as its transparency', () => {
  const opacity = contextOpacityForBlendMode(0.18, 'alpha-blend');
  const plan = planLessonEmphasis({ parts: KEY, focus: 'rna', contextOpacity: opacity }, resolve, ROW_KEYS);
  assert.equal(Number(plan.transparency.toFixed(3)), Number((1 - PASSTHROUGH_CONTEXT_OPACITY_FLOOR).toFixed(3)));
});

test('the viewer applies the floor at paint time and keeps the authored value saved', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  // One helper, reached by the live paint and by the rebuild that repaints it.
  assert.match(source, /function paintedContextOpacity\(contextOpacity\)/);
  assert.match(source, /contextOpacityForBlendMode\(contextOpacity, blend\)/);
  assert.match(source, /contextOpacity: paintedContextOpacity\(contextOpacity\)/);
  assert.match(source, /contextOpacity: paintedContextOpacity\(emphasisState\.contextOpacity\)/);
  // The saved emphasis stays the lesson's own number, never the floored one.
  assert.match(source, /normalizeEmphasisState\(\{ parts, focus, alsoLit, contextOpacity, strandShades \}\)/);
  // A key that went missing reaches the headset log before the paint.
  assert.match(source, /recordEmphasisResolution\(plan\)/);
  assert.match(source, /record\('lesson-emphasis-chain'/);
});

// ---------------------------------------------------------------------------
// The batching rule and the never-black rule.
// ---------------------------------------------------------------------------

test('a key of many parts becomes one Mol* layer per colour, not one per part', () => {
  // The wall tier's shape: many named chains, two colours, no focus — so every
  // part is coloured and nothing is faded. Fourteen overpaint layers over a
  // 40,908-atom representation is fourteen bundle conversions and fourteen
  // passes over the overpaint buffer, for a picture with two colours in it.
  const wall = Array.from({ length: 6 }, (_, i) => ({ id: `alpha-${i}`, label: `Alpha ${i}`,
    color: '#4a90e2', chain: 'A', residues: { from: i + 1, to: i + 1 } }))
    .concat(Array.from({ length: 3 }, (_, i) => ({ id: `beta-${i}`, label: `Beta ${i}`,
      color: '#f5a623', chain: 'B', residues: { from: i + 1, to: i + 1 } })));
  const plan = planLessonEmphasis({ parts: wall }, resolve, ROW_KEYS);
  assert.equal(plan.colours.length, 9);
  const layers = mergeEmphasisColourLayers(plan.colours);
  assert.deepEqual(layers.map(layer => layer.color), ['#4a90e2', '#f5a623']);
  // Every row the nine parts claimed is still drawn, exactly once.
  assert.deepEqual(layers.flatMap(layer => layer.keys).sort(), [...ROW_KEYS].sort());
  const drawn = layers.flatMap(layer => layer.keys);
  assert.equal(new Set(drawn).size, drawn.length);
});

test('merging by colour keeps the last part painting over the one that contains it', () => {
  // A key may list a sub-range after the chain that contains it — the active
  // site inside the protein — and the sub-range keeps its own colour. Merging
  // must not hand those rows back to the chain.
  const plan = planLessonEmphasis({ parts: KEY }, resolve, ROW_KEYS);
  const layers = mergeEmphasisColourLayers(plan.colours);
  const colourOf = key => layers.find(layer => layer.keys.includes(key))?.color;
  assert.equal(colourOf('A:2'), '#ff3b30');
  assert.equal(colourOf('A:3'), '#ff3b30');
  assert.equal(colourOf('A:1'), '#9aa5b0');
  assert.equal(colourOf('B:1'), '#ff8a1f');
  // Three colours, three layers, and no row in two of them.
  assert.equal(layers.length, 3);
  const drawn = layers.flatMap(layer => layer.keys);
  assert.equal(new Set(drawn).size, drawn.length);
});

test('an empty key is no layers at all, which is the plain structure', () => {
  assert.deepEqual(mergeEmphasisColourLayers([]), []);
  assert.deepEqual(mergeEmphasisColourLayers(), []);
});

test('a part whose chain carries no selectable row is missing, not resolved', () => {
  // `resolveKeys` throws for a chain that is absent and answers with an empty
  // list for one that is present with nothing selectable in the asked range.
  // Both are a part the chapter cannot light, and counting the second as
  // resolved is what let a focus fade the whole structure behind nothing.
  const thin = ({ chain }) => chain === 'B' ? [] : resolve({ chain });
  const plan = planLessonEmphasis({ parts: KEY, focus: 'rna' }, thin, ROW_KEYS);
  assert.deepEqual(plan.unresolved.map(part => part.id), ['rna']);
  assert.equal(plan.fallback, 'tier');
  assert.deepEqual(plan.faded, []);
});

test('no plan ever fades the whole structure: a ghost with nothing lit is a blackout', () => {
  // In passthrough, over a dark room, a structure at the ghost opacity with
  // nothing at full strength is not an emphasis, it is an empty room. Whatever
  // went wrong upstream, the fade stays off unless something is lit behind it.
  const empty = () => [];
  const plan = planLessonEmphasis({ parts: KEY, focus: ['rna', 'site'] }, empty, ROW_KEYS);
  assert.deepEqual(plan.lit, []);
  assert.deepEqual(plan.faded, []);
  assert.equal(plan.fallback, 'tier');
  // And the general invariant, over every focus this key can express.
  for (const focus of [undefined, 'rna', 'site', 'protein', ['rna', 'site'], ['protein', 'rna', 'site']]) {
    const each = planLessonEmphasis({ parts: KEY, focus }, resolve, ROW_KEYS);
    assert.ok(each.faded.length === 0 || each.lit.length > 0,
      `A focus of ${JSON.stringify(focus)} faded ${each.faded.length} rows with nothing lit.`);
    assert.ok(each.faded.length < ROW_KEYS.length, 'Every row of the structure was faded.');
  }
});

test('the viewer paints the colour layers before the fade, and merges them first', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const paint = source.slice(source.indexOf('async function paintEmphasisLayers'),
    source.indexOf('function currentEmphasisPlan'));
  // One layer per colour, from the shared helper rather than a local map.
  assert.match(paint, /mergeEmphasisColourLayers\(plan\.colours\)/);
  assert.ok(!/plan\.colours\.map\(/u.test(paint),
    'The viewer still builds one overpaint layer per authored part.');
  // Order is the never-black rule inside the paint: a frame with the ghost on
  // and no colour under it is the blackout. Colours first, always.
  assert.ok(paint.indexOf('OverpaintStructureRepresentation3DFromBundle')
    < paint.indexOf('TransparencyStructureRepresentation3DFromBundle'),
  'The fade is applied before the colours, so an abandoned paint leaves a ghost with nothing lit.');
  // And what it cost is on the headset log, because a headset has no console.
  assert.match(paint, /recordCost\('emphasis-cost'/);
});

// A grown tier lights every subunit. Quest 2 captures showed an earlier build's
// grown protofilament with its new dimer as a grey ghost while the
// first dimer stayed lit blue/amber, so the lit subject shrank even though the
// strand grew — against the landing narration "same two colours".

/** A stand-in grown protofilament: two dimers, lower (A, B) and new (A-14, B-14), plus cargo. */
const GROWN_ROWS = [
  ...Array.from({ length: 437 }, (_, i) => ({ key: `A:${i + 1}`, chain: 'A', residue: i + 1 })),
  ...Array.from({ length: 436 }, (_, i) => ({ key: `B:${i + 1}`, chain: 'B', residue: i + 1 })),
  ...Array.from({ length: 437 }, (_, i) => ({ key: `A-14:${i + 1}`, chain: 'A-14', residue: i + 1 })),
  ...Array.from({ length: 436 }, (_, i) => ({ key: `B-14:${i + 1}`, chain: 'B-14', residue: i + 1 })),
  { key: 'A:501', chain: 'A', residue: 501 }, { key: 'A:502', chain: 'A', residue: 502 },
  { key: 'B:502', chain: 'B', residue: 502 },
];
const GROWN_KEYS = GROWN_ROWS.map(row => row.key);
const grownResolve = ({ chain, residues }) => {
  if (!chain && !residues) return undefined;
  const [first, last] = residues ?? [];
  const hit = GROWN_ROWS.filter(row => (!chain || row.chain === chain)
    && (!residues || (row.residue >= first && row.residue <= last)));
  if (!hit.length) throw Error(`Nothing at ${chain ?? '?'} ${first}-${last} here.`);
  return hit.map(row => row.key);
};
const GROWN_KEY = [
  { id: 'alpha-tubulin', label: 'Alpha tubulin', color: '#4a90e2', chain: 'A', residues: { from: 1, to: 437 } },
  { id: 'beta-tubulin', label: 'Beta tubulin', color: '#f5a623', chain: 'B', residues: { from: 1, to: 436 } },
  { id: 'new-alpha', label: 'The new alpha tubulin', color: '#4a90e2', chain: 'A-14', residues: { from: 1, to: 437 } },
  { id: 'new-beta', label: 'The new beta tubulin', color: '#f5a623', chain: 'B-14', residues: { from: 1, to: 436 } },
  { id: 'gtp', label: 'GTP', color: '#4a90e2', chain: 'A', residues: { from: 501, to: 502 } },
  { id: 'taxol', label: 'Taxol', color: '#f5a623', chain: 'B', residues: { from: 502, to: 502 } },
];
const tubulinRow = key => /^(A|B|A-14|B-14):([1-9]|[1-9][0-9]|[1-3][0-9][0-9]|4[0-3][0-9])$/.test(key);

test('a grown tier landing lights every tubulin subunit: lit parts equal subunits', () => {
  // The shipped protofilament opening chapter focuses all four tubulins, so
  // the plan lights both dimers and fades only the ligand cargo.
  const manifest = JSON.parse(readFileSync(
    new URL('../../plugin/demos/microtubule-growth/protofilament.json', import.meta.url), 'utf8'));
  const reveal = manifest.chapters[0].immersive.emphasis;
  assert.deepEqual([...reveal.focus].sort(),
    ['alpha-tubulin', 'beta-tubulin', 'new-alpha', 'new-beta']);
  const plan = planLessonEmphasis(reveal, grownResolve, GROWN_KEYS);
  // Four lit parts for four subunits: alpha, beta, new-alpha, new-beta.
  assert.equal(plan.colours.length, 4);
  assert.equal(plan.fallback, undefined);
  // No tubulin row of either dimer is faded; the ghost is cargo alone.
  assert.ok(plan.faded.length > 0, 'The ligand cargo still fades.');
  assert.ok(plan.faded.every(key => !tubulinRow(key)),
    `A tubulin subunit faded: ${plan.faded.filter(tubulinRow).slice(0, 4).join(', ')}`);
  for (const chain of ['A', 'B', 'A-14', 'B-14']) {
    assert.ok(!plan.faded.some(key => key.startsWith(`${chain}:`) && tubulinRow(key)),
      `Chain ${chain} has faded tubulin rows.`);
  }
});

test('the previous tier key ghosted the new dimer, which is the 76aa6ff symptom', () => {
  // The dimer tier's opening key (chains A and B, focus alpha+beta) resolves
  // on the grown structure's lower dimer — and the new chains are nowhere in
  // its lit set, so every one of their rows fades. This plan drew the new
  // chains as a 35 per cent grey ghost: it must never be the plan a grown
  // tier lands with, which the test above pins.
  const stale = planLessonEmphasis(
    { parts: GROWN_KEY.filter(part => ['alpha-tubulin', 'beta-tubulin'].includes(part.id)),
      focus: ['alpha-tubulin', 'beta-tubulin'] },
    grownResolve, GROWN_KEYS);
  assert.ok(stale.faded.some(key => key.startsWith('A-14:')), 'The new alpha rows survived a stale key.');
  assert.ok(stale.faded.some(key => key.startsWith('B-14:')), 'The new beta rows survived a stale key.');
  assert.ok(!stale.lit.some(key => key.startsWith('A-14:') || key.startsWith('B-14:')),
    'The new dimer lit under the previous tier key.');
});

test('a source swap forgets the previous chapter framing key, so a grown tier always frames', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const adopt = source.slice(source.indexOf('function adopt(record)'), source.indexOf('function beginWork'));
  assert.match(adopt, /lastLessonChapterKey = undefined/);
});
