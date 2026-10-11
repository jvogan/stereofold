import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as geometry from './spatial-toolbar-geometry.mjs';
import { menuSeatWithinView } from './menu-view-band.mjs';
import { measureReplyCard, measureReplyCardClearance, replyCardOffsetAsync } from './reply-card-layout.mjs';
import { connectionStatus, TALK_LINK_LOST } from './connection-liveness.mjs';
import { recordTalkReplyDelivery, recordTalkReplySeat } from './talk-reply-diagnostics.mjs';
import { replySegmentsOf, replyCaptionHoldMs } from './reply-segments.mjs';
import { projectPlateQuad } from './component-label-measurement.mjs';
import { screenRectFromPoints } from './label-layout.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';

const captionSource = readFileSync(new URL('./talk-caption.mjs', import.meta.url), 'utf8');
const sessionSource = readFileSync(new URL('./immersive-session.mjs', import.meta.url), 'utf8');
const start = sessionSource.indexOf('          const onReply = event => {');
const end = sessionSource.indexOf('          globalThis.addEventListener?.(REPLY_CAPTION_EVENT', start);
assert.ok(start > 0 && end > start);
const listener = new Function('record', 'replySegmentsOf', 'replyCaptionHoldMs', 'recordTalkReplySeat',
  `${sessionSource.slice(start, end)}\nreturn onReply;`);
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const separate = (a, b) => Math.abs(a.x - b.x) >= a.hw + b.hw || Math.abs(a.y - b.y) >= a.hh + b.hh;

/** One head orientation as the headset reports it: yaw about room up, then
 * pitch about the head's own right, then roll about where it is looking. The
 * caption's seat frame levels all of this away; the eyes do not, which is the
 * whole of that defect.
 */
function orientationColumns({ yaw = 0, pitch = 0, roll = 0 } = {}) {
  const [y, p, r] = [yaw, pitch, roll].map(degrees => degrees * Math.PI / 180);
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(y), Math.sin(y), Math.cos(p), Math.sin(p), Math.cos(r), Math.sin(r)];
  const spin = ([x, up, z]) => [x * cy + z * sy, up, -x * sy + z * cy];
  return [spin([cr, sr * cp, sr * sp]), spin([-sr, cr * cp, cr * sp]), spin([0, -sp, cp])];
}
/** A rigid pose as a column-major transform and its exact inverse. */
function poseTransform([c0, c1, c2], translation) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return { matrix: [...c0, 0, ...c1, 0, ...c2, 0, ...translation, 1],
    inverse: { matrix: [c0[0], c1[0], c2[0], 0, c0[1], c1[1], c2[1], 0, c0[2], c1[2], c2[2], 0,
      -dot(c0, translation), -dot(c1, translation), -dot(c2, translation), 1] } };
}
/** What both eyes hold of the corners the mesh builder was actually handed. */
function eyeVerdict(corners, views) {
  const inside = Math.min(...views.map(view => projectPlateQuad(corners, view).inside));
  return { inside, outcome: inside > .999999 ? 'shown' : inside > 0 ? 'partial' : 'blocked' };
}

/** Synthetic room poses, full-view molecular bounds, left-edge
 * menu. Production listener, sink, layout, mesh commit and hold; only GPU work
 * is replaced. No device coordinates or captured imagery enter the fixture.
 */
