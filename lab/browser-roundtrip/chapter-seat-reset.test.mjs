import test from 'node:test';
import assert from 'node:assert/strict';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { lessonSeatSession } from './fixtures/lesson-seat-session.mjs';
import { solveAppearanceFit } from './appearance-fit-worker.mjs';
import { normalizePlacement } from './inspection-state.mjs';

// Telomerase's close-up chapter in the headset, with the real toolbar and its
// clearance proof. The agent moves the molecule aside, then asks for the
// chapter's own seat back. The chapter opened at that seat; putting the
// molecule back there is never refused for covering the menu: the glass
// yields, as it did when the chapter opened.

const runtime = await toolbarFrameRuntime();
const cache = process.env.STEREOFOLD_DEMO_CACHE;

async function closeUp(head = [0, 0, 0]) {
  const s = await lessonSeatSession(runtime);
  const { h, t } = s;
  // The page keeps its placement normalized, as `inspection-state.mjs` does.
  const place = h.inspectionState.place;
  h.inspectionState.place = (patch, action) => place(normalizePlacement(patch, h.inspectionSnapshot().placement), action);
  // The agent's `update_inspection` placement runs the page's own
  // `placeInspection` and stereo clearance proof, through the toolbar.
  s.solves = 0;
  Object.assign(h, { fitAppearanceInWorker: async options => { s.solves++; return solveAppearanceFit(options); }, placementViewWaiters: new Set(),
    noteAtomSphereMeshes: value => value, companionRecord: null, representation: null, ligandOverlay: null, componentLabels: { ...h.componentLabels, transaction: async fn => fn(), relayout: async () => {} } });
  Object.assign(h.immersiveSession, {
    toolbarAction: action => t.toolbar.runAction(action, { origin: 'programmatic' }),
    toolbarRelocationCandidates: pose => t.toolbar.prepareRelocation?.(pose) ?? [],
    relocateToolbar: candidate => t.toolbar.commitRelocation?.(candidate),
    menuDraggedByWearer: () => t.toolbar.menuDraggedByWearer(),
    // The page's toolbar reads the live placement hold; this session hands it over first.
    refreshToolbar: options => { s.publish(); return t.toolbar.update(options); } });
  await s.open('4HHB');
  await s.open('telomerase-haca');
  s.moveHead(head);
  await s.start();
  for (let i = 1; i < 4; i++) await s.chapter(i);
  // The placement proof reads the drawn chapter as vertices: every atom the
  // chapter shows, carried by the presentation transform.
  const cell = value => ({ ref: { value } });
  const asMesh = object => {
    const group = object.values.tPositionGroup.ref.value.array, count = group.length / 4, positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) positions.set(group.subarray(i * 4, i * 4 + 3), i * 3);
    return { type: 'mesh', state: { visible: true }, values: { aPosition: cell(positions), aTransform: object.values.aTransform,
      instanceCount: cell(1), uVertexCount: cell(count), drawCount: cell(count) } };
  };
  const figure = h.lessonFigure;
  h.lessonFigure = { ...figure, placement: () => h.scientificRepresentations()
    .map(repr => ({ renderObjects: repr.renderObjects.map(asMesh) })) };
  return s;
}
const settled = async s => { s.publish(); await s.t.toolbar.update(); await s.settle(); s.publish(); await s.t.toolbar.update(); await s.settle(); };
const agentPlace = async (s, patch) => { await s.h.placeInspection(patch); await settled(s); };
// The controls never cover the molecule; the card covers no more of it
// than it did when the chapter opened; no glass lies on other glass.
function asOpened(measured, opened, where) {
  measured.forEach((eye, i) => {
    assert.deepEqual(eye.glassOverGlass, [], `${where}, ${eye.eye} eye: one glass plate over another`);
    for (const name of ['menu', 'status'])
      assert.equal(eye.atomsUnder[name] ?? 0, 0, `${where}, ${eye.eye} eye: ${name} glass over ${eye.atomsUnder[name]} atoms`);
    assert.ok((eye.atomsUnder.card ?? 0) <= (opened[i].atomsUnder.card ?? 0),
      `${where}, ${eye.eye} eye: card over ${eye.atomsUnder.card} atoms, ${opened[i].atomsUnder.card ?? 0} when the chapter opened`);
  });
}
const under = measured => JSON.stringify(measured.map(eye => eye.atomsUnder));
// The one refusal a put-back with no redraw may give: a lesson's glass
// would not hide and stayed drawn over the structure. A seat that drew other
// glass than it was checked as ("The menu changed while checking its new
// seat") is a fault, not this answer.
const GLASS_KEPT = "The molecule is back on the chapter's seat, but the menu could not be shown clear of it. The menu stayed where it covers the structure.";

