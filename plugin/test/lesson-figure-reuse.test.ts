import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PluginContext } from 'molstar/lib/mol-plugin/context.js';
import { DefaultPluginSpec } from 'molstar/lib/mol-plugin/spec.js';
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms.js';
import { Structure } from 'molstar/lib/mol-model/structure.js';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Task } from 'molstar/lib/mol-task/index.js';
import { setCanvasModule } from 'molstar/lib/mol-geo/geometry/text/font-atlas.js';
import { lessonFigureSchema } from '../src/lesson-figure.js';
// @ts-ignore Shared production figure renderer.
import { createLessonFigure } from '../../lab/browser-roundtrip/lesson-figure.mjs';

const authored = () => lessonFigureSchema.parse({ layers: [
  { id: 'protein', target: { chain: 'A', residues: { from: 1, to: 20 } }, representation: 'cartoon', color: '#25859b',
    colorOverrides: [{ target: { chain: 'A', residues: { from: 10, to: 12 } }, color: '#d98370' }] },
  { id: 'envelope', target: { chain: 'A', residues: { from: 1, to: 20 } }, representation: 'gaussian-surface', color: '#60b4c1', opacity: .14 },
  { id: 'detail', target: { chain: 'A', residues: { from: 21, to: 22 } }, representation: 'ball-and-stick', color: '#d6ad20', sizeFactor: .16 },
] });