function harness({ menuCoversView = false, structureCoversView = false, failAdd = false,
  runTask = async () => {}, tracked = true, facing } = {}) {
  let time = 0, solves = 0, pose = tracked ? [0, 0, 0] : undefined, menuOrigin = [0, 0, 0], orientation = facing;
  let eyeViewsAvailable = true;
  const live = new Set(), records = [], quads = [];
  const scope = { __stereofoldDiagnostics: { record: (kind, detail) => records.push({ kind, detail }) } };
  const columns = () => orientationColumns(orientation);
  const head = () => {
    if (!pose) return undefined;
    return { matrix: poseTransform(columns(), pose).matrix, position: { x: pose[0], y: pose[1], z: pose[2] } };
  };
  const menuPoints = () => {
    const x1 = menuCoversView ? -2 : -.75, x2 = menuCoversView ? 2 : -.45;
    return [[x1, -1, -1], [x2, -1, -1], [x2, 1, -1], [x1, 1, -1]]
      .map(p => p.map((v, i) => v + menuOrigin[i]));
  };
  // Both eyes ride the head: the interpupillary offset runs along the head's
  // own right, not the room's. A levelled head reproduces the fixture's
  // original views exactly, so every earlier expectation is unchanged.
  const views = () => {
    const seen = columns(), right = seen[0], at = pose ?? [0, 0, 0];
    return syntheticViews().map((view, i) => ({ ...view,
      transform: poseTransform(seen, at.map((v, axis) => v + (i === 0 ? -0.032 : 0.032) * right[axis])) }));
  };
  const context = vm.createContext({ ...geometry, menuSeatWithinView, connectionStatus, TALK_LINK_LOST,
    measureReplyCard, measureReplyCardClearance,
    replyCardOffsetAsync: (args, options) => { solves++; return replyCardOffsetAsync(args, { ...options, now: () => 0 }); },
    MeshBuilder: { createState: () => ({}), addTriangleWithNormal(s, a, b, c) { quads.push([a, b, c]); }, getMesh: () => ({}) },
    Mesh: { Utils: {} }, TextBuilder: { create: () => ({ add() {}, getText: () => ({}) }) }, Text: { Utils: {} },
    getFontAtlas: () => ({ buffer: 0, lineHeight: 1, get: () => ({ nw: .6 }) }),
    Shape: { create: () => ({}) }, ShapeRepresentation: () => ({ createOrUpdate() {}, destroy() {} }), Color: x => x,
  });
  vm.runInContext(captionSource.replace(/^import .*;$/gm, '').replace(/\bexport /g, ''), context);
  let adds = 0, card;
  const enter = () => {
    card = context.createTalkCaption({ plugin: { runTask }, head, menuPoints, now: () => time,
      clearance: () => ({ views: eyeViewsAvailable ? views() : [], renderFromRoom: identity(), measured: [0, 1].map(() => ({
        silhouette: structureCoversView ? [0, 0, 10, 10] : [0, 0, .25, .25] })) }),
      viewsAvailable: () => eyeViewsAvailable,
      presentation: { add: r => { if (failAdd && ++adds === 2) throw Error('synthetic label add failure'); live.add(r); }, remove: r => live.delete(r) },
      record: scope.__stereofoldDiagnostics.record });
    context.setTalkOutcomeSink((text, holdMs, complete, onSeat) => card.set({ outcome: text, holdMs, complete, onSeat }));
  };
  enter();
  const onReply = listener({ toolbar: { setStatus: (text, color, progress, holdMs, complete, onSeat) =>
    context.showTalkOutcome(text, holdMs, complete, onSeat) } }, replySegmentsOf, replyCaptionHoldMs,
  (caption, seat) => recordTalkReplySeat(caption, seat, { scope }));
  return { records, live, quads, views, menuPoints, head, solves: () => solves, get card() { return card; },
    receive: caption => { recordTalkReplyDelivery(caption, { scope }); onReply({ detail: caption }); },
    advance: at => { time = at; card.frame(); },
    setEyeViews: available => { eyeViewsAvailable = available; },
    move: point => { pose = point; card.frame(); },
    /** Walk and turn between frames, the way a wearer does: the pose changes
     * and no frame has yet run, so the next caption is the first thing that
     * sees it. */
    carry: (point, facingNow) => { pose = point; orientation = facingNow ?? orientation; },
    reenter: async point => { await card.dispose(); pose = undefined; enter(); pose = point; menuOrigin = [...point]; card.frame(); },
  };
}
const refusal = { id: 'd41-refusal', commandId: 'd41-load', speak: false, holdSeconds: 6,
  text: 'Could not load. Insecure addresses are refused. Use an HTTPS address.',
  refusal: { tool: 'replace_inspection_source', reason: 'insecure address' }, refusalScope: {} };

