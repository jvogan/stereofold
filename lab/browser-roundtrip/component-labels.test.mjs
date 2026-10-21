import vm from 'node:vm';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { planLessonEmphasis } from './lesson-emphasis.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLessonResting, platesWanted } from './lesson-resting.mjs';
import { componentLabelAlpha, componentLabelPaint, componentPlateName,
  COMPONENT_LABEL_BACKING_ALPHA_FLOOR, COMPONENT_LABEL_GLASS, COMPONENT_LABEL_INK,
  COMPONENT_LABEL_GLASS_OPACITY,
  createComponentLabelSession, planComponentLabels } from './component-labels.mjs';

/**
 * A Mol* state tree, down to the one thing the plates need of it: cells that
 * exist under a ref until something deletes them.
 *
 * The plates are built at DETERMINISTIC refs — `stereofold-component-labels-N`
 * — which is the whole reason two overlapping rebuilds destroy each other, so
 * a fake that handed out unique refs would test nothing.
 */
function fakePlugin() {
  const cells = new Map();
  return {
    cells,
    live: () => [...cells.keys()].filter(ref => !ref.endsWith('-text')).sort(),
    add(ref) { cells.set(ref, { ref }); cells.set(`${ref}-text`, { ref: `${ref}-text` }); },
    delete(ref) { cells.delete(ref); cells.delete(`${ref}-text`); },
  };
}

/** The one signal a session edge moves: `canvas.xr.isPresenting.value`. */
function fakeXr(presenting = false) {
  const subscribers = new Set();
  return {
    isPresenting: {
      get value() { return presenting; },
      subscribe(handler) { subscribers.add(handler); return { unsubscribe: () => subscribers.delete(handler) }; },
    },
    /** What the runtime does: set the flag, then tell every subscriber. */
    become(next) { presenting = next; for (const handler of [...subscribers]) handler(next); },
  };
}

/**
 * A viewer's worth of plate building, with the awaits a real one has.
 *
 * `gate` lets a test hold a build open and land a session edge inside it,
 * which is the race the whole module exists for and the one thing a
 * synchronous fake could never reproduce.
 */
function harness({ parts = 3, presenting = false } = {}) {
  const plugin = fakePlugin();
  const xr = fakeXr(presenting);
  const built = [];
  let wanted = true;
  let gate = null;

  const session = createComponentLabelSession({
    isPresenting: () => xr.isPresenting.value,
    wantsLabels: () => wanted,
    async buildPlates({ presenting: sizedFor }) {
      if (gate) await gate;
      const created = [];
      for (let index = 0; index < parts; index += 1) {
        const ref = `stereofold-component-labels-${index}`;
        // A build yields between plates exactly as a Mol* commit does.
        await Promise.resolve();
        plugin.add(ref);
        created.push(ref);
      }
      built.push({ sizedFor, refs: [...created] });
      return created;
    },
    async deletePlates(refs) {
      for (const ref of refs) {
        await Promise.resolve();
        plugin.delete(ref);
      }
    },
  });

  return {
    session, plugin, xr, built,
    setWanted(value) { wanted = value; },
    /** Hold the next build open, and hand back the release. */
    hold() {
      let release;
      gate = new Promise(resolve => { release = resolve; });
      return () => { gate = null; release(); };
    },
    /** The size the plates the wearer is actually looking at were built for. */
    liveSizing: () => built.at(-1)?.sizedFor,
  };
}

test('the plates a rebuild leaves behind are exactly the cells on the state tree', async () => {
  const { session, plugin } = harness();
  await session.rebuild();
  assert.deepEqual(session.refs(), plugin.live());
  assert.equal(session.refs().length, 3);
  assert.equal(new Set(session.refs()).size, 3, 'no ref is listed twice');
});

// The defect this module exists for, reproduced at the smallest size that
// shows it: enter and leave inside one tick. Before serialization the two
// rebuilds raced over the same deterministic refs — run A cleared its list and
// awaited its deletes, run B built fresh cells, then A's deletes removed B's
// cells — so the surviving ref list named cells that were gone, the plates
// vanished, and the frame wait that counts live plates timed out.
test('entering and leaving presentation within one tick leaves one live set of plates', async () => {
  const { session, plugin, xr } = harness({ presenting: false });
  await session.rebuild();

  // Both edges land before either rebuild can finish, which is what "entered
  // VR and left within a second" comes to on the frame clock.
  xr.become(true);
  const entering = session.rebuild();
  xr.become(false);
  const leaving = session.rebuild();
  await Promise.all([entering, leaving]);

  assert.deepEqual(session.refs(), plugin.live(), 'every surviving ref names a live cell');
  assert.equal(session.refs().length, 3, 'exactly one set of plates, not two and not none');
  assert.equal(new Set(session.refs()).size, session.refs().length, 'no duplicate refs');
  assert.equal(session.busy(), false);
});

