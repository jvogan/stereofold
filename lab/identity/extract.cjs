'use strict';

const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { resolve, basename } = require('node:path');
const { createCatalogExtractor } = require('./extract-core.cjs');

// The lab runs from the repository, whose Mol* installation belongs to the
// plugin workspace. The extraction algorithm itself has no resolver: see
// extract-core.cjs, which receives its dependencies explicitly so the bundled
// plugin can use static imports instead of a source-tree createRequire.
const fromPlugin = createRequire(resolve(__dirname, '../../plugin/package.json'));
const { CIF } = fromPlugin('molstar/lib/commonjs/mol-io/reader/cif.js');
const { trajectoryFromMmCIF } = fromPlugin('molstar/lib/commonjs/mol-model-formats/structure/mmcif.js');
const { Symmetry } = fromPlugin('molstar/lib/commonjs/mol-model/structure/model.js');

const { extractBytes } = createCatalogExtractor({
  CIF,
  trajectoryFromMmCIF,
  Symmetry,
  molstarVersion: fromPlugin('molstar/package.json').version,
  sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
});

async function extractFile(path, options = {}) {
  return extractBytes(await readFile(path), { sourceLabel: basename(path), ...options });
}

module.exports = { extractFile, extractBytes };