test('full-view bounds after re-entry: refusal clears the left menu, draws for its full hold, and reports the actual seat', async () => {
  const h = harness();
  h.receive({ ...refusal, id: 'before-return' }); await flush();
  await h.reenter([1.4, 1.6, .3]);
  h.receive(refusal);
  assert.equal(h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === refusal.id).at(-1).detail.drawn, false);
  await flush();
  const outcomes = h.records.filter(e => e.kind === 'talk-caption-seat').map(e => e.detail);
  assert.equal(outcomes.at(-1).outcome, 'shown'); assert.equal(outcomes.at(-1).holdMs, 6000);
  assert.equal(h.live.size, 2);
  const corners = h.quads.slice(-2).flat();
  assert.equal(menuSeatWithinView(corners, h.head()), true);
  for (const view of h.views()) {
    const projected = projectPlateQuad(corners, view);
    assert.ok(projected.inside > .999999);
    const eye = Array.from(view.transform.matrix).slice(12, 15);
    const menu = screenRectFromPoints({ points: h.menuPoints(), eye, target: eye.map((v, i) => v - (i === 2 ? 1 : 0)) });
    assert.ok(separate(projected.rect, { x: menu.x, y: menu.y, hw: menu.halfWidth, hh: menu.halfHeight }));
    assert.equal(separate(projected.rect, { x: 0, y: 0, hw: .25, hh: .25 }), true);
  }
  const delivery = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === refusal.id).at(-1).detail;
  assert.equal(delivery.drawn, true); assert.equal(delivery.seatOutcome, 'shown');
  const outcome = h.records.filter(e => e.kind === 'outcome' && e.detail.captionId === refusal.id).at(-1).detail;
  assert.equal(outcome.status, 'refused'); assert.equal(outcome.seatOutcome, 'shown'); assert.equal(outcome.drawn, true);
  const solves = h.solves();
  for (let i = 0; i < 72; i++) h.advance(i * 10);
  await flush(); assert.equal(h.solves(), solves);
  h.advance(5999); await flush(); assert.equal(h.live.size, 2);
  h.advance(6000); await flush(); assert.equal(h.live.size, 0);
  await h.card.dispose();
});

test('a menu covering all candidate seats keeps the reply pending', async () => {
  const h = harness({ menuCoversView: true }); h.receive(refusal); await flush();
  const seats = h.records.filter(e => e.kind === 'talk-caption-seat').map(e => e.detail);
  assert.equal(seats.at(-1).outcome, 'blocked');
  assert.equal(h.live.size, 0);
  assert.equal(h.records.filter(e => e.kind === 'reply-received').at(-1).detail.drawn, false);
  await h.card.dispose();
});

test('slow geometry starts the full hold after the draw; a pending reply never reports drawn', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const h = harness({ runTask: () => delayed }); h.receive(refusal); await flush();
  h.advance(2000); await flush(); assert.equal(h.live.size, 0);
  assert.ok(h.records.filter(e => e.kind === 'reply-received').every(e => e.detail.drawn === false));
  release(); await flush(); assert.equal(h.live.size, 2);
  h.advance(7999); await flush(); assert.equal(h.live.size, 2);
  h.advance(8000); await flush(); assert.equal(h.live.size, 0);
  await h.card.dispose();
});

test('a failed label commit removes the partial plate and reports failed rather than drawn', async () => {
  const h = harness({ failAdd: true }); h.receive(refusal); await flush();
  assert.equal(h.live.size, 0); assert.equal(h.card.text(), '');
  assert.ok(h.records.filter(e => e.kind === 'reply-received').every(e => e.detail.drawn === false));
  assert.equal(h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail.outcome, 'failed');
  assert.equal(h.records.filter(e => e.kind === 'outcome').at(-1).detail.seatOutcome, 'failed');
  const solves = h.solves(); for (let i = 0; i < 72; i++) h.card.frame(); await flush();
  assert.equal(h.solves(), solves); await h.card.dispose();
});