// The half `0cf026b` missed. The old subscriber gated on the ref list being
// non-empty, and `removeComponentLabels` emptied that list synchronously
// before awaiting its deletes — so for the whole of an in-flight rebuild the
// viewer answered "no plates to resize" and the edge was declined with nothing
// left to re-fire. The wearer finished the session looking at desktop-sized
// plates, which on a Quest 2 is the same as looking at none.
test('a session edge that lands inside a rebuild still ends with XR-sized plates', async () => {
  const h = harness({ presenting: false });
  const release = h.hold();
  const rebuilding = h.session.rebuild();

  // Mid-build the ref list is empty by design. This is precisely the reading
  // the old gate trusted, so the session has to answer the question a
  // different way.
  assert.deepEqual(h.session.refs(), [], 'the ref list is empty while a rebuild is in flight');
  assert.equal(h.session.busy(), true);
  assert.equal(h.session.active(), true, 'but the plates are still live as far as a caller is concerned');

  h.xr.become(true);
  release();
  await rebuilding;

  assert.equal(h.liveSizing(), true, 'the plates the wearer is left with were built for the headset');
  assert.deepEqual(h.session.refs(), h.plugin.live());
  assert.equal(h.session.refs().length, 3);
  assert.equal(h.built.length, 2, 'the interrupted build is redone, once');
});

test('a rebuild asked for while one is running coalesces into a single follow-up', async () => {
  const h = harness();
  const release = h.hold();
  const first = h.session.rebuild();
  // Five callers, one follow-up: a chapter, a selection and a quality change
  // can all land together and must not cost five geometry builds.
  const rest = [h.session.rebuild(), h.session.rebuild(), h.session.rebuild(), h.session.rebuild()];
  release();
  await Promise.all([first, ...rest]);
  assert.equal(h.built.length, 2, 'the running build, then one pass for everything that asked during it');
  assert.deepEqual(h.session.refs(), h.plugin.live());
});

test('a rebuild nobody wants takes the plates down and builds nothing back', async () => {
  const h = harness();
  await h.session.rebuild();
  assert.equal(h.session.refs().length, 3);

  h.setWanted(false);
  await h.session.rebuild();
  assert.deepEqual(h.session.refs(), []);
  assert.deepEqual(h.plugin.live(), [], 'no orphan cells are left on the state tree');
  assert.equal(h.session.active(), false);
});

test('a session edge with no plates wanted costs no build at all', async () => {
  const h = harness();
  h.setWanted(false);
  await h.session.rebuild();
  assert.equal(h.built.length, 0);
});

test('remove takes every plate down, and a rebuild asked for first does not undo it', async () => {
  const h = harness();
  await h.session.rebuild();
  const release = h.hold();
  const rebuilding = h.session.rebuild();
  // The newest request is the live statement of intent. A teardown that says
  // "take them down" after a chapter asked for a rebuild must win, or dispose
  // leaves plates hanging off a structure that is being cleared.
  const removing = h.session.remove();
  release();
  await Promise.all([rebuilding, removing]);
  assert.deepEqual(h.session.refs(), []);
  assert.deepEqual(h.plugin.live(), []);
});

test('adopt hands the live refs to a caller that will delete them itself', async () => {
  const h = harness();
  await h.session.rebuild();
  const orphans = h.session.adopt();
  assert.equal(orphans.length, 3);
  assert.deepEqual(h.session.refs(), [], 'the session no longer claims plates it has given away');
  // The source swap is synchronous and cannot await; the cells stay until it
  // sweeps them, which is why they are handed over rather than dropped.
  assert.equal(h.plugin.live().length, 3);
});

