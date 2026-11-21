import test from 'node:test';
import assert from 'node:assert/strict';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';

// The seat rule without a structure: the clearance proof is a stub that
// moves the glass where a test says the molecule is. What is checked is which
// seat each draw starts from and whether it is proven at all.
const runtime = await toolbarFrameRuntime(new URL('./', import.meta.url));
const head = { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1], position: { x: 0, y: 1.6, z: 0 } };
const near = (a, b) => Boolean(a && b) && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

function session() {
  let moveTo, state = {}, during;
  const proofs = [];
  const f = toolbarFrameHarness(runtime, { state, beforeMenuDraw: async options => {
    proofs.push(options.lesson);
    // Something the page does while the proof is out (a placement lands).
    const pending = during; during = undefined; pending?.();
    return moveTo ? { menuRelocation: { head, anchor: moveTo, constants: runtime.SPATIAL_TOOLBAR_LAYOUT } } : undefined;
  } });
  let placement = { placementMoves: 0, placementHeld: false };
  const publish = next => { state = { voice: { state: 'idle' }, ...placement, ...next }; f.setState(state); };
  return { f, proofs, publish,
    relocateTo: anchor => { moveTo = anchor; },
    whileProving: action => { during = action; },
    hold: () => { placement = { placementMoves: placement.placementMoves + 1, placementHeld: true }; },
    // The lesson's presentation while the next source loads: the outgoing
    // lesson, forced active (`inspection-tour-client.ts`).
    async loading(source, lesson) { publish({ subject: { sourceSha256: source, title: source }, tour: { selectedId: lesson, active: true, navigating: true, sourceTransition: true, step: 0, total: 1, title: 'Loading structure', bodyPage: 'The next structure is being prepared.' } }); await f.toolbar.update(); await settle(); },
    async show(source, lesson) { publish({ subject: { sourceSha256: source, title: source }, tour: lesson && { selectedId: lesson, active: false, step: -1, total: 3 } }); await f.toolbar.update(); await settle(); },
    async start(source, lesson) {
      publish({ subject: { sourceSha256: source, title: source }, tour: { selectedId: lesson, active: true, navigating: true, step: 0, total: 3, title: 'One', bodyPage: 'One.' } });
      await f.toolbar.update({ restoreTourSeat: true, restartTourSeat: true });
      publish({ subject: { sourceSha256: source, title: source }, tour: { selectedId: lesson, active: true, step: 0, total: 3, title: 'One', bodyPage: 'One.' } });
      await f.toolbar.update(); await settle();
    },
    async chapter(source, lesson, step) {
      publish({ subject: { sourceSha256: source, title: source }, tour: { selectedId: lesson, active: true, step, total: 3, title: 'Next', bodyPage: 'Next.' } });
      await f.toolbar.update(); await settle();
    },
    async done(source, lesson) {
      publish({ subject: { sourceSha256: source, title: source }, tour: { selectedId: lesson, active: false, step: -1, total: 0 } });
      await f.toolbar.update({ restoreTourSeat: true }); await settle();
    } };
}

test('Done after the wearer moved the molecule proves its column from the seat the lesson started from', async () => {
  const s = session();
  try {
    await s.show('8OUE', 'lesson-a');
    const resting = s.f.toolbar.seatAnchor();
    s.relocateTo([.5, 1.2, -1.2]);
    await s.start('8OUE', 'lesson-a');
    assert.ok(near(s.f.toolbar.seatAnchor(), [.5, 1.2, -1.2]), 'a chapter seat the solver chose');
    s.relocateTo(undefined);
    // A hand, voice or agent move: the menu keeps its seat while the lesson runs.
    s.hold(); await s.chapter('8OUE', 'lesson-a', 1);
    assert.ok(near(s.f.toolbar.seatAnchor(), [.5, 1.2, -1.2]));
    const before = s.proofs.length;
    await s.done('8OUE', 'lesson-a');
    assert.ok(s.proofs.length > before, 'Done draws a column nobody has seen beside that molecule: it is proven');
    assert.ok(near(s.f.toolbar.seatAnchor(), resting), 'from the seat the lesson started from');
  } finally { await s.f.toolbar.dispose(); }
});

test('the next structure opens from the seat the wearer chose, not where the last lesson ended', async () => {
  const s = session();
  try {
    await s.show('4HHB');
    const entry = s.f.toolbar.seatAnchor();
    await s.show('8OUE', 'lesson-a');
    await s.start('8OUE', 'lesson-a');
    await s.chapter('8OUE', 'lesson-a', 1);
    // Done's column is moved off what the wearer kept in front of them.
    s.relocateTo([.55, 1.1, -1.2]);
    await s.done('8OUE', 'lesson-a');
    await s.show('8OUE', 'lesson-a');
    assert.ok(near(s.f.toolbar.seatAnchor(), [.55, 1.1, -1.2]), 'the same structure keeps it');
    s.relocateTo(undefined);
    await s.show('kinesin', 'lesson-b');
    assert.ok(near(s.f.toolbar.seatAnchor(), entry), 'another structure starts again from the entry seat');
    await s.start('kinesin', 'lesson-b');
    const opened = session();
    await opened.show('4HHB'); await opened.show('kinesin', 'lesson-b'); await opened.start('kinesin', 'lesson-b');
    assert.ok(near(s.f.toolbar.seatAnchor(), opened.f.toolbar.seatAnchor()), 'the lesson opens where it opens first');
    await opened.f.toolbar.dispose();
  } finally { await s.f.toolbar.dispose(); }
});

