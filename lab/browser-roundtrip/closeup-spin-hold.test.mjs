import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { turnSweptPoints } from './focus-placement.mjs';
import { tourFocusHarness, framedTourScene } from './fixtures/tour-focus-harness.mjs';
const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');

// CRISPR's nuclease chapter is a spin chapter framed as a close-up the wearer
// stands inside. Seated for its spin about the stage centre, the close-up was
// pushed three metres away; spun at 1.2 m, the spin would carry the nucleases
// out of view and the rest of Cas9 through the wearer. It holds still instead.

const ball = (centre, radius) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  .map(axis => axis.map((v, i) => centre[i] + v * radius));
const spin = { axis: [0, 1, 0], degrees: 360, continuous: true };

function inspection(h) {
  const start = source.indexOf('\n    chapterPainting(');
  const end = source.indexOf('\n    holdsTurnStill:', start);
  const lineEnd = source.indexOf('\n', end + 1);
  assert.ok(start >= 0 && end > start, 'viewer methods: chapterPainting, holdsTurnStill');
  return vm.runInContext(`({${source.slice(start, lineEnd)}})`, h);
}

async function frame({ assembly, subject, turn }) {
  const { h, records } = tourFocusHarness();
  const sphere = { center: [0, 0, 0], radius: assembly, extrema: ball([0, 0, 0], assembly) };
  const target = { center: subject.center, radius: subject.radius, extrema: ball(subject.center, subject.radius) };
  Object.assign(h, { turnSweptPoints, recordBoundingSphere: () => sphere, loadedSphere: () => sphere,
    drawnCenter: () => Vec3.create(0, 0, 0), paintingChapter: undefined, paintingTurn: undefined, turnHeldFor: null,
    menuClearanceMovedFor: null });
  h.molecularAnimation.selectionSphere = () => target;
  const viewer = inspection(h);
  viewer.chapterPainting('site', { turn });
  // `fill`, as every CRISPR chapter asks.
  await h.emphasize({ ...framedTourScene.emphasis, framing: 'fill', origin: 'lesson' });
  return { held: viewer.holdsTurnStill('site'), focus: records.findLast(record => record.kind === 'xr-focus'),
    standoff: records.findLast(record => record.kind === 'standoff')?.plan.standoff };
}

test('a spin chapter framed as a close-up the wearer stands inside holds still, at its close-up seat', async () => {
  const closeUp = { assembly: 100, subject: { center: [0, 0, 60], radius: 12 } };
  const still = await frame(closeUp);
  assert.equal(still.standoff.limited, 'inside-out', 'the fixture is a close-up the wearer stands inside');
  const spun = await frame({ ...closeUp, turn: spin });
  assert.equal(spun.held, true);
  assert.equal(spun.focus.turnHeld, true);
  assert.equal(spun.focus.scale, still.focus.scale);
  assert.deepEqual(spun.focus.targetRoom, still.focus.targetRoom);
});

test('a spin chapter the wearer stands outside keeps turning, seated for the turn', async () => {
  const wide = { assembly: 100, subject: { center: [0, 0, 0], radius: 90 } };
  const spun = await frame({ ...wide, turn: spin });
  assert.notEqual(spun.standoff.limited, 'inside-out');
  assert.equal(spun.held, false);
  assert.equal(spun.focus.turnHeld, undefined);
});
