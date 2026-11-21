import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { planeOf } from './site-plane.mjs';
import { eyeFrame, nearestView, rotationTurn, sameRotation, siteView, siteViewAtoms, siteViewTurn, SITE_SNAP_DEGREES, SITE_VIEW_ELEVATION_DEGREES } from './site-view.mjs';
import { focusRotation } from './focus-placement.mjs';
import { figureTargetMatchesRow } from './lesson-figure.mjs';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = v => { const m = Math.hypot(...v); return v.map(x => x / m); };
const turned = (rotation, direction) => Array.from(Vec3.transformDirection(Vec3(), Vec3.create(...direction), focusRotation(rotation)));
const near = (a, b, tolerance = 1e-6) => a.every((value, i) => Math.abs(value - b[i]) < tolerance);
const identity = () => Array.from(Mat4.identity());

test('a plane comes from three or more atoms that are not on one line', () => {
  const square = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]];
  const plane = planeOf(square.map(([x, y]) => [x + 5, y - 2, .02 * x + 3]));
  assert.ok(Math.abs(Math.abs(plane.normal[2]) - 1) < 1e-3, `normal ${plane.normal}`);
  assert.ok(near(plane.centre, [5, -2, 3]));
  assert.equal(planeOf(square.slice(0, 2)), undefined, 'two atoms');
  assert.equal(planeOf([[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3.01]]), undefined, 'one line');
  assert.equal(planeOf([[0, 0, 0], [.1, 0, 0], [0, .1, 0]]), undefined, 'a point, not a plane');
});

// A disc in the xy plane, a bond along +z from its centre (as iron to oxygen)
// and a second dash leaning out of the plane on the same side.
const disc = [[2, 0, 0], [0, 2, 0], [-2, 0, 0], [0, -2, 0]];
const bond = [[0, 0, 0], [0, 0, 1.8]];
const lean = [[0, 0, 1.8], [2, .4, 2.6]];

test('a site view looks 30 degrees out of the plane from the distances\' side, with every dash near full length', () => {
  for (const towardEye of [[0, 0, 1], [1, 0, 0], [0, -1, -.2]]) {
    const site = siteView({ planePoints: disc, distances: [bond, lean], towardEye });
    assert.ok(site.views.length >= 2);
    assert.ok(near(site.normal, [0, 0, 1], 1e-9), 'the normal points to the side the distances are on');
    for (const view of site.views) {
      assert.ok(Math.abs(dot(view.toEye, site.normal) - Math.sin(SITE_VIEW_ELEVATION_DEGREES * Math.PI / 180)) < 1e-9);
      assert.ok(Math.abs(dot(view.toEye, view.up)) < 1e-9, 'up lies across the view');
      assert.ok(Math.abs(Math.abs(dot(view.up, site.normal)) - Math.cos(SITE_VIEW_ELEVATION_DEGREES * Math.PI / 180)) < 1e-9,
        'the plane reads level: its normal is straight up or down the screen');
      // A dash along the normal shows at cos 30; the other no shorter than that.
      assert.ok(Math.abs(view.dashFractions[0] - Math.cos(Math.PI / 6)) < 1e-9);
      assert.ok(view.dashFractions[1] >= Math.cos(Math.PI / 6) - .01);
    }
  }
  // No distances: the side the wearer already faces.
  assert.ok(siteView({ planePoints: disc, towardEye: [0, .2, -1] }).normal[2] < 0);
  assert.equal(siteView({ planePoints: disc.slice(0, 2), towardEye: [0, 0, 1] }), undefined);
  assert.equal(siteView({ planePoints: disc }), undefined);
});

test('two labelled atoms side by side are kept apart on screen', () => {
  const labelPoints = [[0, 0, 0], [.5, 0, .4]];
  const free = siteView({ planePoints: disc, distances: [bond], towardEye: [0, 0, 1] });
  const kept = siteView({ planePoints: disc, distances: [bond], labelPoints, towardEye: [0, 0, 1] });
  const apart = view => { const d = [.5, 0, .4], along = dot(d, view.toEye); return Math.sqrt(dot(d, d) - along * along); };
  const widest = Math.max(...free.views.map(apart));
  assert.ok(kept.views.length < free.views.length);
  for (const view of kept.views) assert.ok(apart(view) >= .9 * widest - 1e-9);
});

