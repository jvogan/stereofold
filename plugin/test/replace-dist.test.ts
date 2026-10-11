import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { distSiblings, replaceDistAfter } from '../scripts/replace-dist.js';

const made: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-replace-dist-'));
  made.push(root);
  return root;
}
afterEach(async () => { for (const root of made.splice(0)) await rm(root, { recursive: true, force: true }); });

async function servedDist(root: string): Promise<string> {
  const dist = resolve(root, 'dist');
  await mkdir(resolve(dist, 'molstar'), { recursive: true });
  await writeFile(resolve(dist, 'server.mjs'), 'old server');
  await writeFile(resolve(dist, 'molstar/molstar.js'), 'old molstar');
  return dist;
}

describe('replaceDistAfter', () => {
  it('leaves the served dist as it was when the build throws', async () => {
    // The old build deleted plugin/dist first, so a fresh clone whose build
    // could not resolve a workspace package lost the runtime it shipped with.
    const root = await temporaryRoot();
    const dist = await servedDist(root);
    await expect(replaceDistAfter(dist, async (outRoot) => {
      await writeFile(resolve(outRoot, 'server.mjs'), 'half a build');
      throw new Error('Could not resolve "@stereo/geometry"');
    })).rejects.toThrow('@stereo/geometry');
    expect(await readFile(resolve(dist, 'server.mjs'), 'utf8')).toBe('old server');
    expect(await readFile(resolve(dist, 'molstar/molstar.js'), 'utf8')).toBe('old molstar');
    expect((await readdir(root)).sort()).toEqual(['dist']);
  });

  it('swaps in the new dist only once the build resolves', async () => {
    const root = await temporaryRoot();
    const dist = await servedDist(root);
    await replaceDistAfter(dist, async (outRoot) => {
      // The target is still the old one while the build runs.
      expect(await readFile(resolve(dist, 'server.mjs'), 'utf8')).toBe('old server');
      await writeFile(resolve(outRoot, 'server.mjs'), 'new server');
    });
    expect(await readdir(dist)).toEqual(['server.mjs']);
    expect(await readFile(resolve(dist, 'server.mjs'), 'utf8')).toBe('new server');
    expect((await readdir(root)).sort()).toEqual(['dist']);
  });

  it('builds into an empty sibling at the target\'s depth', async () => {
    const root = await temporaryRoot();
    const dist = await servedDist(root);
    let seen: { outRoot: string; entries: string[] } | undefined;
    await replaceDistAfter(dist, async (outRoot) => { seen = { outRoot, entries: await readdir(outRoot) }; });
    expect(seen).toEqual({ outRoot: distSiblings(dist).next, entries: [] });
    expect(dirname(seen!.outRoot)).toBe(dirname(dist));
  });

  it('creates the dist when there was none', async () => {
    const root = await temporaryRoot();
    const dist = resolve(root, 'dist');
    await replaceDistAfter(dist, async (outRoot) => { await writeFile(resolve(outRoot, 'viewer.html'), 'page'); });
    expect(await readdir(dist)).toEqual(['viewer.html']);
  });

  it('clears what an interrupted build left in either sibling', async () => {
    const root = await temporaryRoot();
    const dist = await servedDist(root);
    const { next, previous } = distSiblings(dist);
    await mkdir(next);
    await writeFile(resolve(next, 'stale.js'), 'from a killed build');
    await mkdir(previous);
    await writeFile(resolve(previous, 'server.mjs'), 'two builds ago');
    await replaceDistAfter(dist, async (outRoot) => { await writeFile(resolve(outRoot, 'server.mjs'), 'new server'); });
    expect(await readdir(dist)).toEqual(['server.mjs']);
    expect((await readdir(root)).sort()).toEqual(['dist']);
  });
});

describe('build.ts wiring', () => {
  it('replaces plugin/dist through the swap instead of deleting it first', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../scripts/build.ts'), 'utf8');
    expect(source).toMatch(/else await replaceDistAfter\(distRoot, emit\);/);
    expect(source).not.toMatch(/await rm\(distRoot/);
  });

  it('keeps the siblings out of git', async () => {
    const ignore = await readFile(resolve(import.meta.dirname, '../.gitignore'), 'utf8');
    const { next, previous } = distSiblings(resolve(import.meta.dirname, '../dist'));
    for (const sibling of [next, previous]) expect(ignore).toContain(`/${basename(sibling)}/`);
  });
});
