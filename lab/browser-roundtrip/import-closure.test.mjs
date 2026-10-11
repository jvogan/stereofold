// The lab build's import audit (build.cjs) decides what the bundle is allowed
// to contain. It used to decide from a list typed out by hand, which went stale
// every time a runtime module was added: both lab builds
// exited 1 with fifty `Unexpected runtime input` violations naming files the
// entry points do import. The set is now the entry points' own import closure,
// restricted to the lab tree. These tests hold both halves of that: a lab
// module reached from an entry point is never a violation, and a file outside
// the lab tree is reported however it got into the bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const labRoot = path.resolve(here, '..');
const { importClosure, isUnexpectedInput } = createRequire(import.meta.url)('./import-closure.cjs');

test('a fabricated import from outside the tree stays out of the set and is reported', async () => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'stereofold-import-closure-'));
  try {
    const tree = path.join(root, 'lab');
    await fs.mkdir(path.join(tree, 'nested'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'outside.mjs'), 'export const outside = 1;\n');
    await fs.writeFile(path.join(tree, 'nested', 'deep.mjs'), 'export const deep = 1;\n');
    await fs.writeFile(path.join(tree, 'inside.mjs'), "export { deep } from './nested/deep.mjs';\n");
    await fs.writeFile(path.join(tree, 'entry.mjs'),
      "import { deep } from './inside.mjs';\nimport { outside } from '../outside.mjs';\nimport 'molstar/lib/mol-plugin/context';\nexport default [deep, outside];\n");

    const closure = await importClosure({ entries: [path.join(tree, 'entry.mjs')], root: tree });
    assert.deepEqual(closure.map(file => path.relative(tree, file)).sort(),
      ['entry.mjs', 'inside.mjs', path.join('nested', 'deep.mjs')].sort(),
      'the walk crosses the tree but never leaves it');

    const allowed = new Set(await Promise.all(closure.map(file => fs.realpath(file))));
    const dependencyRoot = await fs.realpath(path.join(root, 'node_modules'));
    assert.equal(isUnexpectedInput(await fs.realpath(path.join(root, 'outside.mjs')), { allowed, dependencyRoot }), true,
      'a fabricated import from outside the tree is still a violation');
    assert.equal(isUnexpectedInput(await fs.realpath(path.join(tree, 'nested', 'deep.mjs')), { allowed, dependencyRoot }), false);
    assert.equal(isUnexpectedInput(path.join(dependencyRoot, 'molstar', 'lib', 'index.js'), { allowed, dependencyRoot }), false,
      'a dependency is not a violation');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the lab entry points reach the modules the hand-written list had stopped naming', async () => {
  const closure = await importClosure({
    entries: [path.join(here, 'entry.mjs'), path.join(labRoot, 'inspection', 'entry.mjs')],
    root: labRoot,
  });
  const names = new Set(closure.map(file => path.relative(labRoot, file).split(path.sep).join('/')));
  // Five of the fifty files main reported as unexpected.
  for (const name of ['browser-roundtrip/structure-subject.mjs', 'browser-roundtrip/menu-view-band.mjs',
    'browser-roundtrip/quest-exit-banner.mjs', 'inspection/named-view.mjs', 'inspection/workspace.mjs']) {
    assert.ok(names.has(name), `${name} is reached from an entry point: ${[...names].sort().join(' ')}`);
  }
  // Both stylesheets ride along, because the entry points import them.
  assert.ok(names.has('browser-roundtrip/style.css') && names.has('inspection/style.css'));
  // Nothing outside the lab tree enters the set, fixtures and node_modules included.
  for (const file of closure) assert.ok(file.startsWith(`${labRoot}${path.sep}`), file);
});
