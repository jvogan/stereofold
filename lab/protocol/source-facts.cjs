'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { extractBytes } = require('../identity/extract.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const corpus = JSON.parse(readFileSync(resolve(__dirname, '../../fixtures/voice-cases.json'), 'utf8'));
const pinned = new Set(Object.values(corpus.fixtureDefinitions).map(fixture => fixture.sha256));

// The compact ID references a complete key in the extracted identity table.
function selectionId(row) { return hash(row.key); }

async function inspectPinnedSource(bytes) {
  const sha256 = hash(bytes);
  if (!pinned.has(sha256)) throw new Error('The protocol experiment accepts only the four pinned public/synthetic fixtures.');
  const models = new Map();
  for (const assemblyId of ['asymmetric_unit', '1']) {
    const extracted = await extractBytes(bytes, { expectedHash: sha256, assemblyId });
    for (const modelNumber of extracted.modelNumbers) {
      const model = models.get(modelNumber) ?? { modelNumber, assemblies: [] };
      const rows = extracted.rows.filter(row => row.identity.modelNumber === modelNumber);
      model.assemblies.push({ assemblyId, selectionKeys: rows.map(selectionId) });
      models.set(modelNumber, model);
    }
  }
  return { sha256, byteLength: bytes.length, models: [...models.values()] };
}

module.exports = { selectionId, inspectPinnedSource };