test('a new entry waits for its own tracked pose, then positions the pending reply for its whole hold', async () => {
  const h = harness({ tracked: false }); h.receive(refusal); h.advance(2000); await flush();
  assert.equal(h.live.size, 0); assert.equal(h.solves(), 0);
  h.move([2, 1.6, 0]); await flush(); assert.equal(h.live.size, 2);
  assert.ok(menuSeatWithinView(h.quads.slice(-2).flat(), h.head()));
  h.advance(7999); await flush(); assert.equal(h.live.size, 2);
  h.advance(8000); await flush(); assert.equal(h.live.size, 0); await h.card.dispose();
});

test('walking without yaw change repositions a committed caption using the menu view band', async () => {
  const h = harness(); h.receive(refusal); await flush(); h.advance(300);
  const beforeMenu = JSON.stringify(h.menuPoints());
  h.move([1.5, .5, 0]); await flush();
  assert.equal(JSON.stringify(h.menuPoints()), beforeMenu, 'the committed menu did not move');
  assert.equal(h.live.size, 2); assert.ok(menuSeatWithinView(h.quads.slice(-2).flat(), h.head()));
  assert.equal(h.solves(), 2); await h.card.dispose();
});

test('a late failed build cannot remove or acknowledge the replacement reply', async () => {
  let reject; const delayed = new Promise((_, fail) => { reject = fail; }); let calls = 0;
  const h = harness({ runTask: () => ++calls === 1 ? delayed : Promise.resolve() });
  h.receive(refusal); await flush();
  h.receive({ id: 'correction', text: 'Use the other copy.', holdSeconds: 6 });
  reject(Error('old build failed')); await flush();
  assert.equal(h.card.text(), 'Use the other copy.'); assert.equal(h.live.size, 2);
  const old = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === refusal.id);
  assert.ok(old.every(e => !e.detail.drawn)); assert.equal(old.at(-1).detail.seatOutcome, 'superseded');
  assert.equal(h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === 'correction').at(-1).detail.drawn, true);
  await h.card.dispose();
});


test('a 181-character reply pages completely over full-view bounds after return', async () => {
  const text = 'The structure fills the view after returning from Molstar. This answer must stay readable while the menu remains at the left edge. Each page needs its full reading window to finish.';
  assert.equal(text.length, 181);
  const h = harness(); await h.reenter([1.4, 1.6, .3]);
  h.receive({ id: 'd37-long', text, speak: false, holdSeconds: 6 }); await flush();
  const pages = [h.card.text()]; assert.equal(h.live.size, 2);
  let at = 0;
  while (pages.join(' ').length < text.length) {
    h.advance(at + 5999); await flush(); assert.equal(h.live.size, 2);
    assert.equal(h.card.text(), pages.at(-1));
    at += 6000; h.advance(at); await flush(); assert.equal(h.live.size, 2);
    pages.push(h.card.text());
    assert.ok(pages.length <= 4, 'the complete reply fits in four pages');
  }
  assert.ok(pages.length > 1); assert.equal(pages.join(' '), text);
  h.advance(at + 5999); await flush(); assert.equal(h.live.size, 2);
  h.advance(at + 6000); await flush(); assert.equal(h.live.size, 0);
  const seats = h.records.filter(e => e.kind === 'talk-caption-seat' && e.detail.outcome === 'shown');
  assert.ok(seats.length >= pages.length);
  assert.ok(seats.filter(e => e.detail.holdMs === 6000).length >= pages.length);
  await h.card.dispose();
});

/* "shown" has to mean both eyes hold the card.
 * The seat frame is levelled -- `toolbarSeatBasis` drops pitch and roll before
 * it places anything -- so every check written in that frame passes a tipped
 * head. The three tests below read the corners the mesh builder was handed and
 * project them in the eye transforms the wearer actually had.
 */
