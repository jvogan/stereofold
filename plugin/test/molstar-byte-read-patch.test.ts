import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOLSTAR_BYTE_READ_FILES, molstarByteReadBuildPatch, patchMolstarByteReads } from '../src/molstar-byte-read-patch.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const molstarLib = fileURLToPath(new URL('../node_modules/molstar/lib', import.meta.url));

/** The two Mol* helpers, bundled the way the shipped builds bundle them, with or without the patch. */
async function helpers(layout: 'lib' | 'lib/commonjs', patched: boolean) {
  const result = await build({
    stdin: { contents: `export { File_ } from 'molstar/${layout}/mol-util/nodejs-shims.js';
      export { ajaxGet } from 'molstar/${layout}/mol-util/data-source.js';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: patched ? [molstarByteReadBuildPatch] : [], logLevel: 'silent',
  });
  const module = { exports: {} as any };
  new Function('module', 'exports', 'require', result.outputFiles[0]!.text)(module, module.exports, require);
  return module.exports;
}

/** Node 22.0 for the length of one call: its Blob has no `bytes()`. */
async function onNode22_0<T>(body: () => Promise<T>): Promise<T> {
  const saved = Object.getOwnPropertyDescriptor(Blob.prototype, 'bytes');
  delete (Blob.prototype as { bytes?: unknown }).bytes;
  try { return await body(); } finally { if (saved) Object.defineProperty(Blob.prototype, 'bytes', saved); }
}

/** Node 22.0's fetch answer: a response that has `arrayBuffer()` and no `bytes()`. */
const fetchWithoutBytes = (text: string) => vi.fn(async () => ({ status: 200, arrayBuffer: async () => new TextEncoder().encode(text).buffer }));

function libFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? libFiles(join(directory, entry.name)) : entry.name.endsWith('.js') ? [join(directory, entry.name)] : []);
}

afterEach(() => vi.unstubAllGlobals());

describe('Mol* byte reads on every Node 22', () => {
  it.each(['lib', 'lib/commonjs'] as const)('reads a file and a download through arrayBuffer in the %s layout', async layout => {
    const stock = await helpers(layout, false), fixed = await helpers(layout, true);
    vi.stubGlobal('fetch', fetchWithoutBytes('downloaded text'));
    await onNode22_0(async () => {
      // Unpatched, both helpers stop with "is not a function" on Node 22.0.
      await expect(Promise.resolve().then(() => new stock.File_(['abc'], 'a.txt').bytes())).rejects.toThrow(/bytes is not a function/u);
      await expect(stock.ajaxGet({ url: 'https://downloads.invalid/a.cif', type: 'string' }).run()).rejects.toThrow(/bytes is not a function/u);
      // Patched, the same calls return the same bytes.
      const bytes = await new fixed.File_(['abc'], 'a.txt').bytes();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(bytes)).toEqual([97, 98, 99]);
      expect(await fixed.ajaxGet({ url: 'https://downloads.invalid/a.cif', type: 'string' }).run()).toBe('downloaded text');
    });
  });

  it('covers every .bytes() read in the installed Mol*, and stops the build on one it does not know', () => {
    const readers = libFiles(molstarLib).filter(path => /\.bytes\s*\(/u.test(readFileSync(path, 'utf8')));
    expect(readers.length).toBeGreaterThan(0);
    for (const path of readers) {
      expect(path, `${path} reads bytes but is not patched`).toMatch(MOLSTAR_BYTE_READ_FILES);
      expect(patchMolstarByteReads(readFileSync(path, 'utf8'))).not.toMatch(/\.bytes\s*\(/u);
    }
    expect(() => patchMolstarByteReads('const data = await blob.bytes();')).toThrow(/Node 22\.0 has no Blob\.bytes\(\) or Response\.bytes\(\)/u);
    // A file with nothing to rewrite passes through untouched.
    expect(patchMolstarByteReads('export const x = 1;')).toBe('export const x = 1;');
  });

  it('is applied wherever a shipped bundle includes Mol*', () => {
    const source = readFileSync(new URL('../scripts/build.ts', import.meta.url), 'utf8');
    const bundles = [...source.matchAll(/plugins\s*:\s*\[\s*cifFieldBuildPatch\b/gu)].length;
    expect(bundles).toBe(4);
    expect([...source.matchAll(/plugins\s*:\s*\[\s*cifFieldBuildPatch\s*,\s*molstarByteReadBuildPatch\b/gu)]).toHaveLength(bundles);
  });
});