// The half `adopt` could not see. A source swap is synchronous and takes the
// live refs to delete itself -- but mid-rebuild there are none to take, by
// design, so the swap took nothing and the running pass then handed back plates
// built against the structure that had just been replaced. They are root-level
// cells no subtree delete reaches, and every later rebuild addressed them
// against a state tree they do not belong to.
test('a source swap inside a rebuild discards the plates that pass was building', async () => {
  const h = harness();
  const release = h.hold();
  const rebuilding = h.session.rebuild();

  // The swap lands with the build held open, which is the whole race.
  const orphans = h.session.adopt();
  assert.deepEqual(orphans, [], 'there were no live refs to hand over mid-rebuild');
  // A new structure is a new lesson, and the viewer turns the plates off with
  // the swap. The generation is what makes this safe either way.
  h.setWanted(false);

  release();
  await rebuilding;

  assert.deepEqual(h.session.refs(), [], 'the session claims no plate built on the old structure');
  assert.deepEqual(h.plugin.live(), [], 'and the cells it built are off the state tree');
  assert.equal(h.session.active(), false);
});

// The same swap on a session that still wants plates: the discarded pass must
// not leave the wearer with none, so the follow-up builds against the new
// structure rather than the page waiting for something else to ask.
test('a swap inside a rebuild still ends with one live set of plates', async () => {
  const h = harness();
  const release = h.hold();
  const rebuilding = h.session.rebuild();
  h.session.adopt();
  release();
  await rebuilding;

  assert.deepEqual(h.session.refs(), h.plugin.live(), 'every surviving ref names a live cell');
  assert.equal(h.session.refs().length, 3);
  assert.equal(new Set(h.session.refs()).size, h.session.refs().length, 'no duplicate refs');
  assert.equal(h.session.busy(), false);
});

test('a swap that lands before the build leaves that build alone', async () => {
  const h = harness();
  await h.session.rebuild();
  h.session.adopt();
  // Nothing is in flight, so the next rebuild reads the new structure from the
  // start and its plates are the new structure's. Discarding them would cost a
  // wearer their plates on every swap.
  await h.session.rebuild();
  assert.deepEqual(h.session.refs(), h.plugin.live());
  assert.equal(h.session.refs().length, 3);
});

test('a rejected relayout retains the basis-carrying build without solving again', async () => {
  const basis = { eye: [150, 0, 0] }, built = [];
  let release, updates = 0;
  const held = new Promise(resolve => { release = resolve; });
  const session = createComponentLabelSession({
    isPresenting: () => true, wantsLabels: () => true,
    async buildPlates(context) {
      built.push(context);
      if (built.length === 1) await held;
      return ['plate'];
    },
    deletePlates: async () => {},
    updatePlates: async () => { updates++; return false; },
  });
  const rebuilding = session.rebuild('entry', basis);
  assert.equal(built.length, 1, 'the basis-carrying job has been dequeued');
  const moving = session.relayout('menu-move');
  release();
  await assert.rejects(Promise.all([rebuilding, moving]), /Plate update rejected/);
  assert.equal(updates, 1, 'the follow-up tries an in-place update');
  assert.equal(built.length, 1, 'the failed update cannot run a second solver');
  assert.equal(built[0].seatBasis, basis);
  assert.deepEqual(session.refs(), ['plate']);
});

test('a session edge during a basis-carrying build preserves the basis for its follow-up', async () => {
  const basis = { eye: [150, 0, 0] }, built = [];
  let release, presenting = false;
  const held = new Promise(resolve => { release = resolve; });
  const session = createComponentLabelSession({
    isPresenting: () => presenting, wantsLabels: () => true,
    async buildPlates(context) {
      built.push(context);
      if (built.length === 1) await held;
      return ['plate'];
    },
    deletePlates: async () => {},
  });
  const rebuilding = session.rebuild('entry', basis);
  presenting = true;
  release();
  await rebuilding;
  assert.equal(built.length, 2);
  assert.equal(built[1].presenting, true);
  assert.equal(built[1].seatBasis, basis);
});

for (const stage of ['queued', 'deleting', 'building']) {
  test(`adoption drops an old source's seat basis while ${stage}`, async () => {
    const basis = { eye: [150, 0, 0] }, built = [];
    let source = 'old', release, reached, hold = false;
    const held = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { reached = resolve; });
    const session = createComponentLabelSession({
      isPresenting: () => true, wantsLabels: () => true,
      async buildPlates(context) {
        built.push({ source, ...context });
        if (hold && stage === 'building') { reached(); await held; }
        return [source];
      },
      async deletePlates() {
        if (hold && stage !== 'building') { reached(); await held; }
      },
    });
    await session.rebuild();
    hold = true;
    const rebuilding = session.rebuild('entry', stage === 'queued' ? undefined : basis);
    await entered;
    if (stage === 'queued') session.rebuild('tracked-entry', basis);
    source = 'new';
    session.adopt();
    release();
    await rebuilding;
    const newBuilds = built.filter(build => build.source === 'new');
    assert.ok(newBuilds.length, 'the new source still builds');
    assert.ok(newBuilds.every(build => build.seatBasis === undefined), 'old scene units cannot reach a new source');
    assert.deepEqual(session.refs(), ['new']);
  });
}