// Where the wearer's head was when the lesson started, and how far (in the
// placement's own units, as `update_inspection` takes them) the agent moved
// the molecule. Each of these left glass the chapter seat could not clear by
// the explicit-pose proof alone.
const CASES = [[[0, 0, 0], [-.3, 0]], [[.3, 0, 0], [-.6, 0]], [[-.3, 0, 0], [-.6, 0]], [[0, -.15, 0], [.3, 0]]];
// Two of these have one answer only. With the head turned right, the menu
// covered the molecule when the chapter opened: offered every seat, it moves
// to a visible one and the put-back succeeds; offered only hiding, the
// lesson's glass refuses to hide and the put-back says so.
const PINNED = new Map([['any seat, head 0.3,0,0, moved -0.6,0', 'moved'], ['hidden only, head 0.3,0,0, moved -0.6,0', 'kept']]);

test('telomerase close-up: the agent puts the molecule back on the chapter seat, and the glass yields', { skip: !cache }, async t => {
  for (const [head, [dx, dy]] of CASES) {
    const s = await closeUp(head);
    const where = `head ${head}, moved ${dx},${dy}`;
    try {
      const seat = s.placement(), opened = s.measure();
      await agentPlace(s, { translation: [seat.translation[0] + dx, seat.translation[1] + dy, seat.translation[2]] });
      assert.equal(s.h.wearerPlacement.state().reason, 'agent-placement', where);
      // Measured the moment the command returns: the next command (Next) may
      // come at once, and must not find glass that is still to move.
      await s.h.placeInspection({ translation: seat.translation, scale: seat.scale });
      const back = s.measure();
      t.diagnostic(`${where}: opened ${under(opened)}, back ${under(back)}`);
      assert.deepEqual(s.placement(), seat, `${where}: the molecule is back on the chapter seat`);
      assert.equal(s.h.wearerPlacement.holdsPlacement(), false, `${where}: the chapter owns its seat again`);
      asOpened(back, opened, where);
    } finally { await s.dispose(); }
  }
});

test('a seat the agent never left from is still proven against the glass', { skip: !cache }, async () => {
  // Only a put-back is the chapter's seat. A new pose that merely lies near
  // it is the agent's own and still takes the explicit-pose proof.
  const s = await closeUp([.3, 0, 0]);
  try {
    const seat = s.placement();
    await agentPlace(s, { translation: [seat.translation[0] - .6, seat.translation[1], seat.translation[2]] });
    await assert.rejects(s.h.placeInspection({ translation: [seat.translation[0] + 1e-6, ...seat.translation.slice(1)], scale: seat.scale }),
      /would cover the menu/);
    assert.equal(s.h.wearerPlacement.holdsPlacement(), true);
  } finally { await s.dispose(); }
});

test('beside a menu the wearer dragged, the put-back is proven like any other pose', { skip: !cache }, async () => {
  // A dragged menu is the wearer's and no automatic proof moves it, so the
  // seat is checked against it before the molecule lands there.
  const s = await closeUp();
  try {
    const seat = s.placement();
    await agentPlace(s, { translation: [seat.translation[0] - .3, seat.translation[1], seat.translation[2]] });
    for (const drag of [{ phase: 'begin', id: 'tour', kind: 'grip' }, { phase: 'move', offset: [-.12, -.05, 0] }, { phase: 'end' }])
      assert.equal((await s.t.toolbar.aimSynthetic({ drag })).accepted, true);
    await settled(s);
    assert.equal(s.t.toolbar.menuDraggedByWearer(), true);
    const solves = s.solves;
    const outcome = await s.h.placeInspection({ translation: seat.translation, scale: seat.scale }).then(() => 'placed', error => error.message);
    assert.ok(s.solves > solves, 'the seat was proven against the dragged menu');
    if (outcome === 'placed') for (const eye of s.measure()) assert.equal(eye.atomsUnder.menu ?? 0, 0, `${eye.eye} eye: dragged menu over the molecule`);
    else assert.match(outcome, /would cover the menu/);
  } finally { await s.dispose(); }
});