// Real Mol* state transforms and CPU geometry. Only text rasterization and
// canvas presentation are stubbed; these tests make no GPU/pixel claim.
async function fixture(run: (h: any) => Promise<void>) {
  const previousDocument = globalThis.document;
  (globalThis as any).document = { addEventListener() {}, removeEventListener() {},
    createElement() { return { setAttribute() {} }; }, head: { appendChild() {}, removeChild() {} } };
  setCanvasModule({ createCanvas: () => ({ getContext: () => ({
    measureText: () => ({ width: 4 }), clearRect() {}, fillText() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
  }) }) } as any);
  const plugin = new PluginContext(DefaultPluginSpec());
  try {
    await plugin.init();
    const raw = await plugin.builders.data.rawData({ data: readFileSync(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8') });
    const trajectory = await plugin.build().to(raw).apply(StateTransforms.Data.ParseCif).apply(StateTransforms.Model.TrajectoryFromMmCif).commit();
    const model = await plugin.build().to(trajectory).apply(StateTransforms.Model.ModelFromTrajectory, { modelIndex: 0 }).commit();
    let structure = await plugin.build().to(model).apply(StateTransforms.Model.StructureFromModel, { type: { name: 'model', params: {} } }).commit();
    const drawn = new Set<any>(), manualObjects: any[] = [];
    (plugin as any).canvas3d = { xr: { isPresenting: { value: false } }, update() {}, mark() {}, syncVisibility() {},
      add(repr: any) { drawn.add(repr); }, remove(repr: any) { drawn.delete(repr); },
      getRenderObjects: () => [...drawn].flatMap(repr => repr.renderObjects).concat(manualObjects),
    };
    const renderer = createLessonFigure({ plugin, getStructure: () => structure, getTransform: () => Mat4.identity() });
    await run({ plugin, renderer, drawn, manualObjects, structure: () => structure,
      async replaceSource() { structure = await plugin.build().to(model).apply(StateTransforms.Model.StructureFromModel,
        { type: { name: 'model', params: {} } }).commit(); },
    });
    await renderer.forget();
    expect(drawn.size).toBe(0);
  } finally {
    (plugin as any).canvas3d = undefined; plugin.dispose();
    if (previousDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = previousDocument;
  }
}

function identity(repr: any) {
  const objects = [...repr.renderObjects];
  const geometry = objects.map(object => Object.entries(object.values)
    .filter(([key]) => /^(aPosition|aNormal|elements|aStart|aEnd|aCenter|aMapping|aGroup|aScale|aIndex)$/u.test(key))
    .map(([key, value]: [string, any]) => [key, value.ref.value]));
  expect(objects.some(object => object.values.drawCount.ref.value > 0)).toBe(true);
  expect(geometry.flat().length).toBeGreaterThan(0);
  return { repr, objects, geometry };
}
function retained(repr: any, before: ReturnType<typeof identity>) {
  expect(repr).toBe(before.repr);
  expect(repr.renderObjects).toHaveLength(before.objects.length);
  repr.renderObjects.forEach((object: any, i: number) => {
    expect(object).toBe(before.objects[i]);
    for (const [key, buffer] of before.geometry[i]) expect(object.values[key].ref.value).toBe(buffer);
  });
}
const figureCells = (plugin: any) => [...plugin.state.data.cells.values()].filter((cell: any) =>
  cell.transform.tags?.includes('stereofold-lesson-figure')) as any[];

describe('molecular figure layer reuse with the real state tree and geometry', () => {
  it('retains render objects and buffers through alpha, context, focus and annotation edits', async () => fixture(async ({ plugin, renderer, drawn }) => {
    const beforeCells = plugin.state.data.cells.size;
    const first = authored();
    await renderer.install(first);
    const before = renderer.molecular().map(identity), refs = figureCells(plugin).map(cell => cell.transform.ref);
    const next = structuredClone(first);
    next.layers[0].opacity = .12; next.layers[0].context = true;
    next.layers[1].opacity = .08;
    next.focus = [{ chain: 'A', residues: { from: 21, to: 22 } }];
    next.labels = [{ id: 'name', target: { chain: 'A', residues: { from: 21, to: 21 } }, text: 'Detail',
      color: '#d6ad20', sizeFactor: .6, offsetX: 1, offsetY: -1 }];
    next.distances = [{ id: 'contact', a: { chain: 'A', residues: { from: 21, to: 21 }, atomName: 'CA' },
      b: { chain: 'A', residues: { from: 22, to: 22 }, atomName: 'CA' }, color: '#777777', showText: false,
      sizeFactor: .6, offsetX: 0, offsetY: 0 }];
    await renderer.install(next);
    renderer.molecular().forEach((repr: any, i: number) => retained(repr, before[i]));
    expect(renderer.molecular()[0].props.alpha).toBe(.12);
    expect(renderer.molecular()[1].props.alpha).toBe(.08);
    expect(renderer.molecular()[0].renderObjects.every((object: any) => object.values.alpha.ref.value === .12)).toBe(true);
    expect(renderer.molecular()[0].state.overpaint.layers[0].color).toBe(0xd98370);
    expect(renderer.placement()).toEqual(renderer.molecular().slice(1));
    expect(renderer.definition()).toEqual(next);
    const label = [...plugin.state.data.cells.values()].find((cell: any) =>
      cell.transform.transformer.id === StateTransforms.Representation.StructureSelectionsLabel3D.id) as any;
    expect(label.params.values.customText).toBe('Detail');
    expect(renderer.annotations()).toHaveLength(2); expect(drawn.size).toBe(renderer.count());
    expect(renderer.snapshot().distances[0].angstrom).toBeGreaterThan(0);
    for (const ref of refs) expect(plugin.state.data.cells.has(ref)).toBe(true);
    await renderer.install(next); // Whole-figure repeat keeps annotations too.
    expect(renderer.annotations()[0]).toBe(label.obj.data.repr);
    await renderer.install(first);
    renderer.molecular().forEach((repr: any, i: number) => retained(repr, before[i]));
    expect(renderer.molecular()[0].props.alpha).toBe(1);
    expect(renderer.annotations()).toEqual([]); expect(drawn.size).toBe(renderer.count());
    await renderer.forget(); expect(plugin.state.data.cells.size).toBe(beforeCells);
  }));

  it('rebuilds from the first geometry or authored-order change to preserve transparent blending order', async () => fixture(async ({ renderer }) => {
    const first = authored(); await renderer.install(first);
    const changes = [
      (layer: any) => { layer.target.residues.to = 19; },
      (layer: any) => { layer.color = '#ffffff'; },
      (layer: any) => { layer.sizeFactor = 1.2; },
      (layer: any) => { layer.representation = 'ball-and-stick'; },
      (layer: any) => { layer.colorOverrides[0].color = '#222222'; },
    ];
    for (const change of changes) {
      const before = renderer.molecular().map(identity), next = structuredClone(first);
      change(next.layers[0]); await renderer.install(next);
      expect(renderer.molecular()[0]).not.toBe(before[0].repr);
      renderer.molecular().forEach((repr: any, i: number) => expect(repr).not.toBe(before[i].repr));
      await renderer.install(first);
    }
    const before = renderer.molecular().map(identity), reordered = structuredClone(first);
    reordered.layers.reverse(); await renderer.install(reordered);
    renderer.molecular().forEach((repr: any) => expect(before.some((old: any) => old.repr === repr)).toBe(false));
  }));

  it('preserves relative transparent material order after changing an earlier overlapping envelope', async () => fixture(async ({ renderer }) => {
    const first = authored();
    first.layers = [first.layers[1], { ...first.layers[1], id: 'second-envelope', color: '#d98370' }];
    await renderer.install(first);
    const before = renderer.molecular().map(identity);
    const materialOrder = () => renderer.molecular().map((repr: any) => repr.renderObjects[0].materialId);
    expect(materialOrder()[0]).toBeLessThan(materialOrder()[1]);
    const next = structuredClone(first); next.layers[0].color = '#25859b';
    await renderer.install(next);
    expect(materialOrder()[0]).toBeLessThan(materialOrder()[1]);
    renderer.molecular().forEach((repr: any, i: number) => expect(repr).not.toBe(before[i].repr));
  }));

  it('reuses an unchanged prefix while replacing trailing layers, as in KRAS overview/interface', async () => fixture(async ({ renderer }) => {
    const first = authored(); await renderer.install(first);
    const before = renderer.molecular().map(identity), next = structuredClone(first);
    next.layers[0].opacity = .14; next.layers[0].context = true;
    next.layers[2] = { ...next.layers[2], id: 'new-contact', target: { chain: 'A', residues: { from: 25, to: 25 } } };
    await renderer.install(next);
    retained(renderer.molecular()[0], before[0]); retained(renderer.molecular()[1], before[1]);
    expect(renderer.molecular()[2]).not.toBe(before[2].repr);
    expect(renderer.molecular()[1].renderObjects[0].materialId).toBeLessThan(renderer.molecular()[2].renderObjects[0].materialId);
    await renderer.install(first);
    retained(renderer.molecular()[0], before[0]); retained(renderer.molecular()[1], before[1]);
  }));

  it('rebuilds after a newly added external molecular representation to preserve relative transparent order', async () => fixture(async ({ plugin, renderer, structure, drawn }) => {
    const first = authored(); first.layers = [first.layers[1]];
    await renderer.install(first); const before = identity(renderer.molecular()[0]);
    const external = await plugin.builders.structure.representation.addRepresentation(structure(), {
      type: 'gaussian-surface', color: 'uniform', colorParams: { value: 0xd98370 },
      typeParams: { alpha: .14, quality: 'low', resolution: 1.5, smoothness: 1.5 },
    });
    const material = external.obj.data.repr.renderObjects[0].materialId;
    expect(before.objects[0].materialId).toBeLessThan(material);
    const next = structuredClone(first); next.layers[0].opacity = .12;
    await renderer.install(next);
    expect(renderer.molecular()[0]).not.toBe(before.repr);
    expect(renderer.molecular()[0].renderObjects[0].materialId).toBeGreaterThan(material);
    const updated = identity(renderer.molecular()[0]);
    await renderer.install(first); retained(renderer.molecular()[0], updated);
    await plugin.build().delete(external.ref).commit(); expect(drawn.size).toBe(renderer.count());
  }));

  it('accepts a pending external state object committing to the canvas during staging', async () => fixture(async ({ plugin, renderer, structure, drawn }) => {
    const external = await plugin.builders.structure.representation.addRepresentation(structure(), {
      type: 'gaussian-surface', color: 'uniform', colorParams: { value: 0xd98370 },
      typeParams: { alpha: .14, quality: 'low', resolution: 1.5, smoothness: 1.5 },
    });
    // The state representation exists throughout; only its canvas membership
    // changes while a new figure layer is being built asynchronously.
    drawn.delete(external.obj.data.repr);
    const builder = plugin.builders.structure.representation, original = builder.addRepresentation;
    builder.addRepresentation = async function(...args: any[]) {
      const result = await original.apply(this, args);
      drawn.add(external.obj.data.repr);
      return result;
    };
    const first = authored(); await renderer.install(first);
    builder.addRepresentation = original;
    expect(renderer.definition()).toEqual(first);
    const before = renderer.molecular().map(identity), next = structuredClone(first); next.layers[0].opacity = .12;
    await renderer.install(next);
    renderer.molecular().forEach((repr: any, i: number) => retained(repr, before[i]));
    await plugin.build().delete(external.ref).commit();
  }));

  it('keeps retired figure objects owned until a delayed canvas removal across successive installs', async () => fixture(async ({ plugin, renderer, manualObjects }) => {
    const first = authored(); await renderer.install(first);
    const retiredObjects = renderer.molecular().flatMap((repr: any) => identity(repr).objects);
    // Simulate Canvas3D retaining actual render objects after their state-tree
    // generation is retired, until a later asynchronous scene commit.
    manualObjects.push(...retiredObjects);
    const second = structuredClone(first); second.layers[0].color = '#ffffff';
    await renderer.install(second);
    const before = renderer.molecular().map(identity);
    expect(retiredObjects.every((object: any) => plugin.canvas3d.getRenderObjects().includes(object))).toBe(true);
    const builder = plugin.builders.structure.representation, original = builder.addRepresentation;
    builder.addRepresentation = async function(...args: any[]) {
      const result = await original.apply(this, args);
      manualObjects.length = 0;
      return result;
    };
    const third = structuredClone(second); third.layers[2].sizeFactor = .2;
    await renderer.install(third); builder.addRepresentation = original;
    expect(renderer.definition()).toEqual(third);
    retained(renderer.molecular()[0], before[0]); retained(renderer.molecular()[1], before[1]);
    expect(renderer.molecular()[2]).not.toBe(before[2].repr);
    expect(retiredObjects.some((object: any) => plugin.canvas3d.getRenderObjects().includes(object))).toBe(false);
  }));

  it('invalidates reuse for external manual main-scene objects absent from the state tree', async () => fixture(async ({ renderer, manualObjects }) => {
    const first = authored(); await renderer.install(first);
    const before = renderer.molecular().map(identity);
    // An opaque stand-in tests identity enumeration only; real geometry and
    // material ordering are exercised by the external Gaussian test above.
    manualObjects.push({ id: 'external-world-mesh' });
    const next = structuredClone(first); next.layers[0].opacity = .12;
    await renderer.install(next);
    renderer.molecular().forEach((repr: any, i: number) => expect(repr).not.toBe(before[i].repr));
    const updated = renderer.molecular().map(identity);
    await renderer.install(first);
    renderer.molecular().forEach((repr: any, i: number) => retained(repr, updated[i]));
    manualObjects.length = 0;
  }));

  it('invalidates cached cells on deleted representation/modifier and actual source-data replacement', async () => fixture(async ({ plugin, renderer, structure, replaceSource }) => {
    const first = authored(); await renderer.install(first);
    let before = renderer.molecular().map(identity);
    const reprCell = [...plugin.state.data.cells.values()].find((cell: any) => cell.obj?.data?.repr === before[0].repr) as any;
    await plugin.build().delete(reprCell.transform.ref).commit();
    await renderer.install(first);
    renderer.molecular().forEach((repr: any, i: number) => expect(repr).not.toBe(before[i].repr));
    before = renderer.molecular().map(identity);
    const modifier = [...plugin.state.data.cells.values()].find((cell: any) =>
      cell.transform.transformer.id === StateTransforms.Representation.OverpaintStructureRepresentation3DFromBundle.id) as any;
    await plugin.build().delete(modifier.transform.ref).commit();
    await renderer.install(first); expect(renderer.molecular()[0]).not.toBe(before[0].repr);
    expect(renderer.molecular()[1]).not.toBe(before[1].repr);
    before = renderer.molecular().map(identity);
    // StateObjectSelector identity alone is insufficient: its data is mutable.
    structure().obj.data = Structure.ofModel(structure().obj.data.models[0]);
    await renderer.install(first);
    renderer.molecular().forEach((repr: any, i: number) => expect(repr).not.toBe(before[i].repr));
    before = renderer.molecular().map(identity); await replaceSource(); await renderer.install(first);
    renderer.molecular().forEach((repr: any, i: number) => expect(repr).not.toBe(before[i].repr));
  }));

  it('keeps old geometry and alpha if staging a new layer fails', async () => fixture(async ({ plugin, renderer }) => {
    const first = authored(); await renderer.install(first);
    const before = renderer.molecular().map(identity), count = plugin.state.data.cells.size;
    const next = structuredClone(first); next.layers[0].opacity = .12;
    next.layers.push({ ...next.layers[2], id: 'new-detail', target: { chain: 'A', residues: { from: 25, to: 25 } } });
    const builder = plugin.builders.structure.representation, original = builder.addRepresentation;
    builder.addRepresentation = async () => { throw Error('new geometry failed'); };
    await expect(renderer.install(next)).rejects.toThrow('new geometry failed');
    builder.addRepresentation = original;
    expect(renderer.definition()).toEqual(first); expect(plugin.state.data.cells.size).toBe(count);
    renderer.molecular().forEach((repr: any, i: number) => retained(repr, before[i]));
    expect(renderer.molecular()[0].props.alpha).toBe(1);
    await renderer.install(next); expect(renderer.snapshot().layers).toBe(4);
  }));

  it('rolls back a partially applied alpha update and remains usable', async () => fixture(async ({ renderer }) => {
    const first = authored(); await renderer.install(first);
    const repr = renderer.molecular()[0], original = repr.createOrUpdate;
    let fail = true;
    repr.createOrUpdate = function(props: any, data: any) {
      const task = original.call(this, props, data);
      return Task.create('Injected alpha failure', async ctx => {
        await task.runInContext(ctx);
        if (fail && props.alpha === .12) { fail = false; throw Error('alpha update failed'); }
      });
    };
    const next = structuredClone(first); next.layers[0].opacity = .12;
    await expect(renderer.install(next)).rejects.toThrow('opacity');
    expect(renderer.definition()).toEqual(first);
    expect(renderer.molecular()[0].props.alpha).toBe(1);
    expect(renderer.molecular().every((value: any) => value.state.visible)).toBe(true);
    // Mol* may recreate a failed representation during rollback; restored
    // state must contain live, drawable geometry with the old alpha.
    renderer.molecular().forEach(identity);
    expect(renderer.molecular()[0].renderObjects.every((object: any) => object.values.alpha.ref.value === 1)).toBe(true);
    repr.createOrUpdate = original;
    await renderer.install(next); expect(renderer.molecular()[0].props.alpha).toBe(.12);
  }));

  it.each(['before', 'after'])('restores live geometry and reused opacity when retiring old annotations fails %s commit', async phase => fixture(async ({ plugin, renderer }) => {
    const first = authored();
    first.labels = [{ id: 'old', target: { chain: 'A', residues: { from: 21, to: 21 } }, text: 'Old', color: '#777777', sizeFactor: .6, offsetX: 0, offsetY: 0 }];
    await renderer.install(first);
    const before = renderer.molecular().map(identity), count = plugin.state.data.cells.size;
    const next = structuredClone(first); next.layers[0].opacity = .12; next.labels = [];
    const original = plugin.build.bind(plugin); let fail = true;
    plugin.build = () => {
      const builder = original(), remove = builder.delete, commit = builder.commit; let deleting = false;
      builder.delete = function(ref: string) {
        deleting = true;
        if (fail && phase === 'before') { fail = false; throw Error('retirement failed'); }
        return remove.call(this, ref);
      };
      builder.commit = async function(options: any) {
        const result = await commit.call(this, options);
        if (deleting && fail && phase === 'after') { fail = false; throw Error('retirement failed'); }
        return result;
      };
      return builder;
    };
    await expect(renderer.install(next)).rejects.toThrow('retirement failed');
    plugin.build = original;
    expect(renderer.definition()).toEqual(first); expect(plugin.state.data.cells.size).toBe(count);
    expect(renderer.molecular()[0].props.alpha).toBe(1);
    renderer.molecular().forEach((repr: any, i: number) => retained(repr, before[i]));
    renderer.annotations().forEach(identity);
    expect(renderer.molecular()[0].renderObjects.every((object: any) => object.values.alpha.ref.value === 1)).toBe(true);
    await renderer.install(next); expect(renderer.snapshot().labels).toBe(0);
  }));

  it('restores drawable molecular geometry after its actual retirement commit fails', async () => fixture(async ({ plugin, renderer }) => {
    const first = authored(); await renderer.install(first);
    const count = plugin.state.data.cells.size;
    const next = structuredClone(first); next.layers[0].color = '#ffffff';
    const original = plugin.build.bind(plugin); let fail = true;
    plugin.build = () => {
      const builder = original(), remove = builder.delete, commit = builder.commit; let deleting = false;
      builder.delete = function(ref: string) { deleting = true; return remove.call(this, ref); };
      builder.commit = async function(options: any) {
        const result = await commit.call(this, options);
        if (deleting && fail) { fail = false; throw Error('post-disposal failure'); }
        return result;
      };
      return builder;
    };
    await expect(renderer.install(next)).rejects.toThrow('post-disposal failure');
    plugin.build = original;
    expect(renderer.definition()).toEqual(first); expect(plugin.state.data.cells.size).toBe(count);
    renderer.molecular().forEach((repr: any, i: number) => {
      identity(repr); expect(repr.state.visible).toBe(true);
      expect(repr.renderObjects.every((object: any) => object.values.alpha.ref.value === first.layers[i].opacity)).toBe(true);
    });
    expect(figureCells(plugin).every(cell => cell.status === 'ok')).toBe(true);
    await renderer.install(next); expect(renderer.definition()).toEqual(next);
  }));

  it.each(['alpha', 'retirement'])('does not resurrect forgotten figures during an awaited %s commit', async phase => fixture(async ({ plugin, renderer, drawn }) => {
    const baseline = plugin.state.data.cells.size;
    const first = authored();
    first.labels = [{ id: 'old', target: { chain: 'A', residues: { from: 21, to: 21 } }, text: 'Old', color: '#777777', sizeFactor: .6, offsetX: 0, offsetY: 0 }];
    await renderer.install(first);
    const reprRef = [...plugin.state.data.cells.values()].find((cell: any) =>
      cell.obj?.data?.repr === renderer.molecular()[0]).transform.ref;
    const next = structuredClone(first); next.layers[0].opacity = .12; next.labels = [];
    next.distances = [{ id: 'contact', a: { chain: 'A', residues: { from: 21, to: 21 }, atomName: 'CA' },
      b: { chain: 'A', residues: { from: 22, to: 22 }, atomName: 'CA' }, color: '#777777', showText: false,
      sizeFactor: .6, offsetX: 0, offsetY: 0 }];
    let entered!: () => void, resume!: () => void, paused = false;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const original = plugin.build.bind(plugin);
    plugin.build = () => {
      const builder = original(), to = builder.to, remove = builder.delete, commit = builder.commit;
      let pause = false;
      builder.to = function(ref: string) { if (phase === 'alpha' && ref === reprRef) pause = true; return to.call(this, ref); };
      builder.delete = function(ref: string) { if (phase === 'retirement') pause = true; return remove.call(this, ref); };
      builder.commit = async function(options: any) {
        const result = await commit.call(this, options);
        if (pause && !paused) { paused = true; entered(); await gate; }
        return result;
      };
      return builder;
    };
    const installing = renderer.install(next);
    const rejected = expect(installing).rejects.toThrow('source changed');
    await waiting;
    const forgotten = renderer.forget(); resume();
    await rejected; await forgotten; plugin.build = original;
    expect(renderer.definition()).toBeUndefined(); expect(renderer.count()).toBe(0);
    expect(drawn.size).toBe(0); expect(plugin.state.data.cells.size).toBe(baseline);
    await renderer.install(first); expect(renderer.snapshot().layers).toBe(3);
  }));

});
