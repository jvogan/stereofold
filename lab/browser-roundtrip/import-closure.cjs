'use strict';

// The lab build audits what esbuild bundled against a set of files it is
// allowed to bundle. That set used to be typed out by hand in build.cjs, so
// every added runtime module turned the next build into fifty
// `Unexpected runtime input` violations.
//
// The set is now read from the entry points themselves: walk their static
// import specifiers and keep only what resolves inside the lab tree. A new lab
// module reached from an entry point is therefore never a violation, and a file
// outside the lab tree is never added to the set no matter what imports it, so
// the guarantee the audit exists for is unchanged. The walk is deliberately
// independent of esbuild: it reads the sources, not the bundle.

const fs = require('node:fs/promises');
const path = require('node:path');

const SCRIPT_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);
// `import … from '…'` and `export … from '…'`; bare `import '…'`; `import('…')`.
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/gu,
  /\bimport\s+['"]([^'"\n]+)['"]/gu,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/gu,
];

const within = (parent, file) => file === parent || file.startsWith(`${parent}${path.sep}`);

function specifiers(source) {
  const found = [];
  for (const pattern of SPECIFIER_PATTERNS) for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

/**
 * Every file reachable from `entries` by a relative import, stopping at the
 * edge of `root`. Bare specifiers are left alone: they resolve under the
 * dependency root, which the audit checks separately. Files that do not exist
 * are skipped rather than guessed at — esbuild would fail on a broken import
 * long before the audit ran, and an input the walk misses stays a violation,
 * so the miss is reported instead of waved through.
 *
 * @param {{entries: string[], root: string}} options absolute paths.
 * @returns {Promise<string[]>} absolute paths, sorted, deduplicated by realpath.
 */
async function importClosure({ entries, root }) {
  const treeRoot = await fs.realpath(root);
  const seen = new Map();
  const queue = [...entries];
  while (queue.length) {
    const file = path.resolve(queue.shift());
    let real;
    try {
      real = await fs.realpath(file);
    } catch {
      continue;
    }
    if (!within(treeRoot, real) || seen.has(real)) continue;
    seen.set(real, file);
    if (!SCRIPT_EXTENSIONS.has(path.extname(real))) continue;
    const source = await fs.readFile(real, 'utf8');
    for (const specifier of specifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      queue.push(path.resolve(path.dirname(real), specifier));
    }
  }
  return [...seen.values()].sort();
}

/**
 * The audit's verdict on one bundled input: anything that is neither a
 * dependency nor one of the files the entry points reach is reported.
 *
 * @param {string} file realpath of a bundled input.
 * @param {{allowed: Set<string>, dependencyRoot: string}} options
 */
const isUnexpectedInput = (file, { allowed, dependencyRoot }) =>
  !within(dependencyRoot, file) && !allowed.has(file);

module.exports = { importClosure, isUnexpectedInput, within };
