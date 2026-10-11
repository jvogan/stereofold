import test from 'node:test';
import assert from 'node:assert/strict';
import { replyCardOffset, replyCardOffsetAsync, measureReplyCardClearance } from './reply-card-layout.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';

const points = [[-.35, -.08, -.9], [.35, -.08, -.9], [.35, .08, -.9], [-.35, .08, -.9]];
function options(silhouette) {
  const views = syntheticViews();
  return { points: points.map(point => [...point]), eye: [0, 0, 0], target: [0, 0, -1],
    clearance: { views, renderFromRoom: identity(), measured: views.map(() => ({ silhouette })) } };
}
function receipt(solve, options, pacing) {
  let verdict, fallback;
  const value = solve({ ...options, onSeat: v => { verdict = v; }, onFallback: v => { fallback = v; } }, pacing);
  return Promise.resolve(value).then(offset => ({ offset, verdict, fallback }));
}

const quad = (width, height, z) => [[-width, -height, z], [width, -height, z], [width, height, z], [-width, height, z]];
// Exact results captured from the original ranked search before removing its
// unconditional structure scans. Partial glass must keep its blocked verdict;
// menu clearance and the farther search must retain their original seats.
const rankedCases = [
  { name: 'near', offset: [0, 0, 0], outcome: 'shown' },
  { name: 'farther', silhouette: [0, 0, .15, .6], offset: [0, -.76, -.15], outcome: 'shown', fallback: 'farther-seat' },
  { name: 'structure blocked', silhouette: [0, 0, 20, 20], offset: [0, 0, 0], outcome: 'blocked', fallback: 'no-clear-seat' },
  { name: 'partly visible', points: quad(5, .08, -.9), offset: [.2, -.5, 0], outcome: 'blocked', inside: .1621, fallback: 'no-clear-seat' },
  { name: 'menu displaced', menuPoints: quad(.35, .08, -.8), offset: [0, -.2, 0], outcome: 'shown' },
  { name: 'menu blocked', menuPoints: quad(20, 20, -.8), offset: [0, 0, 0], outcome: 'blocked', fallback: 'no-clear-seat' },
];
for (const entry of rankedCases) {
  test(`eligible-only structure checks retain the original ${entry.name} seat and verdict`, async () => {
    const args = { ...options(entry.silhouette),
      ...(entry.points ? { points: entry.points } : {}), ...(entry.menuPoints ? { menuPoints: entry.menuPoints } : {}) };
    const expected = { offset: entry.offset, fallback: entry.fallback,
      verdict: { measured: true, inside: entry.inside ?? 1, outcome: entry.outcome,
        ...(entry.outcome === 'blocked' ? { obstructed: true } : {}) } };
    for (const solve of [replyCardOffset, replyCardOffsetAsync])
      assert.deepEqual(await receipt(solve, args, { budgetMs: 0, yieldTask: async () => {} }), expected);
  });
}

test('ineligible candidates never scan molecular obstacles and a chosen near seat scans each eye once', () => {
  for (const [name, card, menu, expectedReads] of [
    ['outside both eyes', quad(5, .08, -.9), [], 0],
    ['covered by menu', points, quad(20, 20, -.8), 0],
    ['eligible', points, [], 2],
  ]) {
    let reads = 0;
    // The rectangle lies far away, so any clearance read succeeds. Getters
    // count real rectangle comparisons without injecting a test-only solver.
    const obstacle = { get x() { reads++; return 20; }, y: 20, hw: .1, hh: .1 };
    const args = options(undefined);
    args.clearance.measured = args.clearance.views.map(() => ({ rects: [obstacle] }));
    replyCardOffset({ ...args, points: card, menuPoints: menu });
    assert.equal(reads, expectedReads, name);
  }
});