test('a put-back whose glass cannot redraw answers only once the menu is proven clear of it', { skip: !cache }, async t => {
  // The glass proves itself against the seat by redrawing. When that redraw
  // fails, the seat is proven against the glass as any pose is, or the
  // put-back says it could not be. A menu that moves to a visible seat is
  // proof; a lesson's glass that refuses to hide and stays drawn is not.
  const pinned = [];
  for (const only of ['any seat', 'hidden only'])
    for (const [head, [dx, dy]] of CASES) {
      const s = await closeUp(head);
      const where = `${only}, head ${head}, moved ${dx},${dy}`;
      if (PINNED.has(where)) pinned.push(where);
      try {
        const seat = s.placement(), opened = s.measure();
        await agentPlace(s, { translation: [seat.translation[0] + dx, seat.translation[1] + dy, seat.translation[2]] });
        const { refreshToolbar, toolbarRelocationCandidates, relocateToolbar } = s.h.immersiveSession;
        // The toolbar reads the live hold first, as the real refresh does, then fails.
        s.h.immersiveSession.refreshToolbar = async () => { s.publish(); throw Error('The menu could not redraw.'); };
        if (only === 'hidden only') s.h.immersiveSession.toolbarRelocationCandidates = pose =>
          toolbarRelocationCandidates(pose).filter(candidate => candidate.hide);
        // Every menu seat the recovery commits, and whether the glass stayed.
        const relocations = [];
        s.h.immersiveSession.relocateToolbar = async candidate => {
          const receipt = await relocateToolbar(candidate);
          relocations.push({ hide: candidate.hide === true, kept: receipt?.kept === true });
          return receipt;
        };
        const held = s.t.toolbar.platePoints();
        const outcome = await s.h.placeInspection({ translation: seat.translation, scale: seat.scale })
          .then(() => 'placed', error => error.message);
        Object.assign(s.h.immersiveSession, { refreshToolbar, toolbarRelocationCandidates, relocateToolbar });
        t.diagnostic(`${where}: ${outcome}, menu seats ${JSON.stringify(relocations)}`);
        if (outcome === 'placed') asOpened(s.measure(), opened, where);
        else {
          assert.equal(outcome, GLASS_KEPT, where);
          // The refusal is the glass that stayed, not a seat never tried.
          assert.deepEqual(relocations.at(-1), { hide: true, kept: true }, `${where}: the menu was asked to hide and stayed`);
        }
        if (PINNED.get(where) === 'moved') {
          assert.equal(outcome, 'placed', `${where}: the menu moves to a visible seat and the put-back succeeds`);
          assert.ok(relocations.some(({ hide, kept }) => !hide && !kept), `${where}: the menu moved to a visible seat`);
          const drawn = s.t.toolbar.platePoints();
          assert.ok(drawn.length > 0, `${where}: the menu is drawn, not hidden`);
          assert.notDeepEqual(drawn, held, `${where}: the menu left the seat it covered the molecule from`);
        } else if (PINNED.get(where) === 'kept') {
          assert.equal(outcome, GLASS_KEPT, `${where}: a lesson's glass that will not hide is a refusal`);
          assert.ok(relocations.length > 0 && relocations.every(({ hide }) => hide), `${where}: only hiding was tried`);
        }
      } finally { await s.dispose(); }
    }
  assert.deepEqual(pinned, [...PINNED.keys()], 'both pinned cases ran');
});

test('a put-back whose glass cannot redraw moves the menu to the seat it checked, with the head turned a little', { skip: !cache }, async () => {
  // The menu glass is still the glass the move held when the recovery
  // searches for a seat, and a head at rest has turned a little since it was
  // drawn. The seat the recovery checks is the seat it draws, so the menu
  // moves there and the put-back is answered.
  const s = await closeUp([.3, 0, 0]);
  try {
    const seat = s.placement(), opened = s.measure();
    await agentPlace(s, { translation: [seat.translation[0] - .6, seat.translation[1], seat.translation[2]] });
    const turn = 2 * Math.PI / 180, head = s.h.latestRoomPlacementPose.headInRoom;
    [head[0], head[2], head[8], head[10]] = [Math.cos(turn), -Math.sin(turn), Math.sin(turn), Math.cos(turn)];
    const held = s.t.toolbar.platePoints();
    s.h.immersiveSession.refreshToolbar = async () => { s.publish(); throw Error('The menu could not redraw.'); };
    const outcome = await s.h.placeInspection({ translation: seat.translation, scale: seat.scale })
      .then(() => 'placed', error => error.message);
    assert.equal(outcome, 'placed');
    assert.deepEqual(s.placement(), seat, 'the molecule is back on the chapter seat');
    const drawn = s.t.toolbar.platePoints();
    assert.ok(drawn.length > 0, 'the menu is drawn, not hidden');
    assert.notDeepEqual(drawn, held, 'the menu moved to the seat it checked');
    asOpened(s.measure(), opened, 'turned head');
  } finally { await s.dispose(); }
});