test('a build that throws leaves no ref naming a cell that is not there', async () => {
  const plugin = fakePlugin();
  let fail = true;
  const session = createComponentLabelSession({
    isPresenting: () => false,
    wantsLabels: () => true,
    async buildPlates() {
      await Promise.resolve();
      if (fail) throw Error('the commit lost its context');
      plugin.add('stereofold-component-labels-0');
      return ['stereofold-component-labels-0'];
    },
    async deletePlates(refs) { for (const ref of refs) { await Promise.resolve(); plugin.delete(ref); } },
  });

  await assert.rejects(session.rebuild(), /lost its context/);
  assert.deepEqual(session.refs(), []);
  assert.equal(session.busy(), false, 'a failed rebuild does not wedge the queue');

  // And the next caller still gets a rebuild rather than a stuck session.
  fail = false;
  await session.rebuild();
  assert.deepEqual(session.refs(), plugin.live());
});

test('a rejected menu update drains the queued molecular change before rejecting callers', async () => {
  const plugin = fakePlugin();
  const failure = Error('the layout commit lost its context');
  let part = 'old', builds = 0, updates = 0, rejectUpdate;
  const session = createComponentLabelSession({
    isPresenting: () => true, wantsLabels: () => true,
    async buildPlates() {
      builds++;
      plugin.add(part);
      return [part];
    },
    async deletePlates(refs) { for (const ref of refs) plugin.delete(ref); },
    updatePlates: () => {
      updates++;
      return new Promise((_resolve, reject) => { rejectUpdate = reject; });
    },
  });
  await session.rebuild();
  const updating = session.relayout('collapse,reseat');
  await Promise.resolve(); // the update has started; subsequent requests are follow-ups
  part = 'new';
  const rebuilding = session.rebuild('part-change');
  const movingAgain = session.relayout('reseat');
  assert.equal(rebuilding, updating, 'callers share the serialized drain');
  assert.equal(movingAgain, updating);
  const settled = Promise.allSettled([updating, rebuilding, movingAgain]);
  rejectUpdate(failure);
  const results = await settled;
  assert.ok(results.every(result => result.status === 'rejected' && result.reason === failure));
  assert.equal(session.busy(), false);
  assert.deepEqual(session.refs(), ['new'], 'the queued part change needs no further request');
  assert.deepEqual(plugin.live(), ['new'], 'the stale cells were deleted');
  assert.equal(builds, 2, 'the queued molecular change rebuilds once');
  assert.equal(updates, 1, 'a later menu move cannot downgrade the queued rebuild');
});

// The viewer's half of the same defect is guarded at the source, in
// `lesson-emphasis.test.mjs` — "every name-plate rebuild in the viewer goes
// through the one session". `viewer.mjs` imports a dozen Mol* modules and needs
// a WebGL context, so nothing in this lab can execute the two decisions that
// matter: the session edge gating on `active()` rather than on a ref count that
// is empty for the whole of a rebuild, and `onPresented`/`onLeavingPresentation`
// declining the plates so only one path rebuilds them across that edge. Both
// reversions are caught there; do not add a second copy here.

test('a session needs every one of its four collaborators', () => {
  const ok = { isPresenting: () => false, wantsLabels: () => false, buildPlates: async () => [], deletePlates: async () => {} };
  for (const missing of Object.keys(ok)) {
    assert.throws(() => createComponentLabelSession({ ...ok, [missing]: undefined }),
      new RegExp(`needs a ${missing} function`));
  }
});