test('the turn puts the view toward the wearer with its up standing up, by the smaller of the two ways round', () => {
  const site = siteView({ planePoints: disc, distances: [bond, lean], towardEye: [0, 0, 1] });
  for (const [yaw, rotation] of [[0, [0, 0, 0]], [.6, [10, 20, 30]], [-2.2, [-40, 5, 170]]]) {
    const head = Array.from(Mat4.fromRotation(Mat4(), yaw, Vec3.create(0, 1, 0)));
    head[13] = 1.6;
    const placement = { rotation };
    const turn = siteViewTurn({ headInRoom: head, renderFromRoom: identity(), placement, views: site.views });
    const back = [head[8], 0, head[10]];
    assert.ok(near(turned(turn.rotation, turn.view.toEye), unit(back), 1e-6), `toward the wearer at yaw ${yaw}`);
    assert.ok(near(turned(turn.rotation, turn.view.up), [0, 1, 0], 1e-6), 'up stands up');
    // The eased turn about its axis lands exactly where the bake will put it.
    const eased = Mat4.mul(Mat4(), Mat4.fromRotation(Mat4(), turn.angleRadians, Vec3.create(...turn.axis)), focusRotation(rotation));
    assert.ok(Array.from(eased).every((value, i) => Math.abs(value - focusRotation(turn.rotation)[i]) < 1e-6));
    assert.equal(turn.turned, turn.deltaDegrees >= SITE_SNAP_DEGREES);
    assert.ok(turn.durationMs >= 600 && turn.durationMs <= 1000);
    // No other allowed view is reached by a smaller turn.
    for (const view of site.views) {
      const other = siteViewTurn({ headInRoom: head, renderFromRoom: identity(), placement, views: [view] });
      assert.ok(other.deltaDegrees >= turn.deltaDegrees - 1e-6);
    }
  }
  const straightDown = identity(); straightDown.splice(8, 3, 0, 1, 0);
  assert.equal(siteViewTurn({ headInRoom: straightDown, renderFromRoom: identity(), placement: { rotation: [0, 0, 0] }, views: site.views }), undefined);
  assert.equal(nearestView([], Mat4.identity()), undefined);
  assert.ok(near(Array.from(eyeFrame({ toEye: [0, 0, 1], up: [0, 1, 0] })), identity()));
});

test('a turn back returns the rotation it left, and only a rotation nothing else has moved counts as landed', () => {
  const back = rotationTurn({ placement: { rotation: [-15, -33, -42] }, rotation: [0, 0, 0] });
  const eased = Mat4.mul(Mat4(), Mat4.fromRotation(Mat4(), back.angleRadians, Vec3.create(...back.axis)), focusRotation([-15, -33, -42]));
  assert.ok(Array.from(eased).every((value, i) => Math.abs(value - Mat4.identity()[i]) < 1e-6));
  assert.ok(sameRotation([10, 20, 30], [10.01, 20, 30]));
  assert.ok(!sameRotation([10, 20, 30], [10, 21, 30]));
  assert.ok(sameRotation([0, 180, 0], [180, 0, 180]), 'two spellings of one turn');
  // A small turn is still travelled, so the promised view is the one drawn.
  assert.equal(rotationTurn({ placement: { rotation: [0, 0, 0] }, rotation: [0, 3, 0] }).turned, true);
  assert.equal(rotationTurn({ placement: { rotation: [0, 0, 0] }, rotation: [0, .5, 0] }).turned, false);
  assert.equal(rotationTurn({ placement: { rotation: [0, 0] }, rotation: [0, 0, 0] }), undefined);
});