for (const pitch of [-25, 25]) for (const menuCoversView of [false, true]) {
  const where = menuCoversView ? 'a menu over every candidate' : 'a left-edge menu';
  test(`a head pitched ${pitch}° with 10° of roll and ${where} reports what both eyes contain`, async () => {
    const h = harness({ facing: { pitch, roll: 10 }, menuCoversView });
    const id = `pitch${pitch}-${menuCoversView}`;
    h.receive({ ...refusal, id }); await flush();
    const seat = h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail;
    if (menuCoversView) {
      assert.equal(h.live.size, 0, 'a menu-covered card stays pending');
      assert.equal(seat.outcome, 'blocked');
      assert.equal(h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === id).at(-1).detail.drawn, false);
      await h.card.dispose();
      return;
    }
    assert.equal(h.live.size, 2);
    // The authority is the drawn geometry in the wearer's own eye transforms,
    // never the levelled design frame the seat was solved in.
    const verdict = eyeVerdict(h.quads.slice(-2).flat(), h.views());
    assert.equal(seat.outcome, verdict.outcome,
      `seat says ${seat.outcome}; the eyes hold ${verdict.inside.toFixed(4)}`);
    if (seat.outcome !== 'shown') assert.equal(seat.inside, Math.round(verdict.inside * 1e4) / 1e4);
    const delivery = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === id).at(-1).detail;
    assert.equal(delivery.seatOutcome, verdict.outcome);
    assert.equal(delivery.drawn, verdict.outcome === 'shown');
    const outcome = h.records.filter(e => e.kind === 'outcome' && e.detail.captionId === id).at(-1).detail;
    assert.equal(outcome.status, 'refused');
    assert.equal(outcome.drawn, verdict.outcome === 'shown');
    await h.card.dispose();
  });
}

test('a design seat neither eye contains is reported blocked, and the truth follows when the head comes down', async () => {
  // Head tipped fully back: the levelled seat frame is unchanged, so every
  // check it had still passes, and the card is nowhere near the glass.
  const h = harness({ facing: { pitch: 90, roll: 10 } });
  h.receive({ ...refusal, id: 'tipped-back' }); await flush();
  const seat = h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail;
  assert.equal(seat.outcome, 'blocked');
  assert.equal(seat.inside, 0);
  assert.equal(eyeVerdict(h.quads.slice(-2).flat(), h.views()).inside, 0, 'neither eye holds any part of it');
  assert.ok(!h.records.some(e => e.kind === 'talk-caption-seat' && e.detail.outcome === 'shown'),
    'nothing reported this card as shown');
  const delivered = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === 'tipped-back');
  assert.ok(delivered.every(e => e.detail.drawn === false), 'no delivery record claims it was drawn');
  assert.equal(delivered.at(-1).detail.seatOutcome, 'blocked');
  assert.equal(h.records.filter(e => e.kind === 'outcome' && e.detail.captionId === 'tipped-back').at(-1).detail.drawn, false);
  // The wearer lowers their head. The card is re-seated and the same caption
  // gets its true outcome, because a seat that was never shown keeps its
  // reporter.
  h.carry([0, 0, 0], { pitch: 0, roll: 0 });
  h.advance(300); await flush();
  const reseated = h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail;
  assert.equal(reseated.outcome, 'shown');
  assert.equal(eyeVerdict(h.quads.slice(-2).flat(), h.views()).outcome, 'shown');
  const final = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === 'tipped-back').at(-1).detail;
  assert.equal(final.seatOutcome, 'shown'); assert.equal(final.drawn, true);
  const solves = h.solves();
  for (let i = 0; i < 72; i++) h.advance(300 + i);
  await flush();
  assert.equal(h.solves(), solves, 'a still head over a shown card never solves again');
  await h.card.dispose();
});

