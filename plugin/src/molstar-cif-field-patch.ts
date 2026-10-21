import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'esbuild';

/** Text-CIF factory backport from Mol* PR1943 (5.12), not a format rewrite. */
export function patchMolstarCifFieldSource(source: string, version: string): string {
  if (version !== '5.11.0') throw Error('Mol* CIF field compatibility requires the reviewed 5.11.0 source.');
  const anchor = '    return { rowCount, name, fieldNames: [...fieldNames], getField(name) { return fields[name]; } };';
  if (source.split(anchor).length !== 2) throw Error('Mol* CIF category anchor changed; field compatibility patch was not applied.');
  return source.replace(anchor, `    const normalizedFields = Object.create(null);
    for (const fieldName of fieldNames) {
        normalizedFields[fieldName.toLowerCase()] = fields[fieldName];
    }
    return {
        rowCount, name, fieldNames: [...fieldNames],
        getField(name) { return fields[name] ?? normalizedFields[name.toLowerCase()]; }
    };`);
}

/** Covers both lib/ and lib/commonjs/ without changing the installed dependency. */
export const cifFieldBuildPatch: Plugin = {
  name: 'stereofold-cif-field-case-compatibility',
  setup(api) {
    api.onLoad({ filter: /molstar[/\\]lib[/\\](?:commonjs[/\\])?mol-io[/\\]reader[/\\]cif[/\\]data-model\.js$/ }, async ({ path }) => {
      const commonjs = /[/\\]lib[/\\]commonjs[/\\]/.test(path);
      const { version } = JSON.parse(await readFile(resolve(dirname(path), commonjs ? '../../../../../package.json' : '../../../../package.json'), 'utf8'));
      return { contents: patchMolstarCifFieldSource(await readFile(path, 'utf8'), version), loader: 'js' };
    });
  },
};
