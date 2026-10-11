import assert from 'node:assert/strict';
import test from 'node:test';

import { MENU_MAX_WAIT_MS, MENU_SETTLE_MS, createMenuResolve, menuFootprintSignature } from './menu-resolve.mjs';

/**
 * The menu column of the Quest 2 run, in XR room metres, as
 * `menuPoints()` answers: two corners a row, eight rows down the wearer's left.
 * The numbers are that run's own `toolbar {phase:"rows"}` record, the same ones
 * `label-layout.test.mjs` builds its obstacle rectangle from.
 */
const COLUMN = Object.freeze({ x: -0.4435030371466558, z: -0.8474432247267154,
  halfWidth: 0.30 * 0.36, halfHeight: 0.52 * 0.075,
  y: Object.freeze([0.09797296762466431, 0.022972967624664303, -0.05202703237533571,
    -0.1270270323753357, -0.2020270323753357, -0.27702703237533566,
    -0.3520270323753357, -0.4270270323753357]) });

/** Those points, optionally moved and folded the way a press moves them. */
function menuPoints({ rows = COLUMN.y.length, x = COLUMN.x, z = COLUMN.z } = {}) {
  return COLUMN.y.slice(0, rows).flatMap(y => [
    [x - COLUMN.halfWidth, y - COLUMN.halfHeight, z],
    [x + COLUMN.halfWidth, y + COLUMN.halfHeight, z],
  ]);
}