for (const [name, silhouette] of [['clear', undefined], ['farther', [0, 0, .15, .6]], ['fully blocked', [0, 0, 20, 20]]]) {
  test(`paced ${name} search retains exact ranked result and binocular geometry verdict`, async () => {
    const args = options(silhouette), expected = await receipt(replyCardOffset, args);
    let yields = 0;
    const actual = await receipt(replyCardOffsetAsync, args, { budgetMs: 0, yieldTask: async () => { yields++; } });
    assert.deepEqual(actual, expected);
    if (name !== 'clear') assert.ok(yields > 1, 'expensive search is split into independent batches');
    const corners = points.map(point => point.map((v, i) => v + actual.offset[i]));
    const committed = measureReplyCardClearance(corners, [], args.clearance);
    assert.equal(committed.outcome, actual.verdict.outcome);
    if (name === 'farther') assert.equal(actual.fallback, 'farther-seat');
    if (name === 'fully blocked') assert.equal(actual.verdict.outcome, 'blocked');
  });
}
test('first fully blocked search lets a queued frame task run before publishing, unlike the synchronous negative control', async () => {
  const args = options([0, 0, 20, 20]);
  let frame = false, published = false;
  const timer = new Promise(resolve => setTimeout(() => { frame = true; resolve(); }, 0));
  replyCardOffset({ ...args, onSeat: () => { assert.equal(frame, false); } });
  const pending = replyCardOffsetAsync({ ...args, onSeat: () => { published = true; assert.equal(frame, true); } }, { budgetMs: 0 });
  await timer;
  assert.equal(published, false, 'first attempt has not monopolized the event loop until completion');
  await pending;
  assert.equal(published, true);
});
test('superseding the caption or expiring its attempt cancels between batches without a stale receipt', async () => {
  for (const reason of ['superseded', 'deadline']) {
    let current = true, time = 0, yielded = 0;
    const result = await replyCardOffsetAsync({ ...options([0, 0, 20, 20]),
      onSeat: () => assert.fail('cancelled request published a seat'), onFallback: () => assert.fail('cancelled request published fallback') },
    { budgetMs: 0, isCurrent: () => current && time < 3000,
      yieldTask: async () => { yielded++; if (reason === 'superseded') current = false; else time = 3000; } });
    assert.equal(result, undefined); assert.equal(yielded, 1);
  }
});
test('same-head commit validation refuses a changed molecule or menu without launching another grid search', () => {
  const clear = options(undefined).clearance;
  assert.equal(measureReplyCardClearance(points, [], clear).outcome, 'shown');
  assert.equal(measureReplyCardClearance(points, [], options([0, 0, 20, 20]).clearance).outcome, 'blocked');
  assert.equal(measureReplyCardClearance(points, points, clear).outcome, 'blocked');
  assert.equal(measureReplyCardClearance(points, [], { views: [] }).outcome, 'unmeasured');
});

test('mutable XR matrices, menu points and geometry cannot change a search already yielded', async () => {
  const args = options([0, 0, .15, .6]);
  args.menuPoints = [[-.9, -.3, -1], [-.7, -.3, -1], [-.7, .3, -1], [-.9, .3, -1]];
  const expected = await receipt(replyCardOffset, args);
  let changed = false;
  const actual = await receipt(replyCardOffsetAsync, args, { budgetMs: 0, yieldTask: async () => {
    if (changed) return; changed = true;
    args.points[0][0] = 100; args.eye[0] = 100; args.target[2] = 100;
    args.menuPoints[0][0] = 100; args.clearance.renderFromRoom[12] = 100;
    for (const view of args.clearance.views) { view.projectionMatrix[0] = 100; view.transform.inverse.matrix[12] = 100; }
    for (const measured of args.clearance.measured) measured.silhouette[2] = 20;
  } });
  assert.equal(changed, true); assert.deepEqual(actual, expected);
  assert.notEqual(measureReplyCardClearance(points, args.menuPoints, args.clearance).outcome, 'shown', 'latest changed geometry cannot inherit the old solve receipt');
});

test('explicitly undefined optional fields preserve synchronous defaults', async () => {
  const args = { ...options(undefined), menuPoints: undefined, up: undefined, gap: undefined, withinView: undefined };
  assert.deepEqual(await receipt(replyCardOffsetAsync, args), await receipt(replyCardOffset, args));
  assert.deepEqual(await replyCardOffsetAsync({ ...args, onFallback: undefined, onSeat: undefined }), replyCardOffset(args));
});
