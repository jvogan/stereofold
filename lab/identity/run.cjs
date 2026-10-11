#!/usr/bin/env node
'use strict';

const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { extractFile } = require('./extract.cjs');
const { resolveIdentity } = require('./identity.cjs');

const fixtureDirectory = resolve(__dirname, '../../fixtures');

async function loadFixtureCatalogs() {
  const corpus = JSON.parse(await readFile(resolve(fixtureDirectory, 'voice-cases.json'), 'utf8'));
  const catalogs = {};
  for (const [name, fixture] of Object.entries(corpus.fixtureDefinitions)) {
    catalogs[name] = await extractFile(resolve(fixtureDirectory, fixture.bytesPath), {
      expectedHash: fixture.sha256, assemblyId: '1',
    });
  }
  return catalogs;
}

async function main() {
  const catalogs = await loadFixtureCatalogs();
  const edge = catalogs.identity_edge;
  const copy = edge.copies.find(c => c.modelNumber === 1 && c.operatorIds.join(',') === '1');
  const scoped = { sourceHash: edge.source.sha256, modelNumber: 1, copyId: copy.copyId, chain: { namespace: 'label', id: 'A' } };
  const unresolved = resolveIdentity(edge.rows, { ...scoped, residue: { namespace: 'label', number: 3 } });
  const alternate = resolveIdentity(edge.rows, { ...scoped, residue: { namespace: 'label', number: 2 }, atom: { name: 'CA' } });
  console.log(JSON.stringify({
    status: 'draft_experiment',
    fixtures: Object.entries(catalogs).map(([name, c]) => ({ name, source: c.source, assemblyId: c.assemblyId,
      modelNumbers: c.modelNumbers, residueInstances: c.rows.length,
      atomInstances: c.rows.reduce((sum, row) => sum + row.atomSites.length, 0),
      unresolvedSequenceInstances: c.rows.filter(row => row.coordinateState === 'unresolved').length })),
    examples: {
      missingCoordinates: { status: unresolved.status, identity: unresolved.residue.identity, positionAngstrom: unresolved.positionAngstrom },
      alternateSite: { status: alternate.status, alternatives: alternate.candidates.map(c => c.identity.alternateSite) },
      nonPolymerSequenceId: catalogs.synthetic_ligand.rows.find(r => r.identity.componentId === 'LIG1').identity.labelSequenceId,
    },
  }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { fixtureDirectory, loadFixtureCatalogs };