// The shipped lesson, passed through the same state and rebuild owners as the viewer.
async function lessonPlates(install = true) {
  const demo = JSON.parse(readFileSync(new URL('../../plugin/demos/telomerase-haca.json', import.meta.url), 'utf8'));
  const baseline = demo.chapters[0].immersive;
  let emphasis = baseline.emphasis;
  let origin = 'resting';
  const cells = new Map();
  const session = createComponentLabelSession({
    isPresenting: () => true,
    wantsLabels: () => platesWanted(lesson.state(), lesson.labelsEnabled(), origin),
    async buildPlates() {
      const plan = planComponentLabels(emphasis, ({ chain }) => [chain]);
      for (const part of plan.colours) cells.set(part.id, part.opacity);
      return [...cells.keys()];
    },
    async deletePlates(refs) { for (const ref of refs) cells.delete(ref); },
  });
  const lesson = createLessonResting({
    async emphasize(request) { origin = request.origin; emphasis = request; await session.rebuild(); },
    snapshot: () => ({}), rebuildLabels: () => session.rebuild(),
    getEmphasis: () => emphasis, getOrigin: () => origin,
  });
  if (install) await lesson.install({ emphasis, componentLabels: true });
  return { lesson, session, cells,
    async focus() {
      // A command takes ownership before its mutation; the live flag is off.
      origin = 'command';
      lesson.setLabelsEnabled(false);
      emphasis = { ...emphasis, focus: ['tcab1-k'], contextOpacity: 0.35 };
      await lesson.clear();
      await session.rebuild();
    },
  };
}

test('the component key retains TCAB1 full and nine context entries for desktop fading', async () => {
  const h = await lessonPlates();
  assert.equal(h.cells.size, 10);
  assert.ok([...h.cells.values()].every(opacity => opacity === 1));
  await h.focus();
  assert.equal(h.session.refs().length, 10);
  assert.equal(h.cells.get('tcab1-k'), 1);
  assert.equal([...h.cells].filter(([id, opacity]) => id !== 'tcab1-k' && opacity === 0.35).length, 9);
});

test('forgetting or clearing a lesson removes command-owned plates', async () => {
  for (const clear of [false, true]) {
    const h = await lessonPlates();
    await h.focus();
    if (clear) await h.lesson.install(undefined);
    else { h.lesson.forget(); await h.session.rebuild(); }
    assert.deepEqual(h.session.refs(), []);
    assert.equal(h.cells.size, 0);
  }
});

test('no installed lesson and labels off builds no plates', async () => {
  const h = await lessonPlates(false);
  await h.focus();
  assert.equal(h.session.passes(), 0);
  assert.equal(h.cells.size, 0);
});

test('an unresolved focus leaves the remaining plates at full strength', () => {
  const emphasis = { parts: [
    { id: 'a', chain: 'A', color: '#ffffff' }, { id: 'b', chain: 'B', color: '#ffffff' },
  ], focus: ['b'], contextOpacity: 0.35 };
  const plan = planComponentLabels(emphasis, ({ chain }) => chain === 'A' ? ['A:1'] : []);
  assert.deepEqual(plan.colours.map(part => [part.id, part.opacity]), [['a', 1]]);
});

test('a part lit beside the focus keeps its plate at the strength of its paint', () => {
  const emphasis = { parts: [
    { id: 'a', chain: 'A', color: '#ffffff' }, { id: 'b', chain: 'B', color: '#ffffff' }, { id: 'c', chain: 'C', color: '#ffffff' },
  ], focus: ['b'], alsoLit: ['c'], contextOpacity: 0.35 };
  const plan = planComponentLabels(emphasis, ({ chain }) => [`${chain}:1`]);
  assert.deepEqual(plan.colours.map(part => [part.id, part.opacity]), [['a', 0.35], ['b', 1], ['c', 1]]);
});

test('a faded desktop label keeps its backing at the existing floor', () => {
  assert.deepEqual(componentLabelAlpha({ placeAlpha: 1, contextAlpha: 0.18 }),
    { textAlpha: 0.18, backingAlpha: COMPONENT_LABEL_BACKING_ALPHA_FLOOR });
  assert.deepEqual(componentLabelAlpha({ placeAlpha: 0.35, contextAlpha: 0.9 }),
    { textAlpha: 0.35, backingAlpha: COMPONENT_LABEL_BACKING_ALPHA_FLOOR });
  assert.deepEqual(componentLabelAlpha({ placeAlpha: 1, contextAlpha: 1 }),
    { textAlpha: 1, backingAlpha: 1 });
});

/** Relative luminance, for saying which of two colours a reader sees first. */
const luminance = colour => {
  const channel = shift => {
    const value = ((colour >> shift) & 0xff) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
};
/** WCAG contrast ratio between two packed colours. */
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};

