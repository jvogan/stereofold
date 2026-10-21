import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { StructureElement } from 'molstar/lib/mol-model/structure.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { motionFixture, sixBodyAnimation } from './motion-benchmark-fixture.mjs';
import { createLessonFigure, resolveFigureLoci, figureTargetMatchesRow } from './lesson-figure.mjs';
import { createMolecularAnimation, unmaskTransparency } from './molecular-animation.mjs';
import { readCachedDemoCoordinates } from './demo-cache.mjs';
import { pageFunction } from './fixtures/label-action-harness.mjs';
import { DEFAULT_CONTEXT_OPACITY, normalizeEmphasisState, planLessonEmphasis } from './lesson-emphasis.mjs';
import { emptyVisibility, hiddenRowKeys, normalizeVisibility } from './inspection-visibility.mjs';
import { selectAnimationTrack } from './animation-selection.mjs';
import { evaluateTrackVisibility } from '../../packages/motion/src/keyframes.mjs';

const cache = process.env.STEREOFOLD_DEMO_CACHE;
const visibleTexts = figure => figure.annotations().filter(repr => repr.state.visible)
  .map(repr => repr.props.customText).sort();

// Real Mol* plates over six hemoglobin dimers; tracks head0..head5 show two
// copies at a time. A and B name the two alternating state copies.
async function plates(t) {
  const h = await motionFixture({ animation: null });
  let registry, viewer;
  const figure = createLessonFigure({ plugin: h.plugin, getStructure: () => h.structure, getTransform: () => h.presentation,
    plateGate: (figure, plan) => viewer.figurePlateGate(figure, plan), animationOwns: repr => registry?.owns(repr) ?? false });
  const cartoon = [...h.plugin.state.data.cells.values()]
    .find(cell => cell.transform.transformer === StateTransforms.Representation.StructureRepresentation3D).obj.data.repr;
  registry = createMolecularAnimation({ plugin: h.plugin, canvas: h.canvas, getStructure: () => h.structure,
    getTransform: () => h.presentation, getRepresentations: () => [cartoon, ...figure.molecular()],
    getAnnotations: () => [...figure.annotations().map(repr => ({ repr, loci: lociOf(h, repr), gate: figure.plateGate(repr) }))],
    getStaticMask: () => viewer.staticMaskLoci(),
    onRelease: () => figure.applyVisibility() });
  viewer = plateViewer({ ...h, figure, registry, cartoon });
  t.after(async () => { await registry.forget(); await figure.forget(); await h.dispose(); });
  return { ...h, figure, registry, viewer };
}
// Execute the viewer's production fade, hide, mask and emphasis decisions over
// real Mol* structures. Only the unrelated UI and render-admission shell is stubbed.
const viewerSource = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
function plateViewer(h) {
  const data = h.structure.obj.data;
  const rows = Array.from({length: 6}, (_, i) => ({key: 'H' + i,
    identity: {authorChain: 'H' + i, labelChain: 'H' + i, authorResidue: 10, copyId: 'one'}}));
  const loci = key => resolveFigureLoci({chain: key}, data);
  const cell = [...h.plugin.state.data.cells.values()].find(c => c.obj?.data?.repr === h.cartoon);
  const c = vm.createContext({ StructureElement, StateTransforms, figureTargetMatchesRow, lessonSelection: undefined,
    DEFAULT_CONTEXT_OPACITY, normalizeEmphasisState, planLessonEmphasis, hiddenRowKeys, selectAnimationTrack, evaluateTrackVisibility,
    selection: {rows, toLoci: keys => keys.map(loci).reduce((a,b) => StructureElement.Loci.union(a,b), StructureElement.Loci.none(data)),
      fromLoci: value => rows.filter(row => !StructureElement.Loci.isEmpty(StructureElement.Loci.intersect(loci(row.key), value))).map(row => row.key)},
    state: {selectionKeys: []}, visibilityState: emptyVisibility(), stylesState: [],
    emphasisState: normalizeEmphasisState({}), emphasisOrigin: 'command', paintedContextOpacity: value => value,
    spokenSelectionKeys: part => rows.filter(row => row.identity.authorChain === part.chain).map(row => row.key),
    plugin: h.plugin, structure: h.structure, representation: {ref: cell.transform.ref}, ligandOverlay: undefined,
    styleLayerTargets: () => [], dropDeadOverlayRefs() {}, liveEmphasisTargets: targets => ({targets}),
    representationLayerRef: (_repr, ref, suffix = '') => ref + suffix, SCENE_VISIBILITY_LAYER_REF: 'test-visibility',
    lessonFigure: h.figure, molecularAnimation: h.registry, staticMaskCache: undefined, paintedStaticMask: '',
    assertReady() {}, assertContext() {}, recordCost() {}, recordManipulation() {}, recordEmphasisResolution() {},
    volume: undefined, componentLabels: {}, lessonKey: {remember() {}},
    paintEmphasisLayers: async () => {}, rebuildComponentLabels: async () => {}, snapshot: () => ({}),
    mutate: async (_kind, operation) => operation(),
  });
  for (const name of ['hiddenSceneKeys', 'hiddenSceneKeySet', 'currentEmphasisPlan', 'figurePlateGate',
    'staticMaskKeys', 'staticMaskLoci', 'syncStaticMask', 'refreshPlateVisibility', 'paintVisibilityLayers', 'emphasize'])
    vm.runInContext(pageFunction(viewerSource, name), c);
  return c;
}
function lociOf(h, repr) {
  const cell = [...h.plugin.state.data.cells.values()].find(cell => cell.obj?.data?.repr === repr);
  return cell?.obj?.data?.sourceData?.infos?.[0]?.loci;
}
const name = (text, chain) => ({ id: `${text}-${chain}`, text, target: { chain, residues: { from: 10, to: 10 } },
  color: '#246080', offsetX: 0, offsetY: 8, sizeFactor: .6 });
