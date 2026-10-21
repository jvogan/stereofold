/**
 * CRISPR chapter 3 labels the PAM's three bases, and "DT 5", "DG 6" and
 * "DG 7" piled on one another at the PAM, front and side. Three labels on one
 * stretch of one strand are one plate now, at the stretch's centre.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { residueLabelText, residueRunPlate, RESIDUE_PLATE_LIST_MAX } from './residue-label-plates.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const base = { modelNumber: 1, labelChain: 'D', copyId: '1', assemblyId: '1', generatorIndex: 0, operatorIds: ['1'] };
const row = (number, componentId, extra = {}) => ({ key: `D:${number}`, coordinateState: 'resolved', atomSites: [{}],
  identity: { ...base, labelSequenceId: number, authorResidue: number, componentId, ...extra } });
const pam = [row(5, 'DT'), row(6, 'DG'), row(7, 'DG')];

test('a stretch of one strand is one plate that names each residue', () => {
  assert.equal(residueLabelText(pam[0].identity), 'DT 5');
  assert.deepEqual(residueRunPlate(pam), { keys: ['D:5', 'D:6', 'D:7'], text: 'DT 5 · DG 6 · DG 7' });
  // A long stretch names its ends rather than drawing a plate as wide as the lens.
  const helix = Array.from({ length: RESIDUE_PLATE_LIST_MAX + 3 }, (_, i) => row(10 + i, 'ALA'));
  assert.equal(residueRunPlate(helix).text, 'ALA 10 – ALA 16');
});

test('residues on two strands, or apart on one, keep a label each', () => {
  assert.equal(residueRunPlate([pam[0]]), undefined);
  assert.equal(residueRunPlate([pam[0], row(9, 'DA')]), undefined);
  assert.equal(residueRunPlate([pam[0], row(6, 'DG', { labelChain: 'C' })]), undefined);
  assert.equal(residueRunPlate([pam[0], row(6, 'DG', { copyId: '2' })]), undefined);
});

// Sucralose in 9NOV: RRY 1 bonded to RRJ 2 (O2-C1, 1.39 A) in one branched
// chain, with no sequence numbers. Their two labels drew over each other.
const ligand = (authorResidue, componentId, atoms, extra = {}) => ({ key: `C:${authorResidue}`, coordinateState: 'resolved', entityType: extra.entityType ?? 'branched',
  atomSites: atoms.map(([x, y, z], i) => ({ element: extra.elements?.[i] ?? 'C', assemblyCoordinatesAngstrom: [x, y, z] })),
  identity: { ...base, labelChain: 'C', labelSequenceId: null, authorResidue, componentId, ...(extra.identity ?? {}) } });

test('the deposited components of one branched ligand are one plate', () => {
  const rry = ligand(1, 'RRY', [[171.39, 167.34, 122.1], [171.84, 168.34, 121.17], [170.6, 169.9, 120.4]]);
  const rrj = ligand(2, 'RRJ', [[169.4, 170.4, 119.6], [168.1, 171.0, 119.0]]);
  assert.deepEqual(residueRunPlate([rry, rrj]), { keys: ['C:1', 'C:2'], text: 'RRY 1 · RRJ 2' });
  // Three sugars of a glycan, each bonded to the next, are one plate as well.
  const third = ligand(3, 'BMA', [[166.9, 171.6, 118.2]]);
  assert.equal(residueRunPlate([rry, rrj, third]).text, 'RRY 1 · RRJ 2 · BMA 3');
});

test('separate non-polymer molecules keep a label each', () => {
  // Two waters in contact: 2.8 A between oxygens, hydrogens 1.8 A from the other oxygen.
  const water = (n, x) => ligand(n, 'HOH', [[x, 0, 0], [x + 0.96, 0, 0]], { elements: ['O', 'H'], entityType: 'water' });
  assert.equal(residueRunPlate([water(301, 0), water(302, 2.76)]), undefined);
  // Proximity alone must not merge independent molecules.
  assert.equal(residueRunPlate([ligand(1, 'RRY', [[0, 0, 0]], { entityType: 'non-polymer' }), ligand(2, 'RRJ', [[1.4, 0, 0]], { entityType: 'non-polymer' })]), undefined);
  // A bonded pair split across chains is still two labels.
  assert.equal(residueRunPlate([ligand(1, 'RRY', [[0, 0, 0]]),
    ligand(2, 'RRJ', [[1.4, 0, 0]], { identity: { labelChain: 'D' } })]), undefined);
});

test('the page draws the PAM as one plate at the stretch, in the residue label style', async () => {
  const applied = [], cells = new Map();
  const selector = ref => ({ ref, get obj() { return cells.get(ref)?.obj; } });
  const builder = () => {
    const chain = { apply(transformer, params, options) { applied.push({ transformer, params, options }); return chain; },
      async commit() { for (const step of applied) cells.set(step.options.ref, { obj: { data: { repr: step.options.ref } } });
        return selector(applied.at(-1).options.ref); } };
    return chain;
  };
  const c = vm.createContext({
    console, inspectionState: { snapshot: () => ({ appearance: { labels: true, highlightColor: '#f2c47c' } }) },
    inspectionSnapshot: () => ({ placement: { scale: 1 } }), strandedLabelRefs: new Set(),
    selection: { rows: pam, toLoci: keys => ({ keys }) }, structure: { ref: 'structure' },
    state: { selectionKeys: pam.map(entry => entry.key) }, hiddenSceneKeySet: () => new Set(),
    canvas: { xr: { isPresenting: { value: true } } }, LABEL_CHARACTER_DEGREES: { comfortable: 1 },
    xrLabelSizing: () => ({ sizeFactor: 2 }), DESKTOP_LABEL_SIZE_FACTOR: 1, inspectionLabel: undefined,
    componentLabelOffsetZ: scale => 50 * scale,
    applyInspectionTransform() {}, residueRunPlate, Color: value => value, colorNumber: hex => Number.parseInt(hex.slice(1), 16),
    StructureElement: { Bundle: { fromLoci: loci => ({ bundle: loci.keys }) } },
    StructureSelection: { Singletons() {} },
    StateTransforms: { Model: { MultiStructureSelectionFromBundle: 'selection' },
      Representation: { StructureSelectionsLabel3D: 'label' } },
    plugin: {
      build: () => ({ toRoot: builder }),
      builders: { structure: { tryCreateComponentFromSelection: async () => assert.fail('one plate needs no per-residue labels') } },
      state: { data: { cells, build: () => ({ delete: ref => ({ async commit() { cells.delete(ref); } }) }) } },
    },
  });
  for (const name of ['removeInspectionLabels', 'rebuildInspectionLabels']) {
    const start = viewer.indexOf(`  async function ${name}(`);
    vm.runInContext(viewer.slice(start, viewer.indexOf('\n  }', start) + 4), c);
  }
  await c.rebuildInspectionLabels();
  assert.deepEqual(applied.map(step => step.transformer), ['selection', 'label']);
  assert.deepEqual(JSON.parse(JSON.stringify(applied[0].params.selections[0].bundle)), { bundle: ['D:5', 'D:6', 'D:7'] });
  const label = applied[1].params;
  assert.equal(label.customText, 'DT 5 · DG 6 · DG 7');
  assert.equal(label.textColor, 0xf2c47c);
  assert.equal(label.sizeFactor, 2);
  assert.equal(label.scaleByRadius, false);
  assert.equal(label.background, true);
  // It hangs inside the strand it names, so it takes the name plates' push.
  assert.equal(label.offsetZ, 50);
  // Tracked as the residue label, so removal, the render wait and the
  // structure transform all reach it.
  assert.equal(c.inspectionLabel.representation.ref, applied[1].options.ref);
  assert.equal(c.inspectionLabel.component.ref, applied[0].options.ref);
  await c.removeInspectionLabels();
  assert.equal(cells.has(applied[0].options.ref), false);
});

test('unrelated selected residues build independent XR plates and remove every sibling', async () => {
  const rows = [pam[0], row(9, 'DA')], applied = [], cells = new Map();
  const selector = ref => ({ ref, get obj() { return cells.get(ref)?.obj; } });
  const update = { toRoot() { return this; }, apply(transformer, params, options) {
    applied.push({ transformer, params, options });
    return { apply: update.apply.bind(update), selector: selector(options.ref) };
  }, async commit() {
    for (const { options } of applied) cells.set(options.ref, { obj: { data: { repr: options.ref } } });
  } };
  const c = vm.createContext({ inspectionState: { snapshot: () => ({ appearance: { labels: true, highlightColor: '#f2c47c' } }) },
    inspectionSnapshot: () => ({ placement: { scale: 1 } }), strandedLabelRefs: new Set(),
    selection: { rows, toLoci: keys => ({ keys }) }, structure: { ref: 'structure' },
    state: { selectionKeys: rows.map(row => row.key) }, hiddenSceneKeySet: () => new Set(),
    canvas: { xr: { isPresenting: { value: true } } }, LABEL_CHARACTER_DEGREES: { comfortable: 1 },
    xrLabelSizing: () => ({ sizeFactor: 2 }), inspectionLabel: undefined, componentLabelOffsetZ: () => 50,
    applyInspectionTransform() {}, residueRunPlate, residueLabelText, Color: value => value, colorNumber: () => 0xf2c47c,
    StructureElement: { Bundle: { fromLoci: loci => ({ keys: loci.keys }) } }, StructureSelection: {},
    StateTransforms: { Model: { MultiStructureSelectionFromBundle: 'selection' }, Representation: { StructureSelectionsLabel3D: 'label' } },
    plugin: { build: () => update, builders: { structure: { tryCreateComponentFromSelection: () => assert.fail('shared primitive cannot separate labels') } },
      state: { data: { cells, build: () => ({ delete: ref => ({ async commit() {
        cells.delete(ref); cells.delete(`${ref}-text`);
      } }) }) } } },
  });
  for (const name of ['removeInspectionLabels', 'rebuildInspectionLabels']) {
    const start = viewer.indexOf(`  async function ${name}(`);
    vm.runInContext(viewer.slice(start, viewer.indexOf('\n  }', start) + 4), c);
  }
  await c.rebuildInspectionLabels();
  assert.deepEqual(applied.filter(step => step.transformer === 'label').map(step => step.params.customText), ['DT 5', 'DA 9']);
  assert.deepEqual(applied.filter(step => step.transformer === 'selection').map(step => [...step.params.selections[0].bundle.keys]), [['D:5'], ['D:9']]);
  assert.equal(c.inspectionLabel.extraRepresentations.length, 1);
  assert.ok(c.inspectionLabel.extraRepresentations[0].obj);
  await c.removeInspectionLabels();
  assert.equal(cells.size, 0);
  assert.equal(c.strandedLabelRefs.size, 0);
});