test('one primitive owns the plate ink and white backing at the same depth', () => {
  const paint = componentLabelPaint({ color: 0xea580c, offsetZ: 50 });
  // Beside its part, the plate's colour key is built but never drawn.
  assert.deepEqual(Object.keys(paint), ['backing', 'key']);
  assert.equal(paint.key.alpha, 0);
  assert.equal(paint.backing.textColor, COMPONENT_LABEL_INK);
  assert.equal(paint.backing.backgroundColor, 0xffffff);
  assert.equal(paint.backing.backgroundOpacity, COMPONENT_LABEL_GLASS_OPACITY);
  assert.equal(paint.backing.background, true);
  assert.equal(paint.backing.offsetZ, 50);
  assert.equal(paint.backing.tether, false);
  assert.equal(paint.backing.borderWidth, 0);
  assert.ok(contrast(COMPONENT_LABEL_INK, COMPONENT_LABEL_GLASS) > 7);
});

test('a plate placed away from its part carries the part colour as an edge, so a band reads as a legend', () => {
  const part = 0x7c3aed;
  for (const presenting of [true, false]) {
    const beside = componentLabelPaint({ color: part, offsetZ: 50, presenting });
    // A plate beside its part is unchanged: one translucent white primitive.
    // Its key is built, at alpha zero, which Mol* never draws.
    assert.deepEqual(componentLabelPaint({ color: part, offsetZ: 50, presenting, detached: false }), beside);
    assert.equal(beside.key.alpha, 0);
    assert.equal(beside.backing.backgroundMargin, presenting ? 0.5 : 0.25);
    assert.equal(beside.backing.backgroundOpacity, COMPONENT_LABEL_GLASS_OPACITY);

    const away = componentLabelPaint({ color: part, offsetZ: 50, presenting, detached: true });
    assert.deepEqual(Object.keys(away), ['backing', 'key']);
    // The key's glass is the part's own colour, opaque. Its copy of the name
    // is white, so where text.frag pulls those glyphs in front of the white
    // plate they land white on white: no shadow of the name shows.
    assert.equal(away.key.backgroundColor, part);
    assert.equal(away.key.textColor, COMPONENT_LABEL_GLASS);
    assert.equal(away.key.borderColor, part);
    assert.equal(away.key.backgroundOpacity, 1);
    assert.equal(away.key.background, true);
    assert.equal(away.key.tether, false);
    assert.equal(away.key.alpha, away.backing.alpha);
    // It fills the plate's own footprint, so the layout's rectangle is still
    // the drawn one; the white glass inside it shrinks to leave the edge.
    assert.equal(away.key.backgroundMargin, beside.backing.backgroundMargin);
    const edgeEm = (away.key.backgroundMargin - away.backing.backgroundMargin) / 2.5 / 0.8;
    assert.ok(edgeEm >= (presenting ? 0.17 : 0.08), `edge ${edgeEm} em`);
    assert.ok(away.backing.backgroundMargin > 0, 'the name keeps some white around it');
    // The name stays dark ink on white, now opaque so the key never tints it.
    assert.equal(away.backing.textColor, COMPONENT_LABEL_INK);
    assert.equal(away.backing.backgroundColor, COMPONENT_LABEL_GLASS);
    assert.equal(away.backing.backgroundOpacity, 1);
    // Just behind the plate: no depth buffer calls them equal, and no eye
    // sees a gap between them.
    assert.ok(away.key.offsetZ < away.backing.offsetZ && away.key.offsetZ >= 0.99 * away.backing.offsetZ);
    assert.equal(away.backing.offsetZ, 50);
  }
  // Dimmed on the desktop, the key fades with its plate.
  const dimmed = componentLabelPaint({ color: part, contextAlpha: 0.25, detached: true });
  assert.equal(dimmed.key.alpha, COMPONENT_LABEL_BACKING_ALPHA_FLOOR);
  // A part with no colour has no key to show.
  const plain = componentLabelPaint({ detached: true, offsetZ: 50, presenting: true });
  assert.deepEqual(Object.keys(plain), ['backing']);
  assert.equal(plain.backing.backgroundMargin, 0.5);
});

test('a desktop label retains the existing alpha floor when its context fades', () => {
  assert.equal(componentLabelPaint({ placeAlpha: 1, contextAlpha: 1 }).backing.alpha, 1);
  assert.equal(componentLabelPaint({ placeAlpha: 1, contextAlpha: 0.25 }).backing.alpha,
    COMPONENT_LABEL_BACKING_ALPHA_FLOOR);
  assert.equal(componentLabelPaint({ offsetZ: NaN }).backing.offsetZ, 0);
});