// The real chapter on its real coordinates.
const cache = process.env.STEREOFOLD_DEMO_CACHE;
test('the hemoglobin heme close-up turns to show the iron off the plane and both dashes near full length',
  { skip: !cache && 'needs STEREOFOLD_DEMO_CACHE' }, async () => {
    const { coordinates } = await import('./fixtures/kinesin-layout.mjs');
    const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/hemoglobin-switch/flipbook.json', import.meta.url), 'utf8'));
    const figure = lesson.chapters.find(entry => entry.id === 'heme').immersive.figure;
    const atoms = coordinates(`${cache}/hemoglobin-tr-flipbook.cif`, lesson.provenance.sourceSha256);
    const rows = new Map();
    for (const atom of atoms) {
      const key = `${atom.chain}:${atom.residue}:${atom.component}`;
      if (!rows.has(key)) rows.set(key, { key, identity: { authorChain: atom.chain, authorResidue: atom.residue, componentId: atom.component }, atomSites: [] });
      rows.get(key).atomSites.push({ identity: { atomName: atom.atom }, assemblyCoordinatesAngstrom: atom.position });
    }
    const at = (chain, residue, component, name) => atoms.find(a => a.chain === chain && a.residue === residue && a.component === component && a.atom === name).position;
    const input = siteViewAtoms({ rows: [...rows.values()], figure, matchesRow: figureTargetMatchesRow });
    assert.equal(input.planePoints.length, 4, 'the four ring nitrogens');
    assert.equal(input.distances.length, 2);
    assert.equal(input.labelPoints.length, figure.labels.length);
    // The chapter before is seen from the front: the wearer on +z.
    const site = siteView({ ...input, towardEye: [0, 0, 1] });
    const turn = siteViewTurn({ headInRoom: identity(), renderFromRoom: identity(), placement: { rotation: [0, 0, 0] }, views: site.views });
    const view = turn.view;
    const ironR = at('E', 142, 'HEM', 'FE'), ironT = at('A', 142, 'HEM', 'FE');
    const shown = (a, b) => { const d = b.map((v, i) => v - a[i]), along = dot(d, view.toEye); return Math.sqrt(dot(d, d) - along * along) / Math.hypot(...d); };
    const front = (a, b) => { const d = unit(b.map((v, i) => v - a[i])); return Math.sqrt(1 - d[2] ** 2); };
    const oxygen = [at('E', 142, 'HEM', 'FE'), at('E', 143, 'OXY', 'O1')], his58 = [at('E', 143, 'OXY', 'O2'), at('E', 58, 'HIS', 'NE2')];
    // Before: the plane 4 degrees from edge-on, O2 to His 58 at half its length.
    assert.ok(Math.abs(dot(site.normal, [0, 0, 1])) < .1);
    assert.ok(front(...his58) < .5);
    // After: 30 degrees out of the plane, both dashes at 0.85 or more.
    assert.ok(Math.abs(Math.asin(dot(view.toEye, site.normal)) * 180 / Math.PI - 30) < 1e-6);
    assert.ok(shown(...oxygen) >= .85 && shown(...his58) >= .85, `dashes ${shown(...oxygen)} ${shown(...his58)}`);
    // The two irons, 0.77 A apart, stand at least 0.65 A apart on screen.
    const apart = shown(ironT, ironR) * Math.hypot(...ironT.map((v, i) => v - ironR[i]));
    assert.ok(apart >= .65, `irons ${apart.toFixed(2)} A apart on screen`);
    // His 87, the side the T iron moves to, is up the screen; the oxygen hangs below.
    const up = point => dot(point.map((v, i) => v - ironR[i]), view.up);
    assert.ok(up(at('E', 87, 'HIS', 'NE2')) > 1 && up(ironT) > 0 && up(at('E', 143, 'OXY', 'O2')) < -1);
    assert.ok(turn.deltaDegrees < 90 && turn.durationMs <= 1000, `turn ${turn.deltaDegrees}`);
  });