const copies = { layers: [], distances: [], labels: [0, 1, 2, 3, 4, 5].map(i => name(i % 2 ? 'Head B' : 'Head A', 'H' + i)) };

test('a static figure names only the copies its chapter animation shows at t=0, and teardown returns to that', async t => {
  const h = await plates(t);
  const shown = () => h.figure.annotations().map(repr => repr.state.visible);
  // With no animation known the scene draws every copy, and each copy's plate
  // sits on it: two distinct parts may share a name (both R-state O2 sites).
  await h.figure.install(copies);
  assert.deepEqual(shown(), Array(6).fill(true));
  await h.figure.install(copies, { animation: sixBodyAnimation });
  assert.deepEqual(visibleTexts(h.figure), ['Head A', 'Head B']);
  assert.deepEqual(shown(), [true, true, false, false, false, false], 'H0 and H1 are the t=0 copies');
  assert.ok(h.figure.drawn(new Set(h.figure.annotations().flatMap(repr => repr.renderObjects))), 'ruled-out plates still count as drawn');
  // Installed motion owns its plates by track; one copy per name at any time.
  await h.registry.install(sixBodyAnimation);
  h.figure.animationInstalled();
  for (const [seconds, expected] of [[0, [true, true, false, false, false, false]], [2.5, [false, false, true, true, false, false]],
    [4.5, [false, false, false, false, true, true]]]) {
    h.registry.control({ state: 'pause', seekSeconds: seconds });
    assert.deepEqual(shown(), expected, `t=${seconds}`);
  }
  // Removing the animation never shows every copy's plate.
  await h.registry.install(undefined);
  assert.deepEqual(shown(), [true, true, false, false, false, false]);
  assert.deepEqual(h.figure.annotations().map(repr => [...repr.state.transform]), Array(6).fill([...h.presentation]));
});