test('the same reply after 0.6 m and 20 degrees reports nothing until its own seat is committed', async () => {
  const text = 'Both dyskerin copies.';
  const h = harness();
  h.receive({ id: 'repeat-first', text, speak: false, holdSeconds: 6 }); await flush();
  assert.equal(h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail.outcome, 'shown');
  const solves = h.solves();
  // The wearer walks 0.6 m and turns 20 degrees between two frames, so the
  // repeated reply is the first thing that sees the new pose.
  h.carry([0.6, 0, 0], { yaw: 20 });
  h.receive({ id: 'repeat-again', text, speak: false, holdSeconds: 6 });
  const early = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === 'repeat-again');
  assert.ok(early.length >= 1, 'the delivery itself is recorded');
  assert.ok(early.every(e => e.detail.drawn === false),
    'no receipt is reported from the previous seat before the re-seat is decided');
  assert.ok(early.every(e => e.detail.seatOutcome === 'pending'));
  await flush();
  assert.equal(h.solves(), solves + 1, 'the repeated reply earned its own seat');
  const seat = h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail;
  const verdict = eyeVerdict(h.quads.slice(-2).flat(), h.views());
  assert.equal(seat.outcome, verdict.outcome);
  const delivery = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === 'repeat-again').at(-1).detail;
  assert.equal(delivery.seatOutcome, seat.outcome);
  assert.equal(delivery.drawn, verdict.outcome === 'shown');
  assert.equal(h.live.size, 2);
  await h.card.dispose();
});

test('the same reply from an unmoved head answers from the seat already on the glass', async () => {
  const text = 'Both dyskerin copies.';
  const h = harness();
  h.receive({ id: 'still-first', text, speak: false, holdSeconds: 6 }); await flush();
  const solves = h.solves();
  h.receive({ id: 'still-again', text, speak: false, holdSeconds: 6 });
  const delivery = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === 'still-again').at(-1).detail;
  assert.equal(delivery.seatOutcome, 'shown', 'the standing seat is still this pose’s answer');
  assert.equal(delivery.drawn, true);
  await flush();
  assert.equal(h.solves(), solves, 'and it cost no second search');
  assert.equal(h.live.size, 2);
  await h.card.dispose();
});

/**
 * `seatHolds` asked `driftDegrees(pose) < CAPTION_DRIFT_DEGREES`
 * and `menuSeatWithinView(seatPoints, pose)`. `driftDegrees` compares yaw
 * alone; the band works in the levelled design frame. A head that pitched and
 * did not turn passes both, so the same sentence arriving again was answered
 * from the receipt the first delivery earned while the eyes held 2% of the
 * card. The standing seat is now re-measured in the eye views the wearer has.
 */
test('the same reply after 25° of pitch and no yaw is re-seated before any receipt is reused', async () => {
  const text = 'Both dyskerin copies.';
  const h = harness();
  h.receive({ id: 'pitch-first', text, speak: false, holdSeconds: 6 }); await flush();
  assert.equal(h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail.outcome, 'shown');
  const standing = h.quads.slice(-2).flat();
  const solves = h.solves();
  // The head pitches up 25 degrees between two frames and the yaw is unchanged,
  // so both of an earlier run’s tests still pass the seat that is on the glass.
  h.carry([0, 0, 0], { pitch: 25 });
  assert.equal(menuSeatWithinView(standing, h.head()), true,
    'the levelled band still passes the standing seat, which is why it cannot be the judge');
  const held = eyeVerdict(standing, h.views());
  assert.equal(held.outcome, 'partial');
  assert.ok(held.inside < 0.05, `the eyes hold ${held.inside.toFixed(4)} of the card that is on the glass`);

  h.receive({ id: 'pitch-again', text, speak: false, holdSeconds: 6 });
  const early = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === 'pitch-again');
  assert.ok(early.length >= 1, 'the delivery itself is recorded');
  assert.ok(early.every(e => e.detail.drawn === false),
    'the pre-pitch receipt cannot answer a repeat the eyes no longer hold');
  await flush();
  assert.equal(h.solves(), solves + 1, 'the repeated reply earned its own seat');
  const seat = h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail;
  const verdict = eyeVerdict(h.quads.slice(-2).flat(), h.views());
  assert.equal(seat.outcome, verdict.outcome,
    `seat says ${seat.outcome}; the eyes hold ${verdict.inside.toFixed(4)}`);
  const delivery = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === 'pitch-again').at(-1).detail;
  assert.equal(delivery.seatOutcome, seat.outcome);
  assert.equal(delivery.drawn, verdict.outcome === 'shown');
  assert.equal(h.live.size, 2);
  await h.card.dispose();
});

