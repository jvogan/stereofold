import test from 'node:test';
import assert from 'node:assert/strict';
import { createLessonResting, platesWanted, sameEmphasisKey } from './lesson-resting.mjs';
import { normalizeEmphasisState } from './lesson-emphasis.mjs';

/** A lesson's colour key: the first chapter of the telomerase demo, shortened. */
const KEY = [
  { id: 'dyskerin', label: 'Dyskerin', color: '#4f8ef7', chain: 'A' },
  { id: 'nop10', label: 'NOP10', color: '#ff8a1f', chain: 'B' },
  { id: 'rna', label: 'hTR RNA', color: '#3ddc97', chain: 'C' },
];
const OTHER_KEY = [{ id: 'ligand', label: 'Ligand', color: '#ff3b30', chain: 'D' }];

test('source rollback restores the resting baseline and live label flag without repainting', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  v.lesson.setLabelsEnabled(false);
  const saved = v.lesson.checkpoint(), paints = v.paints.length, rebuilds = v.plateRebuilds.length;
  v.lesson.forget(); v.lesson.restoreCheckpoint(saved);
  assert.deepEqual(v.lesson.checkpoint(), saved);
  assert.equal(v.lesson.labelsEnabled(), false);
  assert.equal(v.paints.length, paints); assert.equal(v.plateRebuilds.length, rebuilds);
  saved.resting.emphasis.parts[0].label = 'changed outside baseline';
  assert.notEqual(v.lesson.state().emphasis.parts[0].label, saved.resting.emphasis.parts[0].label);
});

/**
 * A viewer's lesson state, down to what the resting rule reads and writes.
 *
 * `emphasize` behaves exactly as the viewer's does in the two ways that matter
 * here: it records who asked BEFORE the paint, and it rebuilds the name plates
 * after it. The plates are derived from the flag and the painted key, so a flag
 * that drifts out of step with the drawing shows up as plates naming the wrong
 * thing rather than as a number a test had to be told to expect.
 */
function viewer({ failPaint = false } = {}) {
  let emphasis = normalizeEmphasisState({ parts: [] });
  let origin = 'command';
  let plates = [];
  const paints = [];
  const plateRebuilds = [];

  const snapshot = () => ({
    key: emphasis.parts.map(part => part.id),
    focus: [...emphasis.focus],
    origin,
    plates: [...plates],
  });

  async function rebuildPlates() {
    await Promise.resolve();
    plateRebuilds.push(lesson.labelsEnabled());
    plates = platesWanted(lesson.state(), lesson.labelsEnabled(), origin) ? emphasis.parts.map(part => part.label) : [];
  }

  /** The viewer's `emphasize`, which every paint in this file goes through. */
  async function emphasize(request) {
    const { origin: asked = 'command', ...key } = request;
    // The viewer records provenance before the paint, deliberately: the
    // mutation it wraps emits a takeover, and a takeover asks who owns this.
    const previousOrigin = origin;
    origin = asked === 'lesson' ? 'lesson' : asked === 'resting' ? 'resting' : 'command';
    // ...and puts it back when the paint rejects, because a paint that never
    // landed asked for nothing. The viewer's own `emphasize` does this around
    // its `mutate` call for the same reason.
    if (failPaint) { origin = previousOrigin; throw Error('the representation lost its context'); }
    emphasis = normalizeEmphasisState(key);
    paints.push({ origin, key: emphasis.parts.map(part => part.id) });
    await rebuildPlates();
    return snapshot();
  }

  const lesson = createLessonResting({
    emphasize,
    snapshot,
    rebuildLabels: rebuildPlates,
    getEmphasis: () => emphasis,
    getOrigin: () => origin,
  });

  return {
    lesson, paints, plateRebuilds, snapshot,
    /** A tour chapter painting its own key. */
    chapter: (parts, focus) => emphasize({ parts, ...(focus ? { focus } : {}), origin: 'lesson' }),
    /** An agent or the wearer asking for a key by name. */
    byName: (parts, focus) => emphasize({ parts, ...(focus ? { focus } : {}), origin: 'command' }),
    /**
     * What `restoreInspection` does with a capture that names a key.
     *
     * `savedOrigin` is what the capture's own emphasis carries; a capture from
     * a page too old to record one passes undefined, which is every scene
     * saved before the origin was persisted.
     */
    restore(key, savedOrigin) {
      emphasis = normalizeEmphasisState(key);
      origin = lesson.noteRestoredKey(emphasis, savedOrigin) ?? origin;
      return snapshot();
    },
    /** What `completeInspectionCapture` writes into the saved scene. */
    capture: () => (origin === 'command' ? { ...emphasis } : { ...emphasis, origin }),
    /** Break or mend the next paint, so a rejection can be retried. */
    breakPaint(value) { failPaint = value !== false; },
    plates: () => [...plates],
  };
}

