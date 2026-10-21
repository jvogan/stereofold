import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseMolecularLesson } from '../src/molecular-lesson.js';
import { lessonFigureSchema } from '../src/lesson-figure.js';
import { molecularLessonToTour } from '../src/molecular-lesson-tour.js';
import { applyTourStep, xrStepChanges, type Workspace } from '../src/tour-player.js';
import { CIF } from 'molstar/lib/mol-io/reader/cif.js';
import { trajectoryFromMmCIF } from 'molstar/lib/mol-model-formats/structure/mmcif.js';
import { Structure, StructureElement } from 'molstar/lib/mol-model/structure.js';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { expectedInspection, matchesInspectionChange, sceneSchema } from '../src/inspection-contract.js';
// @ts-ignore Shared pure figure policy.
import { withFigureRepresentation, figureRepresentationLayers, figureLayerRepresentation } from '../../lab/browser-roundtrip/lesson-figure-appearance.mjs';
// @ts-ignore Browser module shared by the actual inspector bundle.
import { DEFAULT_INSPECTION } from '../../lab/browser-roundtrip/inspection-state.mjs';
// @ts-ignore Browser module shared by the actual inspector bundle.
import { resolveFigureLoci, createLessonFigure } from '../../lab/browser-roundtrip/lesson-figure.mjs';

const lesson = JSON.parse(readFileSync(new URL('../examples/lessons/9ax6-daraxonrasib.json', import.meta.url), 'utf8'));
const tour = molecularLessonToTour(lesson);