// A plate rests a stand-off of under one character box in front of its atom,
// so a figure atom nearer the wearer than the iron, under the plate, draws over
// the name. Measured on the headset at the chapter's seat: one character box is
// 0.52 Å at the iron, the "Fe, T" plate 1.25 by 0.54 Å. A bigger close-up
// (1.25x, then 1.45x) brings the plate in over the heme. This samples atom
// centres and points along the sticks within a residue; it leaves out atom and
// stick radii and the iron's own bonds, so it is not a full rendered clearance.
test('no sampled atom centre or stick point nearer than the iron lies under a heme close-up iron plate in the headset',
  { skip: !cache && 'needs STEREOFOLD_DEMO_CACHE' }, async () => {
    const { coordinates } = await import('./fixtures/kinesin-layout.mjs');
    const lesson = JSON.parse(readFileSync(new URL('../../plugin/demos/hemoglobin-switch/flipbook.json', import.meta.url), 'utf8'));
    const figure = lesson.chapters.find(entry => entry.id === 'heme').immersive.figure;
    const atoms = coordinates(`${cache}/hemoglobin-tr-flipbook.cif`, lesson.provenance.sourceSha256);
    const rows = new Map();
    for (const atom of atoms) {
      const key = `${atom.chain}:${atom.residue}:${atom.component}`;
      if (!rows.has(key)) rows.set(key, { key, identity: { authorChain: atom.chain, authorResidue: atom.residue, componentId: atom.component }, atomSites: [] });
      rows.get(key).atomSites.push({ identity: { atomName: atom.atom }, assemblyCoordinatesAngstrom: atom.position });
    }
    const input = siteViewAtoms({ rows: [...rows.values()], figure, matchesRow: figureTargetMatchesRow });
    const site = siteView({ ...input, towardEye: [0, 0, 1] });
    const view = siteViewTurn({ headInRoom: identity(), renderFromRoom: identity(), placement: { rotation: [0, 0, 0] }, views: site.views }).view;
    const toEye = unit(view.toEye), up = unit(view.up.map((v, i) => v - toEye[i] * dot(view.up, toEye)));
    const right = [up[1] * toEye[2] - up[2] * toEye[1], up[2] * toEye[0] - up[0] * toEye[2], up[0] * toEye[1] - up[1] * toEye[0]];
    // Every drawn atom, and the sticks between bonded atoms of one residue.
    const drawn = [...rows.values()].filter(row => figure.layers.some(layer => !layer.context && figureTargetMatchesRow(layer.target, row)))
      .flatMap(row => {
        const sites = row.atomSites.map(site => ({ name: `${row.key}:${site.identity.atomName}`, at: site.assemblyCoordinatesAngstrom }));
        const sticks = sites.flatMap((a, i) => sites.slice(i + 1).filter(b => !/:FE$/.test(a.name) && !/:FE$/.test(b.name)
          && Math.hypot(...a.at.map((v, k) => v - b.at[k])) < 1.9).flatMap(b => [.25, .5, .75].map(t =>
          ({ name: `${a.name}-${b.name.split(':').pop()}`, at: a.at.map((v, k) => v + (b.at[k] - v) * t) }))));
        return [...sites, ...sticks];
      });
    assert.ok(drawn.length > 300, `${drawn.length} figure atoms and stick points`);
    const irons = figure.labels.filter(label => label.target.atomName === 'FE');
    assert.equal(irons.length, 2);
    for (const label of irons) {
      const iron = drawn.find(atom => atom.name === `${label.target.chain}:142:HEM:FE`).at;
      const cap = label.maxOffsetEm ?? 2;
      const offset = [label.headsetOffsetX ?? label.offsetX, label.headsetOffsetY ?? label.offsetY]
        .map(value => Math.max(-cap * 3.84, Math.min(cap * 3.84, value)));
      for (const em of [.52, .52 / 1.25, .52 / 1.45]) {
        const unitAngstrom = em / 3.84, centre = offset.map(value => value * unitAngstrom);
        const over = drawn.filter(atom => {
          const d = atom.at.map((v, i) => v - iron[i]);
          return Math.abs(dot(d, right) - centre[0]) <= 1.2 * em && Math.abs(dot(d, up) - centre[1]) <= .52 * em && dot(d, toEye) > 0;
        });
        assert.deepEqual(over.map(atom => atom.name), [], `${label.id} at ${em.toFixed(2)} Å per character: nearer atoms under the plate`);
      }
    }
  });

