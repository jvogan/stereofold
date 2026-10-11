import { describe, expect, it, beforeAll } from 'vitest';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { labelRuntime, labelCell, labelSource, updateLabel, viewerLabelWorkload } from './helpers/molstar-label-runtime.js';
import { labelUniformUpdatePatch, patchMolstarLabelUniformSource, patchMolstarShapeUniformSource } from '../src/molstar-font-atlas-patch.js';

let api: any, stock: any;
beforeAll(async () => {
  [api, stock] = await Promise.all([labelRuntime([labelUniformUpdatePatch]), labelRuntime()]);
});
const values = (cell: any) => cell.b.data.repr.renderObjects[0].values;
const shape = (cell: any) => cell.b.data.repr.getAllLoci()[0].shape;
const buffers = ['aPosition', 'aMapping', 'aDepth', 'elements', 'aGroup', 'aTexCoord', 'tColor', 'tMarker', 'tFont'];
const versions = (cell: any) => buffers.map(key => values(cell)[key].ref.version);
const snapshots = (cell: any) => Object.fromEntries(['padding', 'boundingSphere', 'invariantBoundingSphere', 'uInvariantBoundingSphere',
  'alpha', 'uSizeFactor', 'uOffsetX', 'uOffsetY', 'uOffsetZ', 'uBorderWidth', 'uBackgroundOpacity'].map(key => [key, structuredClone(values(cell)[key].ref.value)]));

