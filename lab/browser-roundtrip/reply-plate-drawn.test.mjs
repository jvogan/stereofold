import { createAssistantStatus } from './assistant-status.mjs';
import { recordTalkReplySeat } from './talk-reply-diagnostics.mjs';
import { menuSeatWithinView } from './menu-view-band.mjs';
/**
 * A delivered reply has to be drawn, not merely reported.
 *
 * On the Quest 2 pass the Mac delivered a 117-character answer. The
 * ring recorded `talk-caption` with the full text and `talk-caption-seat` with
 * `outcome: "shown"`, and the audio played for 7.05 s. Seven captures at two
 * second intervals across that window found no reply anywhere in the wearer's
 * view, and the toolbar reported `plates: 31` both before and after
 *
 * Two separate failures made that one symptom, and this file pins both.
 *
 * The menu never drew the reply at all. `createToolbarPanel` builds the reply
 * card -- `statusBacking`, labelled `Reply status` where the plates are mapped
 * -- only when it is handed a status line, and the only line it was ever handed
 * was a tour's feedback error. A reply set `notice`, changed the content
 * signature, and paid for a full mesh and text rebuild that drew nothing new,
 * which is exactly a plate count that does not move.
 *
 * The head-seated card did draw, and then came down at three seconds while the
 * headset was still speaking the sentence. Six of the seven captures were taken
 * after that. Three seconds is right for `Applied · style +1`; an answer holds
 * for the window the Mac asked for on the caption and for as long as its own
 * clip runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as geometry from './spatial-toolbar-geometry.mjs';
import { connectionStatus, TALK_LINK_LOST } from './connection-liveness.mjs';
import { measureReplyCard, measureReplyCardClearance, replyCardOffsetAsync } from './reply-card-layout.mjs';
import { replyCaptionHoldMs, replySegmentsOf } from './reply-segments.mjs';
import { projectPlateQuad } from './component-label-measurement.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';
import { toolbarFrameRuntime, toolbarFrameHarness } from './fixtures/toolbar-frame-runtime.mjs';

/** The reply a device run delivered, with the hold and the clip length the Mac sent. */
const REPLY = Object.freeze({ id: 'c28f4fa4', speak: true, holdSeconds: 6,
  text: 'Crambin is still on screen. The hemoglobin reload could not start, because the headset panel has not saved its scene.',
  segments: [{ text: 'Crambin is still on screen.', seconds: 7.05, audio: { base64: 'AA==', bytes: 1, mimeType: 'audio/ogg' } }] });

// The page's own reply listeners, cut from production rather than restated, so
// a change that stops passing the hold through fails here.
const sessionSource = readFileSync(new URL('./immersive-session.mjs', import.meta.url), 'utf8');
const listenerStart = sessionSource.indexOf('          const onReply = event => {');
const listenerEnd = sessionSource.indexOf('          globalThis.addEventListener?.(REPLY_CAPTION_EVENT', listenerStart);
assert.ok(listenerStart > 0 && listenerEnd > listenerStart, 'immersive-session.mjs must own the reply listeners');
const buildCaptionListeners = new Function('record', 'replySegmentsOf', 'replyCaptionHoldMs', 'recordTalkReplySeat',
  `${sessionSource.slice(listenerStart, listenerEnd)}\nreturn { onReply, onSegment };`);

const captionListeners = (...args) => buildCaptionListeners(...args, recordTalkReplySeat);

/** The recorded fields of view, carried to the height the wearer's head is at
 * in the test that uses them. The immersive path always hands the layout
 * its eye transforms, so a harness that stands for that path hands them over
 * too, and `outcome: "shown"` in it is a measurement rather than a name. */
const eyesAt = metres => syntheticViews().map(view => {
  const matrix = [...view.transform.matrix], inverse = [...view.transform.inverse.matrix];
  matrix[13] += metres; inverse[13] -= metres;
  return { ...view, transform: { matrix, inverse: { matrix: inverse } } };
});

