import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { requireSceneGeometryBudget, requireGeometryBudget, structureGeometryCounts } from './representation-budget.mjs';
import { withFigureRepresentation } from './lesson-figure-appearance.mjs';
import { MOLECULAR_REPRESENTATIONS, nextMolecularRepresentation } from './spatial-toolbar-content.mjs';

const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const plain = value => JSON.parse(JSON.stringify(value));
function fixture({ figureAtoms = 2700, figureBonds = 2800, override = 'molecular-surface' } = {}) {
  let figure = { layers: [{ target: { chain: 'local-A' } }], representationOverride: override }, queries = 0;
  const h = vm.createContext({
    requireSceneGeometryBudget, requireGeometryBudget, structureGeometryCounts, withFigureRepresentation, MOLECULAR_REPRESENTATIONS,
    volume: false, structure: { obj: { data: { elementCount: 3052, bondCount: 3100, atomicResidueCount: 400 } } },
    companionRecord: undefined, stylesState: [], spatialRepresentationInputs: [], spatialRepresentationOptions: [],
    currentXrSession: () => 'same-session', sessionDeviceClass: () => 'quest2', activeRenderQuality: () => 'balanced',
    xrRepresentationQuality: () => 'lower', isStandaloneHmdAgent: () => false,
    canvas: { xr: { isPresenting: { value: true } } },
    plugin: { representation: { structure: { registry: { get: () => ({ isApplicable: () => true }) } } } },
    inspectionSnapshot: () => ({ appearance: { representation: 'molecular-surface' } }),
    styleLayerDefinitions: () => [],
    lessonFigure: {
      definition: () => structuredClone(figure), geometryIdentity: () => figure,
      geometryEntries(next = figure) {
        queries++;
        return next?.representationOverride ? [{ representation: next.representationOverride,
          atoms: figureAtoms, bonds: figureBonds, residues: 350 }] : [];
      },
    },
  });
  vm.runInContext(section('  function geometryFor(', '\n  async function paintCompanion(')
    + section('  function spatialRepresentations()', '\n  function motionReason()'), h);
  return { h, queries: () => queries, replaceFigure(next) { figure = next; } };
}

test('the figure cycle admits the complete prospective style and keeps every applicable style available with combined-scene advisories', () => {
  const { h } = fixture();
  assert.doesNotThrow(() => h.geometryFor('ball-and-stick'), 'the stale Surface figure made the old base-only check pass');
  assert.deepEqual(plain(h.spatialRepresentations()), [...MOLECULAR_REPRESENTATIONS]);
  assert.equal(nextMolecularRepresentation('molecular-surface', h.spatialRepresentations()), 'ball-and-stick');
  for (const representation of h.spatialRepresentations()) {
    const figure = withFigureRepresentation(h.lessonFigure.definition(), representation);
    assert.doesNotThrow(() => h.geometryFor(representation, h.structure.obj.data, figure));
  }
  assert.equal(h.geometryFor('ball-and-stick', h.structure.obj.data,
    withFigureRepresentation(h.lessonFigure.definition(), 'ball-and-stick')).status, 'advisory');
});

test('a costly current figure does not hide a cheaper complete prospective style', () => {
  const { h } = fixture({ figureAtoms: 4500, figureBonds: 4000, override: 'ball-and-stick' });
  assert.equal(h.geometryFor('spacefill').status, 'advisory');
  assert.ok(h.spatialRepresentations().includes('spacefill'), 'new base and figure together fit Spacefill');
});

test('figure install, replacement and removal invalidate availability without repeating geometry work in steady frames', () => {
  const f = fixture();
  const choices = f.h.spatialRepresentations(), count = f.queries();
  f.h.spatialRepresentations();
  assert.equal(f.queries(), count);
  f.replaceFigure({ layers: [{ target: { chain: 'local-B' } }] });
  assert.deepEqual(plain(f.h.spatialRepresentations()), plain(choices));
  assert.ok(f.queries() > count, 'a changed authored graph with no override must be budgeted prospectively too');
  const replaced = f.queries(); f.h.spatialRepresentations(); assert.equal(f.queries(), replaced);
  f.replaceFigure(undefined);
  assert.deepEqual(plain(f.h.spatialRepresentations()), [...MOLECULAR_REPRESENTATIONS]);
});

test('prospective figure admission still charges the comparison and scoped meshes', () => {
  const { h } = fixture();
  const candidate = withFigureRepresentation(h.lessonFigure.definition(), 'spacefill');
  assert.doesNotThrow(() => h.geometryFor('spacefill', h.structure.obj.data, candidate));
  h.companionRecord = { companionState: { appearance: { representation: 'spacefill' } },
    structure: { obj: { data: { elementCount: 5000, bondCount: 0, atomicResidueCount: 600 } } } };
  assert.equal(h.geometryFor('spacefill', h.structure.obj.data, candidate).status, 'advisory');
  h.companionRecord = undefined;
  h.styleLayerDefinitions = () => [{ look: { representation: 'spacefill' },
    data: { elementCount: 5000, bondCount: 0, atomicResidueCount: 600 } }];
  assert.equal(h.geometryFor('spacefill', h.structure.obj.data, candidate).status, 'advisory');
});

test('measured 9AX6 assembly 1 overview admits Ribbons, Spacefill and Surface and Atoms with a historical-cost advisory', () => {
  // Counts resolved with pinned Mol* from source SHA
  // 631d0ce3ea45229f42f2b063adccdb1a76156a122056eb9dff496c0af17d7c34,
  // assembly 1 and the bundled overview's deduplicated author selectors.
  const counts = [
    { atoms: 3052, bonds: 2792, residues: 657 },
    { atoms: 1366, bonds: 1390, residues: 167 },
    { atoms: 1262, bonds: 1291, residues: 164 },
    { atoms: 58, bonds: 65, residues: 1 },
    { atoms: 32, bonds: 34, residues: 1 },
  ];
  const options = { presenting: true, deviceClass: 'quest2', quality: 'lower' };
  const entries = representation => counts.map((count, index) => ({ ...count,
    representation: representation === 'cartoon' && index >= 3 ? 'ball-and-stick' : representation }));
  for (const representation of ['cartoon', 'spacefill', 'molecular-surface'])
    assert.doesNotThrow(() => requireSceneGeometryBudget(entries(representation), options));
  const atoms = requireSceneGeometryBudget(entries('ball-and-stick'), options);
  assert.ok(atoms.every(decision => decision.status === 'advisory' && decision.level === 'lower'));
  assert.ok(atoms.every(decision => Object.keys(decision.typeParams).length === 0));
  assert.doesNotThrow(() => requireGeometryBudget({ ...counts[0], representation: 'ball-and-stick', ...options }),
    'both base and full scene remain permitted; only the full scene needs a warning');
});
