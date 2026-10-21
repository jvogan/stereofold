import { createAssistantStatus } from './assistant-status.mjs';
import { menuSeatWithinView } from './menu-view-band.mjs';
/**
 * No caption kind ends in an ellipsis.
 *
 * On the Quest 2 pass three caption kinds drew two lines and cut the
 * rest. The reply plate drew
 * `This reply is a reading window…` out of a 26-word answer and
 * `talk-caption-seat` recorded `lines: 2`. The lost-link card drew
 * `Link to the Mac / lost ·…` out of `Link to the Mac lost · reconnecting…`.
 * The Fit placement line, on the menu readout rather than this plate, drew
 * `Fitted to the right of the…` and lost the word `menu`; `caption-card.test.mjs`
 * holds that one. In every case the word carrying the instruction is the word
 * that went.
 *
 * An earlier run had already paged what the host marked `complete` — the source refusals —
 * so the mechanism existed and nothing else reached it. These tests hold the
 * two kinds that did not: a spoken reply and a connection state line.
 *
 * The glyph advances are the measured Arial atlas in
 * `fixtures/toolbar-bold-font-metrics.json`, the same file the toolbar wrap is
 * checked against, so a plate width asserted here is a width the headset draws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as geometry from './spatial-toolbar-geometry.mjs';
import { connectionStatus, setConnectionStatus, markTalkLinkLost, LINK_LOST, PAIR_AGAIN, TALK_LINK_LOST } from './connection-liveness.mjs';
import { measureReplyCard, measureReplyCardClearance, replyCardOffsetAsync } from './reply-card-layout.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';

const metrics = JSON.parse(readFileSync(new URL('./fixtures/toolbar-bold-font-metrics.json', import.meta.url)));
const advanceOf = glyph => metrics.advances[glyph] ?? 0.6;

/**
 * The reply the Mac delivered verbatim, and the window it held
 * for: 7.351 s, measured on the recording. The plate drew `This reply is a reading window…` out of it.
 */
const REPLY_SENTENCE = 'This reply is a reading window test. The plate should hold this sentence long enough '
  + 'to read it, and then it should go away on its own.';
const REPLY_HOLD_MS = 7_351;

/**
 * The shipped caption with only Mol*'s mesh, text and GPU boundary replaced.
 * The wrap, the paging, the seat and the expiry are the production ones, and
 * the font atlas returns the measured advances.
 */
function captionHarness({ runTask = async () => {}, clearanceSource, headSource } = {}) {
  const source = readFileSync(new URL('./talk-caption.mjs', import.meta.url), 'utf8');
  const live = new Set(), records = [], textDraws = [], textRows = [];
  let time = 0;
  const context = vm.createContext({ assistantStatus: createAssistantStatus(), menuSeatWithinView, connectionStatus, TALK_LINK_LOST, ...geometry, measureReplyCard, measureReplyCardClearance,
    replyCardOffsetAsync: (args, options) => replyCardOffsetAsync(args, { ...options, now: () => 0 }),
    MeshBuilder: { createState: () => ({}), addTriangleWithNormal() {}, getMesh: () => ({}) },
    Mesh: { Utils: {} },
    TextBuilder: { create: () => { const glyphs = [], rows = new Map(); return {
      add: (glyph, x, y, z) => { glyphs.push(glyph); rows.set(y, { y, z, glyphs: (rows.get(y)?.glyphs ?? '') + glyph }); },
      getText: () => { textDraws.push(glyphs.join('')); textRows.push([...rows.values()]); return {}; },
    }; } },
    Text: { Utils: {} },
    getFontAtlas: () => ({ buffer: 0, lineHeight: 1, get: glyph => ({ nw: advanceOf(glyph) }) }),
    Shape: { create: () => ({}) }, ShapeRepresentation: () => ({ createOrUpdate() {}, destroy() {} }), Color: value => value });
  vm.runInContext('"use strict";\n' + source.replace(/^import .*;$/gm, '').replace(/\bexport /g, ''), context);
  const card = context.createTalkCaption({ plugin: { runTask },
    presentation: { add: representation => live.add(representation), remove: representation => live.delete(representation) },
    head: headSource ?? (() => ({ position: { x: 0, y: 0, z: 0 }, matrix: identity() })),
    clearance: clearanceSource ?? (() => ({views:syntheticViews(),renderFromRoom:identity()})),
    now: () => time, record: (kind, detail) => records.push({ kind, detail }) });
  // `const` declarations stay lexical inside the script, so the module's own
  // constants are read back by evaluating their names in the same context.
  const read = expression => vm.runInContext(expression, context);
  return { card, context, read, live, records, textDraws, textRows, setTime: ms => { time = ms; }, advance: ms => { time = ms; card.frame(); } };
}