/**
 * The production talk caption, with the two-eye clearance the reply solver
 * uses on hardware. Only Mol*'s mesh, text and GPU boundary is replaced; the
 * seat, the wrap, the offset search and the expiry are the shipped ones.
 */
function captionHarness({ clearance = () => ({ views: eyesAt(0), renderFromRoom: identity() }) } = {}) {
  const source = readFileSync(new URL('./talk-caption.mjs', import.meta.url), 'utf8');
  const live = new Set(), records = [], quads = [], textDraws = [];
  let time = 0;
  const context = vm.createContext({ assistantStatus: createAssistantStatus(), menuSeatWithinView, connectionStatus, TALK_LINK_LOST, ...geometry, measureReplyCard, measureReplyCardClearance,
    replyCardOffsetAsync: (args, options) => replyCardOffsetAsync(args, { ...options, now: () => 0 }),
    MeshBuilder: { createState: () => ({}), addTriangleWithNormal(state, a, b, c) { quads.push([a, b, c]); }, getMesh: () => ({}) },
    Mesh: { Utils: {} }, TextBuilder: { create: () => { const glyphs = []; return { add: glyph => glyphs.push(glyph), getText: () => { textDraws.push(glyphs.join('')); return {}; } }; } }, Text: { Utils: {} },
    getFontAtlas: () => ({ buffer: 0, lineHeight: 1, get: () => ({ nw: .6 }) }),
    Shape: { create: () => ({}) }, ShapeRepresentation: () => ({ createOrUpdate() {}, destroy() {} }), Color: value => value });
  vm.runInContext('"use strict";\n' + source.replace(/^import .*;$/gm, '').replace(/\bexport /g, ''), context);
  const card = context.createTalkCaption({ plugin: { runTask: async () => {} },
    presentation: { add: representation => live.add(representation), remove: representation => live.delete(representation) },
    head: () => ({ position: { x: 0, y: 0, z: 0 }, matrix: identity() }), clearance,
    now: () => time, record: (kind, detail) => records.push({ kind, detail }) });
  context.setTalkOutcomeSink((text, holdMs, complete, onSeat) => card.set({ outcome: text, holdMs, complete, onSeat }));
  return { card, context, live, records, quads, textDraws,
    advance: ms => { time = ms; card.frame(); } };
}

const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

test('a delivered reply is drawn in the wearer\'s view, seated inside both eye frusta', async () => {
  const harness = captionHarness();
  const listeners = captionListeners(
    { toolbar: { setStatus: (text, color, progress, holdMs, complete, onSeat) => harness.context.showTalkOutcome(text, holdMs, complete, onSeat) } },
    replySegmentsOf, replyCaptionHoldMs);
  listeners.onReply({ detail: REPLY });
  await flush();

  assert.equal(harness.live.size, 2, 'the reply adds its plate and its glyphs to the drawn set');
  assert.equal(harness.records.filter(entry => entry.kind === 'talk-caption').length, 1);
  assert.deepEqual(harness.records.filter(entry => entry.kind === 'talk-caption-seat').map(entry => entry.detail.outcome),
    ['shown'], 'the seat is reported once, and reported as drawn');
  assert.equal(harness.card.text(), REPLY.segments[0].text, 'the drawn line is the segment that is sounding');

  // `outcome: shown` is only worth as much as the geometry behind it. The
  // corners the mesh builder was actually handed must land on the glass of both
  // eyes, which is what an earlier run could not confirm from the log alone.
  const corners = harness.quads.slice(-2).flat();
  for (const view of syntheticViews()) {
    const projected = projectPlateQuad(corners, view);
    assert.ok(projected.rect, 'the reply plate projects into the eye');
    assert.ok(projected.inside > .999, 'the whole reply plate is inside the eye frustum');
  }
});

