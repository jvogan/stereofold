import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { sha256 } from './contracts.mjs';
import { Receiver } from './receiver.mjs';
import { Transfer } from './transfer.mjs';
const require = createRequire(import.meta.url);
const { extractBytes } = require('../identity/extract.cjs');
const { inspectPinnedSource, selectionId } = require('./source-facts.cjs');

const fixture = new URL('../../fixtures/identity-edge.cif', import.meta.url);
const bytes = await readFile(fixture);
const extracted = await extractBytes(bytes, { assemblyId: '1' });
const unresolved = extracted.rows.find(row => row.identity.modelNumber === 2 && row.identity.labelChain === 'A'
  && row.identity.labelSequenceId === 3 && row.identity.operatorIds.join(',') === '2');
assert.ok(unresolved && unresolved.atomSites.length === 0);

function setup(changes = {}) {
  const receiver = new Receiver({ clock: () => 100,
    target: { bindingId: 'binding-a', taskId: 'task-a', panelId: 'panel-a', sessionId: 'session-a', deviceId: 'quest-a' },
    serverEpoch: 'server-a', receiverEpoch: 'receiver-a', leaseId: 'lease-a', actors: ['codex-a'],
    policy: { inactivityMs: 1_800_000, leaseMs: 60_000, maxCommands: 8 },
    scene: { sceneId: 'original', sourceSha256: '0'.repeat(64), revision: 0 } });
  const transfer = new Transfer({ receiver,
    limits: { maxSourceBytes: 70_000, maxChunkBytes: 4096, maxSelectionKeys: 128 }, inspectSource: inspectPinnedSource });
  const manifest = { version: 1, sceneId: 'edge-model2', privacy: 'public',
    source: { format: 'mmcif', sha256: sha256(bytes), byteLength: bytes.length }, modelNumber: 2,
    assemblyId: '1', representation: 'cartoon', color: 'chain-id', selectionKeys: [selectionId(unresolved)],
    view: { centerAngstrom: [0, 0, 0], orientation: [0, 0, 0, 1], radiusAngstrom: 12 }, ...changes };
  const attempt = transfer.begin(manifest).attemptId;
  transfer.append(attempt, 0, bytes);
  return { receiver, transfer, attempt };
}

test('S01 real Mol* facts preserve model 2, assembly 1 and an unresolved sequence selection', async () => {
  const { receiver, transfer, attempt } = setup();
  await transfer.prepare(attempt);
  assert.equal(receiver.inspect().state.sceneId, 'original');
  transfer.commit(attempt);
  const result = receiver.inspect().state.manifest;
  assert.equal(result.source.sha256, '1a70440ac7b729a3a99abe5b5f89e3894c32daebc35f15f0842117b909db130c');
  assert.equal(result.modelNumber, 2);
  assert.equal(result.assemblyId, '1');
  assert.deepEqual(result.selectionKeys, [selectionId(unresolved)]);
  assert.equal(unresolved.coordinateState, 'unresolved');
  assert.deepEqual(unresolved.atomSites, []);
});

for (const [name, changes, reason] of [
  ['model', { modelNumber: 3 }, 'model_unavailable'],
  ['assembly', { assemblyId: 'missing' }, 'assembly_unavailable'],
  ['selection', { selectionKeys: ['0'.repeat(64)] }, 'selection_unavailable'],
  ['selection from another model', { modelNumber: 1 }, 'selection_unavailable'],
  ['selection from another assembly', { assemblyId: 'asymmetric_unit' }, 'selection_unavailable'],
]) {
  test(`S02 a valid source hash does not authorize a wrong ${name}`, async () => {
    const { receiver, transfer, attempt } = setup(changes);
    await assert.rejects(transfer.prepare(attempt), error => error.code === reason);
    assert.equal(receiver.inspect().state.sceneId, 'original');
  });
}

test('S03 parser adapter rejects bytes outside the pinned experiment', async () => {
  await assert.rejects(inspectPinnedSource(Buffer.from('unlisted source')), /four pinned/);
});

test('S04 public 1CRN facts retain all 46 residue selections', async () => {
  const bytes = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url));
  const result = await inspectPinnedSource(bytes);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].modelNumber, 1);
  assert.equal(result.models[0].assemblies.find(a => a.assemblyId === '1').selectionKeys.length, 46);
});