const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

/** The widest drawn line of a page, in cap-height multiples, from the measured atlas. */
function widestLine(context, page) {
  return Math.max(...context.captionLines(page, context.captionGlass(page))
    .map(line => Array.from(line).reduce((total, glyph) => total + advanceOf(glyph), 0)));
}

/** Every page a caption showed, in order, repeats collapsed to a turn. */
async function readPages(harness, { until, step }) {
  const pages = [];
  for (let at = 0; at <= until; at += step) {
    harness.advance(at); await flush();
    const drawn = harness.card.text();
    if (drawn && drawn !== pages.at(-1)) pages.push(drawn);
  }
  return pages;
}

test.afterEach(() => setConnectionStatus(''));

test('a reply too long for the card pages at its reading window and never ends in an ellipsis', async () => {
  const harness = captionHarness();
  harness.card.set({ outcome: REPLY_SENTENCE, holdMs: REPLY_HOLD_MS });
  await flush();
  const pages = [harness.card.text()];
  assert.ok(pages[0], 'the reply is drawn');
  assert.ok(!pages[0].endsWith('…'), `the first page is whole: ${pages[0]}`);
  // The window the Mac asked for belongs to each page, not to the sentence.
  for (const at of [1, REPLY_HOLD_MS - 1]) {
    harness.advance(at); await flush();
    assert.equal(harness.card.text(), pages[0], 'a page holds for the whole reading window');
  }
  for (let page = 1; page < 12; page++) {
    harness.advance(page * REPLY_HOLD_MS); await flush();
    const drawn = harness.card.text();
    if (!drawn) break;
    pages.push(drawn);
  }
  assert.ok(pages.length > 1, 'a 26-word reply does not fit one card');
  assert.equal(pages.join(' '), REPLY_SENTENCE, 'every word of the reply is drawn');
  for (const page of pages) assert.ok(!page.includes('…'), `no page is elided: ${page}`);
  // Each page reaches the glyph builder, not only the caption's own text().
  const drawn = harness.textDraws.join('');
  for (const page of pages) assert.ok(drawn.includes(page.replace(/\s/gu, '')), `page drawn: ${page}`);
});

test('a paged reply stays inside the caption glass at the measured advances', async () => {
  const harness = captionHarness();
  harness.card.set({ outcome: REPLY_SENTENCE, holdMs: REPLY_HOLD_MS });
  await flush();
  const lineChars = harness.read('CAPTION_WIDE_LINE_CHARS'), maxLines = harness.read('CAPTION_WIDE_MAX_LINES');
  const limit = lineChars * Math.max(...Object.values(metrics.advances));
  for (let page = 0; page < 12; page++) {
    harness.advance(page * REPLY_HOLD_MS); await flush();
    const drawn = harness.card.text();
    if (!drawn) break;
    const lines = harness.context.captionLines(drawn, harness.context.captionGlass(drawn));
    assert.ok(lines.length <= maxLines, `${drawn} draws ${lines.length} lines`);
    assert.ok(widestLine(harness.context, drawn) <= limit, `${drawn} is wider than the glass`);
  }
});

