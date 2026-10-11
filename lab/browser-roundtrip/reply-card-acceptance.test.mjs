import { menuSeatWithinView } from './menu-view-band.mjs';
import { connectionStatus, setConnectionStatus, markTalkLinkLost, LINK_LOST, TALK_LINK_LOST } from './connection-liveness.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { measureReplyCard, measureReplyCardClearance, replyCardOffsetAsync } from './reply-card-layout.mjs';
import * as geometry from './spatial-toolbar-geometry.mjs';
import { projectPlateQuad } from './component-label-measurement.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';
import { replayOptionsFromLayoutRecord } from './fixtures/layout-replay.mjs';
import { layoutComponentPlates, countObstacleOverlaps } from './label-layout.mjs';
import { sanitizeDetail } from './headset-diagnostics.mjs';

const capture = JSON.parse(readFileSync(new URL('./fixtures/acceptance-6-show-dyskerin.json', import.meta.url)));
const layouts = capture.entries.filter(e => e.kind === 'component-label-layout');
const measured = capture.entries.filter(e => e.kind === 'component-labels-drawn').slice(0, 2).map(e => e.detail);
// The recorded per-eye rectangles are unchanged. The ring did not retain the
// reply's mesh or eye matrices: exercise its production geometry in a canonical
// head basis, with the recorded per-eye FOV, rather than inventing device poses.
const views = syntheticViews().map((v, i) => {
  const [l, r, t, b] = measured[i].fov;
  const p = [...v.projectionMatrix];
  p[0] = 2 / (r - l); p[8] = (r + l) / (r - l);
  p[5] = 2 / (t - b); p[9] = (t + b) / (t - b);
  return { ...v, projectionMatrix: p };
});
const clearance = { views, measured, renderFromRoom: identity() };
const asRect = r => ({ x: r.x, y: r.y, halfWidth: r.hw, halfHeight: r.hh });
const overlaps = (a, b) => countObstacleOverlaps([{ rect: asRect(a) }], [asRect(b)]);

