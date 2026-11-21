import { createAssistantStatus } from './assistant-status.mjs';
import { menuSeatWithinView } from './menu-view-band.mjs';
import { connectionStatus, TALK_LINK_LOST } from './connection-liveness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { measureReplyCard, measureReplyCardClearance, replyCardOffsetAsync } from './reply-card-layout.mjs';
import * as geometry from './spatial-toolbar-geometry.mjs';
import { projectPlateQuad } from './component-label-measurement.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';
import { countObstacleOverlaps } from './label-layout.mjs';
import { emptyLessonFigureBinding } from './fixtures/empty-lesson-figure.mjs';

// The recorded per-eye name plates and field of view of a real headset reply,
// in a canonical head basis (the same replay `reply-card-acceptance` uses).
const capture = JSON.parse(readFileSync(new URL('./fixtures/acceptance-6-show-dyskerin.json', import.meta.url)));
const measured = capture.entries.filter(e => e.kind === 'component-labels-drawn').slice(0, 2).map(e => e.detail);
const views = syntheticViews().map((v, i) => {
  const [l, r, t, b] = measured[i].fov;
  const p = [...v.projectionMatrix];
  p[0] = 2 / (r - l); p[8] = (r + l) / (r - l);
  p[5] = 2 / (t - b); p[9] = (t + b) / (t - b);
  return { ...v, projectionMatrix: p };
});
// A structure around the wearer: its silhouette is the whole glass in each eye,
// which is what `subjectRect` returns for a sphere that reaches the eye's plane.
const fullGlass = measured.map(m => {
  const [l, r, t, b] = m.fov;
  return { ...m, silhouette: [(l + r) / 2, (t + b) / 2, (r - l) / 2, (t - b) / 2] };
});
const surrounded = { views, measured: fullGlass, renderFromRoom: identity(), surrounds: true };
// The same full glass from a structure that fills the view without reaching
// the wearer's plane.
const filled = { views, measured: fullGlass, renderFromRoom: identity(), surrounds: false };
// A menu low and to the right, so the card has an obstacle to clear besides
// the name plates.
const menu = [[.25, -.55, -.9], [.45, -.55, -.9], [.45, -.35, -.9], [.25, -.35, -.9]];

function harness(clearanceSource) {
  const source = readFileSync(new URL('./talk-caption.mjs', import.meta.url), 'utf8');
  const live = new Set(), records = [], quads = [];
  let time = 0, solves = 0;
  const h = vm.createContext({ assistantStatus: createAssistantStatus(), menuSeatWithinView, connectionStatus, TALK_LINK_LOST, ...geometry, measureReplyCard, measureReplyCardClearance,
    replyCardOffsetAsync: (args, options) => { solves++; return replyCardOffsetAsync(args, { ...options, now: () => 0 }); },
    MeshBuilder: { createState: () => ({}), addTriangleWithNormal(s, a, b, c) { quads.push([a, b, c]); }, getMesh: () => ({}) },
    Mesh: { Utils: {} }, TextBuilder: { create: () => ({ add() {}, getText: () => ({}) }) }, Text: { Utils: {} },
    getFontAtlas: () => ({ buffer: 0, lineHeight: 1, get: () => ({ nw: .6 }) }),
    Shape: { create: () => ({}) }, ShapeRepresentation: () => ({ createOrUpdate() {}, destroy() {} }), Color: x => x,
  });
  vm.runInContext('"use strict";\n' + source.replace(/^import .*;$/gm, '').replace(/\bexport /g, ''), h);
  const card = h.createTalkCaption({ plugin: { runTask: async () => {} },
    presentation: { add: r => live.add(r), remove: r => live.delete(r) },
    head: () => ({ position: { x: 0, y: 0, z: 0 }, matrix: identity() }), menuPoints: () => menu,
    clearance: clearanceSource, now: () => time, record: (kind, detail) => records.push({ kind, detail }) });
  return { card, live, records, quads, solves: () => solves, advance: ms => { time = ms; card.frame(); } };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const asRect = r => ({ x: r.x, y: r.y, halfWidth: r.hw, halfHeight: r.hh });
const MESSAGE = "That's the end of the demo. Thanks for watching!";

test('a message to a wearer the structure surrounds is shown whole, clear of the menu and names, for its window', async () => {
  const h = harness(() => surrounded);
  const answers = [];
  h.card.set({ outcome: MESSAGE, holdMs: 6000, onSeat: seat => answers.push(seat) });
  await flush();
  assert.equal(h.live.size, 2, 'plate and text are drawn');
  assert.equal(h.solves(), 1, 'one seat search, as for any reply');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].outcome, 'shown');
  assert.equal(answers[0].fallback, 'surrounded');
  assert.equal(answers[0].holdMs, 6000);
  const corners = h.quads.slice(-2).flat();
  for (let i = 0; i < 2; i++) {
    const projected = projectPlateQuad(corners, views[i]);
    assert.ok(projected.inside > .999999, `${views[i].eye}: the whole card is on the glass`);
    for (const plate of measured[i].rects)
      assert.equal(countObstacleOverlaps([{ rect: asRect(projected.rect) }], [asRect(plate)]), 0, `${views[i].eye}: card covers ${plate.id}`);
  }
  assert.equal(measureReplyCardClearance(corners, menu,
    { ...surrounded, measured: measured.map(m => ({ ...m, silhouette: null })) }).outcome, 'shown',
    'clear of the menu and every name plate in both eyes');
  const seat = h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail;
  assert.equal(seat.outcome, 'shown'); assert.equal(seat.fallback, 'surrounded');
  h.advance(5999); await flush();
  assert.equal(h.live.size, 2, 'it stays for its normal reading window');
  h.advance(6001); await flush();
  assert.equal(h.live.size, 0, 'and then retires');
  assert.ok(h.records.some(e => e.kind === 'caption-retired' && e.detail.holdMs === 6000));
  await h.card.dispose();
});

