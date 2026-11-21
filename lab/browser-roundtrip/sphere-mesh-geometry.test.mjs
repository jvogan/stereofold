import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { atomSphereMesh, noteAtomSphereMeshes } from './component-label-measurement.mjs';
import { resetEntryGeometry } from './reset-entry-geometry.mjs';
import { appearanceFitMessage } from './appearance-fit.mjs';
import { visibleChapterSpheres } from './chapter-field.mjs';
import { identity, syntheticViews } from './fixtures/component-label-diagnostics.mjs';

const require = createRequire(import.meta.url);
const { Sphere } = require('molstar/lib/commonjs/mol-geo/primitive/sphere.js');
const cell = value => ({ ref: { value, version: 0 } });
const translated = translation => { const m = identity(); m.splice(12, 3, ...translation); return m; };

// Two atoms drawn the way Mol* builds a spacefill mesh: one subdivided sphere
// per atom, its vertices on the atom's sphere, its group the atom's index.
const atoms = [{ center: [0.2, -0.1, 0.05], radius: 0.17 }, { center: [-0.25, 0.15, -0.1], radius: 0.155 }];
const unitSphere = { center: [0, 0, 0], radius: 0.5 };
function sphereMesh(detail = 1, matrix = translated([0, 0, -1])) {
  const { vertices, indices } = Sphere(detail);
  const perAtom = vertices.length / 3;
  const positions = [], groups = [], elements = [];
  atoms.forEach(({ center, radius }, group) => {
    for (let i = 0; i < perAtom; i++) {
      positions.push(...[0, 1, 2].map(axis => center[axis] + vertices[i * 3 + axis] * radius));
      groups.push(group);
    }
    for (const index of indices) elements.push(index + group * perAtom);
  });
  return { type: 'mesh', state: { visible: true }, values: {
    drawCount: cell(elements.length), elements: cell(Uint32Array.from(elements)), aPosition: cell(Float32Array.from(positions)),
    aGroup: cell(Float32Array.from(groups)), uVertexCount: cell(positions.length / 3), uGroupCount: cell(atoms.length),
    instanceCount: cell(1), aTransform: cell(Float32Array.from(matrix)), matrix: cell(identity()),
    invariantBoundingSphere: cell(unitSphere), boundingSphere: cell({ center: [0, 0, -1], radius: 0.5 }),
  } };
}
// The same unit drawn as impostors, as far as a geometry reader can tell.
function impostors(matrix = translated([0, 0, -1])) {
  return { type: 'spheres', state: { visible: true }, values: {
    drawCount: cell(atoms.length * 6), instanceCount: cell(1), aTransform: cell(Float32Array.from(matrix)),
    invariantBoundingSphere: cell(unitSphere), boundingSphere: cell({ center: [0, 0, -1], radius: 0.5 }),
  } };
}
const spacefill = object => ({ label: 'Spacefill', renderObjects: [object] });
const extract = objects => resetEntryGeometry({ objects, fromPlacement: identity(), toPlacement: identity(),
  views: syntheticViews(), cameraScale: 1, renderFromRoom: identity() });

test('only the mesh objects of a spacefill representation are read as atom spheres, copies included', () => {
  const sphereObject = sphereMesh(), cartoon = { ...sphereMesh(), values: { ...sphereMesh().values } };
  const impostor = impostors();
  assert.equal(atomSphereMesh(sphereObject), false, 'nothing is assumed before the representation is noted');
  const reprs = [spacefill(sphereObject), { label: 'Cartoon', renderObjects: [cartoon] }, spacefill(impostor)];
  assert.equal(noteAtomSphereMeshes(reprs), reprs, 'the list comes back for the caller to read');
  assert.equal(atomSphereMesh(sphereObject), true);
  assert.equal(atomSphereMesh({ ...sphereObject, state: { ...sphereObject.state, visible: true } }), true,
    'a reader that unhides a staged object keeps its values, and so its reading');
  assert.equal(atomSphereMesh(cartoon), false);
  assert.equal(atomSphereMesh(impostor), false, 'impostors have no vertices to skip');
  assert.equal(noteAtomSphereMeshes(undefined), undefined);
});

test('a spacefill sphere mesh is measured as its impostors are, not vertex by vertex', () => {
  const sphereObject = sphereMesh();
  const unread = extract([sphereMesh()]);
  assert.equal(unread.subject.length, 2 * 42, 'an unnoted mesh still gives every vertex');
  noteAtomSphereMeshes([spacefill(sphereObject)]);
  assert.deepEqual(extract([sphereObject]).subject, extract([impostors()]).subject);
  assert.deepEqual(extract([sphereObject]).subject, [{ center: [0, 0, -1], radius: 0.5 }]);
  // The unit's instance sphere encloses every vertex the mesh draws.
  for (const point of unread.subject) assert.ok(Math.hypot(point.center[0], point.center[1], point.center[2] + 1) <= 0.5);
});