test('a figure layer on a copy hidden at t=0 stays hidden after motion is removed', async t => {
  const h = await plates(t);
  const layer = chain => ({ id: `ink-${chain}`, target: { chain, residues: { from: 10, to: 12 } }, representation: 'ball-and-stick', color: '#fff1c9', opacity: 1 });
  await h.figure.install({ ...copies, layers: [layer('H0'), layer('H2')] }, { animation: sixBodyAnimation });
  const shown = () => h.figure.molecular().map(repr => repr.state.visible);
  assert.deepEqual(shown(), [true, false]);
  await h.registry.install(sixBodyAnimation);
  h.registry.control({ state: 'pause', seekSeconds: 2.5 });
  assert.deepEqual(shown(), [false, true], 'each layer follows its own track');
  await h.registry.install(undefined);
  assert.deepEqual(shown(), [true, false], 'teardown returns to the t=0 scene');
});

test('a still chapter staged during the previous chapter\'s motion draws every copy once that motion ends', async t => {
  const h = await plates(t);
  const layer = chain => ({ id: `ink-${chain}`, target: { chain, residues: { from: 10, to: 12 } }, representation: 'ball-and-stick', color: '#fff1c9', opacity: 1 });
  Object.assign(h.viewer, { now: () => performance.now(), applyInspectionTransform() {},
    inspectionMutation: async operation => operation() });
  vm.runInContext(pageFunction(viewerSource, 'installMolecularChapter'), h.viewer);
  // The tour restores the animated chapter, then stages the still chapter's
  // figure while that motion runs, as `setLessonFigure` does.
  await h.figure.install(copies, { animation: sixBodyAnimation });
  await h.registry.install(sixBodyAnimation);
  h.figure.animationInstalled();
  await h.figure.install({ ...copies, layers: [layer('H0'), layer('H2')] }, { deferReveal: true, animation: sixBodyAnimation });
  await h.registry.refresh();
  h.figure.animationInstalled();
  await h.viewer.syncStaticMask();
  // The still chapter installs no motion of its own.
  await h.viewer.installMolecularChapter(undefined, 'still');
  assert.equal(h.registry.snapshot(), null);
  assert.deepEqual(h.figure.annotations().map(repr => repr.state.visible), Array(6).fill(true));
  assert.deepEqual(h.figure.molecular().map(repr => repr.state.visible), [true, true], 'both layers draw');
  assert.deepEqual([...h.viewer.staticMaskKeys()], [], 'no copy stays masked');
  assert.equal(h.viewer.paintedStaticMask, '');
  // Removing motion inside its own chapter still returns to that chapter's t=0 scene.
  await h.figure.install(copies, { animation: sixBodyAnimation });
  await h.registry.install(sixBodyAnimation);
  h.figure.animationInstalled();
  await h.viewer.installMolecularChapter(undefined);
  assert.deepEqual(h.figure.annotations().map(repr => repr.state.visible), [true, true, false, false, false, false]);
});

test('chapter visibility hides plates, static or attached, without a geometry rebuild', async t => {
  const h = await plates(t);
  const hide = chain => { h.viewer.visibilityState = {...emptyVisibility(), hiddenChains: chain ? [{labelChain: chain, copyId: 'one'}] : []}; };
  await h.figure.install(copies, { animation: sixBodyAnimation });
  hide('H0');
  h.figure.applyVisibility();
  assert.deepEqual(h.figure.annotations().map(repr => repr.state.visible), [false, true, false, false, false, false],
    'a hidden copy loses its plate, and copies hidden at t=0 stay unnamed');
  await h.figure.install(copies, { animation: undefined });
  assert.deepEqual(h.figure.annotations().map(repr => repr.state.visible), [false, true, true, true, true, true],
    'with no animation known, every drawn copy keeps its plate');
  hide();
  await h.figure.install(copies, { animation: sixBodyAnimation });
  await h.registry.install(sixBodyAnimation); h.figure.animationInstalled();
  const geometry = h.figure.annotations().map(repr => repr.geometryVersion);
  hide('H3'); h.figure.applyVisibility(); h.registry.control({ state: 'pause', seekSeconds: 2.5 });
  assert.deepEqual(h.figure.annotations().map(repr => repr.state.visible), [false, false, true, false, false, false],
    'an attached plate also follows the gate while its track is visible');
  assert.deepEqual(h.figure.annotations().map(repr => repr.geometryVersion), geometry);
});