test('a short outcome keeps the narrow glass it always had', () => {
  const harness = captionHarness();
  const narrow = harness.context.captionGlass('Applied · style +1');
  assert.equal(narrow.lineChars, harness.read('CAPTION_LINE_CHARS'));
  assert.equal(narrow.maxLines, harness.read('CAPTION_MAX_LINES'));
  // Joined rather than deep-compared: the array is built inside the vm realm.
  assert.equal(harness.context.captionLines('Applied · style +1', narrow).join(' / '), 'Applied · style / +1');
  assert.ok(harness.context.captionFits('Applied · style +1', narrow), 'control feedback never pages');
});

for (const revision of ['r3', 'r5']) test(`the ${revision} outcome wraps after the separator with adjacent drawn lines`, async () => {
  const harness = captionHarness(), text = `Applied · scene · ${revision}`;
  try {
    const glass = harness.context.captionGlass(text);
    assert.equal(glass.lineChars, harness.read('CAPTION_LINE_CHARS'));
    const lines = Array.from(harness.context.captionLines(text, glass));
    assert.deepEqual(lines, ['Applied · scene ·', revision]);
    assert.equal(lines.join(' '), text);
    assert.ok(lines.every(line => line.trim() && !line.startsWith('·')));
    assert.deepEqual(Array.from(harness.context.captionLines(text, { lineChars: text.length })), [text]);
    harness.card.set({ outcome: text }); await flush();
    const drawn = harness.textRows.at(-1);
    assert.deepEqual(drawn.map(row => row.glyphs), ['Applied·scene·', revision]);
    const pitch = harness.read('CAPTION_FONT_METERS * CAPTION_LINE_PITCH');
    assert.ok(Math.abs(Math.hypot(drawn[0].y - drawn[1].y, drawn[0].z - drawn[1].z) - pitch) < 1e-8,
      'no blank baseline between the two lines on the tilted card');
    const width = widestLine(harness.context, text);
    assert.ok(width <= glass.lineChars * Math.max(...Object.values(metrics.advances)), 'the measured text fits the existing glass envelope');
  } finally { await harness.card.dispose(); }
});

test('outcome separators stay with their preceding words across widths and page boundaries', () => {
  const { context } = captionHarness();
  for (const text of ['Applied · scene · r3', 'Applied · scene · r5', 'Applied · color · selection · r12']) {
    for (let lineChars = Math.max(...text.split(' ').map(word => word.length)); lineChars <= text.length; lineChars++) {
      const lines = Array.from(context.captionLines(text, { lineChars, maxLines: Infinity }));
      assert.equal(lines.join(' '), text);
      assert.ok(lines.every(line => line.trim() && !line.startsWith('·')), `${lineChars}: ${lines.join(' / ')}`);
      const pages = Array.from(context.captionPages(text, { lineChars, maxLines: 1 }));
      assert.deepEqual(pages, lines);
      assert.ok(pages.every(page => context.captionFits(page, { lineChars, maxLines: 1 })));
    }
  }
});

test('every connection state line the build can show is drawn whole', async () => {
  const harness = captionHarness();
  for (const line of [LINK_LOST, PAIR_AGAIN, `${TALK_LINK_LOST}. ${LINK_LOST}`, `${TALK_LINK_LOST}. ${PAIR_AGAIN}`]) {
    assert.ok(harness.context.captionFits(line), `${line} must fit the caption glass without a page turn`);
    // The wrap puts the spaces back where it took them out, so a whole line
    // reassembles exactly. A trailing "…" that was written into the sentence
    // is a state, not a cut, and survives that comparison.
    assert.equal(harness.context.captionLines(line, harness.context.captionGlass(line)).join(' '), line);
  }
});