/**
 * One reload, in the order a hydrate actually runs it.
 *
 * This is the whole defect in four lines. `loadSource` restores the saved scene
 * inside the hydrate's `built` phase, and `placeLessonScene` sends the resting
 * state — the lesson's, or `undefined` — later, in the `placed` phase. So the
 * restore is always asked whose key this is BEFORE the baseline exists, and a
 * test that installs first proves nothing about a reload.
 *
 * @param {object|undefined} capture the emphasis the saved scene names
 * @param {object|undefined} baseline what `placed` installs, if a lesson loaded
 */
async function reload(capture, baseline) {
  const v = viewer();
  if (capture) v.restore(capture, capture.origin); // the `built` phase
  await v.lesson.install(baseline); // the `placed` phase
  return v;
}

test('the resting baseline is installed, painted, and named on its plates', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  assert.deepEqual(v.snapshot().key, ['dyskerin', 'nop10', 'rna']);
  assert.equal(v.snapshot().origin, 'resting');
  assert.equal(v.lesson.labelsEnabled(), true);
  assert.deepEqual(v.plates(), ['Dyskerin', 'NOP10', 'hTR RNA']);
});

test('plates are opt-in: a lesson that never authored them draws none', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY } });
  assert.equal(v.lesson.labelsEnabled(), false);
  assert.deepEqual(v.plates(), []);
});

// The sequence the tour player runs on every grab, agent focus, quality change
// and workbench sync: a chapter is live, something takes over, and the wearer
// must be handed the lesson's baseline rather than a twelve-per-cent ghost
// wearing the last chapter's colours.
test('a takeover releases the chapter back to the resting key and its plates', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  await v.chapter(KEY, 'rna');
  assert.equal(v.snapshot().origin, 'lesson');
  assert.deepEqual(v.snapshot().focus, ['rna']);

  await v.lesson.clear();
  assert.deepEqual(v.snapshot().key, ['dyskerin', 'nop10', 'rna']);
  assert.deepEqual(v.snapshot().focus, [], 'the chapter\'s fade is gone with it');
  assert.equal(v.snapshot().origin, 'resting');
  assert.deepEqual(v.plates(), ['Dyskerin', 'NOP10', 'hTR RNA']);
});

test('a chapter that turned the plates off gets them back when it lets go', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  await v.chapter(KEY, 'rna');
  v.lesson.setLabelsEnabled(false); // the chapter's own appearance said so
  await v.lesson.clear();
  assert.equal(v.lesson.labelsEnabled(), true);
  assert.deepEqual(v.plates(), ['Dyskerin', 'NOP10', 'hTR RNA']);
});

test('a key somebody asked for by name survives a takeover untouched', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  await v.byName(OTHER_KEY);
  const before = v.paints.length;
  await v.lesson.clear();
  assert.equal(v.paints.length, before, 'nothing was repainted');
  assert.deepEqual(v.snapshot().key, ['ligand']);
});

// The dropped short-circuit. Without it every grab of a plain structure on a
// viewer with no lesson cost a full repaint for no visible change.
test('a takeover with nothing painted and no lesson loaded repaints nothing', async () => {
  const v = viewer();
  await v.chapter([]); // a lesson that emphasises nothing
  const before = v.paints.length;
  await v.lesson.clear();
  assert.equal(v.paints.length, before);
});

test('but an empty chapter over a loaded lesson still returns to the baseline', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  await v.chapter([]);
  assert.deepEqual(v.snapshot().key, []);
  await v.lesson.clear();
  assert.deepEqual(v.snapshot().key, ['dyskerin', 'nop10', 'rna']);
});