test('a delivered reply holds for the window the Mac asked for, then leaves', async () => {
  const harness = captionHarness();
  const listeners = captionListeners(
    { toolbar: { setStatus: (text, color, progress, holdMs, complete, onSeat) => harness.context.showTalkOutcome(text, holdMs, complete, onSeat) } },
    replySegmentsOf, replyCaptionHoldMs);
  listeners.onReply({ detail: REPLY });
  await flush();

  // The window is the longer of the Mac's `holdSeconds` and the clip's own
  // length. Three seconds was the whole defect: the plate came down while the
  // headset was still reading the sentence out.
  const window = replyCaptionHoldMs(REPLY.segments[0], REPLY);
  assert.equal(window, 7050);
  for (const at of [2000, 3100, 5000, 7000]) {
    harness.advance(at); await flush();
    assert.equal(harness.live.size, 2, `the reply is still readable at ${at} ms`);
    assert.equal(harness.card.text(), REPLY.segments[0].text);
  }
  harness.advance(window + 1); await flush();
  assert.equal(harness.live.size, 0, 'the reply leaves the wearer\'s view when its window ends');
  assert.equal(harness.card.text(), '');
});

test('control feedback keeps the three-second hold a reply does not', async () => {
  const harness = captionHarness();
  harness.context.showTalkOutcome('Applied · style +1');
  await flush();
  assert.equal(harness.live.size, 2);
  harness.advance(2999); await flush();
  assert.equal(harness.live.size, 2, 'a confirmation is readable for its own three seconds');
  harness.advance(3000); await flush();
  assert.equal(harness.live.size, 0, 'and no longer, so the plate is never stale');
});

test('the reply\'s seat and window reach the ring, and the menu keeps its own plate count', async () => {
  const runtime = await toolbarFrameRuntime();
  const records = [], previous = globalThis.__stereofoldDiagnostics;
  globalThis.__stereofoldDiagnostics = { record: (kind, detail) => records.push({ kind, detail }) };
  const live = new Set();
  const presentation = { add: representation => live.add(representation), remove: representation => live.delete(representation) };
  let now = 0;
  // A resting caption card, as the wearer had. The reply takes
  // its own head-seated glass in front of that and never the menu's, which is
  // the reply-once rule: one answer, one visible surface.
  const harness = toolbarFrameHarness(runtime, { presentation,
    state: { voice: { state: 'idle' }, subject: { title: 'Water structure of a hydrophobic protein at 1.5 A', entryId: '1CRN' } } });
  const card = runtime.createTalkCaption({ plugin: { runTask: task => task.run() }, presentation,
    head: () => ({ position: { x: 0, y: 1.6, z: 0 }, matrix: identity() }), now: () => now,
    clearance: () => ({ views: eyesAt(1.6), renderFromRoom: identity() }),
    record: (kind, detail) => records.push({ kind, detail }) });
  runtime.setTalkOutcomeSink((text, holdMs, complete, onSeat) => card.set({ outcome: text, holdMs, complete, onSeat }));
  try {
    harness.toolbar.syncPose(harness.frame);
    await harness.toolbar.update();
    harness.session.requestAnimationFrame = () => 1; // Expiry is advanced explicitly.
    const plates = () => records.filter(entry => entry.kind === 'toolbar' && entry.detail.phase === 'plates').at(-1).detail;
    const quiet = plates();

    const completed = [];
    await harness.toolbar.setStatus(REPLY.segments[0].text, undefined, undefined,
      replyCaptionHoldMs(REPLY.segments[0], REPLY), false, receipt => completed.push(receipt));
    await flush();
    const drawn = [...live].map(representation => representation.shape).filter(Boolean);
    assert.equal(drawn.filter(shape => shape.name === 'Stereofold caption').length, 1,
      'the answer has exactly one visible surface, the head-seated card');
    assert.equal(plates().plates, quiet.plates,
      'the menu keeps its own plate count: that counter never held this card');

    // The two numbers an earlier run needed from the ring and did not have.
    const seat = records.filter(entry => entry.kind === 'talk-caption-seat').at(-1).detail;
    assert.deepEqual(completed, [seat], 'the real toolbar and sink return only the committed seat');
    assert.equal(seat.outcome, 'shown');
    assert.equal(seat.holdMs, 7050, 'the ring says how long the card will stay');
    assert.equal(seat.seat.length, 3, 'and where it went, in room metres');
    assert.ok(seat.seat[1] < 1.6, 'the card is seated below the wearer\'s gaze');
  } finally {
    runtime.setTalkOutcomeSink(undefined);
    await card.dispose();
    await harness.toolbar.dispose();
    globalThis.__stereofoldDiagnostics = previous;
  }
});

