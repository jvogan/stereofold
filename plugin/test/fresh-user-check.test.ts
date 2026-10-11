import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertFreshRuntime } from '../scripts/fresh-user-check.js';

it('rejects a fresh-user tree missing only inspector-host.js', async () => {
  const artifact = await mkdtemp(join(tmpdir(), 'stereofold-fresh-runtime-'));
  await mkdir(join(artifact, 'dist'));
  for (const file of ['server.mjs', 'viewer.html', 'inspector.html', 'inspector.css']) {
    await writeFile(join(artifact, 'dist', file), 'built');
  }
  await expect(assertFreshRuntime(artifact), 'missing inspector host blocks fresh-user check')
    .rejects.toThrow('the artifact is missing dist/inspector-host.js');
  await writeFile(join(artifact, 'dist/inspector-host.js'), 'built');
  await expect(assertFreshRuntime(artifact)).resolves.toBeUndefined();
});