test('the fit worker is sent no positions for a sphere mesh and reads the impostors’ instance sphere', () => {
  const sphereObject = sphereMesh(), other = sphereMesh();
  noteAtomSphereMeshes([spacefill(sphereObject)]);
  const views = syntheticViews().map(view => ({ eye: view.eye, projectionMatrix: view.projectionMatrix,
    transform: { inverse: { matrix: view.transform.inverse.matrix } } }));
  const message = appearanceFitMessage({ cameraScale: 1, geometry: { objects: [sphereObject, other], views,
    fromPlacement: identity(), toPlacement: identity() } });
  const [sent, mesh] = message.geometry.objects;
  assert.equal(sent.values.aPosition, undefined);
  assert.ok(sent.values.invariantBoundingSphere && sent.values.aTransform, 'the instance sphere still travels');
  assert.equal(mesh.values.aPosition.ref.value.length, other.values.aPosition.ref.value.length, 'any other mesh keeps its vertices');
  const worker = resetEntryGeometry({ ...message.geometry, objects: [sent], cameraScale: 1, renderFromRoom: identity() });
  assert.deepEqual(worker.subject, extract([impostors()]).subject);
});

test('the chapter field reads one ball per drawn atom from a sphere mesh, at the atom’s own radius', () => {
  for (const detail of [0, 1, 2]) {
    const sphereObject = sphereMesh(detail);
    const boxed = visibleChapterSpheres([sphereMesh(detail)], identity());
    noteAtomSphereMeshes([spacefill(sphereObject)]);
    const balls = visibleChapterSpheres([sphereObject], identity());
    assert.equal(balls.length, atoms.length);
    balls.forEach((ball, i) => {
      const atom = atoms[i], centre = atom.center.map((v, axis) => v + [0, 0, -1][axis]);
      ball.center.forEach((v, axis) => assert.ok(Math.abs(v - centre[axis]) < 1e-6, `detail ${detail} centre`));
      assert.ok(Math.abs(ball.radius - atom.radius) < 1e-6, `detail ${detail} radius ${ball.radius} for ${atom.radius}`);
      assert.ok(boxed[i].radius > ball.radius * 1.4, 'the triangle walk encloses each atom in its box’s sphere');
    });
  }
});

test('a group drawn in more than one run of vertices is enclosed whole', () => {
  const sphereObject = sphereMesh(0);
  const groups = sphereObject.values.aGroup.ref.value;
  // Atom 0's twelve vertices, then atom 1's, relabelled 0, 1, 0: group 0 in two runs.
  for (let i = 6; i < 12; i++) groups[i] = 1;
  for (let i = 12; i < 24; i++) groups[i] = 0;
  noteAtomSphereMeshes([spacefill(sphereObject)]);
  const balls = visibleChapterSpheres([sphereObject], identity());
  assert.equal(balls.length, 2);
  const positions = sphereObject.values.aPosition.ref.value;
  for (let i = 0; i < 24; i++) {
    const ball = balls[groups[i] === 0 ? 0 : 1], point = [0, 1, 2].map(axis => positions[i * 3 + axis] + [0, 0, -1][axis]);
    assert.ok(Math.hypot(...point.map((v, axis) => v - ball.center[axis])) <= ball.radius + 1e-6, `vertex ${i} inside its group's ball`);
  }
});

test('a faded atom of a sphere mesh leaves the chapter field as a faded impostor does', () => {
  const sphereObject = sphereMesh();
  const v = sphereObject.values;
  // Atom 1 at half transparency: faint, not lit.
  Object.assign(v, { dTransparency: cell(true), dTransparencyType: cell('groupInstance'), uTransparencyStrength: cell(1),
    tTransparency: cell({ array: Uint8Array.from([0, 128]) }) });
  noteAtomSphereMeshes([spacefill(sphereObject)]);
  assert.equal(visibleChapterSpheres([sphereObject], identity()).length, 1, 'lit atoms only');
  assert.equal(visibleChapterSpheres([sphereObject], identity(), { minimumAlpha: 0 }).length, 2, 'faint atoms count when asked');
});

test('every geometry reader collects its representations through the note, and a summary takes one snapshot', () => {
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const body = name => { const start = viewer.indexOf(`function ${name}(`); return viewer.slice(start, viewer.indexOf('\n  }\n', start) + 4); };
  const scientific = body('scientificRepresentations');
  assert.equal((scientific.match(/return noteAtomSphereMeshes\(/g) ?? []).length, 2, 'both returns note the meshes');
  assert.doesNotMatch(scientific, /return (?!noteAtomSphereMeshes)/);
  assert.match(body('clearHeldPlatePlacement'), /objects: \(figure \? noteAtomSphereMeshes\(\[\.\.\.lessonFigure\.placement\(\)/);
  const summary = body('chapterFieldSummary');
  assert.equal((summary.match(/inspectionSnapshot\(\)/g) ?? []).length, 1);
  assert.doesNotMatch(summary.slice(summary.indexOf('const metres')), /inspectionSnapshot/);
});
