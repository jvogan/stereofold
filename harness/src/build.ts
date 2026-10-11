import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('../dist/', import.meta.url));
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [fileURLToPath(new URL('./host-bridge.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: fileURLToPath(new URL('../dist/host-bridge.js', import.meta.url)),
  sourcemap: false,
  legalComments: 'none',
});

console.log(`Built ${root}dist/host-bridge.js`);