// The panel sends this on every hydrate that carries no lesson, so it has
// to be a complete clear rather than a flag change.
test('setLessonRestingState(undefined) clears the baseline, the key and the plates', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  assert.deepEqual(v.plates().length, 3);

  await v.lesson.install(undefined);
  assert.equal(v.lesson.state(), undefined, 'the baseline is forgotten');
  assert.equal(v.lesson.labelsEnabled(), false, 'the plate flag is off');
  assert.deepEqual(v.plates(), [], 'the plates are gone');
  assert.deepEqual(v.snapshot().key, [], 'the key is back to plain chain colours');

  // And a takeover afterwards has nothing to put back, so it costs nothing.
  const before = v.paints.length;
  await v.lesson.clear();
  assert.equal(v.paints.length, before);
});

test('clearing the baseline leaves a key asked for by name, but takes its plates', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  await v.byName(OTHER_KEY);
  await v.lesson.install(undefined);
  assert.deepEqual(v.snapshot().key, ['ligand'], 'the wearer asked for this key');
  assert.equal(v.lesson.labelsEnabled(), false);
  assert.deepEqual(v.plates(), []);
  assert.equal(v.lesson.state(), undefined);
});

// The restored-key overwrite. A hydrate arrives after the wearer has restored
// a saved scene, and the baseline paint used to take that scene straight back
// off the molecule.
test('a hydrate does not overwrite a saved scene the wearer just restored', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  v.restore(normalizeEmphasisState({ parts: OTHER_KEY }));
  assert.equal(v.snapshot().origin, 'command', 'a saved scene named its own key');

  const before = v.paints.length;
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  assert.equal(v.paints.length, before, 'the resting paint stood down');
  assert.deepEqual(v.snapshot().key, ['ligand']);
  // The baseline is still recorded, so the next takeover has somewhere to go.
  assert.deepEqual(v.lesson.state().emphasis.parts.map(part => part.id), ['dyskerin', 'nop10', 'rna']);
});

// `applyStepEmphasis(undefined)` in the tour player is this clear, and it runs
// immediately after the starting view is restored. The restore already painted
// the baseline, so the clear must find nothing left to do.
test('putting a tour away after a restore does not overwrite the restored key', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  await v.chapter(KEY, 'rna');

  // A saved scene of that chapter, restored: not the baseline, and not the
  // lesson's to take off.
  v.restore(normalizeEmphasisState({ parts: KEY, focus: 'rna' }));
  const before = v.paints.length;
  await v.lesson.clear();
  assert.equal(v.paints.length, before, 'the restored key is left exactly as it was');
  assert.deepEqual(v.snapshot().focus, ['rna']);
});

test('restoring the starting view paints the baseline once, not twice', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  await v.chapter(KEY, 'rna');

  // The starting view carries the lesson's own resting key, so the restore IS
  // the baseline paint and the clear that follows it is redundant.
  v.restore(normalizeEmphasisState({ parts: KEY }));
  assert.equal(v.snapshot().origin, 'resting');
  const before = v.paints.length;
  await v.lesson.clear();
  assert.equal(v.paints.length, before);
  assert.deepEqual(v.snapshot().key, ['dyskerin', 'nop10', 'rna']);
});

// THE RELOAD. The panel saves the view on every hydrate, so every reload after
// the first carries a capture naming the lesson's own starting key, and the
// restore runs a whole phase before the baseline is installed. Before the
// capture carried its origin this ended with zero paints, `labelsEnabled()`
// false and no plate rebuild at all: the shipped telomerase lesson came back
// from every reload with none of its ten name plates.
test('a reload of a lesson session installs the baseline and puts the plates back', async () => {
  // The capture a previous hydrate saved: the baseline, painted as 'resting'.
  const first = viewer();
  await first.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  const saved = first.capture();
  assert.equal(saved.origin, 'resting', 'the capture records who painted this key');

  const v = await reload(saved, { emphasis: { parts: KEY }, componentLabels: true });
  assert.deepEqual(v.lesson.state().emphasis.parts.map(part => part.id), ['dyskerin', 'nop10', 'rna'],
    'the baseline is installed');
  assert.equal(v.lesson.labelsEnabled(), true, 'the plates are enabled');
  assert.deepEqual(v.plates(), ['Dyskerin', 'NOP10', 'hTR RNA'], 'and built');
  assert.equal(v.snapshot().origin, 'resting');
  assert.equal(v.paints.length, 1, 'the baseline paint ran rather than standing down');
});

