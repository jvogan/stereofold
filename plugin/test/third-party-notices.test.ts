import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Metafile } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { generateThirdPartyNotices } from '../scripts/third-party-notices.js';

function metafile(inputPaths: readonly string[]): Metafile {
  const inputs: Record<string, { bytes: number; imports: []; format: 'esm' }> = {};
  for (const path of inputPaths) inputs[path] = { bytes: 1, imports: [], format: 'esm' };
  return { inputs, outputs: {} } as unknown as Metafile;
}

async function writePackage(root: string, name: string, version: string, licenseText: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version, license: 'MIT' }));
  await writeFile(join(root, 'LICENSE'), licenseText);
  await writeFile(join(root, 'index.js'), '// entry\n');
}

/**
 * generateThirdPartyNotices also reads the embedded-font OFL notices from
 * `<pluginRoot>/../lab/inspection/fonts`. Fixtures
 * live under a per-test temp root, so nest the fake plugin root one level
 * down and provide those files alongside it.
 */
async function fixtureRoot(): Promise<{ workDir: string; pluginRoot: string }> {
  const workDir = await mkdtemp(join(tmpdir(), 'notices-fixture-'));
  const pluginRoot = join(workDir, 'plugin');
  await mkdir(pluginRoot, { recursive: true });
  const fontsDir = join(workDir, 'lab/inspection/fonts');
  await mkdir(fontsDir, { recursive: true });
  await writeFile(join(fontsDir, 'SourceSans3-OFL.txt'), 'Source Sans 3 OFL text\n');
  await writeFile(join(fontsDir, 'IBMPlexMono-OFL.txt'), 'IBM Plex Mono OFL text\n');
  return { workDir, pluginRoot };
}

describe('generateThirdPartyNotices package identity', () => {
  const cleanups: string[] = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  it('covers all four runtime bundles and includes host-only dependency notices', async () => {
    const { workDir, pluginRoot } = await fixtureRoot();
    cleanups.push(workDir);
    const bundles = ['viewer.html', 'inspector.html', 'inspector-host.js', 'server.mjs'];
    const metafiles = await Promise.all(bundles.map(async (bundle, index) => {
      const name = `bundle-dependency-${index}`;
      await writePackage(join(pluginRoot, 'node_modules', name), name, '1.0.0', `${bundle} dependency license\n`);
      return metafile([`node_modules/${name}/index.js`]);
    }));
    const notices = await generateThirdPartyNotices(pluginRoot, metafiles);
    for (const bundle of bundles) {
      expect(notices, `${bundle} coverage`).toContain(`\`dist/${bundle}\``);
      expect(notices).toContain(`${bundle} dependency license`);
    }
  });

  it('treats two separate roots with byte-identical package content as one entry', async () => {
    const { workDir, pluginRoot } = await fixtureRoot();
    cleanups.push(workDir);

    // pnpm can give a dependency's own nested resolution a separate
    // hardlinked copy of the same store package rather than a symlink, so
    // two genuinely distinct on-disk roots end up with identical content:
    // node_modules/.pnpm/immutable@5.1.9/node_modules/immutable and
    // molstar's own nested node_modules/immutable, both name@5.1.9 with the
    // same package.json and LICENSE text but no filesystem link between them.
    const rootA = join(pluginRoot, 'node_modules/.pnpm/immutable@5.1.9/node_modules/immutable');
    await writePackage(rootA, 'immutable', '5.1.9', 'immutable license text\n');

    const rootB = join(pluginRoot, 'node_modules/.pnpm/molstar@1/node_modules/molstar/node_modules/immutable');
    await writePackage(rootB, 'immutable', '5.1.9', 'immutable license text\n');

    const inputs = metafile([
      'node_modules/.pnpm/immutable@5.1.9/node_modules/immutable/index.js',
      'node_modules/.pnpm/molstar@1/node_modules/molstar/node_modules/immutable/index.js',
    ]);

    const notices = await generateThirdPartyNotices(pluginRoot, [inputs]);
    const occurrences = notices.split('immutable license text').length - 1;
    expect(occurrences).toBe(1);
    expect(notices.match(/## immutable 5\.1\.9/gu)).toHaveLength(1);
  });

  it('still throws when the same identity resolves to two roots with genuinely different license text', async () => {
    const { workDir, pluginRoot } = await fixtureRoot();
    cleanups.push(workDir);

    const rootA = join(pluginRoot, 'node_modules/.pnpm/immutable@5.1.9/node_modules/immutable');
    await writePackage(rootA, 'immutable', '5.1.9', 'root A license text\n');

    const rootB = join(pluginRoot, 'node_modules/.pnpm/molstar@1/node_modules/molstar/node_modules/immutable');
    await writePackage(rootB, 'immutable', '5.1.9', 'root B license text\n');

    const inputs = metafile([
      'node_modules/.pnpm/immutable@5.1.9/node_modules/immutable/index.js',
      'node_modules/.pnpm/molstar@1/node_modules/molstar/node_modules/immutable/index.js',
    ]);

    await expect(generateThirdPartyNotices(pluginRoot, [inputs]))
      .rejects.toThrow('Bundled package identity resolves to multiple roots: immutable@5.1.9');
  });
});
