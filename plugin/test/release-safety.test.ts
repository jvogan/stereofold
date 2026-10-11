import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const pluginDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const directoryHelper = resolve(pluginDirectory, 'scripts/safe-directory-swap.py');

function releaseArguments(pluginRoot: string): string[] {
  return [
    directoryHelper,
    'release',
    '--source', pluginRoot,
    '--expected-source', pluginRoot,
    '--target', resolve(pluginRoot, 'release/stereofold'),
    '--expected-target', resolve(pluginRoot, 'release/stereofold'),
    '--entry', '.codex-plugin',
    '--entry', 'README.md',
  ];
}

describe('release staging safety', () => {
  it('rejects symlinked release parents and targets without touching their referents', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-release-safety-')));
    const pluginRoot = resolve(temporaryRoot, 'plugin');
    const victim = resolve(temporaryRoot, 'victim');
    await mkdir(pluginRoot);
    await mkdir(resolve(pluginRoot, '.codex-plugin'));
    await writeFile(resolve(pluginRoot, '.codex-plugin/plugin.json'), '{"name":"stereofold","version":"0.1.0"}\n');
    await mkdir(victim);
    await writeFile(resolve(victim, 'keep.txt'), 'untouched');

    try {
      await symlink(victim, resolve(pluginRoot, 'release'));
      await expect(execFileAsync('python3', releaseArguments(pluginRoot))).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('symlinked release parent'),
      });
      expect(await readFile(resolve(victim, 'keep.txt'), 'utf8')).toBe('untouched');

      await rm(resolve(pluginRoot, 'release'));
      await mkdir(resolve(pluginRoot, 'release'));
      await symlink(victim, resolve(pluginRoot, 'release/stereofold'));
      await expect(execFileAsync('python3', releaseArguments(pluginRoot))).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('symlinked plugin target'),
      });
      expect(await readFile(resolve(victim, 'keep.txt'), 'utf8')).toBe('untouched');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('rejects symlinked source inputs and clears only the exact generated target', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-release-source-')));
    const pluginRoot = resolve(temporaryRoot, 'plugin');
    const outside = resolve(temporaryRoot, 'outside.txt');
    await mkdir(pluginRoot);
    await mkdir(resolve(pluginRoot, '.codex-plugin'));
    await writeFile(resolve(pluginRoot, '.codex-plugin/plugin.json'), '{"name":"stereofold","version":"0.1.0"}\n');
    await writeFile(outside, 'outside');
    await symlink(outside, resolve(pluginRoot, 'README.md'));

    try {
      await expect(execFileAsync('python3', releaseArguments(pluginRoot))).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('symlinked release input'),
      });
      expect(await readFile(outside, 'utf8')).toBe('outside');

      await rm(resolve(pluginRoot, 'README.md'));
      await writeFile(resolve(pluginRoot, 'README.md'), 'source');
      const target = resolve(pluginRoot, 'release/stereofold');
      await mkdir(target, { recursive: true });
      await writeFile(resolve(target, 'generated.txt'), 'old');
      expect(await readFile(resolve(target, 'generated.txt'), 'utf8')).toBe('old');
      await execFileAsync('python3', releaseArguments(pluginRoot));
      expect(await readFile(resolve(target, 'README.md'), 'utf8')).toBe('source');
      await expect(readFile(resolve(target, 'generated.txt'))).rejects.toThrow();
      expect((await readdir(resolve(pluginRoot, 'release')))
        .some((name) => name.startsWith('.stereofold-backup-'))).toBe(true);
      expect(await readFile(outside, 'utf8')).toBe('outside');

      const releaseSource = await readFile(resolve(pluginDirectory, 'scripts/release.ts'), 'utf8');
      const helperSource = await readFile(directoryHelper, 'utf8');
      expect(releaseSource).not.toContain('cp(');
      expect(releaseSource).toContain("safeDirectorySwap,\n    'release'");
      expect(helperSource).toContain('same_identity(installed, expected_stage)');
      expect(helperSource).toContain('.stereofold-rejected-');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('keeps the current release intact when a later selected source changes during copying', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-release-concurrent-')));
    const pluginRoot = resolve(temporaryRoot, 'plugin');
    const target = resolve(pluginRoot, 'release/stereofold');
    await mkdir(resolve(pluginRoot, '.codex-plugin'), { recursive: true });
    await writeFile(resolve(pluginRoot, '.codex-plugin/plugin.json'), '{"name":"stereofold","version":"0.1.0"}\n');
    await writeFile(resolve(pluginRoot, 'README.md'), 'initial source');
    await mkdir(target, { recursive: true });
    await writeFile(resolve(target, 'keep.txt'), 'current release');
    const probe = `
import importlib.util
import pathlib
import sys
spec = importlib.util.spec_from_file_location("safe_directory_swap", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
source = pathlib.Path(sys.argv[2])
target = source / "release" / "stereofold"
copy_entry = module.copy_entry
def copy_then_change(source_fd, target_fd, name):
    copy_entry(source_fd, target_fd, name)
    if name == ".codex-plugin":
        (source / "README.md").write_text("concurrent source")
module.copy_entry = copy_then_change
try:
    module.stage_release(source, target, [".codex-plugin", "README.md"])
except ValueError as error:
    if "Release source changed while staging" not in str(error):
        raise
    print(str(error))
else:
    raise AssertionError("concurrent source mutation was accepted")
`;
    try {
      const result = await execFileAsync('python3', ['-c', probe, directoryHelper, pluginRoot]);
      expect(result.stdout).toContain('Release source changed while staging; current release left intact');
      expect(await readFile(resolve(target, 'keep.txt'), 'utf8')).toBe('current release');
      await expect(readFile(resolve(target, 'README.md'))).rejects.toThrow();
      expect((await readdir(resolve(pluginRoot, 'release')))
        .some((name) => name.startsWith('.stereofold-stage-'))).toBe(true);

      const helperSource = await readFile(directoryHelper, 'utf8');
      expect(helperSource.match(/snapshot_entries\(source_fd, entries\)/gu)).toHaveLength(2);
      expect(helperSource).toContain('portable_snapshot(staged_snapshot) == portable_snapshot(source_snapshot)');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('keeps the current release intact when staged bytes differ from the source snapshot', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-release-stage-mismatch-')));
    const pluginRoot = resolve(temporaryRoot, 'plugin');
    const target = resolve(pluginRoot, 'release/stereofold');
    await mkdir(resolve(pluginRoot, '.codex-plugin'), { recursive: true });
    await writeFile(resolve(pluginRoot, '.codex-plugin/plugin.json'), '{"name":"stereofold","version":"0.1.0"}\n');
    await writeFile(resolve(pluginRoot, 'README.md'), 'source bytes');
    await mkdir(target, { recursive: true });
    await writeFile(resolve(target, 'keep.txt'), 'current release');
    const probe = `
import importlib.util
import os
import pathlib
import sys
spec = importlib.util.spec_from_file_location("safe_directory_swap", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
source = pathlib.Path(sys.argv[2])
target = source / "release" / "stereofold"
copy_entry = module.copy_entry
def copy_then_corrupt(source_fd, target_fd, name):
    copy_entry(source_fd, target_fd, name)
    if name == "README.md":
        descriptor = os.open(name, os.O_WRONLY | os.O_TRUNC, dir_fd=target_fd)
        os.write(descriptor, b"different staged bytes")
        os.close(descriptor)
module.copy_entry = copy_then_corrupt
try:
    module.stage_release(source, target, [".codex-plugin", "README.md"])
except ValueError as error:
    if "Staged release does not match its source snapshot" not in str(error):
        raise
    print(str(error))
else:
    raise AssertionError("stage corruption was accepted")
`;
    try {
      const result = await execFileAsync('python3', ['-c', probe, directoryHelper, pluginRoot]);
      expect(result.stdout).toContain('Staged release does not match its source snapshot');
      expect(await readFile(resolve(target, 'keep.txt'), 'utf8')).toBe('current release');
      await expect(readFile(resolve(target, 'README.md'))).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});