// The same reload against a capture from a page too old to name an origin. The
// key is still recognisably the baseline the hydrate is installing, and nobody
// chose it over the lesson, so the plates must come back for those scenes too.
test('a reload adopts the lesson key even from a capture that names no origin', async () => {
  const v = await reload(normalizeEmphasisState({ parts: KEY }),
    { emphasis: { parts: KEY }, componentLabels: true });
  assert.equal(v.lesson.labelsEnabled(), true);
  assert.deepEqual(v.plates(), ['Dyskerin', 'NOP10', 'hTR RNA']);
  assert.equal(v.snapshot().origin, 'resting');
});

test('a reload of a lesson session leaves a saved key the wearer asked for by name', async () => {
  const v = await reload(normalizeEmphasisState({ parts: OTHER_KEY }),
    { emphasis: { parts: KEY }, componentLabels: true });
  assert.deepEqual(v.snapshot().key, ['ligand'], 'the wearer chose this over the lesson');
  assert.equal(v.paints.length, 0, 'the baseline paint stood down');
  // The baseline is still recorded, so the next takeover has somewhere to go.
  assert.deepEqual(v.lesson.state().emphasis.parts.map(part => part.id), ['dyskerin', 'nop10', 'rna']);
});

// The plain half of the same rule. A hydrate with no lesson sends `undefined`,
// and what that has to do depends entirely on who painted the saved key.
test('a reload of a plain session returns a lesson resting key to chain colours', async () => {
  const lessonSession = viewer();
  await lessonSession.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });

  const v = await reload(lessonSession.capture(), undefined);
  assert.deepEqual(v.snapshot().key, [], 'a lesson nobody loaded does not get to keep painting');
  assert.equal(v.lesson.labelsEnabled(), false);
  assert.deepEqual(v.plates(), []);
});

test('a reload of a plain session keeps a key the wearer asked for by name', async () => {
  const named = viewer();
  await named.byName(OTHER_KEY);
  const saved = named.capture();
  assert.equal(saved.origin, undefined, "'command' is written as absence");

  const v = await reload(saved, undefined);
  assert.deepEqual(v.snapshot().key, ['ligand'], 'nobody took this off the wearer');
  assert.equal(v.lesson.labelsEnabled(), false, 'but its plates were the lesson\'s');
  assert.deepEqual(v.plates(), []);
});

// A chapter key saved mid-lesson: still the lesson's, so the reload's baseline
// repaints over it rather than leaving the wearer a chapter's fade with no tour
// running to explain it.
test('a reload of a saved chapter key repaints the lesson baseline over it', async () => {
  const mid = viewer();
  await mid.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  await mid.chapter(KEY, 'rna');
  const saved = mid.capture();
  assert.equal(saved.origin, 'lesson');

  const v = await reload(saved, { emphasis: { parts: KEY }, componentLabels: true });
  assert.deepEqual(v.snapshot().focus, [], 'the chapter\'s fade is gone with the chapter');
  assert.equal(v.lesson.labelsEnabled(), true);
  assert.deepEqual(v.plates(), ['Dyskerin', 'NOP10', 'hTR RNA']);
});

test('a saved origin survives the capture and comes back as provenance', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  assert.equal(v.capture().origin, 'resting');
  await v.chapter(KEY, 'rna');
  assert.equal(v.capture().origin, 'lesson');
  await v.byName(OTHER_KEY);
  assert.equal(v.capture().origin, undefined, 'a key asked for by name saves no origin at all');
});

test('a capture that names no key leaves provenance exactly where it was', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY } });
  await v.chapter(KEY, 'rna');
  assert.equal(v.lesson.noteRestoredKey(undefined), undefined);
  assert.equal(v.snapshot().origin, 'lesson', 'an older capture behaves as it always did');
});

// The flag says what is DRAWN. The tour player's `dropLessonEmphasis` swallows
// the rejection, so a flag moved before the await would leave the viewer
// counting plates that were never built -- and the frame wait counts plates.
test('a paint that fails leaves the plate flag where the drawing is', async () => {
  const v = viewer({ failPaint: true });
  await assert.rejects(v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true }),
    /lost its context/);
  assert.equal(v.lesson.labelsEnabled(), false);
  assert.equal(v.lesson.state(), undefined, 'a baseline that never painted is not installed');
});