/**
 * The seat is solved for the pose `refresh` sampled when the
 * build was queued, and a mesh build is asynchronous. A head that moved while
 * it ran committed a card the earlier pose described and published that pose's
 * receipt. Here pose A holds the whole card in both eyes and pose B, half a
 * metre to the right, pushes it out of the right eye alone.
 */
test('a build queued at one pose waits for full clearance at its commit pose', async () => {
  let release; const delayed = new Promise(resolve => { release = resolve; });
  const h = harness({ runTask: () => delayed });
  h.receive({ id: 'moved-while-building', text: 'Both dyskerin copies.', speak: false, holdSeconds: 6 });
  await flush();
  assert.equal(h.live.size, 0, 'nothing is committed while the build is in flight');
  // The wearer steps 0.5 m right before the mesh lands. No frame has run, so
  // the queued pose is the only one the solve ever saw.
  h.carry([0.5, 0, 0]);
  release(); await flush();
  assert.equal(h.live.size, 0, 'the stale mesh cannot mount over the new pose');

  const corners = h.quads.slice(-2).flat();
  const atCommit = h.views().map(view => projectPlateQuad(corners, view).inside);
  assert.ok(atCommit[0] > .999999, 'the left eye still holds the whole card');
  assert.ok(atCommit[1] < .999999, 'the right eye does not');
  const seat = h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail;
  assert.equal(seat.outcome, 'blocked', 'the full clearance check refuses the stale mesh');
  const delivered = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === 'moved-while-building');
  assert.ok(delivered.every(e => e.detail.drawn === false), 'nothing claims the committed card was shown');
  assert.equal(delivered.at(-1).detail.seatOutcome, 'blocked');

  // The caption id keeps its reporter, so the seat the committed pose is owed
  // arrives under it and is the last word on this reply.
  h.advance(300); await flush();
  const reseated = h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail;
  assert.equal(reseated.outcome, 'shown');
  assert.equal(eyeVerdict(h.quads.slice(-2).flat(), h.views()).outcome, 'shown');
  const final = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === 'moved-while-building').at(-1).detail;
  assert.equal(final.seatOutcome, 'shown'); assert.equal(final.drawn, true);
  assert.equal(h.records.filter(e => e.kind === 'reply-received'
    && e.detail.captionId === 'moved-while-building' && e.detail.drawn === true).length, 1,
  'exactly one receipt for this caption id says the wearer was shown it');
  await h.card.dispose();
});

test('a missing eye view removes old glass and ends retries until the scene or head changes', async () => {
  const h = harness();
  h.receive({ id: 'first', text: 'First reply.', speak: false, holdSeconds: 6 });
  await flush();
  assert.equal(h.live.size, 2);
  h.setEyeViews(false);
  h.receive({ id: 'second', text: 'Second reply.', speak: false, holdSeconds: 6 });
  await flush();
  assert.equal(h.live.size, 0, 'unmeasurable new reply removes the old plate');
  for (const time of [200, 600, 1400, 3000, 3200]) { h.advance(time); await flush(); }
  const stopped = h.records.filter(entry => entry.kind === 'talk-caption-seat' && entry.detail.outcome === 'not-shown');
  assert.equal(stopped.length, 1);
  const reply = h.records.filter(entry => entry.kind === 'reply-received' && entry.detail.captionId === 'second').at(-1).detail;
  assert.equal(reply.drawn, false);
  assert.equal(reply.seatOutcome, 'not-shown');
  const attempts = h.records.filter(entry => entry.kind === 'talk-caption-seat').length;
  h.advance(4000); h.advance(4500); await flush();
  assert.equal(h.records.filter(entry => entry.kind === 'talk-caption-seat').length, attempts,
    'a still head does not restart the blocked solver');
  h.setEyeViews(true); h.card.invalidate(); await flush();
  assert.equal(h.records.filter(entry => entry.kind === 'talk-caption-seat').at(-1).detail.outcome, 'shown');
  await h.card.dispose();
});

