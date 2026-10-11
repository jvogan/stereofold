import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Build-only adaptation of the pinned state updater. Cancellation still goes
 * through doError and Mol*'s normal state rollback; only its console severity
 * differs from a failed transform. Do not classify by reason/message text. */
export function patchMolstarStateAbortSource(source, version) {
  if (version !== '5.11.0') throw Error('Mol* state abort logging requires the reviewed 5.11.0 source.');
  const start = 'async function updateSubtree(ctx, root) {';
  const end = 'function resolveParams(ctx, transform, src, cell) {';
  const original = '        doError(ctx, root, e, false);\n        console.error(e);\n        return;';
  if (source.split(start).length !== 2 || source.split(end).length !== 2
    || !source.includes("import { Task } from '../mol-task/index.js';")) {
    throw Error('Mol* state updater boundaries/import changed; abort logging patch was not applied.');
  }
  const from = source.indexOf(start), to = source.indexOf(end, from);
  const subtree = source.slice(from, to);
  if (to <= from || subtree.split(original).length !== 2) {
    throw Error('Mol* state updater catch changed; abort logging patch was not applied.');
  }
  return source.slice(0, from) + subtree.replace(original,
    '        doError(ctx, root, e, false);\n        if (Task.isAbort(e))\n            console.info(e);\n        else\n            console.error(e);\n        return;') + source.slice(to);
}

/** The optional callback lets audited lab builds record both original and
 * transformed bytes instead of pretending that the dependency was unchanged. */
export function stateAbortLoggingPatch(onPatched) {
  return {
    name: 'stereofold-molstar-state-abort-logging',
    setup(api) {
      let patched = 0;
      api.onStart(() => { patched = 0; });
      api.onLoad({ filter: /molstar[/\\]lib[/\\]mol-state[/\\]state\.js$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const { version } = JSON.parse(await readFile(resolve(dirname(path), '../../package.json'), 'utf8'));
        const contents = patchMolstarStateAbortSource(source, version);
        patched++;
        onPatched?.({ path, source, contents, version });
        return { contents, loader: 'js' };
      });
      api.onEnd(result => {
        if (!result.errors.length && patched !== 1) {
          return { errors: [{ text: `Expected exactly one pinned Mol* state updater; patched ${patched}.` }] };
        }
      });
    },
  };
}
