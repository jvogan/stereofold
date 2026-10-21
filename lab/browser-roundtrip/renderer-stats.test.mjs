import assert from 'node:assert/strict';
import test from 'node:test';
import { captureRendererStats } from './renderer-stats.mjs';

const object = (type = 'mesh', extras = {}) => ({ type, state: { visible: true, alphaFactor: 1 },
  values: Object.fromEntries(Object.entries({ drawCount: 6, instanceCount: 2, uVertexCount: 4, alpha: 1,
    dTransparency: false, transparencyAverage: 0, markerAverage: 0, ...extras }).map(([key, value]) => [key, { ref: { value } }])) });
const plugin = (objects, cells = []) => ({ canvas3d: { getRenderObjects: () => objects, reprCount: { value: cells.length } },
  state: { data: { cells: new Map(cells.map((cell, index) => [index, cell])) } } });

test('reports only live scalar geometry facts and known representation roles', () => {
  const mesh = object(), hidden = object('text'), masked = object('mesh', { dTransparency: true, transparencyAverage: 1, uTransparencyStrength: 1 });
  hidden.state.visible = false;
  const owner = { obj: { data: { repr: { state: { visible: true }, renderObjects: [mesh], geometryVersion: 7 } } },
    transform: { tags: ['stereofold-molecular-animation'] }, params: { values: { type: { name: 'cartoon', params: { quality: 'low' } } } } };
  const result = captureRendererStats(plugin([mesh, hidden, masked], [owner]));
  assert.equal(result.objectCount, 3); assert.equal(result.visibleObjects, 2);
  assert.equal(result.fullyMaskedObjects, 1); assert.equal(result.drawElements, 24);
  assert.deepEqual(result.byType, { mesh: 2, text: 1 });
  assert.deepEqual(result.byRole, { animation: 1, unowned: 2 });
  assert.deepEqual(result.objects[0].owner, { index: 0, role: 'animation', type: 'cartoon', quality: 'low', visible: true, hidden: false, geometryVersion: 7 });
  assert.equal(mesh.values.drawCount.ref.value, 6, 'diagnostics do not mutate renderer data');
});

test('does not export labels, source contents, arbitrary strings, matrices or buffers', () => {
  const secret = 'not-public-source-metadata';
  const mesh = object(secret, { aPosition: new Float32Array([1, 2, 3]), alpha: secret, dTransparencyType: secret });
  mesh.label = secret;
  const repr = { renderObjects: [mesh], state: { visible: true, transform: [secret] }, sourceData: secret };
  const cell = { obj: { label: secret, data: { repr, sourceData: secret } }, transform: { ref: secret, tags: [secret] },
    params: { values: { type: { name: secret, params: { quality: secret } } } } };
  const result = captureRendererStats(plugin([mesh], [cell]));
  assert.equal(result.objects[0].alpha, null);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(result), /aPosition|sourceData|transform|not-public/);
});

test('bounds the inventory and reports truncation without copying backing buffers', () => {
  const result = captureRendererStats(plugin(Array.from({ length: 3000 }, () => object())));
  assert.equal(result.objectCount, 3000); assert.equal(result.inspectedObjects, 2048);
  assert.equal(result.objects.length, 256); assert.equal(result.truncated, true);
});

test('is available only after a renderer exists and keeps masked facts distinct from draw claims', () => {
  assert.deepEqual(captureRendererStats(undefined), { available: false });
  const mesh = object('mesh', { dTransparency: true, transparencyAverage: 1, uTransparencyStrength: 1, markerAverage: 1 });
  const result = captureRendererStats(plugin([mesh]));
  assert.equal(result.objects[0].fullyMasked, true);
  assert.equal(result.objects[0].markerAverage, 1);
  assert.match(result.scope, /not a measured GPU submission/);
});

test('inherits component roles and keeps geometry metadata when paint cells share a representation', () => {
  for (const [tag, role] of [['stereofold-lesson-figure', 'figure'], ['stereofold-scoped-style', 'style']]) {
    const mesh = object(), repr = { state: { visible: true }, renderObjects: [mesh], geometryVersion: 5 };
    const geometry = { obj: { data: { repr } }, transform: { parent: 'component' },
      params: { values: { type: { name: 'cartoon', params: { quality: 'high' } } } } };
    const paint = { obj: { data: { repr } }, transform: { parent: 'geometry' }, params: { values: { layers: [] } } };
    for (const reverse of [false, true]) {
      const p = plugin([mesh]);
      p.state.data.cells = new Map([['component', { transform: { tags: [tag], parent: 'source' } }],
        ...(reverse ? [['paint', paint], ['geometry', geometry]] : [['geometry', geometry], ['paint', paint]])]);
      const result = captureRendererStats(p);
      assert.equal(result.inspectedRepresentations, 1);
      assert.deepEqual(result.objects[0].owner, { index: 0, role, type: 'cartoon', quality: 'high', visible: true, hidden: false, geometryVersion: 5 });
    }
  }
});
