import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measureReplyCard, replyCardOffset } from './reply-card-layout.mjs';
import { syntheticViews, identity } from './fixtures/component-label-diagnostics.mjs';
import { projectPlateQuad } from './component-label-measurement.mjs';
import { createToolbarPanel, toolbarMenuPoints, toolbarSeatBasis, SPATIAL_TOOLBAR_LAYOUT, TOOLBAR_READING_RANGE_METERS, toolbarLayoutForStandoff } from './spatial-toolbar-geometry.mjs';
import { spatialToolbarRows } from './spatial-toolbar-content.mjs';
import { screenRectFromPoints } from './label-layout.mjs';

// Use the head caption's real tilted seat without loading a Mol* renderer.
const source = readFileSync(new URL('./talk-caption.mjs', import.meta.url), 'utf8');
const start = source.indexOf('export function captionSeat(');
const captionSeat = new Function('toolbarSeatBasis', `${source.slice(start, source.indexOf('\n}', start) + 2).replace('export ', '')}; return captionSeat;`)(toolbarSeatBasis);

test('a full near band seats the readable card farther out, clear of the structure in both eyes', () => {
  const points = [[-.35, -.08, -.9], [.35, -.08, -.9], [.35, .08, -.9], [-.35, .08, -.9]];
  const views = syntheticViews(), silhouette = { x: 0, y: 0, hw: .15, hh: .6 };
  let fallback, verdict;
  const offset = replyCardOffset({ points, eye: [0, 0, 0], target: [0, 0, -1],
    clearance: { views, renderFromRoom: identity(), measured: views.map(() => ({
      silhouette: [silhouette.x, silhouette.y, silhouette.hw, silhouette.hh] })) },
    onFallback: reason => { fallback = reason; }, onSeat: seat => { verdict = seat; } });
  assert.equal(fallback, 'farther-seat');
  assert.equal(verdict.outcome, 'shown');
  assert.ok(offset[2] < 0);
  for (const view of views) {
    const { rect, inside } = projectPlateQuad(points.map(point => point.map((value, i) => value + offset[i])), view);
    assert.ok(inside > .999999);
    assert.ok(Math.abs(rect.x) >= rect.hw + silhouette.hw + .025
      || Math.abs(rect.y) >= rect.hh + silhouette.hh + .025);
  }
});

test('head-seated reply clears the same menu blocker through 72 seat and eye combinations', () => {
  let checked = 0;
  for (const collapsed of [true, false]) for (const side of [-1, 1]) {
    for (const range of [TOOLBAR_READING_RANGE_METERS, 1.6, 2]) for (const yaw of [0, 0.6, -0.8]) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 1.6, 0, 1] };
      const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed }),
        constants: toolbarLayoutForStandoff(range, { ...SPATIAL_TOOLBAR_LAYOUT,
          rightMeters: side * Math.abs(SPATIAL_TOOLBAR_LAYOUT.rightMeters) }) });
      const seat = captionSeat(head, { forwardMeters: 0.9, belowDegrees: 25 });
      const points = [-1, 1].flatMap(x => [-1, 1].map(y => seat.origin.map((v, i) =>
        v + x * 0.39 * seat.right[i] + y * 0.084 * seat.up[i])));
      const basis = toolbarSeatBasis(head), menuPoints = toolbarMenuPoints(panel);
      const target = basis.origin.map((v, i) => v + basis.forward[i]);
      const offset = replyCardOffset({ points, menuPoints, eye: basis.origin, target });
      for (const eyeX of [-0.032, 0.032]) {
        const eye = basis.origin.map((v, i) => v + basis.right[i] * eyeX);
        const view = { eye, target: eye.map((v, i) => v + basis.forward[i]) };
        const menu = screenRectFromPoints({ points: menuPoints, ...view });
        const card = screenRectFromPoints({ points: points.map(p => p.map((v, i) => v + offset[i])), ...view });
        assert.ok(Math.abs(card.x - menu.x) >= card.halfWidth + menu.halfWidth + .025 - 1e-12
          || Math.abs(card.y - menu.y) >= card.halfHeight + menu.halfHeight + .025 - 1e-12,
        JSON.stringify({ collapsed, side, range, yaw, eyeX }));
        checked++;
      }
    }
  }
  assert.equal(checked, 72);
  assert.match(source, /menuPoints: menuObstacle\(\)/);
  assert.match(source, /const points = menuPoints\(\)/);
  assert.match(source, /nextMenu === lastMenu/);
});

/* The no-`clearance.views` path reported `shown` with `inside: 1`.
 * Nothing on it knows where the wearer's eyes are, so it holds no evidence
 * that either eye contains the card and may not claim one.
 */
test('a seat solved with no eye views is reported unmeasured, never shown', () => {
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1] };
  const panel = createToolbarPanel({ head, rows: spatialToolbarRows({ collapsed: false }),
    constants: toolbarLayoutForStandoff(1.4, SPATIAL_TOOLBAR_LAYOUT) });
  const seat = captionSeat(head, { forwardMeters: 0.9, belowDegrees: 25 });
  const points = [-1, 1].flatMap(x => [-1, 1].map(y => seat.origin.map((v, i) =>
    v + x * 0.39 * seat.right[i] + y * 0.084 * seat.up[i])));
  const basis = toolbarSeatBasis(head);
  const verdicts = [];
  replyCardOffset({ points, menuPoints: toolbarMenuPoints(panel), eye: basis.origin,
    target: basis.origin.map((v, i) => v + basis.forward[i]),
    onSeat: verdict => verdicts.push(verdict) });
  assert.equal(verdicts.length, 1, 'the seat that is returned is reported exactly once');
  assert.equal(verdicts[0].outcome, 'unmeasured', 'a solve with no eye transforms cannot report a draw');
  assert.equal(verdicts[0].measured, false);
  assert.equal(verdicts[0].inside, undefined, 'and carries no fraction it did not measure');
});

/* The same measurement, asked of a card that is already on the glass. */
test('measureReplyCard answers for the eyes it is given, and refuses when it has none', () => {
  const corners = [[-0.2, -0.1, -1], [0.2, -0.1, -1], [0.2, 0.1, -1], [-0.2, 0.1, -1]];
  assert.equal(measureReplyCard(corners, undefined), undefined);
  assert.equal(measureReplyCard(corners, { views: [] }), undefined);
  assert.equal(measureReplyCard(corners, { views: syntheticViews().slice(0, 1) }), undefined);
  assert.equal(measureReplyCard([], { views: syntheticViews() }), undefined);
  const held = measureReplyCard(corners, { views: syntheticViews(), renderFromRoom: identity() });
  assert.deepEqual(held, { measured: true, inside: 1, outcome: 'shown' });
  const lifted = syntheticViews().map(view => {
    const matrix = [...view.transform.matrix], inverse = [...view.transform.inverse.matrix];
    matrix[13] += 2; inverse[13] -= 2;
    return { ...view, transform: { matrix, inverse: { matrix: inverse } } };
  });
  assert.deepEqual(measureReplyCard(corners, { views: lifted, renderFromRoom: identity() }),
    { measured: true, inside: 0, outcome: 'blocked' });
});