test('a plate shows a name the wearer can take in at a glance', () => {
  // The shipped telomerase lesson, part by part.
  assert.equal(componentPlateName('Dyskerin (DKC1), first copy'), 'Dyskerin 1');
  assert.equal(componentPlateName('Dyskerin (DKC1), second copy'), 'Dyskerin 2');
  assert.equal(componentPlateName('NOP10, first copy'), 'NOP10 1');
  assert.equal(componentPlateName('NOP10, second copy'), 'NOP10 2');
  assert.equal(componentPlateName('NHP2, first copy'), 'NHP2 1');
  assert.equal(componentPlateName('GAR1, second copy'), 'GAR1 2');
  assert.equal(componentPlateName('Telomerase RNA H/ACA domain'), 'Telomerase RNA H/ACA');
  assert.equal(componentPlateName('TCAB1'), 'TCAB1');
  // Every one of them fits inside the widest plate the fan will draw, which
  // the authored names did not: at the resting size "Telomerase RNA H/ACA
  // domain" is a rectangle wider than the structure it names.
  for (const name of ['Dyskerin 1', 'NOP10 2', 'Telomerase RNA H/ACA', 'TCAB1']) {
    assert.ok(name.length <= 20, `${name} is still ${name.length} characters`);
  }
});

test('shortening a name never leaves the plate blank or loses the part', () => {
  assert.equal(componentPlateName('  Cas9   (SpCas9) ,  third copy '), 'Cas9 3');
  assert.equal(componentPlateName('Nucleosome copy 2'), 'Nucleosome 2');
  assert.equal(componentPlateName('Tubulin beta subunit'), 'Tubulin beta');
  // Nothing to shorten is left exactly as it was.
  assert.equal(componentPlateName('hTR'), 'hTR');
  // A name that is nothing BUT the parts this strips keeps the authored name,
  // because an empty plate is worse than a long one.
  assert.equal(componentPlateName('(DKC1)'), '(DKC1)');
  assert.equal(componentPlateName('domain'), 'domain');
  assert.equal(componentPlateName(''), '');
  assert.equal(componentPlateName(undefined), '');
});

