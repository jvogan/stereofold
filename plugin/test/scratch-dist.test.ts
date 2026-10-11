import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isScratchDist, planScratchDist, prepareScratchDist, readDistEntries, scratchDistMarker,
  SCRATCH_DIST_MARKER } from '../scripts/scratch-dist.js';

const made: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-scratch-'));
  made.push(root);
  return root;
}
afterEach(async () => { for (const root of made.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('planScratchDist', () => {
  it('creates a directory that is not there', () => {
    expect(planScratchDist('/tmp/absent', undefined)).toEqual({ action: 'create' });
  });

  it('replaces an empty directory', () => {
    expect(planScratchDist('/tmp/empty', [])).toEqual({ action: 'replace', reason: 'empty' });
  });

  it('replaces a directory this build marked as its own', () => {
    expect(planScratchDist('/tmp/dist', [SCRATCH_DIST_MARKER, 'viewer.html'])).toEqual({ action: 'replace', reason: 'marked' });
  });

  it('refuses a directory that merely looks like a dist', () => {
    // The old rule deleted anything holding viewer.html or server.mjs, which
    // is a test a checkout of any web project passes. --out at a source tree
    // would have taken the tree with it.
    expect(() => planScratchDist('/work/site', ['viewer.html', 'src', 'package.json']))
      .toThrow(/Refusing to delete \/work\/site/);
    expect(() => planScratchDist('/work/site', ['server.mjs'])).toThrow(new RegExp(SCRATCH_DIST_MARKER));
  });

  it('refuses someone else\'s home directory rather than emptying it', () => {
    expect(() => planScratchDist('/home/example', ['Documents', 'Desktop', 'Downloads']))
      .toThrow(/Build into a new or empty directory/);
  });
});

describe('prepareScratchDist', () => {
  it('marks the directory it creates, so the next build may replace it', async () => {
    const root = await temporaryRoot();
    const dist = resolve(root, 'dist');
    expect(await prepareScratchDist(dist)).toEqual({ action: 'create' });
    expect(await isScratchDist(dist)).toBe(true);
    expect(JSON.parse(await readFile(resolve(dist, SCRATCH_DIST_MARKER), 'utf8')).tool).toBe('stereofold-build');
  });

  it('empties its own output on the second run', async () => {
    const root = await temporaryRoot();
    const dist = resolve(root, 'dist');
    await prepareScratchDist(dist);
    await writeFile(resolve(dist, 'viewer.html'), 'old');
    expect(await prepareScratchDist(dist)).toEqual({ action: 'replace', reason: 'marked' });
    expect(await readdir(dist)).toEqual([SCRATCH_DIST_MARKER]);
  });

  it('leaves a directory it did not create exactly as it found it', async () => {
    const root = await temporaryRoot();
    const dist = resolve(root, 'someone-elses-work');
    await mkdir(resolve(dist, 'src'), { recursive: true });
    await writeFile(resolve(dist, 'viewer.html'), 'a real page');
    await expect(prepareScratchDist(dist)).rejects.toThrow(/Refusing to delete/);
    expect((await readdir(dist)).sort()).toEqual(['src', 'viewer.html']);
    expect(await readFile(resolve(dist, 'viewer.html'), 'utf8')).toBe('a real page');
  });

  it('reports an absent directory as nothing rather than throwing', async () => {
    const root = await temporaryRoot();
    expect(await readDistEntries(resolve(root, 'nowhere'))).toBeUndefined();
  });

  it('writes a marker that carries no secret', () => {
    const marker = JSON.parse(scratchDistMarker({ at: '2026-09-11T00:00:00.000Z', buildId: 'abc' }));
    expect(marker).toEqual({ tool: 'stereofold-build', at: '2026-09-11T00:00:00.000Z', buildId: 'abc' });
  });
});

describe('build.ts wiring', () => {
  it('routes the scratch delete through the guard and leaves plugin/dist alone', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../scripts/build.ts'), 'utf8');
    expect(source).toMatch(/if \(scratchDist\) await prepareScratchDist\(distRoot\);/);
    // The old guess, which any directory holding one of these two names passed.
    expect(source).not.toMatch(/existing\.includes\('viewer\.html'\)/);
  });
});