describe('Mol* selection-label uniform path', () => {
  it('matches full-rebuild bounds, padding and state before updated without rebuilding/upload versions', async () => {
    const fast = await labelCell(api, undefined, { tooltip: 'Pick this label' });
    const full = await labelCell(stock, undefined, { tooltip: 'Pick this label' });
    const repr = fast.b.data.repr;
    const object = repr.renderObjects[0], geometry = repr.geometryVersion, initialVersions = versions(fast);
    const initialPadding = values(fast).padding.ref.value;
    const transform = api.Mat4.fromTranslation(api.Mat4(), [10, -5, 2]);
    const state = { visible: false, alphaFactor: .7, transform, colorOnly: true };
    repr.setState(state); full.b.data.repr.setState(state);
    let events = 0, seenPadding = 0;
    const subscription = repr.updated.subscribe(() => { events++; seenPadding = values(fast).padding.ref.value; });
    const before = api.shapeBuilds;
    try {
      for (const patch of [{ sizeFactor: 4, alpha: .4, offsetX: 2, offsetY: -1, offsetZ: 3, borderWidth: .3, backgroundOpacity: .6 },
        { sizeFactor: .5, alpha: .8, offsetX: -3, offsetY: 2, offsetZ: 1, borderWidth: .1, backgroundOpacity: .2 }]) {
        await updateLabel(api, fast, patch);
        await updateLabel(stock, full, patch);
        expect(snapshots(fast)).toEqual(snapshots(full));
        expect(seenPadding).toBe(values(fast).padding.ref.value);
        expect(object.state).toMatchObject({ visible: false, alphaFactor: .7, pickable: true, colorOnly: true, opaque: false, writeDepth: true });
        expect(repr.state.markerActions).toBe(full.b.data.repr.state.markerActions);
        expect(values(fast).aTransform.ref.value).toEqual(values(full).aTransform.ref.value);
        expect(shape(fast).sourceData).toBe(fast.b.data.sourceData);
        expect(shape(fast).sourceData.infos[0].loci).toBe(fast.a.data[0].loci);
      }
      expect(values(fast).padding.ref.value).not.toBe(initialPadding);
      expect(events).toBe(2);
      expect(api.shapeBuilds).toBe(before);
      expect(repr.geometryVersion).toBe(geometry);
      expect(repr.renderObjects[0]).toBe(object);
      expect(versions(fast)).toEqual(initialVersions);
      expect(shape(fast).getLabel(0)).toBe('Pick this label');
    } finally { subscription.unsubscribe(); repr.destroy(); full.b.data.repr.destroy(); }
    expect(object.state.disposed).toBe(true);
  });

  it.each([
    { textColor: 0xff0000 }, { borderColor: 0xff0000 }, { backgroundColor: 0xff0000 },
    { attachment: 'top-left' }, { tether: true }, { tetherLength: 3 }, { tetherBaseWidth: .5 },
    { fontQuality: 1 }, { fontFamily: 'serif' }, { fontWeight: 'bold' }, { fontStyle: 'italic' }, { fontVariant: 'small-caps' },
    { textSize: 2 }, { scaleByRadius: true }, { customText: 'Changed' }, { background: true },
    { backgroundMargin: 1 }, { tooltip: 'New tooltip' }, { snapshotKey: 'snapshot' },
    { instanceGranularity: true }, { unknownFutureProp: 'changed' },
  ])('rebuilds for non-uniform property %j even alongside alpha', async patch => {
    const cell = await labelCell(api);
    const before = api.shapeBuilds, oldShape = shape(cell), version = cell.b.data.repr.geometryVersion;
    try {
      await updateLabel(api, cell, { alpha: .4, ...patch });
      expect(api.shapeBuilds).toBe(before + 1);
      expect(shape(cell)).not.toBe(oldShape);
      expect(cell.b.data.repr.geometryVersion).toBeGreaterThan(version);
      expect(shape(cell).sourceData).toBe(cell.b.data.sourceData);
    } finally { cell.b.data.repr.destroy(); }
  });

  it('rebuilds on changed selection/source identity, refreshes picking and resumes the fast path', async () => {
    const cell = await labelCell(api);
    try {
      await updateLabel(api, cell, { alpha: .5 });
      const first = shape(cell), firstBounds = structuredClone(values(cell).invariantBoundingSphere.ref.value);
      for (const center of [1, 50]) { // same coordinates still have distinct scientific identity
        cell.a = labelSource(api, center);
        const before = api.shapeBuilds;
        await updateLabel(api, cell, { alpha: .6 });
        expect(api.shapeBuilds).toBe(before + 1);
        expect(shape(cell)).not.toBe(first);
        expect(shape(cell).sourceData.infos[0].loci).toBe(cell.a.data[0].loci);
        expect(shape(cell).sourceData).toBe(cell.b.data.sourceData);
        const object = cell.b.data.repr.renderObjects[0];
        expect(cell.b.data.repr.getLoci({ objectId: object.id, groupId: 0, instanceId: 0 }).shape).toBe(shape(cell));
        await updateLabel(api, cell, { alpha: .7 });
        expect(api.shapeBuilds).toBe(before + 1);
      }
      expect(values(cell).invariantBoundingSphere.ref.value).not.toEqual(firstBounds);
    } finally { cell.b.data.repr.destroy(); }
  });

  it('updates interactivity through full changes and retains it on subsequent uniform changes', async () => {
    const cell = await labelCell(api);
    try {
      for (const tooltip of ['Pick me', '']) {
        await updateLabel(api, cell, { tooltip });
        const before = api.shapeBuilds;
        await updateLabel(api, cell, { alpha: .4 });
        expect(api.shapeBuilds).toBe(before);
        expect(cell.b.data.repr.renderObjects[0].state.pickable).toBe(Boolean(tooltip));
        expect(cell.b.data.repr.state.pickable).toBe(Boolean(tooltip));
      }
    } finally { cell.b.data.repr.destroy(); }
  });

  it('runs real viewer staging: repaint, emphasis and tour preserve each single backed label without rebuilding', async () => {
    for (const scenario of ['viewer-appearance', 'viewer-selection', 'viewer-emphasize', 'viewer-tour']) {
      const workload = await viewerLabelWorkload();
      const cells = new Map(await Promise.all(workload.initial.map(async ([ref, props]) => [ref, await labelCell(api, undefined, props)] as const)));
      expect(cells.size).toBe(10);
      for (const [ref, cell] of cells) {
        expect(ref.endsWith('-backing')).toBe(true);
        expect(cell.b.data.repr.props).toMatchObject({ background: true, tether: false });
      }
      try {
        const staged = await workload.updates(scenario, 1);
        const before = api.shapeBuilds;
        for (const [ref, props] of staged) await updateLabel(api, cells.get(ref), props);
        const moving = scenario === 'viewer-emphasize' || scenario === 'viewer-tour';
        expect(staged.length).toBe(moving ? 10 : 0);
        expect(api.shapeBuilds - before).toBe(0);
        for (const [ref, cell] of cells) {
          // Every requested placement/paint value still reaches the real repr.
          const wanted = staged.find(([key]) => key === ref)?.[1];
          if (wanted) expect(cell.b.data.repr.props).toMatchObject(wanted);
        }
      } finally { cells.forEach(cell => cell.b.data.repr.destroy()); }
    }
  });

  it('fails closed for either upstream anchor and both production hook filters', async () => {
    for (const [suffix, patch, needle] of [
      ['loci/label.js', patchMolstarLabelUniformSource, 'ShapeRepresentation(getTextShape, Text.Utils)'],
      ['representation.js', patchMolstarShapeUniformSource, 'updateState.updateTransform || updateState.createGeometry'],
    ] as const) {
      const source = await readFile(new URL(`../node_modules/molstar/lib/mol-repr/shape/${suffix}`, import.meta.url), 'utf8');
      expect(patch(source)).not.toBe(source);
      const mutated = source.replace(needle, 'upstreamChanged');
      expect(() => patch(mutated)).toThrow('Stereofold uniform patch was not applied');
      const root = await mkdtemp(join(tmpdir(), 'stereofold-label-drift-'));
      const path = join(root, 'mol-repr/shape', suffix);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, mutated);
      await expect(build({ entryPoints: [path], bundle: true, write: false, plugins: [labelUniformUpdatePatch], logLevel: 'silent' })).rejects.toThrow('Stereofold uniform patch was not applied');
    }
  });
});