test('a refused source draws the complete host sentence for the protected reply reading window', async () => {
  const harness = captionHarness();
  const listeners = captionListeners(
    { toolbar: { setStatus: (text, color, progress, holdMs, complete, onSeat) => harness.context.showTalkOutcome(text, holdMs, complete, onSeat) } },
    replySegmentsOf, replyCaptionHoldMs);
  const refusal = { id: 'source-refusal', speak: false, holdSeconds: 6, refusalScope: {},
    text: 'Could not load · insecure address. Insecure URLs and embedded credentials are refused. Only https URLs to UTF-8 mmCIF or PDB files are supported, and local files must be absolute regular .cif or .mmcif files; either way this plugin fetches or reads at most 16,777,216 bytes (16 MiB), which is its own policy and not a viewer limit.' };
  listeners.onReply({ detail: refusal });
  await flush();
  const pages = [harness.card.text()];
  assert.equal(harness.textDraws.at(-1), pages[0].replace(/\s/gu, ''), 'every page character reaches the glyph builder');
  assert.equal(harness.live.size, 2, 'the refusal adds both plate and text representations');
  harness.context.showTalkOutcome('');
  await flush();
  for (const at of [1000, 3100, 5999]) {
    harness.advance(at); await flush();
    assert.equal(harness.card.text(), pages[0], 'a routine clear cannot replace the refusal');
    assert.equal(harness.live.size, 2);
  }
  for (let page = 1; pages.join(' ').length < refusal.text.length && page < 12; page++) {
    harness.advance(page * 6001); await flush();
    pages.push(harness.card.text());
    assert.equal(harness.textDraws.at(-1), pages.at(-1).replace(/\s/gu, ''));
    assert.equal(harness.live.size, 2);
  }
  assert.equal(pages.join(' '), refusal.text, 'every word of the host refusal is drawn');
  harness.advance(pages.length * 6001); await flush();
  assert.equal(harness.live.size, 0);
});

test('a new reply cancels every unread refusal page', async () => {
  const harness = captionHarness();
  harness.card.set({ outcome: 'Could not load. ' + 'The host refused this source. '.repeat(8), holdMs: 6000, complete: true });
  await flush();
  harness.advance(6000);
  harness.context.showTalkOutcome('');
  await flush();
  assert.ok(harness.card.text(), 'the old status timer cannot remove the next refusal page');
  harness.context.showTalkOutcome('Use the current structure.', 6000);
  await flush();
  assert.equal(harness.card.text(), 'Use the current structure.');
  harness.advance(12001); await flush();
  assert.equal(harness.card.text(), '');
  harness.advance(24000); await flush();
  assert.equal(harness.live.size, 0, 'no unread page returns after a correction');
});

/**
 * On the device every reply between the Mol* return and
 * the next Fit was written to the ring as `reply-received... "drawn": true`
 * and, in the same second, as `talk-caption-seat {"outcome":"blocked"}`. The
 * wearer saw nothing. This runs the same production listener and sink with
 * lifted eyes, and checks the farther seat and its delivery against those
 * eyes rather than the levelled seat frame.
 */