test('plates a failed build stranded are deleted first by the next pass, even one that builds nothing', async () => {
  const tree = new Set(), deletes = [];
  let wanted = true, failDeletes = 0, builds = 0;
  const session = createComponentLabelSession({
    isPresenting: () => false, wantsLabels: () => wanted,
    async buildPlates({ strand }) {
      builds += 1;
      if (builds > 1) { tree.add('plate-0'); return ['plate-0']; }
      // A partial build whose own cleanup could not delete what it committed.
      tree.add('plate-0'); tree.add('plate-1');
      strand(['plate-0', 'plate-1']);
      throw Error('plate_commit_failed');
    },
    async deletePlates(refs) {
      deletes.push([...refs]);
      if (failDeletes > 0) { failDeletes -= 1; throw Error('delete_failed'); }
      for (const ref of refs) tree.delete(ref);
    },
  });
  await assert.rejects(session.rebuild(), /plate_commit_failed/);
  assert.deepEqual(session.refs(), []);
  assert.equal(session.active(), true, 'stranded plates are still drawn');
  // A recovery that wants no plates still runs a pass, and a failed retire rejects it.
  wanted = false; failDeletes = 1;
  await assert.rejects(session.rebuild(), /delete_failed/);
  assert.equal(session.active(), true);
  await session.rebuild();
  assert.deepEqual(deletes, [['plate-0', 'plate-1'], ['plate-0', 'plate-1']]);
  assert.deepEqual([...tree], []); assert.equal(session.active(), false);
  // The next build reuses plate-0 for a live plate; nothing stranded remains to delete it.
  wanted = true;
  await session.rebuild(); await session.rebuild();
  assert.deepEqual(session.refs(), ['plate-0']); assert.equal(tree.has('plate-0'), true);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const nextTask = () => new Promise(resolve => setImmediate(resolve));

test('cancelled release relayout queued before start leaves committed plates untouched', async () => {
  let current = true, updates = 0;
  const session = createComponentLabelSession({ isPresenting: () => true, wantsLabels: () => true,
    buildPlates: async () => ['plate'], deletePlates: async () => { throw Error('unexpected delete'); },
    updatePlates: async () => { updates++; return true; } });
  await session.rebuild();
  const pending = session.relayout('placement', { isCurrent: () => current }); current = false;
  await pending; assert.equal(updates, 0); assert.deepEqual(session.refs(), ['plate']);
});

for (const during of ['delete', 'build']) test(`cancelled release during destructive ${during} fallback still repairs wanted labels`, async () => {
  let current = true, gate, live = [], buildCount = 0;
  const session = createComponentLabelSession({ isPresenting: () => true, wantsLabels: () => true,
    async buildPlates() { if (during === 'build' && gate) await gate.promise; buildCount++; live = ['plate']; return [...live]; },
    async deletePlates() { live = []; if (during === 'delete' && gate) await gate.promise; } });
  await session.rebuild(); gate = deferred();
  const pending = session.relayout('placement', { isCurrent: () => current }); await nextTask();
  current = false; gate.resolve(); await pending;
  assert.deepEqual(live, ['plate']); assert.deepEqual(session.refs(), ['plate']); assert.equal(buildCount, 2);
});

test('a cancelled optional placement cannot suppress a queued mandatory source rebuild', async () => {
  let current = true, builds = 0;
  const session = createComponentLabelSession({ isPresenting: () => true, wantsLabels: () => true,
    buildPlates: async () => { builds++; return ['new-source']; }, deletePlates: async () => {} });
  await session.transaction(async () => {
    await session.rebuild('source');
    await session.relayout('placement', { isCurrent: () => current }); current = false;
  });
  assert.equal(builds, 1); assert.deepEqual(session.refs(), ['new-source']);
});

test('cancelled in-flight update cannot adopt or repair the old source after source adoption', async () => {
  let current = true, source = 'old', activeGuard, gate = deferred(), updates = 0;
  const deleted = [], built = [];
  const session = createComponentLabelSession({ isPresenting: () => true, wantsLabels: () => true,
    buildPlates: async () => { built.push(source); return [source]; }, deletePlates: async refs => deleted.push(...refs),
    async updatePlates(_refs, _reason, guard) { updates++; activeGuard = guard; await gate.promise; return true; } });
  await session.rebuild(); const pending = session.relayout('placement', { isCurrent: () => current });
  await nextTask(); assert.equal(activeGuard.isCurrent(), true);
  current = false; assert.deepEqual(session.adopt(), ['old']); source = 'new';
  const next = session.rebuild('source'); gate.resolve(); await pending; await next;
  assert.equal(activeGuard.isCurrent(), false); assert.equal(updates, 1);
  assert.deepEqual(session.refs(), ['new']); assert.deepEqual(built, ['old', 'new']); assert.deepEqual(deleted, []);
});


test('XR telomerase chapters 1 and 4 draw only full-contrast emphasis plates; desktop keeps context', () => {
  const demo = JSON.parse(readFileSync(new URL('../../plugin/demos/telomerase-haca.json', import.meta.url), 'utf8'));
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  for (const index of [0, 3]) {
    const emphasis = { ...demo.chapters[index].immersive.emphasis, parts: demo.chapters[0].immersive.emphasis.parts };
    const resolve = ({ chain }) => [chain];
    const key = planComponentLabels(emphasis, resolve), plan = planLessonEmphasis(emphasis, resolve);
    const h = vm.createContext({ canvas: { xr: { isPresenting: { value: true } } },
      componentLabelKeyPlan: () => key, hiddenSceneKeySet: () => new Set() });
    vm.runInContext(pageFunction(viewer, 'componentLabelPlateParts'), h);
    const parts = h.componentLabelPlateParts(plan);
    assert.equal(parts.length, 10, 'keep context geometry available for emphasis-only repaint');
    const visible = [];
    for (const part of parts) {
      const contextAlpha = key.colours.find(entry => entry.id === part.id)?.opacity ?? 1;
      if (contextAlpha >= 1) visible.push(part.id);
      for (const placeAlpha of [0.25, 0.6, 1])
        assert.equal(componentLabelPaint({ presenting: true, placeAlpha, contextAlpha }).backing.alpha, contextAlpha >= 1 ? 1 : 0);
    }
    assert.equal(visible.length, index === 0 ? 10 : 2);
    assert.deepEqual(visible.sort(), key.colours.filter(part => part.opacity >= 1).map(part => part.id).sort());
    h.canvas.xr.isPresenting.value = false;
    assert.equal(h.componentLabelPlateParts(plan).length, 10);
  }
  assert.equal(componentLabelPaint({ presenting: true, contextAlpha: .12 }).backing.alpha, 0);
  assert.equal(componentLabelPaint({ presenting: true, placeAlpha: 0 }).backing.alpha, 0);
  assert.equal(componentLabelPaint({ contextAlpha: .12 }).backing.alpha, .6);
});