test('a full glass that does not surround the wearer still keeps the card down and answers not shown', async () => {
  const h = harness(() => filled);
  const answers = [];
  h.card.set({ outcome: MESSAGE, holdMs: 6000, onSeat: seat => answers.push(seat) });
  await flush();
  assert.equal(h.live.size, 0);
  assert.ok(h.records.some(e => e.detail.fallback === 'no-clear-seat'));
  assert.ok(!h.records.some(e => e.detail.fallback === 'surrounded'));
  h.advance(3001); await flush();
  assert.equal(h.live.size, 0);
  assert.equal(answers.at(-1).outcome, 'not-shown', 'the answer never says shown for a card that was not drawn');
  await h.card.dispose();
});

test('a clear seat is chosen exactly as before whatever the flag says', async () => {
  const ordinary = { views, measured, renderFromRoom: identity() };
  const seats = [];
  for (const source of [ordinary, { ...ordinary, surrounds: false }]) {
    const h = harness(() => source);
    const answers = [];
    h.card.set({ outcome: 'Both dyskerin copies.', onSeat: seat => answers.push(seat) });
    await flush();
    assert.equal(h.live.size, 2);
    assert.equal(answers[0].outcome, 'shown');
    assert.equal(answers[0].fallback, undefined);
    seats.push(answers[0].seat);
    await h.card.dispose();
  }
  assert.deepEqual(seats[1], seats[0]);
});

test('a wearer the structure stops surrounding during the build gets the full check at commit', async () => {
  let reads = 0;
  // The seat is solved surrounded; by the commit the flag is gone and the
  // full-glass silhouette is an obstacle again, so the old mesh is not mounted.
  const h = harness(() => (++reads === 1 ? surrounded : filled));
  h.card.set({ outcome: MESSAGE, holdMs: 6000 });
  await flush();
  assert.equal(h.live.size, 0);
  assert.equal(h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail.reason, 'moved-during-build');
  await h.card.dispose();
});

test('a card mounted after the structure stops surrounding the wearer is not recorded as surrounded', async () => {
  let reads = 0;
  // The seat is solved surrounded; by the commit the wearer has stepped back
  // and the structure is a small silhouette in a corner of each glass.
  const clear = { views, renderFromRoom: identity(), surrounds: false,
    measured: measured.map(m => ({ ...m, silhouette: [m.fov[0] + .1, m.fov[2] - .1, .05, .05] })) };
  const h = harness(() => (++reads === 1 ? surrounded : clear));
  const answers = [];
  h.card.set({ outcome: MESSAGE, holdMs: 6000, onSeat: seat => answers.push(seat) });
  await flush();
  assert.ok(reads >= 2, 'the clearance was read again at commit');
  assert.equal(h.live.size, 2, 'plate and text are drawn');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].outcome, 'shown');
  assert.equal(answers[0].fallback, undefined, 'the answer does not say surrounded');
  assert.equal(h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail.outcome, 'shown');
  assert.ok(!h.records.some(e => e.detail.fallback === 'surrounded'), 'no record says surrounded');
  await h.card.dispose();
});

function viewerClearance(spheres) {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  function replyCardClearance(');
  assert.ok(start >= 0);
  const subject = {};
  const h = vm.createContext({ latestRoomPlacementPose: { labelViews: views, renderFromRoom: identity() },
    componentLabelMeasurement: { plates: [] }, componentLabels: { refs: () => [] }, canvas: { camera: { scale: 1 } },
    plugin: { state: { data: { cells: new Map() } } }, ...emptyLessonFigureBinding(),
    scientificRepresentations: () => [{ renderObjects: [subject] }],
    labelObjectRenderable: () => false, renderedSubjectSpheres: () => spheres,
    measureComponentLabels: () => measured,
  });
  vm.runInContext('"use strict";\n' + source.slice(start, source.indexOf('\n  }', start) + 4), h);
  return h.replyCardClearance();
}

test('the viewer marks a structure whose bounds reach both eyes as surrounding the wearer', () => {
  assert.equal(viewerClearance([{ center: [0, 0, -.5], radius: 2 }]).surrounds, true, 'wearer inside the bounds');
  assert.equal(viewerClearance([{ center: [1, 0, -.2], radius: .5 }]).surrounds, true, 'bounds beside the wearer');
  assert.equal(viewerClearance([{ center: [0, 0, -2], radius: .2 }]).surrounds, false, 'in front of the wearer');
  assert.equal(viewerClearance([{ center: [0, 0, -1.2], radius: 1 }]).surrounds, false, 'filling the view, short of the eyes');
  assert.equal(viewerClearance([{ center: [0, 0, 5], radius: 1 }]).surrounds, false, 'wholly behind the wearer');
  assert.equal(viewerClearance([]).surrounds, false, 'no structure');
});
