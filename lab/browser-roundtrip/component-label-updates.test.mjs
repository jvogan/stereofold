import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Task } from 'molstar/lib/mol-task/index.js';
import { Text } from 'molstar/lib/mol-geo/geometry/text/text.js';
import { TextBuilder } from 'molstar/lib/mol-geo/geometry/text/text-builder.js';
import { LabelRepresentation, LabelParams } from 'molstar/lib/mol-repr/shape/loci/label.js';
import * as plates from './component-labels.mjs';

test('Mol* 5.11 selection-label uniform edits also rebuild shape geometry and bump the atlas', async () => {
  const source = readFileSync(new URL(import.meta.resolve('molstar/lib/mol-plugin-state/transforms/representation.js')), 'utf8');
  const start = source.indexOf('    update(', source.indexOf('const StructureSelectionsLabel3D ='));
  const end = source.indexOf('\n    },', start) + 6;
  // Run the installed transformer update and actual LabelRepresentation. Only
  // rasterising fonts into a DOM canvas is replaced by an empty text geometry.
  const update = new Function('Task', 'getLabelDataFromStructureSelections', 'MarkerActions',
    'MarkerAction', 'StateTransformer', `return ({${source.slice(start, end)}}).update;`)(
    Task, () => ({ infos: [] }), { Highlighting: 1 }, { None: 0 }, { UpdateResult: { Updated: 'updated' } });
  const create = TextBuilder.create;
  let builds = 0, text;
  TextBuilder.create = (_props, _initial, _chunk, previous) => ({ add() {}, getText() {
    builds++; text = Text.createEmpty(previous); return text;
  } });
  const repr = LabelRepresentation({}, () => LabelParams);
  try {
    await repr.createOrUpdate({}, { infos: [] }).run();
    const b = { data: { repr } };
    for (const patch of [{ offsetX: 1 }, { sizeFactor: 2 }, { alpha: 0.5 },
      { backgroundOpacity: 0.5 }, { tetherLength: 3 }]) {
      const beforeBuilds = builds, beforeAtlas = text.fontTexture.ref.version;
      await update({ a: { data: [] }, b, oldParams: repr.props, newParams: patch }, {}).run();
      assert.equal(builds, beforeBuilds + 1, JSON.stringify(patch));
      assert.equal(text.fontTexture.ref.version, beforeAtlas + 1, 'Text.update bumps the atlas cell');
    }
  } finally {
    repr.destroy();
    TextBuilder.create = create;
  }
});

test('leader tolerance converts half a projected pixel to Mol* mapping units', () => {
  const still = plates.componentLabelStillUnits(4, 3000);
  const committed = { tetherLength: 1, sizeFactor: 0.1 };
  assert.equal(plates.componentLabelLayerChanged(committed,
    { ...committed, tetherLength: 1 + 0.4 / 750 / 0.1 }, still), false);
  assert.equal(plates.componentLabelLayerChanged(committed,
    { ...committed, tetherLength: 1 + 3 / 750 / 0.1 }, still), true);
});


test('plate-update geometry is false for a no-op and true for an opacity shape commit', () => {
  const staged = plates.stageComponentLabelLayers({ committed: () => ({ alpha: 1 }),
    updates: { to: () => ({ update() {} }) }, now: () => 0 });
  staged.stage('plate', { alpha: 1 });
  assert.equal(staged.detail('repaint').geometry, false);
  staged.stage('plate', { alpha: 0.5 });
  assert.equal(staged.detail('repaint').geometry, true);
  assert.equal(staged.detail('repaint').changed, 1);
});