function harness(clearanceSource = () => clearance) {
  const source = readFileSync(new URL('./talk-caption.mjs', import.meta.url), 'utf8');
  const live = new Set(), records = [], quads = [];
  let time = 0, solves = 0;
  const h = vm.createContext({ menuSeatWithinView, connectionStatus, TALK_LINK_LOST, ...geometry, measureReplyCard, measureReplyCardClearance, replyCardOffsetAsync: (args, options) => { solves++; return replyCardOffsetAsync(args, { ...options, now: () => 0 }); },
    MeshBuilder: { createState: () => ({}), addTriangleWithNormal(s, a, b, c) { quads.push([a, b, c]); }, getMesh: () => ({}) },
    Mesh: { Utils: {} }, TextBuilder: { create: () => ({ add() {}, getText: () => ({}) }) }, Text: { Utils: {} },
    // Conservative sans width; no recorded glyph atlas exists in the ring.
    getFontAtlas: () => ({ buffer: 0, lineHeight: 1, get: () => ({ nw: .6 }) }),
    Shape: { create: () => ({}) }, ShapeRepresentation: () => ({ createOrUpdate() {}, destroy() {} }), Color: x => x,
  });
  vm.runInContext('"use strict";\n' + source.replace(/^import .*;$/gm, '').replace(/\bexport /g, ''), h);
  const card = h.createTalkCaption({ plugin: { runTask: async () => {} },
    presentation: { add: r => live.add(r), remove: r => live.delete(r) },
    head: () => ({ position: { x: 0, y: 0, z: 0 }, matrix: identity() }),
    clearance: clearanceSource, now: () => time, record: (kind, detail) => records.push({ kind, detail }) });
  return { card, live, records, quads, solves: () => solves,
    advance: ms => { time = ms; card.frame(); } };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function assertClear(h) {
  const corners = h.quads.slice(-2).flat();
  for (let i = 0; i < 2; i++) {
    const projected = projectPlateQuad(corners, views[i]);
    assert.ok(projected.inside > .999, 'entire readable card stays on glass');
    for (const plate of measured[i].rects) assert.equal(overlaps(projected.rect, plate), 0,
      `${measured[i].eye}: reply overlaps ${plate.id}`);
    const [x, y, hw, hh] = measured[i].silhouette;
    assert.equal(overlaps(projected.rect, { x, y, hw, hh }), 0, 'reply never covers subject');
  }
}

test('acceptance 6 show-dyskerin: real replay and reply clear every drawn plate in both eyes', async () => {
  assert.equal(layouts.length, 1);
  assert.equal(capture.entries.filter(e => e.kind === 'plate-update').length, 1);
  assert.equal(capture.entries.filter(e => e.kind === 'talk-caption' && e.detail.text === 'Both dyskerin copies.').length, 1);
  const record = layouts[0].detail;
  const solved = layoutComponentPlates(replayOptionsFromLayoutRecord(record));
  for (const p of solved.placements) {
    const r = record.rects.find(r => r.id === p.id);
    for (const [a, b] of [['x', 'x'], ['y', 'y'], ['halfWidth', 'hw'], ['halfHeight', 'hh']])
      assert.ok(Math.abs(p.rect[a] - r[b]) <= .0006);
  }
  for (const key of ['overlaps', 'subjectOverlaps', 'menuOverlaps', 'offGlass', 'unresolved']) assert.equal(solved[key], 0, key);
  const unreserved = harness(() => undefined);
  unreserved.card.set({ outcome: 'Both dyskerin copies.' }); await flush();
  assert.equal(unreserved.live.size, 0, 'no eye views leave the reply pending');
  assert.equal(unreserved.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail.outcome, 'unmeasured');
  await unreserved.card.dispose();
  const h = harness(); h.card.set({ outcome: 'Both dyskerin copies.' }); await flush();
  assertClear(h); assert.equal(h.solves(), 1); assert.equal(h.live.size, 2);
});

test('production talk card lifecycle seats once per change, contains failures and never solves unchanged frames', async () => {
  const h = harness();
  for (const text of ['Both dyskerin copies.', 'Showing NOP10.']) {
    const before = h.solves();
    h.card.set({ outcome: text }); await flush(); assertClear(h);
    assert.equal(h.solves(), before + 1);
    for (let i = 0; i < 72; i++) { h.card.frame(); h.card.set({ outcome: text }); }
    await flush(); assert.equal(h.solves(), before + 1); assert.equal(h.live.size, 2);
  }
  h.card.set({ outcome: '' }); await flush();
  assert.equal(h.live.size, 2, 'an unrelated clear preserves the current reply window');
  h.advance(3001); await flush();
  assert.equal(h.live.size, 0); assert.equal(h.solves(), 2, 'dismissal removes geometry without a solve');
  for (let i = 0; i < 72; i++) h.card.frame();
  assert.equal(h.solves(), 2);
  assert.equal(h.records.filter(e => e.kind === 'talk-caption').length, 2, 'reply once');
  for (const e of h.records) assert.deepEqual(sanitizeDetail(e.detail), JSON.parse(JSON.stringify(e.detail)));
  await h.card.dispose();
});

test('a changed component layout hides the old reply until committed geometry can seat it once', async () => {
  const h = harness(); h.card.set({ outcome: 'Both dyskerin copies.' }); await flush();
  h.card.suspend(); assert.equal(h.live.size, 0);
  for (let i = 0; i < 72; i++) h.card.frame();
  assert.equal(h.solves(), 1, 'no solving while components are changing');
  h.card.invalidate(); await flush();
  assert.equal(h.solves(), 2); assertClear(h);
  assert.equal(h.records.filter(e => e.kind === 'talk-caption').length, 1, 'scene reseating does not duplicate the reply');
  h.advance(3001); assert.equal(h.live.size, 0, 'original expiry survives the scene change');
});

test('viewer supplies committed backing geometry and full subject bounds to the card', () => {
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  function replyCardClearance(');
  assert.ok(start >= 0);
  const backing = {}, text = {}, subject = {};
  const h = vm.createContext({ latestRoomPlacementPose: { labelViews: views, renderFromRoom: identity() },
    componentLabelMeasurement: { plates: [{ id: 'nop10-e', ref: 'plate', lines: 1 }] },
    componentLabels: { refs: () => ['plate'] }, canvas: { camera: { scale: .01 } },
    plugin: { state: { data: { cells: new Map([
      ['plate-backing', { obj: { data: { repr: { renderObjects: [backing] } } } }],
      ['plate-text', { obj: { data: { repr: { renderObjects: [text] } } } }],
    ]) } } }, representation: { obj: { data: { repr: { renderObjects: [subject] } } } }, ligandOverlay: null,
    labelObjectRenderable: o => o === backing,
    renderedSubjectSpheres: (o, scale) => { assert.equal(o, subject); assert.equal(scale, .01); return [{ center: [0, 0, -2], radius: .2 }]; },
    measureComponentLabels: options => { assert.equal(options.plates[0].objects[0], backing); assert.equal(options.subject.spheres.length, 1); return measured; },
  });
  vm.runInContext('"use strict";\n' + source.slice(start, source.indexOf('\n  }', start) + 4), h);
  const result = h.replyCardClearance();
  assert.equal(result.measured, measured); assert.equal(result.views, views);
  assert.match(source, /clearance: replyCardClearance/);
  assert.match(source, /talkCaption\?\.suspend\?\.\(\)/);
  assert.match(source, /labelMeasurementGate\.measured\(now\);\s*talkCaption\?\.invalidate\?\.\(\)/);
});

test('unavailable free glass keeps the plate pending without retrying unchanged frames', async () => {
  for (const [clearanceSource, outcome, drawn] of [
    [() => { throw Error('disposed scene'); }, 'unmeasured', 0],
    [() => ({ ...clearance, measured: measured.map(m => ({ ...m, silhouette: [0, 0, 10, 10] })) }), 'blocked', 0],
  ]) {
    const h = harness(clearanceSource);
    h.card.set({ outcome: 'Both dyskerin copies.' }); await flush();
    assert.equal(h.live.size, drawn);
    const attempts = h.solves(), records = h.records.length;
    for (let i = 0; i < 72; i++) h.card.frame();
    await flush(); assert.equal(h.solves(), attempts); assert.equal(h.records.length, records);
    assert.ok(h.records.some(e => e.detail.outcome === outcome));
    if (outcome === 'blocked') assert.ok(h.records.some(e => e.detail.fallback === 'no-clear-seat'));
    await h.card.dispose();
  }
});


test('a lost-link warning preserves the answer, retires once, and leaves persistent menu status truthful', async () => {
  const h = harness();
  try {
    setConnectionStatus(LINK_LOST);
    h.card.set({ outcome: 'Temporary caption' });await flush();
    assert.equal(h.card.text(), 'Temporary caption', 'The answer keeps its promised reading window');
    h.advance(3001);await flush();
    assert.equal(h.card.text(), LINK_LOST);
    const solves = h.solves();
    h.advance(9002);await flush();
    assert.equal(h.card.text(), '');
    assert.equal(connectionStatus().line, LINK_LOST, 'Retiring a warning does not claim recovery');
    assert.equal(spatialToolbarRows({connection:connectionStatus(),voice:{state:'listening'}})[0].label, 'No link');
    for (let i = 1; i <= 72; i++) h.advance(60_000 + i);
    await flush();
    assert.equal(h.card.text(), '');
    assert.equal(h.solves(), solves, 'Repeated missed beats cannot renew the warning');
    setConnectionStatus();h.card.frame();await flush();
    assert.equal(h.card.text(), '');
  } finally { setConnectionStatus();await h.card.dispose(); }
});

test('offline listening cannot persist after the brief warning; only a new link edge renews it', async () => {
  const h = harness();
  try {
    setConnectionStatus(LINK_LOST); markTalkLinkLost();
    h.card.set({ talking: true, progress: 'Listening…' }); await flush();
    assert.match(h.card.text(), /No link · not listening/);
    h.advance(6001); await flush();
    assert.equal(h.card.text(), '', 'A retired warning cannot expose a stale Listening line');
    setConnectionStatus(LINK_LOST);h.card.frame();await flush();
    assert.equal(h.card.text(), '', 'The same offline state never renews its caption');
    setConnectionStatus();h.card.set({talking:false,progress:''});await flush();
    setConnectionStatus(LINK_LOST);h.card.frame();await flush();
    assert.equal(h.card.text(), LINK_LOST, 'A newly lost connection earns a new reading window');
  } finally { setConnectionStatus();await h.card.dispose(); }
});

test('a pending scientific reply obtains its draw receipt before a connection warning', async () => {
  const h = harness(), receipts = [];
  try {
    setConnectionStatus(LINK_LOST);
    h.card.set({ outcome: 'Custom ligand selected.', holdMs: 5000, onSeat: receipt => receipts.push(receipt) });
    await flush();
    assert.equal(h.card.text(), 'Custom ligand selected.');
    assert.equal(receipts[0]?.outcome, 'shown');
    h.advance(4999);await flush();assert.equal(h.card.text(), 'Custom ligand selected.');
    h.advance(5001);await flush();assert.equal(h.card.text(), LINK_LOST);
    h.advance(11002);await flush();assert.equal(h.card.text(), '');
  } finally { setConnectionStatus();await h.card.dispose(); }
});

/** Eyes lifted clear of the levelled seat frame: the same capture, the same
 * recorded fields of view, and a card the wearer is now well above. */
const liftedViews = metres => views.map(view => {
  const matrix = [...view.transform.matrix], inverse = [...view.transform.inverse.matrix];
  matrix[13] += metres; inverse[13] -= metres;
  return { ...view, transform: { matrix, inverse: { matrix: inverse } } };
});

test('a lifted eye pose gets a new readable seat when one fits', async () => {
  const h = harness(() => ({ ...clearance, views: liftedViews(2) }));
  h.card.set({ outcome: 'Both dyskerin copies.' }); await flush();
  assert.equal(h.live.size, 2, 'the card is still committed; only the claim about it changes');
  const seat = h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail;
  assert.equal(seat.outcome, 'shown');
  const corners = h.quads.slice(-2).flat();
  for (const view of liftedViews(2)) assert.ok(projectPlateQuad(corners, view).inside > .999999);
  for (const e of h.records) assert.deepEqual(sanitizeDetail(e.detail), JSON.parse(JSON.stringify(e.detail)));
  await h.card.dispose();
});

test('a near seat partly held by one eye is moved until both eyes contain it', async () => {
  const h = harness(() => ({ ...clearance, views: liftedViews(1.5) }));
  h.card.set({ outcome: 'Both dyskerin copies.' }); await flush();
  const seat = h.records.filter(e => e.kind === 'talk-caption-seat').at(-1).detail;
  const inside = Math.min(...liftedViews(1.5).map(view => projectPlateQuad(h.quads.slice(-2).flat(), view).inside));
  assert.ok(inside > .999999);
  assert.equal(seat.outcome, 'shown');
  await h.card.dispose();
});