test('a stage of the same running lesson keeps the seat its chapter has', async () => {
  const s = session();
  try {
    await s.show('4HHB');
    await s.show('kinesin-motion', 'lesson-b');
    s.relocateTo([.5, 1.2, -1.2]);
    await s.start('kinesin-motion', 'lesson-b');
    s.relocateTo(undefined);
    await s.chapter('kinesin-flipbook', 'lesson-b', 1);
    assert.ok(near(s.f.toolbar.seatAnchor(), [.5, 1.2, -1.2]));
  } finally { await s.f.toolbar.dispose(); }
});

test('a structure opening while the last lesson still presents itself starts from the session seat', async () => {
  const s = session();
  try {
    await s.show('4HHB');
    const entry = s.f.toolbar.seatAnchor();
    await s.show('8OUE', 'lesson-a');
    await s.start('8OUE', 'lesson-a');
    s.relocateTo([.55, 1.1, -1.2]);
    await s.done('8OUE', 'lesson-a');
    s.relocateTo(undefined);
    // The new subject can arrive while the presentation still holds lesson-a.
    await s.loading('kinesin', 'lesson-a');
    await s.show('kinesin', 'lesson-b');
    assert.ok(near(s.f.toolbar.seatAnchor(), entry), JSON.stringify(s.f.toolbar.seatAnchor()));
  } finally { await s.f.toolbar.dispose(); }
});

test('a lesson started on a structure already shown keeps its seat through its next stage', async () => {
  const s = session();
  try {
    await s.show('4HHB');
    await s.show('kinesin-motion');
    s.relocateTo([.5, 1.2, -1.2]);
    await s.start('kinesin-motion', 'lesson-b');
    s.relocateTo(undefined);
    await s.loading('kinesin-flipbook', 'lesson-b');
    await s.chapter('kinesin-flipbook', 'lesson-b', 1);
    assert.ok(near(s.f.toolbar.seatAnchor(), [.5, 1.2, -1.2]), JSON.stringify(s.f.toolbar.seatAnchor()));
  } finally { await s.f.toolbar.dispose(); }
});

test('an opening interrupted by a placement still draws, and later notices still reach the glass', async () => {
  const s = session();
  try {
    await s.show('4HHB');
    await s.show('8OUE', 'lesson-a');
    s.relocateTo([.55, 1.1, -1.2]);
    await s.start('8OUE', 'lesson-a');
    await s.done('8OUE', 'lesson-a');
    s.relocateTo(undefined);
    // A placement lands while the opening draw's proof is out.
    s.whileProving(() => { s.hold(); s.publish({ subject: { sourceSha256: 'kinesin', title: 'kinesin' }, tour: { selectedId: 'lesson-b', active: false, step: -1, total: 3 } }); });
    await s.show('kinesin', 'lesson-b');
    const drawn = s.proofs.length;
    s.publish({ subject: { sourceSha256: 'kinesin', title: 'kinesin, cartoon' }, tour: { selectedId: 'lesson-b', active: false, step: -1, total: 3 } });
    await s.f.toolbar.update(); await settle();
    assert.ok(s.proofs.length > drawn, 'a host notice after the opening is drawn and proven');
    assert.ok(s.f.toolbar.readoutText().some(line => line.includes('kinesin, cartoon')), JSON.stringify(s.f.toolbar.readoutText()));
  } finally { await s.f.toolbar.dispose(); }
});

test('a seat the wearer summons during a lesson is where the next structure opens, not where Done went', async () => {
  const s = session();
  try {
    await s.show('4HHB');
    const entry = s.f.toolbar.seatAnchor();
    await s.show('8OUE', 'lesson-a');
    await s.start('8OUE', 'lesson-a');
    s.f.moveHead(.4);
    s.f.toolbar.runAction({ kind: 'recenter-menu', reason: 'menu' });
    await settle(); await s.f.frames(4); await settle();
    s.f.moveHead(0);
    s.relocateTo([-.5, 1.1, -1.2]);
    await s.done('8OUE', 'lesson-a');
    assert.ok(near(s.f.toolbar.seatAnchor(), [-.5, 1.1, -1.2]));
    s.relocateTo(undefined);
    await s.show('kinesin', 'lesson-b');
    const opened = s.f.toolbar.seatAnchor();
    assert.ok(!near(opened, [-.5, 1.1, -1.2]), 'not the seat Done took');
    assert.ok(Math.abs(opened[0] - entry[0] - .4) < 1e-6, `from where the wearer summoned it: ${JSON.stringify({ opened, entry })}`);
  } finally { await s.f.toolbar.dispose(); }
});