// The other half of the same rejection, and the one the plate-flag test misses.
// The viewer records provenance BEFORE it awaits the paint, deliberately, so a
// rejection that is not rolled back leaves the page believing the lesson's own
// resting paint owns a key it never drew. `clear` acts only on a 'lesson' key,
// so a stuck 'resting' makes every later takeover return silently and the
// wearer keeps a chapter's twelve-per-cent fade with no tour to explain it.
// `emphasize` in viewer.mjs puts the previous origin back for exactly this.
test('a release that fails leaves the chapter owning the key it still wears', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  await v.chapter(KEY, 'rna');
  assert.equal(v.snapshot().origin, 'lesson');

  v.breakPaint(true);
  await assert.rejects(v.lesson.clear(), /lost its context/);
  assert.equal(v.snapshot().origin, 'lesson', 'the chapter still owns the key on the molecule');
  assert.deepEqual(v.snapshot().focus, ['rna'], 'and the fade it drew is still there');

  // The retry is the point: a takeover that failed once must still work.
  v.breakPaint(false);
  await v.lesson.clear();
  assert.deepEqual(v.snapshot().key, ['dyskerin', 'nop10', 'rna']);
  assert.deepEqual(v.snapshot().focus, [], 'the chapter is released on the second try');
  assert.equal(v.lesson.labelsEnabled(), true);
});

test('a failed release leaves the plate flag where the drawing is', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  await v.chapter(KEY, 'rna');
  v.lesson.setLabelsEnabled(false);
  const broken = createLessonResting({
    emphasize: async () => { throw Error('the representation lost its context'); },
    snapshot: () => ({}),
    rebuildLabels: async () => {},
    getEmphasis: () => normalizeEmphasisState({ parts: KEY }),
    getOrigin: () => 'lesson',
  });
  await broken.install({ emphasis: { parts: KEY }, componentLabels: true }).catch(() => {});
  assert.equal(broken.labelsEnabled(), false);
});

test('a new source forgets the previous lesson entirely', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  v.lesson.forget();
  assert.equal(v.lesson.state(), undefined);
  assert.equal(v.lesson.labelsEnabled(), false);
});

test('two keys are the same key when they name the same parts the same way', () => {
  assert.equal(sameEmphasisKey({ parts: KEY }, { parts: KEY }), true);
  assert.equal(sameEmphasisKey({ parts: KEY }, { parts: OTHER_KEY }), false);
  assert.equal(sameEmphasisKey({ parts: KEY, focus: 'rna' }, { parts: KEY }), false);
  assert.equal(sameEmphasisKey(undefined, { parts: KEY }), false);
  assert.equal(sameEmphasisKey({ parts: KEY }, undefined), false);
});

test('a resting state needs every one of its collaborators', () => {
  const ok = { emphasize: async () => {}, snapshot: () => ({}), rebuildLabels: async () => {},
    getEmphasis: () => ({ parts: [] }), getOrigin: () => 'command' };
  for (const missing of Object.keys(ok)) {
    assert.throws(() => createLessonResting({ ...ok, [missing]: undefined }),
      new RegExp(`needs a ${missing} function`));
  }
});


test('command plate ownership is independent of the live chapter flag', async () => {
  const v = viewer();
  await v.lesson.install({ emphasis: { parts: KEY }, componentLabels: true });
  v.lesson.setLabelsEnabled(false);
  await v.byName(KEY, 'rna');
  await v.lesson.clear();
  assert.deepEqual(v.plates(), KEY.map(part => part.label));
  assert.equal(v.lesson.labelsEnabled(), false, 'the command does not rewrite the live flag');
  await v.lesson.install(undefined);
  assert.deepEqual(v.plates(), []);
});

test('the plate rule preserves lesson names across chapter and command ownership', () => {
  assert.equal(platesWanted({ componentLabels: true }, false, 'command'), true);
  for (const origin of ['lesson', 'resting', 'command']) {
    assert.equal(platesWanted(undefined, false, origin), false);
    assert.equal(platesWanted(undefined, true, origin), true);
    assert.equal(platesWanted({ componentLabels: false }, false, origin), false);
  }
  assert.equal(platesWanted({ componentLabels: true }, false, 'lesson'), true);
  assert.equal(platesWanted({ componentLabels: true }, false, 'resting'), false);
});