// The lesson's figure call can arrive while motion already runs. Its plates
// must join their moving bodies at once, never stand at deposited copies.
test('a figure set during running motion puts each plate on its posed, drawn copy', async t => {
  const h = await plates(t);
  const source = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  async function setLessonFigure(');
  const end = source.indexOf('    if (value && frame && !wearerPlacement.holdsPlacement())', start);
  assert.ok(start > 0 && end > start);
  let masked = 0;
  const setLessonFigure = vm.runInNewContext(`${source.slice(start, end)}return snapshot(); };setLessonFigure`, {
    assertReady() {}, now: () => performance.now(), recordCost() {}, state: {}, snapshot: () => ({}),
    inspectionMutation: operation => operation(), molecularAnimation: h.registry, lessonFigure: h.figure,
    syncStaticMask: async () => { masked++; }, applyInspectionTransform() {},
  });
  const animation = structuredClone(sixBodyAnimation);
  animation.tracks.forEach((track, i) => { track.keyframes[1].translation[0] = i * 7; });
  await h.registry.install(animation);
  h.registry.control({ state: 'pause', seekSeconds: 2.5 });
  await setLessonFigure(copies);
  const reprs = h.figure.annotations();
  assert.deepEqual(reprs.map(repr => repr.state.visible), [false, false, true, true, false, false]);
  assert.equal(masked, 1, 'the static mask follows the figure');
  const assertOwners = () => {
    for (const repr of reprs.filter(repr => repr.state.visible)) {
      const loci = lociOf(h, repr);
      const body = h.registry.representations().find(body => {
        const data = [...h.plugin.state.data.cells.values()].find(cell => cell.obj?.data?.repr === body)?.obj?.data?.sourceData;
        return data?.units && !StructureElement.Loci.isEmpty(StructureElement.Loci.remap(loci, data));
      });
      assert.ok(body?.state.visible, 'owning body is drawn');
      assert.ok(Mat4.areEqual(repr.state.transform, body.state.transform, 1e-9), 'plate transform matches its owning body');
    }
  };
  assertOwners();
  h.registry.control({ state: 'pause', seekSeconds: 4.5 });
  assert.deepEqual(reprs.map(repr => repr.state.visible), [false, false, false, false, true, true]);
  assertOwners();
});

const emphasis = opacity => ({parts: [{id: 'head', label: 'Head', chain: 'H0', color: '#246080'}], focus: 'head', contextOpacity: opacity});
test('plates follow the emphasis being painted in both directions and after rollback', async t => {
  const h = await plates(t);
  await h.figure.install(copies);
  await h.viewer.emphasize(emphasis(.05));
  assert.equal(h.figure.annotations()[1].state.visible, false, 'newly faint context loses its plate immediately');
  await h.viewer.emphasize(emphasis(1));
  assert.equal(h.figure.annotations()[1].state.visible, true, 'newly opaque context regains its plate immediately');
  const previous = h.viewer.emphasisState;
  h.viewer.mutate = async (_kind, operation) => { await operation(); throw Error('draw failed'); };
  await assert.rejects(h.viewer.emphasize(emphasis(.05)), /draw failed/);
  assert.equal(h.viewer.emphasisState, previous);
  h.viewer.refreshPlateVisibility();
  assert.equal(h.figure.annotations()[1].state.visible, true, 'recovery uses the committed emphasis');
});

test('plates accept the default context opacity boundary with floating point tolerance', async t => {
  const h = await plates(t);
  await h.figure.install(copies);
  for (const opacity of [DEFAULT_CONTEXT_OPACITY, DEFAULT_CONTEXT_OPACITY - Number.EPSILON,
    DEFAULT_CONTEXT_OPACITY + Number.EPSILON, DEFAULT_CONTEXT_OPACITY - 1e-6]) {
    h.viewer.emphasisState = normalizeEmphasisState(emphasis(opacity));
    await h.viewer.paintVisibilityLayers();
    assert.equal(h.figure.annotations()[1].state.visible, opacity >= DEFAULT_CONTEXT_OPACITY - 1e-12, `opacity ${opacity}`);
  }
});

test('reused bodies unmask at track reveal and restore current user hides and fades on teardown', async t => {
  const h = await plates(t);
  await h.figure.install({...copies, layers: [{id: 'scoped', target: {chain: 'H2'}, representation: 'ball-and-stick', color: '#246080'}]}, {animation: sixBodyAnimation});
  const repr = h.figure.molecular()[0];
  const cell = [...h.plugin.state.data.cells.values()].find(c => c.obj?.data?.repr === repr);
  h.viewer.styleLayerTargets = () => [{repr: {ref: cell.transform.ref}, suffix: '-scoped', data: cell.obj.data.sourceData}];
  h.viewer.emphasisState = normalizeEmphasisState(emphasis(.35));
  await h.viewer.paintVisibilityLayers();
  const before = repr.state.transparency;
  assert.ok(before.layers.some(layer => layer.value === 1));
  await h.registry.install(sixBodyAnimation);
  h.registry.control({state: 'pause', seekSeconds: 2.5});
  assert.ok(h.registry.owns(repr), 'scoped body is reused');
  assert.equal(repr.state.visible, true);
  assert.equal(repr.state.transparency.layers.some(layer => layer.value === 1), false, 'static mask is removed');
  assert.ok(repr.state.transparency.layers.some(layer => layer.value === .65), 'fade survives');
  const geometry = repr.geometryVersion;
  await h.registry.refresh();
  assert.equal(repr.state.transparency.layers.some(layer => layer.value === 1), false, 'refresh does not recapture the unmasked state');
  await h.registry.install(undefined);
  assert.deepEqual(repr.state.transparency, before, 'teardown restores the original static mask');
  await h.registry.install(sixBodyAnimation);
  // Repaint during motion, including a user hide that overlaps the static mask.
  h.viewer.visibilityState = {...emptyVisibility(), hiddenChains: [{labelChain: 'H2', copyId: 'one'}]};
  h.viewer.emphasisState = normalizeEmphasisState(emphasis(.4));
  await h.viewer.paintVisibilityLayers();
  const edited = repr.state.transparency;
  await h.registry.refresh();
  assert.ok(repr.state.transparency.layers.some(layer => layer.value === 1), 'user hide remains during motion');
  await h.registry.install(undefined);
  assert.deepEqual(repr.state.transparency, edited, 'teardown keeps the latest user hide and fade');
  assert.equal(repr.geometryVersion, geometry);
});

for (const rollback of [false, true]) test(`static chapter keeps two plates after ${rollback ? 'failed restore rollback' : 'capture and restore'}`, async t => {
  const h = await plates(t), c = h.viewer;
  await h.figure.install(copies, {animation: sixBodyAnimation});
  await h.registry.install(sixBodyAnimation);
  await h.registry.install(undefined);
  assert.equal(visibleTexts(h.figure).length, 2);
  Object.assign(c, {
    detached: structuredClone, liveScene: () => ({sourceSha256: 'fixture', modelNumber: 1, assemblyId: '1', camera: {}}),
    cameraSnapshot: value => value, desktopPreviewCamera: undefined, lessonMotionHold: {presented: v => v, release() {}},
    inspectionSnapshot: () => ({}), savedEmphasis: () => undefined, savedVisibility: () => ({}), lessonPlayback: undefined,
    validInspectionCapture: value => ({...structuredClone(value), keys: []}), normalizeVisibility, normalizeStyles: () => [],
    wearerPlacement: {holdsPlacement: () => false}, syncInspectionPayload() {}, invalidateGesturePivot() {},
    inspectionState: {replace() {}, setPayload() {}}, restoreCompanion: async () => {}, markSelection() {},
    applyInspectionAppearance: async () => { if (rollback) throw Error('appearance failed'); },
    applyInspectionTransform() {}, inspectionPayload: () => ({}),
    inspectionMutation: async (operation, options) => { try { await operation(); } catch (error) { await options.rollback(); throw error; } },
  });
  for (const name of ['completeInspectionCapture', 'restoreInspection']) vm.runInContext(pageFunction(viewerSource, name), c);
  const saved = c.completeInspectionCapture();
  assert.equal(saved.inspection.animation, undefined, 'static context does not start a clock');
  if (rollback) {
    await assert.rejects(c.restoreInspection({inspection: {}}, {preserveCamera: true}), /appearance failed/);
  } else {
    await h.figure.install(copies, {animation: undefined});
    await c.restoreInspection(saved, {preserveCamera: true});
  }
  assert.equal(visibleTexts(h.figure).length, 2, 'two before restore must remain two afterward');
  assert.deepEqual([...c.staticMaskKeys()], ['H2', 'H3', 'H4', 'H5']);
  assert.equal(h.registry.snapshot(), null);
});

test('body copies drop the static t=0 mask but keep the wearer\'s own hides and fades', async t => {
  const h = await motionFixture({ animation: null });
  t.after(() => h.dispose());
  const data = h.structure.obj.data, loci = chain => resolveFigureLoci({ chain }, data);
  const mask = StructureElement.Loci.union(loci('H2'), loci('H3'));
  const template = { kind: 'element-loci', layers: [
    { loci: loci('H0'), value: .82 },
    { loci: StructureElement.Loci.union(mask, loci('H5')), value: 1 },
  ] };
  const body = unmaskTransparency(template, mask, data);
  assert.equal(body.layers[0], template.layers[0], 'fades are untouched');
  assert.equal(StructureElement.Loci.size(body.layers[1].loci), StructureElement.Loci.size(loci('H5')));
  assert.equal(unmaskTransparency(template, undefined, data), template);
});

// The static scene of every animated chapter of the three motion demos, with
// no animation installed: each plate names a copy drawn at t=0, so each name
// shows once, and figure layers of t=0-hidden copies stay hidden too.
for (const demo of ['hemoglobin-switch', 'kinesin-walk', 'atp-synthase-rotor']) {
  test(`${demo} motion: the static figure of an animated chapter draws only its t=0 copies`, { skip: !cache }, async () => {
    const lesson = JSON.parse(readFileSync(new URL(`../../plugin/demos/${demo}/motion.json`, import.meta.url), 'utf8'));
    const h = await motionFixture({ source: readCachedDemoCoordinates(demo, 'motion'), animation: null });
    const figure = createLessonFigure({ plugin: h.plugin, getStructure: () => h.structure, getTransform: () => h.presentation });
    try {
      for (const chapter of lesson.chapters.filter(chapter => chapter.animation)) {
        const authored = { distances: [], ...chapter.immersive.figure };
        await figure.install(authored, { animation: chapter.animation });
        const startHidden = new Set(chapter.animation.tracks.filter(track => !evaluateTrackVisibility(track, 0)).flatMap(track => track.chains));
        const reprs = figure.annotations().slice(0, authored.labels.length);
        authored.labels.forEach((label, i) => assert.equal(reprs[i].state.visible, !startHidden.has(label.target.chain),
          `${chapter.id}/${label.id} (${label.text})`));
        const texts = reprs.filter(repr => repr.state.visible).map(repr => repr.props.customText);
        for (const text of ['Head 1', 'Head 2', 'Alpha 1', 'Beta 1', 'Alpha 2', 'Beta 2', 'T state'])
          assert.ok(texts.filter(value => value === text).length <= 1, `${chapter.id}: one ${text}`);
        assert.ok(!texts.includes('R state'), 'never names the R state at t=0');
        const cells = [...h.plugin.state.data.cells.values()];
        for (const layer of authored.layers) {
          const component = cells.find(cell => cell.transform.tags?.includes('stereofold-lesson-figure') && cell.obj?.label === layer.id);
          const repr = component && cells.find(cell => cell.transform.parent === component.transform.ref && cell.obj?.data?.repr);
          assert.ok(repr, `${chapter.id}/${layer.id} layer built`);
          assert.equal(repr.state.isHidden, startHidden.has(layer.target.chain), `${chapter.id}/${layer.id} layer`);
        }
      }
    } finally { await figure.forget(); await h.dispose(); }
  });
}