describe('source-backed immersive molecular figures', () => {
  it('preserves opt-in exterior placement while leaving attached labels as the default', () => {
    const figure=structuredClone(tour.steps[0].figure!);
    expect(lessonFigureSchema.parse(figure).labels[0].placement).toBeUndefined();
    for (const placement of ['attached','outside-figure'] as const) {
      const authored={...figure,labels:[{...figure.labels[0],placement}]};
      const manifest=structuredClone(lesson);manifest.chapters[0].immersive.figure=authored;
      const parsed=parseMolecularLesson(manifest);
      expect(molecularLessonToTour(parsed).steps[0].figure?.labels[0].placement).toBe(placement);
      const scene=sceneSchema.parse({sourceSha256:'a'.repeat(64),modelNumber:1,assemblyId:'1',selectionKeys:[],
        camera:{mode:'perspective',fov:Math.PI/4,position:[0,0,80],target:[0,0,0],up:[0,1,0],radius:20,radiusMax:20,fog:0,clipFar:true,minNear:1,minFar:0},
        inspection:{...structuredClone(DEFAULT_INSPECTION),lessonFigure:authored}});
      expect(scene.inspection.lessonFigure?.labels[0].placement).toBe(placement);
    }
    expect(lessonFigureSchema.safeParse({...figure,labels:[{...figure.labels[0],placement:'outside-everything'}]}).success).toBe(false);
  });

  it('accepts maxOffsetEm from 2 to 5, defaults to 2, and preserves it through lesson and scene contracts', () => {
    const figure = structuredClone(tour.steps[0].figure!);
    for (const maxOffsetEm of [2, 3.5, 4, 5]) {
      const authored = { ...figure, labels: [{ ...figure.labels[0], maxOffsetEm }] };
      expect(lessonFigureSchema.parse(authored).labels[0]).toMatchObject({ maxOffsetEm });
      const manifest = structuredClone(lesson);
      manifest.chapters[0].immersive.figure = authored;
      const parsed = parseMolecularLesson(manifest);
      expect(parsed.chapters[0].immersive?.figure?.labels[0]).toMatchObject({ maxOffsetEm });
      expect(molecularLessonToTour(parsed).steps[0].figure?.labels[0]).toMatchObject({ maxOffsetEm });
      const scene = sceneSchema.parse({ sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1',
        selectionKeys: [], camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
          radius: 20, radiusMax: 20, fog: 0, clipFar: true, minNear: 1, minFar: 0 },
        inspection: { ...structuredClone(DEFAULT_INSPECTION), lessonFigure: authored } });
      expect(scene.inspection.lessonFigure?.labels[0]).toMatchObject({ maxOffsetEm });
    }
    const { maxOffsetEm: _cap, ...defaultLabel } = figure.labels[0];
    expect(lessonFigureSchema.parse({ ...figure, labels: [defaultLabel] }).labels[0]).toMatchObject({ maxOffsetEm: 2 });
    for (const maxOffsetEm of [-1, 0, 1.99, 5.01, Infinity, NaN, '4', null])
      expect(lessonFigureSchema.safeParse({ ...figure, labels: [{ ...defaultLabel, maxOffsetEm }] }).success).toBe(false);
  });
  it('preserves optional desktop label pixels through lesson and scene contracts within 14–48', () => {
    const figure = structuredClone(tour.steps[0].figure!);
    expect(lessonFigureSchema.parse(figure).labels[0].desktopSizePx).toBeUndefined();
    for (const desktopSizePx of [14, 26, 32, 48]) {
      const authored = { ...figure, labels: [{ ...figure.labels[0], desktopSizePx }] };
      const manifest = structuredClone(lesson);
      manifest.chapters[0].immersive.figure = authored;
      const parsed = parseMolecularLesson(manifest);
      expect(molecularLessonToTour(parsed).steps[0].figure?.labels[0].desktopSizePx).toBe(desktopSizePx);
      const scene = sceneSchema.parse({ sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1',
        selectionKeys: [], camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
          radius: 20, radiusMax: 20, fog: 0, clipFar: true, minNear: 1, minFar: 0 },
        inspection: { ...structuredClone(DEFAULT_INSPECTION), lessonFigure: authored } });
      expect(scene.inspection.lessonFigure?.labels[0].desktopSizePx).toBe(desktopSizePx);
    }
    for (const desktopSizePx of [13.99, 48.01, Infinity, NaN, '32', null])
      expect(lessonFigureSchema.safeParse({ ...figure, labels: [{ ...figure.labels[0], desktopSizePx }] }).success).toBe(false);
  });
  it('saves the explicit global choice without rewriting authored styles or scientific annotations', () => {
    const original = tour.steps[0].figure!;
    for (const representation of ['cartoon', 'ball-and-stick', 'spacefill', 'molecular-surface']) {
      const changed = lessonFigureSchema.parse(withFigureRepresentation(original, representation));
      expect(changed.representationOverride).toBe(representation);
      expect(changed.layers).toEqual(original.layers);
      expect(changed.labels).toEqual(original.labels);
      expect(changed.distances).toEqual(original.distances);
      const layers = figureRepresentationLayers(changed);
      expect(layers.map((layer: any) => layer.id)).toEqual(['kras', 'cypa', 'drug', 'nucleotide']);
      expect(layers[0].colorOverrides).toEqual(original.layers[0].colorOverrides);
      expect(layers[0].opacity).toBe(1);
      if (representation === 'spacefill') expect(layers[2].sizeFactor).toBeUndefined();
    }
    expect(original.representationOverride).toBeUndefined();
    expect(figureRepresentationLayers(original)).toEqual(original.layers);
    expect(figureLayerRepresentation({ representation: 'cartoon', target: { chain: 'A', atomName: 'OE2' } }, { polymerResidueCount: 1 })).toBe('ball-and-stick');
    expect(figureLayerRepresentation({ representation: 'cartoon', target: { chain: 'A' } }, { polymerResidueCount: 0 })).toBe('ball-and-stick');
    expect(lessonFigureSchema.safeParse({ ...original, representationOverride: 'isosurface' }).success).toBe(false);
  });
  it('predicts and confirms global agent edits while a scoped style preserves the layered figure', () => {
    const scene = sceneSchema.parse({ sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1',
      selectionKeys: [], camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
        radius: 20, radiusMax: 20, fog: 0, clipFar: true, minNear: 1, minFar: 0 },
      inspection: { ...structuredClone(DEFAULT_INSPECTION), lessonFigure: tour.steps[0].figure } });
    const change = { kind: 'appearance' as const, patch: { representation: 'spacefill' as const } };
    const expected = expectedInspection(scene, change);
    expect(expected.inspection.lessonFigure?.representationOverride).toBe('spacefill');
    expect(expected.inspection.lessonFigure?.layers).toEqual(scene.inspection.lessonFigure?.layers);
    expect(expected.sourceSha256).toBe(scene.sourceSha256);
    expect(expected.selectionKeys).toEqual(scene.selectionKeys);
    expect(expected.inspection.placement).toEqual(scene.inspection.placement);
    expect(matchesInspectionChange(expected, expected, change)).toBe(true);
    const wrong = structuredClone(expected); delete wrong.inspection.lessonFigure!.representationOverride;
    expect(matchesInspectionChange(wrong, expected, change)).toBe(false);
    const scoped = expectedInspection(scene, { kind: 'styles', patch: { styles: [{ selectionKeys: ['local-key'], representation: 'spacefill' }] } });
    expect(scoped.inspection.lessonFigure).toEqual(scene.inspection.lessonFigure);
    const compound = expectedInspection(scene, { kind: 'compound', patch: { ops: [change,
      { kind: 'selection', patch: { selectionKeys: ['local-key'] } }] } });
    expect(compound.inspection.lessonFigure?.representationOverride).toBe('spacefill');
    expect(compound.selectionKeys).toEqual(['local-key']);
  });
  it('builds actual global Mol* geometry for local coordinates, keeps part colours and keeps ligands visible with Ribbons', async () => {
    const previousDocument = globalThis.document;
    // This test exercises CPU geometry and the real state tree, with no GPU or XR claim.
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {},
      createElement() { return { setAttribute() {} }; }, head: { appendChild() {}, removeChild() {} } };
    const plugin = new PluginContext(DefaultPluginSpec());
    try {
      await plugin.init();
      const data = await plugin.builders.data.rawData({ data: readFileSync(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8') });
      const trajectory = await plugin.build().to(data).apply(StateTransforms.Data.ParseCif).apply(StateTransforms.Model.TrajectoryFromMmCif).commit();
      const model = await plugin.build().to(trajectory).apply(StateTransforms.Model.ModelFromTrajectory, { modelIndex: 0 }).commit();
      const structure = await plugin.build().to(model).apply(StateTransforms.Model.StructureFromModel, { type: { name: 'model', params: {} } }).commit();
      (plugin as any).canvas3d = { xr: { isPresenting: { value: false } }, update() {}, remove() {}, add() {}, mark() {}, syncVisibility() {} };
      const transform = Mat4.identity(); transform[12] = 7;
      let otherGeometry: any[] = [];
      const renderer = createLessonFigure({ plugin, getStructure: () => structure, getTransform: () => transform,
        getGeometryOptions: () => ({ deviceClass: 'quest2', standalone: true, quality: 'low' }),
        getGeometryEntries: () => otherGeometry });
      const authored = lessonFigureSchema.parse({ layers: [
        { id: 'local-protein', target: { chain: 'A', residues: { from: 1, to: 20 } }, representation: 'cartoon', color: '#25859B',
          colorOverrides: [{ target: { chain: 'A', residues: { from: 10, to: 12 } }, color: '#D98370' }] },
        { id: 'local-envelope', target: { chain: 'A', residues: { from: 1, to: 20 } }, representation: 'gaussian-surface', opacity: .14, color: '#60B4C1' },
        { id: 'local-heme', target: { chain: 'A', componentId: 'HEM' }, representation: 'ball-and-stick', color: '#D6AD20', sizeFactor: .16 },
      ] });
      for (const representation of ['ball-and-stick', 'spacefill', 'molecular-surface', 'cartoon']) {
        await renderer.install(withFigureRepresentation(authored, representation));
        expect(renderer.snapshot().layers).toBe(2);
        expect(renderer.snapshot().layerRepresentations.map((part: any) => part.representation))
          .toEqual([representation, representation === 'cartoon' ? 'ball-and-stick' : representation]);
        expect(renderer.definition().layers).toEqual(authored.layers);
        expect(renderer.molecular()).toHaveLength(2);
        for (const repr of renderer.molecular()) {
          expect(repr.renderObjects.some((object: any) => object.values.drawCount.ref.value > 0)).toBe(true);
          expect(Array.from(repr.state.transform)).toEqual(Array.from(transform));
        }
        expect(renderer.molecular()[0].state.overpaint.layers).toHaveLength(1);
        expect(renderer.molecular()[0].state.overpaint.layers[0].color).toBe(0xD98370);
        const refs = renderer.molecular(); await renderer.refresh();
        expect(renderer.molecular()).toEqual(refs);
      }
      // A new author graph and a new source restore must not inherit the wearer's old override.
      await renderer.install(authored);
      expect(renderer.snapshot().layers).toBe(3);
      expect(renderer.definition().representationOverride).toBeUndefined();
      (plugin as any).canvas3d.xr.isPresenting.value = true;
      otherGeometry = [{ representation: 'ball-and-stick', atoms: 4500, bonds: 5600, residues: 600 }];
      // Work estimates advise; they no longer refuse an otherwise valid figure
      // or silently change its chosen geometry quality.
      await renderer.install(withFigureRepresentation(authored, 'ball-and-stick'));
      expect(renderer.definition().representationOverride).toBe('ball-and-stick');
      expect(renderer.molecular().every((repr: any) => repr.props.quality === 'low')).toBe(true);
      otherGeometry = [];
      const heavy = lessonFigureSchema.parse({ layers: Array.from({ length: 8 }, (_, index) => ({
        id: `overlap-${index}`, target: { chain: 'A', residues: { from: index + 1, to: 140 } }, representation: 'cartoon', color: '#25859b',
      })) });
      await renderer.install(withFigureRepresentation(heavy, 'ball-and-stick'));
      expect(renderer.molecular()).toHaveLength(8);
      expect(renderer.molecular().every((repr: any) => repr.props.quality === 'low')).toBe(true);
      await renderer.forget(); expect(renderer.snapshot()).toBeNull();
    } finally {
      (plugin as any).canvas3d = undefined; plugin.dispose();
      if (previousDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = previousDocument;
    }
  });
  it('resolves author residue and atom selectors through the pinned Mol* runtime before any state mutation', async () => {
    const parsed = await CIF.parse(readFileSync(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8')).run();
    if (parsed.isError) throw Error(parsed.message);
    const trajectory = await trajectoryFromMmCIF(parsed.result.blocks[0]).run();
    const data = Structure.ofModel(trajectory.representative);
    const loci = resolveFigureLoci({ chain: 'A', residues: { from: 10, to: 10 }, atomName: 'CA' }, data);
    expect(StructureElement.Loci.size(loci)).toBe(1);
    expect(StructureElement.Loci.size(resolveFigureLoci({ chain: 'missing' }, data))).toBe(0);
    let changed = false;
    const renderer = createLessonFigure({ plugin: { build: () => { changed = true; throw Error('mutation'); } },
      getStructure: () => ({ obj: { data } }), getTransform: () => [] });
    await expect(renderer.install({ layers: [{ id: 'missing', target: { chain: 'missing' } }], labels: [], distances: [] }))
      .rejects.toThrow('target did not resolve');
    expect(changed).toBe(false);
  });
  it('preserves both complete example scenes, exact atom endpoints and white background', () => {
    expect(tour.steps.map(step => step.id)).toEqual(['overview', 'interface']);
    expect(tour.steps.map(step => step.figure?.layers.length)).toEqual([6, 10]);
    for (const step of tour.steps) {
      expect(step.appearance?.background).toBe('#FFFFFF');
      expect(step.figure?.labels).toHaveLength(3);
      expect(step.figure?.distances).toHaveLength(2);
      expect(xrStepChanges(step)).toContain('figure');
    }
    expect(tour.steps[1].figure?.distances[1].b).toEqual({ chain: 'D', residues: { from: 102, to: 102 }, componentId: 'ASN', atomName: 'N' });
  });
  it('preserves twelve individually anchored labels and rejects more than sixteen', () => {
    const labels = Array.from({ length: 12 }, (_, index) => ({
      id: `name-${index}`, target: { chain: `${index % 2 ? 'B' : 'A'}-${2 + Math.floor(index / 2)}` },
      text: index % 2 ? 'Beta-tubulin' : 'Alpha-tubulin', color: '#2366AB', sizeFactor: 1.5,
    }));
    const parsed = lessonFigureSchema.parse({ ...tour.steps[0].figure, labels });
    expect(parsed.labels).toHaveLength(12);
    expect(parsed.labels.map(label => label.target.chain)).toEqual(labels.map(label => label.target.chain));
    expect(lessonFigureSchema.safeParse({ ...parsed, labels: Array.from({ length: 17 }, (_, index) =>
      ({ ...labels[0], id: `name-${index}` })) }).success).toBe(false);
  });
  it('refuses broad distance endpoints, reversed ranges, duplicate ids and oversized graphs', () => {
    const figure = tour.steps[0].figure!;
    expect(lessonFigureSchema.safeParse({ ...figure, distances: [{ ...figure.distances[0], a: { chain: 'D' } }] }).success).toBe(false);
    expect(lessonFigureSchema.safeParse({ ...figure, layers: [{ ...figure.layers[0], target: { chain: 'A', residues: { from: 30, to: 10 } } }] }).success).toBe(false);
    expect(lessonFigureSchema.safeParse({ ...figure, labels: [{ ...figure.labels[0], id: figure.layers[0].id }] }).success).toBe(false);
    expect(lessonFigureSchema.safeParse({ ...figure, layers: Array(17).fill(figure.layers[0]) }).success).toBe(false);
    expect(lessonFigureSchema.safeParse({ ...figure, layers: [{ ...figure.layers[0], context: true }] }).success).toBe(false);
    expect(tour.steps[1].figure?.layers.filter(layer => layer.context)).toHaveLength(2);
  });
  it('does not mistake a figure-only chapter for a silent XR step', () => {
    expect(xrStepChanges({ id: 'detail', title: 'Detail', figure: tour.steps[1].figure })).toEqual(['figure']);
  });
  const workspace = (figure?: (value: unknown, options?: unknown) => Promise<unknown>): Workspace => ({
    snapshot: () => ({ ready: true }), rows: () => [], capture: () => ({}),
    runTour: async action => action(), setStatus: () => {},
    viewer: { select: async () => {}, focus: async () => {}, inspection: {
      configure: async () => {}, place: async () => {}, fit: async () => {}, resetOrientation: async () => {},
      orbit: async () => {}, dolly: async () => {}, setMotion: async () => {}, restore: async () => {},
      ...(figure ? { setLessonFigure: figure } : {}),
    } },
  });
  it('fails explicitly on old renderers rather than silently dropping the annotations', async () => {
    await expect(applyTourStep(workspace(), { id: 'detail', title: 'Detail', figure: tour.steps[1].figure }, () => true, false))
      .rejects.toThrow('does not support molecular figures');
  });
  it('awaits actual figure construction and propagates a missing-atom failure', async () => {
    const calls: unknown[] = [];
    await applyTourStep(workspace(async (value, options) => { calls.push([value, options]); }), tour.steps[0], () => true, false);
    expect(calls).toEqual([[tour.steps[0].figure, { frame: true }]]);
    await expect(applyTourStep(workspace(async () => { throw Error('Figure target did not resolve'); }), tour.steps[0], () => true, false))
      .rejects.toThrow('did not resolve');
  });
  it('clears a previous figure on a plain chapter', async () => {
    const calls: unknown[] = [];
    await applyTourStep(workspace(async value => { calls.push(value); }), { id: 'plain', title: 'Plain' }, () => true, false);
    expect(calls).toEqual([undefined]);
  });
  it('plays a plain density chapter with no atomic structure or installed figure', async () => {
    let changed = false;
    const renderer = createLessonFigure({ plugin: { canvas3d: { xr: { isPresenting: { value: false } } },
      state: { data: { cells: new Map() } }, build: () => { changed = true; throw Error('unexpected atomic mutation'); } },
      getStructure: () => undefined, getTransform: () => [] });
    await applyTourStep(workspace(async value => renderer.install(value)),
      { id: 'density', title: 'Real density' }, () => true, false);
    expect(renderer.snapshot()).toBeNull();
    expect(changed).toBe(false);
    await expect(renderer.install({ layers: [], labels: [], distances: [] }))
      .rejects.toThrow('needs loaded atomic coordinates');
    await renderer.install(undefined);
    expect(renderer.snapshot()).toBeNull();
  });
});
