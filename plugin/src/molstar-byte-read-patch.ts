import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

/**
 * Mol*'s Node helpers read bytes with `Blob.bytes()` and `Response.bytes()`.
 *
 * This package runs on any Node 22 (`engines` in package.json), and Node 22.0
 * has neither method: its `Blob` and its fetch `Response` offer
 * `arrayBuffer()`. A call to either helper there throws "is not a function",
 * so each is rewritten to the `arrayBuffer()` every supported Node has,
 * returning the same fresh `Uint8Array`.
 */
const BYTE_READS: readonly (readonly [string, string])[] = [
  ['this.blob.bytes()', 'this.blob.arrayBuffer().then(buffer => new Uint8Array(buffer))'],
  ['await response.bytes()', 'new Uint8Array(await response.arrayBuffer())'],
];

/** The Mol* files that read bytes that way, in both its ES module and CommonJS layouts. */
export const MOLSTAR_BYTE_READ_FILES = /molstar[/\\]lib[/\\](?:commonjs[/\\])?mol-util[/\\](?:nodejs-shims|data-source)\.js$/;

/**
 * One Mol* file with every known `.bytes()` read rewritten. Any other
 * `.bytes(` call left in it stops the build, so a Mol* upgrade that adds one
 * is read before it ships.
 */
export function patchMolstarByteReads(source: string): string {
  let patched = source;
  for (const [call, replacement] of BYTE_READS) patched = patched.split(call).join(replacement);
  if (/\.bytes\s*\(/u.test(patched)) {
    throw Error('Mol* reads bytes with a .bytes() call this patch does not know; Node 22.0 has no Blob.bytes() or Response.bytes().');
  }
  return patched;
}

/** Applied wherever Mol* is bundled, without changing the installed dependency. */
export const molstarByteReadBuildPatch: Plugin = {
  name: 'stereofold-molstar-byte-reads',
  setup(api) {
    api.onLoad({ filter: MOLSTAR_BYTE_READ_FILES }, async ({ path }) => ({ contents: patchMolstarByteReads(await readFile(path, 'utf8')), loader: 'js' }));
  },
};