test('a lifted eye pose gets a readable reply seat before the delivery reports drawn', async () => {
  const eyes = syntheticViews().map(view => {
    const matrix = [...view.transform.matrix], inverse = [...view.transform.inverse.matrix];
    matrix[13] += 2; inverse[13] -= 2;
    return { ...view, transform: { matrix, inverse: { matrix: inverse } } };
  });
  const harness = captionHarness({ clearance: () => ({ views: eyes, renderFromRoom: identity() }) });
  const ring = [], scope = { __stereofoldDiagnostics: { record: (kind, detail) => ring.push({ kind, detail }) } };
  const listeners = buildCaptionListeners(
    { toolbar: { setStatus: (text, color, progress, holdMs, complete, onSeat) => harness.context.showTalkOutcome(text, holdMs, complete, onSeat) } },
    replySegmentsOf, replyCaptionHoldMs, (caption, seat) => recordTalkReplySeat(caption, seat, { scope }));
  listeners.onReply({ detail: REPLY });
  await flush();

  const seat = harness.records.filter(entry => entry.kind === 'talk-caption-seat').at(-1).detail;
  assert.equal(seat.outcome, 'shown', 'the seat says what the eyes say');
  for (const view of eyes) assert.ok(projectPlateQuad(harness.quads.slice(-2).flat(), view).inside > .999999);
  assert.equal(harness.live.size, 2);

  const delivered = ring.filter(entry => entry.kind === 'reply-received');
  assert.ok(delivered.length > 0, 'the production sink reported the seat through the listener');
  assert.equal(delivered.at(-1).detail.drawn, true);
  assert.equal(delivered.at(-1).detail.seatOutcome, 'shown');
  assert.equal(delivered.at(-1).detail.captionId, REPLY.id);
});

/**
 * `replyCardOffset` reported `outcome: "shown", inside: 1,
 * measured: false` whenever the caller supplied no `clearance.views`. On the
 * immersive path that is a tracked frame that carried no eye transforms -- the
 * page then knows nothing about where the wearer is looking, and the delivery
 * record still said the reply had been drawn. It now says which of the two it
 * is, so `drawn: false` from a missing measurement cannot be read as a card
 * neither eye could hold.
 */
test('a reply the page can give no eye views is logged unmeasured and never drawn', async () => {
  let views;
  const harness = captionHarness({ clearance: () => views });
  const ring = [], scope = { __stereofoldDiagnostics: { record: (kind, detail) => ring.push({ kind, detail }) } };
  const listeners = buildCaptionListeners(
    { toolbar: { setStatus: (text, color, progress, holdMs, complete, onSeat) => harness.context.showTalkOutcome(text, holdMs, complete, onSeat) } },
    replySegmentsOf, replyCaptionHoldMs, (caption, seat) => recordTalkReplySeat(caption, seat, { scope }));
  listeners.onReply({ detail: REPLY });
  await flush();

  assert.equal(harness.live.size, 0, 'the card stays pending until both eye views exist');
  const seat = harness.records.filter(entry => entry.kind === 'talk-caption-seat').at(-1).detail;
  assert.equal(seat.outcome, 'unmeasured', 'no eye transforms reached the layout, so nothing may say shown');
  assert.equal(seat.measured, false);
  assert.equal(seat.inside, undefined, 'and no fraction is reported that was never measured');

  const delivered = ring.filter(entry => entry.kind === 'reply-received');
  assert.ok(delivered.length > 0, 'the production sink reported the seat through the listener');
  assert.ok(delivered.every(entry => entry.detail.drawn === false),
    'no record of this reply claims the wearer was shown it');
  assert.equal(delivered.at(-1).detail.seatOutcome, 'unmeasured');
  assert.equal(delivered.at(-1).detail.measured, false);
  assert.equal(delivered.at(-1).detail.reason, 'no-eye-views', 'the delivery record says why it is not drawn');
  assert.equal(delivered.at(-1).detail.captionId, REPLY.id);
  views = { views: eyesAt(0), renderFromRoom: identity() };
  harness.advance(201); await flush();
  assert.equal(harness.live.size, 2, 'the pending reply is drawn when both eyes become measurable');
  assert.equal(harness.records.filter(entry => entry.kind === 'talk-caption-seat').at(-1).detail.outcome, 'shown');
});
