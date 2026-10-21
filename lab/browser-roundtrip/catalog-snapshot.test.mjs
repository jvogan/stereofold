import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeOwnedSelectionCatalogAsync, snapshotSelectionCatalog } from './catalog-snapshot.mjs';

const catalog = () => ({ source: { sha256: 'a'.repeat(64) }, rows: Array.from({ length: 320 }, (_, i) => ({
  key: `residue-${i}`, atomSites: [{ identity: { sourceAtomId: String(i) }, coordinates: [i, 2, 3] }],
})) });

test('verified private wire catalog is frozen cooperatively and reused without a second clone', async () => {
  const input = catalog(), original = structuredClone(input);
  let turns = 0;
  const frozen = await freezeOwnedSelectionCatalogAsync(input, { budgetMs: 0,
    yieldTask: () => new Promise(resolve => setTimeout(() => { turns++; resolve(); }, 0)),
  });
  assert.ok(turns > 1);
  assert.equal(frozen, input);
  assert.equal(snapshotSelectionCatalog(frozen), frozen, 'brand is shared by the decoder and source snapshot path');
  assert.deepEqual(frozen, original);
  assert.throws(() => { frozen.rows[0].atomSites[0].coordinates[0] = 100; }, TypeError);
  assert.throws(() => { frozen.source.sha256 = 'b'.repeat(64); }, TypeError);
});

test('caller-owned or shallow-frozen catalogs are copied, isolated and never trusted as owned wire data', () => {
  const input = Object.freeze(catalog());
  const frozen = snapshotSelectionCatalog(input);
  assert.notEqual(frozen, input);
  input.rows[0].atomSites[0].coordinates[0] = 999;
  assert.equal(frozen.rows[0].atomSites[0].coordinates[0], 0);
  assert.throws(() => { frozen.rows[0].atomSites[0].identity.sourceAtomId = 'forged'; }, TypeError);
});

test('cancelled sealing never brands a partly frozen catalog for source reuse', async () => {
  const input = catalog();
  let cancelled = false;
  await assert.rejects(freezeOwnedSelectionCatalogAsync(input, { budgetMs: 0,
    yieldTask: async () => { cancelled = true; },
    check: () => { if (cancelled) throw Error('source replaced'); },
  }), /source replaced/);
  const isolated = snapshotSelectionCatalog(input);
  assert.notEqual(isolated, input);
  assert.throws(() => { isolated.rows[0].atomSites[0].coordinates[0] = 999; }, TypeError);
});