// The page's own framing: focusSelection and the placement bake, real.
test('a framed plane view turns the structure with the travel, and the next framed figure turns it back', async () => {
  const { tourFocusHarness } = await import('./fixtures/tour-focus-harness.mjs');
  const { h, records } = tourFocusHarness();
  Object.assign(h, { siteViewTurn, rotationTurn, sameRotation, siteViewReturn: undefined });
  const site = siteView({ planePoints: disc, distances: [bond, lean], towardEye: [0, 0, 1] });
  const view = siteViewTurn({ headInRoom: h.latestRoomPlacementPose.headInRoom, renderFromRoom: identity(),
    placement: { rotation: [0, 0, 0] }, views: site.views }).view;
  const frame = facing => { h.latestHeadSample = h.now(); return h.focusSelection({ selectionKeys: ['B'], framing: 'fill', minTargetFraction: .15,
    liftEmphasis: false, elevationDegrees: 0, lessonSelection: true, facing }); };
  await frame({ view });
  const landed = h.inspectionState.placement().rotation;
  assert.ok(near(turned(landed, view.toEye), [0, 0, 1], 1e-6), 'the view faces the wearer');
  assert.ok(near(turned(landed, view.up), [0, 1, 0], 1e-6));
  const turn = records.filter(r => r.kind === 'closeup-view').at(-1);
  assert.ok(turn.turnDegrees > 6 && turn.ms >= 600, JSON.stringify(turn));
  assert.ok(sameRotation(h.siteViewReturn.rotation, [0, 0, 0]) && sameRotation(h.siteViewReturn.landed, landed));
  // Back: the next framed figure, without a plane, turns back to where it was.
  await frame({ back: h.siteViewReturn });
  assert.ok(sameRotation(h.inspectionState.placement().rotation, [0, 0, 0]), `${h.inspectionState.placement().rotation}`);
  assert.equal(records.filter(r => r.kind === 'closeup-view').at(-1).back, true);
  // A restored close-up pose (undo, a saved view) turns back again; the pose it went back to does not.
  await frame({ back: h.siteViewReturn });
  assert.ok(sameRotation(h.inspectionState.placement().rotation, [0, 0, 0]));
  h.inspectionState.place({ rotation: landed }, 'test');
  await frame({ back: h.siteViewReturn });
  assert.ok(sameRotation(h.inspectionState.placement().rotation, [0, 0, 0]));
  // A turn made in between belongs to whoever made it: no turn back.
  await frame({ view });
  h.inspectionState.place({ rotation: [0, 25, 0] }, 'test');
  await frame({ back: h.siteViewReturn });
  assert.ok(sameRotation(h.inspectionState.placement().rotation, [0, 25, 0]));
  // A framing without a plane view or a turn to undo leaves the rotation alone.
  await frame(undefined);
  assert.ok(sameRotation(h.inspectionState.placement().rotation, [0, 25, 0]));
});

// The page's choice of facing for a framed figure: who may turn back, and the
// direction a close-up framed on the way back is cut for.
test('only the structure that was turned is turned back, a new lesson drops the way back, and a returning close-up is cut for where it lands', async () => {
  const { pageFunction } = await import('./fixtures/label-action-harness.mjs');
  const { towardWearer } = await import('./closeup-context.mjs');
  const vm = await import('node:vm');
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const structure = {}, landed = [-15, -33, -42];
  let rotation = landed;
  const installed = [];
  const c = vm.createContext({ structure, sameRotation, towardWearer, assertReady() {},
    lessonResting: { install: async value => { installed.push(value); } },
    canvas: { xr: { isPresenting: { value: true } } }, inspectionState: {},
    latestRoomPlacementPose: { headInRoom: identity(), renderFromRoom: identity() },
    inspectionSnapshot: () => ({ placement: { rotation } }) });
  for (const name of ['siteFacing', 'setLessonRestingState']) vm.runInContext(pageFunction(source, name), c);
  // The page's own `let` is not visible to cut functions; a context global stands in for it.
  vm.runInContext('var siteViewReturn;', c);
  const turned = () => { c.siteViewReturn = { rotation: [0, 0, 0], landed, structure }; };
  turned();
  const overview = { layers: [], labels: [], distances: [] };
  const back = c.siteFacing(overview);
  assert.equal(back.back, c.siteViewReturn);
  assert.ok(near(back.towardEye, [0, 0, 1], 1e-9), 'cut for the pose it turns back to');
  rotation = [0, 25, 0];
  assert.equal(c.siteFacing(overview).towardEye, undefined, 'nothing to turn back: cut for the pose it stands in');
  rotation = landed;
  await c.setLessonRestingState({ emphasis: undefined });
  assert.equal(c.siteViewReturn, undefined, 'a lesson installed on the same structure starts from the pose it finds');
  assert.equal(c.siteFacing(overview), undefined);
  assert.equal(installed.length, 1);
  turned(); c.structure = {};
  assert.equal(c.siteFacing(overview), undefined, 'another structure');
});