/** A hand-driven clock and timer queue, so a settle is a fact rather than a wait. */
function fakeClock() {
  let now = 0, next = 1;
  const timers = new Map();
  return {
    now: () => now,
    schedule: (fn, ms) => { const handle = next++; timers.set(handle, { fn, at: now + ms }); return handle; },
    cancel: handle => { timers.delete(handle); },
    pending: () => timers.size,
    /** Run every timer due within `ms`, in order, advancing the clock as it goes. */
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

/** A coalescer wired to a fake clock, with the reasons it has asked to solve. */
function harness(options = {}) {
  const clock = fakeClock();
  const solved = [];
  const resolve = createMenuResolve({ solve: reason => solved.push(reason),
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel, ...options });
  return { clock, solved, resolve };
}

test('a redraw that did not move the column is not a motion', () => {
  // The no-jitter rule. `update()` redraws whenever anything on the panel
  // changes -- a status line, a row label, the hover plate coming down -- and
  // most of those leave the column's own rectangle exactly where it was. Same
  // input, same output, and no record for the device check to read past.
  const { clock, solved, resolve } = harness();
  resolve.seed(menuPoints());
  assert.equal(resolve.moved({ points: menuPoints(), reason: 'grow' }), false);
  assert.equal(resolve.pending(), false);
  clock.advance(MENU_SETTLE_MS * 4);
  assert.deepEqual(solved, []);
});

test('a float recomputed along another path is not a motion either', () => {
  // `menuPoints()` rebuilds its points from the panel every time it is asked,
  // so an identical panel can answer with a different last bit. The footprint
  // is compared in millimetres, the same step the toolbar rounds its own seat
  // signature to.
  const { clock, solved, resolve } = harness();
  resolve.seed(menuPoints());
  const jittered = menuPoints().map(([x, y, z]) => [x + 1e-9, y - 2e-9, z + 5e-10]);
  assert.equal(resolve.moved({ points: jittered, reason: 'follow' }), false);
  clock.advance(MENU_SETTLE_MS * 4);
  assert.deepEqual(solved, []);
});

test('a re-seat asks for one re-solve, once the column has come to rest', () => {
  const { clock, solved, resolve } = harness();
  resolve.seed(menuPoints());
  assert.equal(resolve.moved({ points: menuPoints({ x: 0.52 }), reason: ['reseat'] }), true);
  // Nothing yet: the plate offsets are static uniforms, so solving while the
  // panel is still moving is what makes the names swim.
  clock.advance(MENU_SETTLE_MS - 1);
  assert.deepEqual(solved, []);
  clock.advance(2);
  assert.deepEqual(solved, ['reseat']);
  assert.equal(resolve.pending(), false);
});

test('the Menu row folds and re-seats, and the plates are solved once for both', () => {
  // `viewer.mjs` answers the Menu press with a `collapse` and then a
  // `recenter-menu`, which are two committed redraws an XR tick apart. Two
  // re-solves would lay the plates out against a column that was still on its
  // way; the record names both causes so the device check can tell this press
  // from a Move.
  const { clock, solved, resolve } = harness();
  resolve.seed(menuPoints());
  resolve.moved({ points: menuPoints({ rows: 4 }), reason: ['collapse'] });
  clock.advance(30);
  resolve.moved({ points: menuPoints({ rows: 4, x: 0.52 }), reason: ['reseat'] });
  clock.advance(MENU_SETTLE_MS + 1);
  assert.deepEqual(solved, ['collapse,reseat']);
});

test('expanding the grid names itself, and a repeated cause is named once', () => {
  const { clock, solved, resolve } = harness();
  resolve.seed(menuPoints({ rows: 4 }));
  resolve.moved({ points: menuPoints(), reason: ['expand'] });
  clock.advance(20);
  resolve.moved({ points: menuPoints({ z: -0.9 }), reason: ['expand', 'reseat'] });
  clock.advance(20);
  resolve.moved({ points: menuPoints({ z: -0.95 }), reason: ['reseat'] });
  clock.advance(MENU_SETTLE_MS + 1);
  assert.deepEqual(solved, ['expand,reseat']);
});

test('a column that never settles is still solved against, within a bounded wait', () => {
  // The starvation a trailing debounce alone has. A panel whose footprint
  // changes every frame -- the wearer walking with a cutaway open -- would
  // reschedule forever and the plates would be solved against none of it.
  const { clock, solved, resolve } = harness();
  resolve.seed(menuPoints());
  for (let step = 1; clock.now() < MENU_MAX_WAIT_MS * 1.5; step++) {
    resolve.moved({ points: menuPoints({ z: -0.85 - step / 1000 }), reason: 'follow' });
    clock.advance(MENU_SETTLE_MS / 4);
  }
  assert.ok(solved.length >= 1, 'a continuously moving column was never solved against');
  assert.deepEqual([...new Set(solved)], ['follow']);
  // And bounded on the other side: it is one re-solve per bounded wait, not one
  // per redraw. Eight hundred milliseconds of redraws at a quarter of the
  // settle window is thirty draws.
  assert.ok(solved.length <= 3, `${solved.length} re-solves for one continuous motion`);
});

test('the reason is the burst, not the last thing in it', () => {
  const { clock, solved, resolve } = harness();
  resolve.seed(menuPoints());
  resolve.moved({ points: menuPoints({ rows: 4 }), reason: 'collapse' });
  clock.advance(MENU_SETTLE_MS + 1);
  resolve.moved({ points: menuPoints(), reason: 'expand' });
  clock.advance(MENU_SETTLE_MS + 1);
  // Two settled motions, two records, each naming what the wearer did.
  assert.deepEqual(solved, ['collapse', 'expand']);
});

test('an unnamed redraw is a follow, because the wearer did not ask for it', () => {
  const { clock, solved, resolve } = harness();
  resolve.seed(menuPoints());
  resolve.moved({ points: menuPoints({ z: -0.95 }) });
  clock.advance(MENU_SETTLE_MS + 1);
  assert.deepEqual(solved, ['follow']);
});

test('a motion the toolbar could not name is still solved for', () => {
  // The one failure the plates cannot recover from on their own: an empty
  // reason list would take the footprint as read and then drop the re-solve,
  // leaving the layout permanently behind the column.
  const { clock, solved, resolve } = harness();
  resolve.seed(menuPoints());
  for (const reason of [[], '', null, undefined]) {
    resolve.moved({ points: menuPoints({ z: -0.85 - solved.length / 100 }), reason });
    clock.advance(MENU_SETTLE_MS + 1);
  }
  assert.deepEqual(solved, ['follow', 'follow', 'follow', 'follow']);
});

test('a re-solve that throws leaves the plates alone and the coalescer working', () => {
  // The same contract the entry pass keeps: a failed re-solve must leave the
  // wearer the plates they already have, and must not take the next one down.
  const clock = fakeClock();
  const seen = [];
  const resolve = createMenuResolve({
    solve: reason => { seen.push(reason); if (seen.length === 1) throw Error('no layout'); },
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
  resolve.seed(menuPoints());
  resolve.moved({ points: menuPoints({ x: 0.52 }), reason: 'reseat' });
  clock.advance(MENU_SETTLE_MS + 1);
  resolve.moved({ points: menuPoints({ rows: 4, x: 0.52 }), reason: 'collapse' });
  clock.advance(MENU_SETTLE_MS + 1);
  assert.deepEqual(seen, ['reseat', 'collapse']);
});

test('a session going away takes its owed re-solve with it', () => {
  const { clock, solved, resolve } = harness();
  resolve.seed(menuPoints());
  resolve.moved({ points: menuPoints({ x: 0.52 }), reason: 'reseat' });
  resolve.dispose();
  clock.advance(MENU_SETTLE_MS * 4);
  assert.deepEqual(solved, []);
  assert.equal(clock.pending(), 0, 'a timer was left behind to fire into a torn-down session');
});

test('an empty column is a footprint like any other, and comparable', () => {
  assert.equal(menuFootprintSignature([]), '');
  assert.equal(menuFootprintSignature(), '');
  assert.equal(menuFootprintSignature(menuPoints()), menuFootprintSignature(menuPoints()));
  assert.notEqual(menuFootprintSignature(menuPoints()), menuFootprintSignature(menuPoints({ rows: 4 })));
});

test('status glyph changes produce neither a label rebuild nor a layout record', async () => {
  const { createToolbarPanel, toolbarMenuPoints } = await import('./spatial-toolbar-geometry.mjs');
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] };
  const rows = ['Talk', 'Play', 'Next', 'Menu'].map(label => ({ label }));
  const points = status => toolbarMenuPoints(createToolbarPanel({ rows, head, status }));
  const clock = fakeClock(), layouts = []; let rebuilds = 0;
  const resolver = createMenuResolve({ solve: reason => { rebuilds++; layouts.push({ kind: 'component-label-layout', reason }); },
    now: clock.now, schedule: clock.schedule, cancel: clock.cancel });
  resolver.seed(points(''));
  for (const status of ['Listening…', 'Smaller.', 'word '.repeat(12), '']) {
    assert.equal(resolver.moved({ points: points(status), reason: 'grow' }), false);
    clock.advance(MENU_SETTLE_MS + 1);
  }
  assert.equal(rebuilds, 0); assert.deepEqual(layouts, []);
  head.position.x += 0.25;
  assert.equal(resolver.moved({ points: points('Smaller.'), reason: 'reseat' }), true);
  clock.advance(MENU_SETTLE_MS + 1);
  assert.equal(rebuilds, 1); assert.deepEqual(layouts, [{ kind: 'component-label-layout', reason: 'reseat' }]);
});


test('an explicit reseat at an unchanged pose still solves and records once', () => {
  const { clock, solved, resolve } = harness();
  resolve.seed(menuPoints());
  assert.equal(resolve.moved({ points: menuPoints(), reason: ['reseat'] }), true);
  clock.advance(MENU_SETTLE_MS);
  assert.deepEqual(solved, ['reseat']);
  assert.equal(resolve.moved({ points: menuPoints(), reason: 'grow' }), false);
  clock.advance(MENU_SETTLE_MS);
  assert.deepEqual(solved, ['reseat']);
});