test('a standing reply leaves the glass when eye measurements disappear', async () => {
  const h = harness();
  h.receive({ id: 'standing', text: 'A visible reply.', speak: false, holdSeconds: 6 });
  await flush();
  assert.equal(h.live.size, 2);
  h.setEyeViews(false);
  h.advance(200); await flush();
  assert.equal(h.live.size, 0);
  assert.equal(h.records.filter(entry => entry.kind === 'talk-caption-seat').at(-1).detail.outcome, 'unmeasured');
  await h.card.dispose();
});


test('voice region refusal reports a drawn plate and retires after six seconds', async () => {
  const h = harness();
  const caption = { ...refusal, id: 'd75-chain-z', commandId: 'd75-focus', utteranceId: 'd75-voice',
    text: 'Could not apply · request refused. 4HHB has no chain Z. Chains are A, B, C, D.',
    refusal: { tool: 'focus_selection', reason: 'request refused' } };
  h.receive(caption);
  assert.equal(h.records.some(e => e.kind === 'tool-refused' && e.detail.captioned === true), false);
  await flush();
  assert.equal(h.live.size, 2);
  const event = h.records.find(e => e.kind === 'tool-refused' && e.detail.captioned === true);
  assert.ok(event);
  assert.equal(event.detail.captionId, caption.id);
  assert.equal(event.detail.utteranceId, caption.utteranceId);
  assert.equal(event.detail.tool, 'focus_selection');
  assert.equal(event.detail.drawn, true);
  assert.equal(event.detail.seatOutcome, 'shown');
  assert.ok(h.records.some(e => e.kind === 'talk-caption' && e.detail.text === caption.text));
  h.advance(5999); await flush(); assert.equal(h.live.size, 2);
  h.advance(6000); await flush(); assert.equal(h.live.size, 0);
  const retired = h.records.find(e => e.kind === 'caption-retired');
  assert.ok(retired);
  assert.equal(retired.detail.holdMs, 6000);
  assert.equal(retired.detail.shownMs, 6000);
});

for (const scenario of ['no head pose', '2 mm drift']) test(`caption deadline is terminal with ${scenario}`, async () => {
  const h = harness({ tracked: scenario !== 'no head pose' });
  h.setEyeViews(false);
  h.receive({ id: scenario, text: 'Reply awaiting a safe seat.', speak: false, holdSeconds: 6 });
  await flush();
  for (let time = 200; time <= 10000; time += 200) {
    if (scenario === '2 mm drift') h.carry([time / 200 * .002, 0, 0]);
    h.advance(time); await flush();
    if (time === 3000) {
      const final = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === scenario).at(-1).detail;
      assert.equal(final.seatOutcome, 'not-shown');
      assert.equal(final.drawn, false);
    }
  }
  assert.equal(h.records.filter(e => e.kind === 'talk-caption-seat' && e.detail.outcome === 'not-shown').length, 1);
  assert.ok(h.solves() <= 5, 'drift does not restart the backoff or deadline');
  assert.equal(h.live.size, 0);
  await h.card.dispose();
});

test('a caption build finishing after the terminal deadline cannot reveal or report success', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const h = harness({ runTask: () => delayed });
  h.receive({ id: 'late', text: 'A delayed reply.', speak: false, holdSeconds: 6 });
  await flush();
  h.advance(3000); await flush();
  release(); await flush();
  assert.equal(h.live.size, 0);
  const receipts = h.records.filter(e => e.kind === 'reply-received' && e.detail.captionId === 'late');
  assert.equal(receipts.at(-1).detail.seatOutcome, 'not-shown');
  assert.ok(receipts.every(e => e.detail.drawn === false));
  assert.equal(h.records.filter(e => e.kind === 'talk-caption-seat' && e.detail.outcome === 'not-shown').length, 1);
  await h.card.dispose();
});
