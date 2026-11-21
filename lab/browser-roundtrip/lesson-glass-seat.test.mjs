import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { toolbarFrameRuntime } from './fixtures/toolbar-frame-runtime.mjs';
import { lessonSeatSession } from './fixtures/lesson-seat-session.mjs';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { SPIN_FIELD_BALLS } from './chapter-field.mjs';
import { BoundaryHelper } from 'molstar/lib/mol-math/geometry/boundary-helper.js';
import { coordinates } from './fixtures/kinesin-layout.mjs';

// Where the menu, the chapter card, the assistant line and the name plates
// stand, chapter by chapter, against the molecule and one another, measured
// in each eye from where the wearer's head is. The menu, card and assistant
// line are the real toolbar's glass, seated by its own rule and proven by the
// page's own clearance solver; the molecule is every atom the chapter shows;
// the plates are the lesson's labels where the headset draws them.
//
// A session is history: lessons open one after another, the wearer looks
// from somewhere else for a while, takes hold of the molecule. Where the glass
// opens must not depend on that history, only on what is on show.

const runtime = await toolbarFrameRuntime();
const cache = process.env.STEREOFOLD_DEMO_CACHE;
const STANDARD = [0, 0, 0];
// The three other head positions the headset pass used: 0.3 m to either side
// and 0.15 m lower (it moved the molecule the other way instead).
const HEADS = [[.3, 0, 0], [-.3, 0, 0], [0, -.15, 0]];
const mm = point => point?.map(v => Math.round(v * 1000));
const rounded = rect => rect && Object.fromEntries(Object.entries(rect).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
const glassKey = measured => JSON.stringify(measured.map(eye => eye.rects), (k, v) => typeof v === 'number' ? Math.round(v * 1000) : v);

/** Nothing covers anything: glass, plates and the molecule, in both eyes. */
function assertUncovered(measured, where, { atoms = ['menu', 'card', 'status'], labels = true } = {}) {
  for (const eye of measured) {
    assert.deepEqual(eye.glassOverGlass, [], `${where}, ${eye.eye} eye: one glass plate over another`);
    if (labels) assert.deepEqual(eye.glassOverLabel, [], `${where}, ${eye.eye} eye: glass over a name plate`);
    for (const name of atoms) assert.equal(eye.atomsUnder[name] ?? 0, 0, `${where}, ${eye.eye} eye: ${name} glass over ${eye.atomsUnder[name]} atoms`);
  }
}
const describe = measured => JSON.stringify(measured.map(eye => ({ eye: eye.eye, labels: eye.labels,
  rects: Object.fromEntries(Object.entries(eye.rects).map(([name, rect]) => [name, rounded(rect)])),
  glass: eye.glassOverGlass, plates: eye.glassOverLabel, atoms: eye.atomsUnder })));

async function telomeraseFrom(head, { grabAt } = {}) {
  const s = await lessonSeatSession(runtime);
  await s.open('4HHB');
  await s.open('telomerase-haca');
  s.moveHead(head);
  const chapters = [];
  await s.start();
  chapters.push(s.measure());
  for (let i = 1; i < 5; i++) { await s.chapter(i); chapters.push(s.measure()); }
  // The wearer takes hold of the molecule in the last chapter and sets it
  // down (where it was, or at `grabAt`), then sits back at the standard seat.
  await s.grab(undefined, grabAt);
  s.moveHead(STANDARD);
  return { s, chapters };
}

test('telomerase: every chapter is clear from the standard seat', { skip: !cache }, async t => {
  const { s, chapters } = await telomeraseFrom(STANDARD);
  try {
    chapters.forEach((measured, i) => {
      t.diagnostic(`chapter ${i + 1}: ${describe(measured)}`);
      assertUncovered(measured, `chapter ${i + 1}`);
      assert.ok(measured.every(eye => eye.labels > 0 && eye.rects.menu && eye.rects.card), `chapter ${i + 1}: card, menu and names drawn`);
    });
  } finally { await s.dispose(); }
  // Seen from where the head was during the lesson (a lesson started from
  // off the seat is framed from there while the menu keeps its room seat).
  for (const head of HEADS) {
    const other = await telomeraseFrom(head);
    other.chapters.forEach((measured, i) => t.diagnostic(`head ${head} chapter ${i + 1}: ${describe(measured)}`));
    await other.s.dispose();
  }
});

test('telomerase: Done is clear from the standard seat whatever the head did during the lesson', { skip: !cache }, async t => {
  for (const head of [STANDARD, ...HEADS]) {
    const { s } = await telomeraseFrom(head);
    try {
      await s.done();
      const measured = s.measure();
      t.diagnostic(`head ${head}, Done: seat ${mm(s.seat())} ${describe(measured)}`);
      assert.equal(s.t.toolbar.isHidden(), false, `head ${head}: the menu stays drawn`);
      assertUncovered(measured, `head ${head}, Done`);
    } finally { await s.dispose(); }
  }
});

test('telomerase: the same molecule at Done gets the same menu and card, whatever came before', { skip: !cache }, async t => {
  // The standard session decides where the molecule is when Done is pressed;
  // the others put it exactly there.
  const reference = await telomeraseFrom(STANDARD);
  const held = reference.s.placement();
  await reference.s.done();
  const expected = { seat: mm(reference.s.seat()), glass: glassKey(reference.s.measure()) };
  await reference.s.dispose();
  for (const head of HEADS) {
    const { s } = await telomeraseFrom(head, { grabAt: held });
    try {
      assert.deepEqual(s.placement(), held);
      await s.done();
      t.diagnostic(`head ${head}: seat ${mm(s.seat())}, expected ${expected.seat}`);
      assert.deepEqual(mm(s.seat()), expected.seat, `head ${head}: Done's menu seat`);
      assert.equal(glassKey(s.measure()), expected.glass, `head ${head}: Done's card and menu`);
    } finally { await s.dispose(); }
  }
});

const MOTION = ['kinesin-walk', 'atp-synthase-rotor', 'hemoglobin-switch'];
async function openedFirst(name) {
  const s = await lessonSeatSession(runtime);
  await s.open('4HHB'); await s.open(name); await s.start();
  return s;
}

test('CRISPR-Cas9: the opening chapter is clear of the glass at every angle of its spin', { skip: !cache }, async t => {
  const s = await lessonSeatSession(runtime);
  try {
    await s.open('4HHB');
    await s.open('crispr-cas9');
    await s.start();
    const measured = s.measure(), turned = s.spinCover();
    t.diagnostic(`chapter 1: placement ${JSON.stringify(s.placement())} ${describe(measured)} spin ${JSON.stringify(turned)}`);
    assert.ok(measured.every(eye => eye.rects.menu && eye.rects.card), 'card and menu drawn');
    assertUncovered(measured, 'chapter 1');
    turned.forEach((eye, i) => {
      for (const [name, most] of Object.entries(eye))
        assert.equal(most.atoms, 0, `${measured[i].eye} eye: ${name} glass over ${most.atoms} atoms ${most.degrees} degrees into the spin`);
    });
  } finally { await s.dispose(); }
});

// CRISPR-Cas9 chapters 1 and 2, as they land and as they would land with the
// glass proven at the authored angle alone (the chapter framed the same way).
// With `extents` the chapter is framed by its boundary's extreme points, as
// the page frames a structure (`focusPlacement`), not by its sphere alone.
async function crisprLandings({ turnGlass = true, extents = false, head } = {}) {
  const s = await lessonSeatSession(runtime);
  if (!turnGlass) s.h.chapterSpinning = () => false;
  const landing = () => {
    const focus = s.records.filter(record => record.kind === 'xr-focus').at(-1);
    const pivot = Vec3.transformMat4(Vec3(), s.h.pivotCenter(), s.h.presentationTransform()).map(v => v * s.h.canvas.camera.scale);
    const distance = Math.hypot(pivot[0] - (head?.[0] ?? 0), pivot[1] - 1.6 - (head?.[1] ?? 0), pivot[2] - (head?.[2] ?? 0)), placement = s.placement();
    const glass = s.records.filter(record => record.kind === 'chapter-field' && String(record.reason).startsWith('chapter-glass')).at(-1);
    return { size: placement.scale / distance, distance, angle: focus.angleDegrees, scale: focus.scale, moved: glass?.moveCost > 0,
      target: Math.hypot(...focus.targetRoom.map((v, i) => v - focus.eyeRoom[i])), cover: s.spinCover(), measured: s.measure() };
  };
  try {
    await s.open('4HHB'); await s.open('crispr-cas9');
    if (extents) {
      const helper = new BoundaryHelper('98'), atoms = coordinates(`${cache}/9KJ6.cif`, s.shown().lesson.provenance.sourceSha256);
      for (const atom of atoms) helper.includePosition(atom.position);
      helper.finishedIncludeStep();
      for (const atom of atoms) helper.radiusPosition(atom.position);
      const loaded = { ...s.h.loadedSphere(), extrema: helper.getSphere().extrema.map(point => Array.from(point)) };
      s.h.loadedSphere = s.h.recordBoundingSphere = () => loaded;
    }
    if (head) s.moveHead(head);
    await s.start(); const first = landing();
    await s.chapter(1); const second = landing();
    return { s, chapters: [first, second] };
  } catch (error) { await s.dispose(); throw error; }
}

test('CRISPR-Cas9: chapters 1 and 2 keep nine tenths of their size with the glass clear of the whole turn', { skip: !cache }, async t => {
  const still = await crisprLandings({ turnGlass: false });
  await still.s.dispose();
  const { s, chapters } = await crisprLandings();
  try {
    chapters.forEach((landed, i) => {
      const before = still.chapters[i], where = `chapter ${i + 1}`;
      t.diagnostic(`${where}: size ${(landed.size / before.size).toFixed(3)} of the still glass's, distance ${before.distance.toFixed(3)} -> ${landed.distance.toFixed(3)} m`);
      assert.ok(landed.size >= .89 * before.size, `${where} lands at ${(landed.size / before.size).toFixed(3)} of its size`);
      landed.cover.forEach((eye, k) => {
        for (const [name, most] of Object.entries(eye))
          assert.equal(most.atoms, 0, `${where}, ${landed.measured[k].eye} eye: ${name} glass over ${most.atoms} atoms ${most.degrees} degrees into the spin`);
      });
    });
  } finally { await s.dispose(); }
});

// From a head 0.2 m to the right, 0.1 m lower and 0.1 m back, both chapters
// took a move sideways and back that kept their field's centre within a ninth
// of its framed distance but set their target back by 13%: they landed 0.884
// of their size. A chapter's size is its scale over its target's distance.
test('CRISPR-Cas9: a chapter moved sideways for the glass of its whole turn keeps nine tenths of its size', { skip: !cache }, async t => {
  const head = [.2, -.1, .1];
  const still = await crisprLandings({ turnGlass: false, head });
  await still.s.dispose();
  const { s, chapters } = await crisprLandings({ head });
  try {
    chapters.forEach((landed, i) => {
      const before = still.chapters[i], share = (landed.scale / landed.target) / (before.scale / before.target);
      t.diagnostic(`chapter ${i + 1}: ${share.toFixed(3)} of its size, target ${before.target.toFixed(3)} -> ${landed.target.toFixed(3)} m, moved ${landed.moved}`);
      assert.ok(share >= .9, `chapter ${i + 1} lands at ${share.toFixed(3)} of its size`);
      landed.cover.forEach((eye, k) => {
        for (const [name, most] of Object.entries(eye))
          assert.equal(most.atoms, 0, `chapter ${i + 1}, ${landed.measured[k].eye} eye: ${name} glass over ${most.atoms} atoms ${most.degrees} degrees into the spin`);
      });
    });
  } finally { await s.dispose(); }
});

test('CRISPR-Cas9: a chapter moved clear of the glass reports the angle its framing projected, at the landed distance', { skip: !cache }, async t => {
  // From a little lower, chapter 2 is moved for the glass; the opening chapter is not.
  const head = [0, -.15, 0];
  const still = await crisprLandings({ turnGlass: false, extents: true, head });
  await still.s.dispose();
  const { s, chapters } = await crisprLandings({ extents: true, head });
  try {
    assert.ok(chapters[1].moved && !still.chapters[1].moved, 'chapter 2 is moved for the glass');
    // The solver's projected half-width, in structure units, from the angle it reports.
    const halfWidth = ({ angle, target, scale }) => Math.tan(angle * Math.PI / 360) * target / scale;
    chapters.forEach((landed, i) => {
      const before = still.chapters[i];
      t.diagnostic(`chapter ${i + 1}: ${before.angle} degrees at ${before.target.toFixed(3)} m -> ${landed.angle} at ${landed.target.toFixed(3)} m, half-width ${(halfWidth(landed) / halfWidth(before)).toFixed(4)}`);
      assert.ok(Math.abs(halfWidth(landed) / halfWidth(before) - 1) < .004,
        `chapter ${i + 1}: ${landed.angle} degrees at ${landed.target.toFixed(3)} m and scale ${landed.scale.toFixed(3)}, against ${before.angle} at ${before.target.toFixed(3)} m and scale ${before.scale.toFixed(3)}`);
    });
  } finally { await s.dispose(); }
});

test('CRISPR-Cas9: a spinning chapter builds its turn\'s field and its menu proof once while it turns', { skip: !cache }, async () => {
  const s = await lessonSeatSession(runtime);
  try {
    let request;
    const prove = s.h.clearChapterMenu;
    s.h.clearChapterMenu = options => prove(request = options);
    await s.open('4HHB'); await s.open('crispr-cas9');
    // Framed by its extreme points, the opening chapter finds no seat clear of
    // its whole turn: each redraw keeps the card that covers least.
    const helper = new BoundaryHelper('98'), atoms = coordinates(`${cache}/9KJ6.cif`, s.shown().lesson.provenance.sourceSha256);
    for (const atom of atoms) helper.includePosition(atom.position);
    helper.finishedIncludeStep();
    for (const atom of atoms) helper.radiusPosition(atom.position);
    const loaded = { ...s.h.loadedSphere(), extrema: helper.getSphere().extrema.map(point => Array.from(point)) };
    s.h.loadedSphere = s.h.recordBoundingSphere = () => loaded;
    const sweep = s.h.sweptChapterBalls;
    let builds = 0, scanned = 0;
    s.h.sweptChapterBalls = (...args) => { builds++; return sweep(...args); };
    await s.start();
    assert.ok(builds > 0, 'the opening chapter\'s turn was swept');
    builds = 0;
    for (let i = 0; i < 3; i++) {
      const field = s.h.chapterFieldBounds(undefined, { still: true, drawn: true });
      s.h.chapterFieldBounds(undefined, { still: true, drawn: true, allDrawn: true });
      assert.ok(field.spheres.length <= SPIN_FIELD_BALLS, `${field.spheres.length} balls`);
    }
    assert.equal(builds, 0, 'the landed turn\'s field is reused, not swept again');
    // A redraw of the same glass while the chapter turns scans no seat again.
    const first = await prove({ ...request, isCurrent: () => true });
    assert.equal(first?.kept, true, `the card is kept: ${JSON.stringify(first)}`);
    const again = await prove({ ...request, isCurrent: () => true,
      relocationCandidates: pose => { scanned++; return request.relocationCandidates(pose); },
      chapterCardCandidates: pose => { scanned++; return request.chapterCardCandidates(pose); } });
    assert.equal(again?.chapterCardSeat?.id, first.chapterCardSeat.id);
    assert.equal(scanned, 0, 'the redraw took the turn\'s proof again');
    // A scan the proof has not seen runs in slices: the event loop turns while it
    // proves, here on a clock that passes 50 ms per reading, and it keeps its answer.
    vm.runInContext('lastSpinProof = null;', s.h);
    let clock = 0, turned = false;
    s.h.now = () => (clock += 50);
    setTimeout(() => { turned = true; }, 0);
    const sliced = await prove({ ...request, isCurrent: () => true });
    assert.ok(turned, 'the event loop turned during the scan');
    assert.equal(sliced?.chapterCardSeat?.id, first.chapterCardSeat.id);
  } finally { await s.dispose(); }
});

// Between slices the tracking sample can drop, the source can be swapped or
// Fit can move the placement. A proof that outlives any of them ends
// cancelled, never as clearance and never by throwing.
test('CRISPR-Cas9: a spinning chapter\'s proof that outlives its tracking, source or placement ends cancelled', { skip: !cache }, async () => {
  const s = await lessonSeatSession(runtime);
  try {
    let request;
    const prove = s.h.clearChapterMenu;
    s.h.clearChapterMenu = options => prove(request = options);
    await s.open('4HHB'); await s.open('crispr-cas9');
    const helper = new BoundaryHelper('98'), atoms = coordinates(`${cache}/9KJ6.cif`, s.shown().lesson.provenance.sourceSha256);
    for (const atom of atoms) helper.includePosition(atom.position);
    helper.finishedIncludeStep();
    for (const atom of atoms) helper.radiusPosition(atom.position);
    const loaded = { ...s.h.loadedSphere(), extrema: helper.getSphere().extrema.map(point => Array.from(point)) };
    s.h.loadedSphere = s.h.recordBoundingSphere = () => loaded;
    await s.start();
    const pose = s.h.latestRoomPlacementPose, placement = s.h.inspectionSnapshot().placement, clock = s.h.now, webgl = s.h.canvas.webgl;
    vm.runInContext('var sourceRecord = {};', s.h);
    let held = false;
    const changes = {
      tracking: () => { s.h.latestRoomPlacementPose = null; },
      source: () => { s.h.sourceRecord = {}; },
      drag: () => { held = true; },
      placement: () => { s.h.inspectionState.place({ ...placement, translation: placement.translation.map(v => v + .05) }); } };
    for (const [name, change] of Object.entries(changes)) {
      vm.runInContext('lastSpinProof = null;', s.h);
      let time = 0, frames = 0;
      s.h.now = () => (time += 25);
      // The third headset frame between slices arrives after the change.
      s.h.canvas.webgl = { ...webgl, xr: { session: { requestAnimationFrame: callback => {
        if (++frames === 3) change();
        setTimeout(callback, 0);
      } } } };
      const kept = s.records.filter(r => r.reason === 'chapter-card-kept').length;
      const answer = await prove({ ...request, isCurrent: () => true, menuHeld: () => held }).catch(error => ({ threw: error.message }));
      held = false;
      assert.equal(s.records.filter(r => r.reason === 'chapter-card-kept').length, kept, `${name}: no seat is written`);
      Object.assign(s.h, { now: clock, latestRoomPlacementPose: pose }); s.h.canvas.webgl = webgl;
      s.h.inspectionState.place(placement);
      assert.ok(frames >= 3, `${name}: ${frames} frames`);
      assert.deepEqual({ ...answer }, { cancelled: true }, `${name} changed between slices: ${JSON.stringify(answer && Object.keys(answer))}`);
    }
  } finally { await s.dispose(); }
});

// A proof runs in slices, and ends cancelled when the placement changes, only
// against a spin's swept field, and that field always stands still: the
// level move is taken only for a field that moves. So a spinning chapter's
// proof never moves the structure itself, and the toolbar gets and draws the
// seat it answers. Chapter 2's sideways move is its framing's, before any proof.
test('CRISPR-Cas9: a spinning chapter\'s menu proof never moves the structure, and the toolbar draws the seat it answers', { skip: !cache }, async t => {
  for (const extents of [false, true]) {
    const s = await lessonSeatSession(runtime);
    try {
      const prove = s.h.clearChapterMenu, proofs = [];
      s.h.clearChapterMenu = async options => {
        const field = s.h.chapterFieldBounds(undefined, { still: true, drawn: true });
        const before = JSON.stringify(s.h.inspectionSnapshot().placement), from = s.records.length;
        const answer = await prove(options);
        proofs.push({ swept: !!field?.sweptKey, still: field?.still === true, answer, moves: s.records.slice(from).filter(r => r.reason === 'menu').length,
          moved: JSON.stringify(s.h.inspectionSnapshot().placement) !== before });
        return answer;
      };
      await s.open('4HHB'); await s.open('crispr-cas9');
      if (extents) {
        const helper = new BoundaryHelper('98'), atoms = coordinates(`${cache}/9KJ6.cif`, s.shown().lesson.provenance.sourceSha256);
        for (const atom of atoms) helper.includePosition(atom.position);
        helper.finishedIncludeStep();
        for (const atom of atoms) helper.radiusPosition(atom.position);
        const loaded = { ...s.h.loadedSphere(), extrema: helper.getSphere().extrema.map(point => Array.from(point)) };
        s.h.loadedSphere = s.h.recordBoundingSphere = () => loaded;
      }
      await s.start(); await s.chapter(1);
      const spun = proofs.filter(proof => proof.swept);
      t.diagnostic(`${extents ? 'extents' : 'sphere'}: ${spun.map(({ answer, moved }) => `${answer?.cancelled ? 'cancelled'
        : answer?.chapterCardSeat?.id ?? answer?.menuRelocation?.id ?? (answer?.obstructed ? 'obstructed' : 'clear')}${moved ? ' MOVED' : ''}`).join(', ')}`);
      assert.ok(spun.length >= 2, `${spun.length} proofs against the turn`);
      for (const proof of spun) {
        assert.equal(proof.still, true, 'the turn\'s field stands still');
        assert.equal(proof.moved || proof.moves > 0, false, 'the proof moved nothing');
        assert.notEqual(proof.answer?.cancelled, true, 'nothing else moved it either, so it answered');
      }
      const seated = spun.filter(({ answer }) => answer?.chapterCardSeat || answer?.menuRelocation).at(-1)?.answer;
      if (seated) assert.equal(s.records.filter(r => /^(menu-relocated|chapter-card-)/.test(r.reason)).at(-1)?.seat,
        (seated.chapterCardSeat ?? seated.menuRelocation).id, 'its seat is written when the toolbar draws it');
    } finally { await s.dispose(); }
  }
});

// The landing proof scanned every card seat's card, menu and status line
// against the whole turn, then each of their plates again for the record:
// 205 scans of 12,000 balls in two copies of one field, 600 to 760 ms on the
// headset while the new card waited. The same card wins when each seat is
// measured only as far as the ranking needs, against one field.
test('CRISPR-Cas9: a spinning chapter keeps its card after measuring each seat only as far as the ranking needs', { skip: !cache }, async t => {
  const s = await lessonSeatSession(runtime);
  try {
    let request;
    const prove = s.h.clearChapterMenu;
    s.h.clearChapterMenu = options => prove(request = options);
    await s.open('4HHB'); await s.open('crispr-cas9');
    const helper = new BoundaryHelper('98'), atoms = coordinates(`${cache}/9KJ6.cif`, s.shown().lesson.provenance.sourceSha256);
    for (const atom of atoms) helper.includePosition(atom.position);
    helper.finishedIncludeStep();
    for (const atom of atoms) helper.radiusPosition(atom.position);
    const loaded = { ...s.h.loadedSphere(), extrema: helper.getSphere().extrema.map(point => Array.from(point)) };
    s.h.loadedSphere = s.h.recordBoundingSphere = () => loaded;
    await s.start();
    const landed = s.records.filter(record => record.reason === 'chapter-card-kept').at(-1);
    assert.ok(landed, 'the opening chapter keeps its card');
    const scorer = s.h.createMenuObstructionScorer;
    let scorers = 0, whole = 0, first = 0;
    s.h.createMenuObstructionScorer = options => {
      scorers++;
      const score = scorer(options);
      return query => { if (!query.any) whole++; else first++; return score(query); };
    };
    vm.runInContext('lastSpinProof = null;', s.h);
    const answer = await prove({ ...request, isCurrent: () => true });
    const landings = s.records.filter(r => r.reason === 'chapter-card-kept').length;
    answer.committed();
    assert.equal(s.records.filter(r => r.reason === 'chapter-card-kept').length, landings + 1, 'the seat is written once the toolbar draws it');
    const record = s.records.filter(r => r.reason === 'chapter-card-kept').at(-1);
    t.diagnostic(`${record.seat}: ${scorers} field(s), ${whole} whole scans, ${first} ended at the first covered part`);
    assert.equal(answer?.chapterCardSeat?.id, landed.seat, 'the same card wins');
    for (const key of ['seat', 'covered', 'controlsCovered', 'overlap', 'status', 'crossesPlates'])
      assert.deepEqual(record[key], landed[key], `${key} as the landing recorded it`);
    assert.equal('seats' in record || 'seats' in landed, false, 'no per-seat breakdown is claimed where none was measured');
    assert.equal(scorers, 1, 'the status line is measured against the menu\'s field');
    assert.ok(whole <= 20, `${whole} whole scans of the turn`);
    // Building the turn's field is a slice of its own: on a clock that passes
    // 25 ms per reading, the event loop turns before any glass is proven.
    vm.runInContext('lastSpinProof = null;', s.h);
    let clock = 0, turned = false, turnedFirst;
    s.h.now = () => (clock += 25);
    const fit = s.h.fitChapterField;
    s.h.fitChapterField = (...args) => { turnedFirst ??= turned; return fit(...args); };
    setTimeout(() => { turned = true; }, 0);
    // In the headset each slice waits for a frame to be drawn: a timer alone
    // let the next slice run first, and frames still waited over 100 ms.
    let frames = 0;
    const webgl = s.h.canvas.webgl;
    s.h.canvas.webgl = { ...webgl, xr: { session: { requestAnimationFrame: callback => { frames++; setTimeout(callback, 0); } } } };
    const sliced = await prove({ ...request, isCurrent: () => true });
    s.h.canvas.webgl = webgl;
    assert.equal(turnedFirst, true, 'the event loop turned between the field and the first proof');
    assert.ok(frames > 1, `${frames} frames drawn between slices`);
    assert.equal(sliced?.chapterCardSeat?.id, landed.seat);
  } finally { await s.dispose(); }
});

test('kinesin walk, ATP synthase rotor and hemoglobin: the opening chapter from the standard seat', { skip: !cache }, async t => {
  for (const name of MOTION) {
    const s = await openedFirst(name);
    try {
      const measured = s.measure();
      t.diagnostic(`${name}: seat ${mm(s.seat())} ${describe(measured)}`);
      // A moving chapter's card may stand on its motion envelope, and its
      // plates ride along it: those are the chapter solver's own trade. The
      // controls never cover the molecule and no glass lies on another.
      assertUncovered(measured, name, { atoms: ['menu', 'status'], labels: false });
    } finally { await s.dispose(); }
  }
});

test('the next lesson opens where it opens first, whatever the lesson before it did', { skip: !cache }, async t => {
  const first = {};
  for (const name of MOTION) {
    const s = await openedFirst(name);
    first[name] = { seat: mm(s.seat()), glass: glassKey(s.measure()) };
    await s.dispose();
  }
  for (const head of [STANDARD, ...HEADS]) {
    const { s } = await telomeraseFrom(head);
    try {
      await s.done();
      for (const name of MOTION) {
        await s.open(name); await s.start();
        t.diagnostic(`head ${head}, ${name} after telomerase: seat ${mm(s.seat())}, opened first ${first[name].seat}`);
        assert.deepEqual(mm(s.seat()), first[name].seat, `head ${head}: ${name}'s menu seat`);
        assert.equal(glassKey(s.measure()), first[name].glass, `head ${head}: ${name}'s card, menu and assistant line`);
      }
    } finally { await s.dispose(); }
  }
});

test('a menu the wearer dragged stays where they put it when the next lesson opens', { skip: !cache }, async () => {
  const s = await lessonSeatSession(runtime);
  try {
    await s.open('4HHB');
    const before = s.seat();
    assert.equal((await s.t.toolbar.aimSynthetic({ drag: { phase: 'begin', id: 'tour', kind: 'grip' } })).accepted, true);
    assert.equal((await s.t.toolbar.aimSynthetic({ drag: { phase: 'move', offset: [-.12, -.05, 0] } })).accepted, true);
    assert.equal((await s.t.toolbar.aimSynthetic({ drag: { phase: 'end' } })).accepted, true);
    await s.settle(); await s.t.frames(12); await s.settle();
    const dragged = s.seat();
    assert.ok(Math.hypot(...dragged.map((v, i) => v - before[i])) > .1, 'the drag moved the menu');
    await s.open('telomerase-haca');
    assert.deepEqual(mm(s.seat()), mm(dragged), 'a new structure keeps the dragged seat');
    await s.open('kinesin-walk');
    assert.deepEqual(mm(s.seat()), mm(dragged), 'and so does the next lesson');
  } finally { await s.dispose(); }
});