test('the lost-link caption draws the preserved-view sentence without claiming a reconnect', async () => {
  const harness = captionHarness();
  setConnectionStatus(LINK_LOST);
  harness.advance(1); await flush();
  const drawn = harness.card.text();
  assert.equal(drawn, LINK_LOST, 'the caption carries the whole sentence');
  assert.ok(drawn.includes('Your view is still here.'), 'the complete state sentence survives');
  assert.doesNotMatch(drawn, /reconnecting|…/i);
  assert.equal(harness.textDraws.at(-1), LINK_LOST.replace(/\s/gu, ''), 'every character reaches the glyph builder');
  const seat = harness.records.filter(entry => entry.kind === 'talk-caption-seat').at(-1);
  assert.equal(seat.detail.lines, 2, 'the lost-link sentence is two wide lines, not two narrow ones and a cut');
});

test('a state line longer than the glass turns pages instead of losing its end', async () => {
  const harness = captionHarness();
  setConnectionStatus(`${LINK_LOST} ${PAIR_AGAIN} ${PAIR_AGAIN}`);
  markTalkLinkLost();
  const whole = `${TALK_LINK_LOST}. ${LINK_LOST} ${PAIR_AGAIN} ${PAIR_AGAIN}`;
  assert.ok(!harness.context.captionFits(whole), 'this line needs more than one page');
  const pages = await readPages(harness, { until: 40_000, step: 500 });
  for (const page of pages) assert.ok(!page.includes('…'), page);
  const seen = [];
  for (const page of pages) if (!seen.includes(page)) seen.push(page);
  assert.equal(seen.join(' '), whole, 'the pages concatenate back to the sentence');
  assert.equal(pages.length, seen.length, 'An unsolicited connection warning pages once, then retires');
  assert.equal(harness.card.text(), '');
});

// Device sentences from a device run.
const REFUSALS = [
  ['stale revision', 'Could not apply · request refused. The scene or saved revision changed since this utterance began. Ask again; the request will not be retargeted.'],
  ['chapter budget', 'Could not apply · request refused. Chapter 2 refused: 8535 atoms in ball-and-stick exceed the 260000-vertex headset limit at lowest detail. Staying on the current chapter.'],
  ['insecure URL', 'Could not load · insecure address. Insecure URLs and embedded credentials are refused. Only https URLs to UTF-8 mmCIF or PDB files are supported, and local files must be absolute regular .cif or .mmcif files; either way this plugin fetches or reads at most 16,777,216 bytes (16 MiB), which is its own policy and not a viewer limit.'],
];

for (const [name, sentence] of REFUSALS) test(`${name} refusal pages at clauses and draws every page legibly`, async () => {
  const harness = captionHarness();
  try {
    const pages = Array.from(harness.context.captionPages(sentence));
    assert.ok(pages.length > 1);
    assert.equal(pages.join(' '), sentence);
    for (const page of pages.slice(0, -1)) assert.match(page, /[.;,:]$/, `mid-clause page: ${page}`);
    harness.card.set({outcome:sentence, holdMs:6000});
    await flush();
    for (const [index,page] of pages.entries()) {
      harness.advance(index * 6000); await flush();
      assert.equal(harness.card.text(),page);
      assert.equal(harness.textDraws.at(-1),page.replace(/\s/gu,''));
      const glass = harness.context.captionGlass(page);
      assert.ok(harness.context.captionFits(page,glass));
      assert.ok(widestLine(harness.context,page) <= glass.lineChars * Math.max(...Object.values(metrics.advances)));
      assert.ok(harness.read('CAPTION_FONT_METERS * GLYPH_CAP_FRACTION >= META_MIN_CAP_METERS'));
      assert.equal(harness.records.filter(entry=>entry.kind==='talk-caption-seat').at(-1).detail.outcome,'shown');
      harness.advance((index + 1) * 6000 - 1); await flush();
      assert.equal(harness.card.text(),page,'each drawn page retains the existing six-second reading window');
    }
    harness.advance(pages.length * 6000); await flush();
    assert.equal(harness.card.text(),'');
  } finally { await harness.card.dispose(); }
});

test('paging never inserts spaces inside numbers or hyphenated tokens', () => {
  const {context} = captionHarness();
  for (const token of ['16,777,216','260000-vertex','ball-and-stick','1234567890123456789012345678901234567890','alpha-beta-gamma-delta-epsilon-zeta-eta-theta']) {
    const text = `This exceeds the limit: ${token} atoms. Ask again.`;
    const pages = Array.from(context.captionPages(text,{lineChars:8,maxLines:2}));
    assert.equal(pages.join(' '),text);
    assert.ok(pages.some(page=>page.includes(token)),`token was split: ${token}`);
  }
});


test('ordinary words longer than a page retain their bounded wrap without losing glyphs', () => {
  const {context} = captionHarness(), text = 'supercalifragilisticexpialidocious'.repeat(5);
  const glass = {lineChars:8,maxLines:2};
  const pages = Array.from(context.captionPages(text,glass));
  assert.ok(pages.length > 1);
  assert.equal(pages.join('').replace(/\s/gu,''),text);
  for (const page of pages) {
    assert.ok(context.captionFits(page,glass));
    assert.ok(context.captionLines(page,glass).every(line=>line.length<=glass.lineChars && !line.includes('…')));
  }
});

for (const expireAt of ['mesh', 'commit-clearance']) {
  test(`an expired acknowledged outcome retires the existing caption and cannot mount late during ${expireAt}`, async () => {
    let release, blocked = false, reads = 0, harness;
    const gate = new Promise(resolve => { release = resolve; });
    harness = captionHarness({ runTask: async () => { if (blocked && expireAt === 'mesh') await gate; },
      clearanceSource: () => {
        if (blocked && expireAt === 'commit-clearance' && ++reads === 2) harness.setTime(3201);
        return { views: syntheticViews(), renderFromRoom: identity() };
      } });
    harness.card.set({ notice: 'Existing caption' }); await flush();
    assert.equal(harness.card.text(), 'Existing caption');
    harness.setTime(100); blocked = true;
    const receipts = [];
    harness.card.set({ notice: '', outcome: 'New acknowledged reply', holdMs: 6000, onSeat: value => receipts.push(value) });
    await flush();
    if (expireAt === 'mesh') {
      harness.setTime(3201); harness.card.frame();
      assert.equal(harness.card.text(), '', 'the live frame retires the timed-out attempt and prior caption');
      release(); await flush();
    } else {
      assert.equal(harness.card.text(), 'Existing caption', 'the staged build has not replaced the old caption');
      harness.card.frame();
    }
    assert.equal(harness.card.text(), '');
    assert.equal(receipts.some(value => value.outcome === 'shown'), false);
    assert.equal(receipts.at(-1)?.outcome, 'not-shown');
    assert.equal(harness.live.size, 0, 'the expired attempt leaves no old or staged representations mounted');
    if (expireAt === 'commit-clearance') await flush();
    assert.equal(harness.card.text(), '', 'a late build cannot insert the expired reply');
    assert.equal(harness.live.size, 0);
    await harness.card.dispose();
  });
}


test('native WebXR pose and DOMPoint prototype getters preserve the plain-pose caption seat', async () => {
  const matrix = identity(); matrix[12] = 0.03;
  const position = Object.create({ get x() { return 0.03; }, get y() { return 0; }, get z() { return 0; } });
  const transform = Object.create({ get matrix() { return matrix; }, get position() { return position; } });
  const nativePose = Object.create({ get transform() { return transform; } });
  const plain = captionHarness({ headSource: () => ({ matrix: [...matrix], position: { x: 0.03, y: 0, z: 0 } }) });
  const native = captionHarness({ headSource: () => nativePose });
  try {
    for (const harness of [plain, native]) { harness.card.set({ notice: 'Native tracked caption' }); await flush(); }
    assert.equal(plain.card.text(), 'Native tracked caption');
    assert.equal(native.card.text(), plain.card.text());
    assert.deepEqual(native.textRows, plain.textRows, 'the actual glyph coordinates match the normalized head pose');
    assert.equal(native.records.filter(entry => entry.kind === 'talk-caption-seat').at(-1).detail.outcome, 'shown');
  } finally { await plain.card.dispose(); await native.card.dispose(); }
});
