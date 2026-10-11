import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const installer = resolve(repositoryRoot, 'harness/kits/install-codex.sh');
const claudeInstaller = resolve(repositoryRoot, 'harness/kits/install-claude-science.sh');
const codexKit = resolve(repositoryRoot, 'harness/kits/codex-personal-plugin.md');
const configHelper = resolve(repositoryRoot, 'plugin/scripts/safe-config-update.py');
const directoryHelper = resolve(repositoryRoot, 'plugin/scripts/safe-directory-swap.py');
const installCheckHelper = resolve(repositoryRoot, 'plugin/scripts/codex-install-check.py');

describe('Claude Code installer bundle preflight', () => {
  it.each(['missing', 'stale-source', 'stale-script', 'fresh'] as const)(
    'reports build readiness with a %s inspector host', async (state) => {
      const root = await mkdtemp(join(tmpdir(), 'stereofold-claude-code-preflight-'));
      try {
        const script = join(root, 'harness/kits/install-claude-code.sh');
        const plugin = join(root, 'plugin');
        const bin = join(root, 'bin');
        const home = join(root, 'home');
        for (const directory of ['harness/kits', 'plugin/dist', 'plugin/src', 'plugin/scripts',
          'plugin/.claude-plugin', 'plugin/claude-code/skills/stereofold-quest', 'bin', 'home']) {
          await mkdir(join(root, directory), { recursive: true });
        }
        await cp(join(repositoryRoot, 'harness/kits/install-claude-code.sh'), script);
        await writeFile(join(plugin, '.claude-plugin/plugin.json'), '{}');
        await writeFile(join(plugin, 'claude-code/skills/stereofold-quest/SKILL.md'), '# Fixture');
        // Commands are isolated: preview must never execute the package manager.
        for (const [name, body] of [['node', 'echo 26'], ['claude', 'exit 0'], ['pnpm', 'exit 99']]) {
          await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        }
        for (const file of ['src/server.ts', 'scripts/inspector-host.ts', 'dist/server.mjs',
          'dist/inspector.html', 'dist/inspector.css', ...(state === 'missing' ? [] : ['dist/inspector-host.js'])]) {
          const path = join(plugin, file);
          await writeFile(path, '// fixture\n');
          const modified = file.startsWith('dist/') ? 300 : 100;
          await utimes(path, modified, modified);
        }
        if (state.startsWith('stale-')) {
          await utimes(join(plugin, 'dist/inspector-host.js'), 150, 150);
          const changed = state === 'stale-source' ? 'src/server.ts' : 'scripts/inspector-host.ts';
          await utimes(join(plugin, changed), 200, 200);
        }
        const { stdout } = await execFileAsync('bash', [script, '--preview'], {
          env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` },
        });
        expect(stdout.includes('plugin/dist is missing or older')).toBe(state !== 'fresh');
        expect(stdout).toContain('would install complete plugin: stereofold@stereofold');
        expect(await readdir(home)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe('Codex installer safety', () => {
  it('allows a verified separately namespaced Structure Viewer without removing it', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-install-safety-')));
    const profile = resolve(temporaryRoot, 'profile');
    await mkdir(profile);

    try {
      const version = '0.1.0+codex.20260908165911-b9189e98';
      await writeInstalledPlugin(profile, 'openai-curated-remote', 'structure-viewer', version, ['structure-viewer']);
      const result = await runInstallCheck([
        'ownership', '--codex-home', profile, '--server-id', 'stereo_structure',
      ], {
        installed: [{
          name: 'structure-viewer', pluginId: 'structure-viewer@openai-curated-remote', version, installed: true,
        }],
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('CODEX COEXISTENCE CHECK PASS 1 non-conflicting structure-viewer plugin(s)');

      const source = await readFile(installer, 'utf8');
      expect(source).toContain('ownership');
      expect(source).not.toContain('UPSTREAM_PLUGINS=');
      expect(source).not.toContain('plugin remove "$upstream"');
      expect(source).not.toContain('rsync -a --delete');
      expect(source.indexOf('ownership')).toBeLessThan(source.indexOf('SWAP_OUTPUT=$(python3'));
      expect(source).toContain('[ -L "$PERSONAL_PLUGIN" ]');
      expect(source.indexOf('[ -L "$PERSONAL_PLUGIN" ]')).toBeLessThan(source.indexOf('SWAP_OUTPUT=$(python3'));
      expect(source).toContain('Refusing unexpected personal plugin target');
      expect(source).toContain('Refusing unresolved or symlinked plugin parent');
      expect(source).toContain('safe-directory-swap.py');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ['overlapping server ownership', ['stereo_structure'], 'conflicts with installed structure-viewer@openai-curated-remote'],
    ['unknown registration identity', undefined, 'invalid plugin identifier'],
  ])('fails closed for %s', async (_label, servers, reason) => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-install-ownership-')));
    const profile = resolve(temporaryRoot, 'profile');
    await mkdir(profile);
    const plugin = {
      name: 'structure-viewer',
      pluginId: servers == null ? 'structure-viewer' : 'structure-viewer@openai-curated-remote',
      version: '0.1.80',
      installed: true,
    };
    try {
      if (servers != null) await writeInstalledPlugin(profile, 'openai-curated-remote', 'structure-viewer', '0.1.80', servers);
      const result = await runInstallCheck([
        'ownership', '--codex-home', profile, '--server-id', 'stereo_structure',
      ], { installed: [plugin] });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(reason);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('fails closed when a cache manifest declares another MCP descriptor', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-install-descriptor-')));
    const profile = resolve(temporaryRoot, 'profile');
    await mkdir(profile);
    try {
      await writeInstalledPlugin(
        profile, 'openai-curated-remote', 'structure-viewer', '0.1.80', ['structure-viewer'], './another.mcp.json',
      );
      const result = await runInstallCheck([
        'ownership', '--codex-home', profile, '--server-id', 'stereo_structure',
      ], {
        installed: [{
          name: 'structure-viewer', pluginId: 'structure-viewer@openai-curated-remote', version: '0.1.80', installed: true,
        }],
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Installed cache identity does not match Codex discovery');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each(['.', '..'])('rejects an escaping cache version %j before it can use the parent descriptor', async (version) => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-install-version-')));
    const profile = resolve(temporaryRoot, 'profile');
    await mkdir(profile);
    try {
      // These create plausible artifacts at the path a naïve cache join would
      // escape to; validation must reject the discovery version first.
      await writeInstalledPlugin(profile, 'openai-curated-remote', 'structure-viewer', version, ['structure-viewer']);
      const result = await runInstallCheck([
        'ownership', '--codex-home', profile, '--server-id', 'stereo_structure',
      ], {
        installed: [{
          name: 'structure-viewer', pluginId: 'structure-viewer@openai-curated-remote', version, installed: true,
        }],
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('invalid name or version');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('fails closed when Codex plugin discovery fails after writing parseable output', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-install-discovery-')));
    const profile = resolve(temporaryRoot, 'profile');
    await mkdir(profile);
    const mockBin = resolve(temporaryRoot, 'bin');
    const mutationLog = resolve(temporaryRoot, 'mutation.log');
    await mkdir(mockBin, { recursive: true });
    const mockCodex = resolve(mockBin, 'codex');
    await writeFile(mockCodex, `#!/bin/sh
if [ "$1" = plugin ] && [ "$2" = list ] && [ "$3" = --json ]; then
  printf '%s\\n' '{"installed":[]}'
  exit 44
fi
printf '%s\\n' "$*" >> "$STEREOFOLD_MUTATION_LOG"
exit 97
`);
    await chmod(mockCodex, 0o755);

    try {
      await expect(execFileAsync('/bin/bash', [installer, '--codex-home', profile], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${mockBin}:${process.env.PATH ?? ''}`,
          STEREOFOLD_MUTATION_LOG: mutationLog,
        },
      })).rejects.toMatchObject({ code: 44 });
      await expect(access(mutationLog)).rejects.toThrow();
      expect(await readFile(installer, 'utf8')).toContain('set -euo pipefail');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ['Codex marketplace', 'codex-install'],
    ['Claude Science config', 'claude-install'],
  ])('rejects a symlinked %s target without touching its referent', async (_label, operation) => {
    const created = await mkdtemp(join(tmpdir(), 'stereofold-config-symlink-'));
    const temporaryRoot = await realpath(created);
    const victim = resolve(temporaryRoot, 'victim.json');
    const target = resolve(temporaryRoot, operation === 'codex-install' ? 'marketplace.json' : 'local-mcp.json');
    const original = operation === 'codex-install'
      ? '{"name":"personal","plugins":[]}\n'
      : '{"servers":[]}\n';
    await writeFile(victim, original);
    await symlink(victim, target);

    try {
      await expect(execFileAsync('python3', [
        configHelper,
        operation,
        '--target', target,
        '--expected-target', target,
        '--check-only',
      ], { cwd: repositoryRoot })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Refusing symlink config target'),
      });
      expect(await readFile(victim, 'utf8')).toBe(original);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('rejects a symlinked config parent and atomically replaces regular configs', async () => {
    const created = await mkdtemp(join(tmpdir(), 'stereofold-config-atomic-'));
    const temporaryRoot = await realpath(created);
    const actualParent = resolve(temporaryRoot, 'actual');
    const linkedParent = resolve(temporaryRoot, 'linked');
    await mkdir(actualParent);
    await symlink(actualParent, linkedParent);
    const linkedTarget = resolve(linkedParent, 'local-mcp.json');

    try {
      await expect(execFileAsync('python3', [
        configHelper,
        'claude-install',
        '--target', linkedTarget,
        '--expected-target', linkedTarget,
        '--check-only',
      ], { cwd: repositoryRoot })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Refusing symlinked config parent'),
      });

      const marketplace = resolve(actualParent, 'marketplace.json');
      await writeFile(marketplace, '{"name":"personal","plugins":[]}\n');
      await execFileAsync('python3', [
        configHelper,
        'codex-install',
        '--target', marketplace,
        '--expected-target', marketplace,
      ], { cwd: repositoryRoot });
      const installed = JSON.parse(await readFile(marketplace, 'utf8')) as { plugins?: Array<{ name?: string }> };
      expect(installed.plugins?.map((plugin) => plugin.name)).toEqual(['stereofold']);
      expect((await readdir(actualParent)).some((name) => name.endsWith('.tmp'))).toBe(false);

      const localMcp = resolve(actualParent, 'local-mcp.json');
      const server = resolve(actualParent, 'server.mjs');
      await writeFile(localMcp, '{"servers":[]}\n');
      await writeFile(server, '');
      await execFileAsync('python3', [
        configHelper,
        'claude-install',
        '--target', localMcp,
        '--expected-target', localMcp,
        '--server', server,
      ], { cwd: repositoryRoot });
      const configured = JSON.parse(await readFile(localMcp, 'utf8')) as { servers?: Array<{ name?: string }> };
      expect(configured.servers?.map((entry) => entry.name)).toEqual(['stereofold']);
      expect((await readdir(actualParent)).some((name) => name.startsWith('local-mcp.json.bak-'))).toBe(true);
      expect((await readdir(actualParent)).some((name) => name.endsWith('.tmp'))).toBe(false);

      const [codexSource, claudeSource] = await Promise.all([
        readFile(installer, 'utf8'),
        readFile(claudeInstaller, 'utf8'),
      ]);
      expect(codexSource).toContain('safe-config-update.py');
      expect(claudeSource).toContain('safe-config-update.py');
      expect(codexSource.indexOf('--check-only')).toBeLessThan(codexSource.indexOf('pnpm --filter stereo-structure release'));
      expect(codexSource).not.toContain('rsync -a --delete');
      expect(codexSource).toContain('SWAP_OUTPUT=$(python3 "$DIRECTORY_HELPER" install');
      expect(claudeSource.indexOf('--check-only')).toBeLessThan(claudeSource.indexOf('pnpm --filter stereo-structure release'));

      const kit = await readFile(codexKit, 'utf8');
      const uninstall = kit.slice(kit.indexOf('## Uninstall'));
      expect(uninstall).toContain('codex-remove');
      expect(uninstall).toContain('env CODEX_HOME="$STEREOFOLD_PROFILE" "$STEREOFOLD_CLI" plugin remove stereofold@personal');
      expect(uninstall.indexOf('--check-only')).toBeLessThan(uninstall.lastIndexOf('codex-remove'));
      expect(uninstall).not.toContain('rm -rf');
      expect(uninstall).toContain('"$DIRECTORY_HELPER" remove');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('creates a new personal marketplace with no preview writes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-marketplace-create-')));
    const target = resolve(root, 'new/.agents/plugins/marketplace.json');
    const args = [configHelper, 'codex-install', '--target', target, '--expected-target', target, '--initialize'];
    try {
      await execFileAsync('python3', [...args, '--check-only']);
      expect(await readdir(root)).toEqual([]);
      await execFileAsync('python3', args);
      const marketplace = JSON.parse(await readFile(target, 'utf8'));
      expect(marketplace.name).toBe('personal');
      expect(marketplace.plugins).toEqual([{
        name: 'stereofold', source: { source: 'local', path: './plugins/stereofold' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Education & Research',
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('registers the supplied absolute Node executable for Claude Science', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-science-node-')));
    const target = resolve(root, 'local-mcp.json');
    const server = resolve(root, 'server.mjs');
    try {
      await writeFile(server, 'export {};');
      await writeFile(target, '{"servers":[{"name":"unrelated","command":"keep"}]}');
      await execFileAsync('python3', [configHelper, 'claude-install', '--target', target,
        '--expected-target', target, '--server', server, '--node', process.execPath]);
      const config = JSON.parse(await readFile(target, 'utf8'));
      expect(config.servers[0]).toEqual({ name: 'unrelated', command: 'keep' });
      expect(config.servers[1].command).toBe(process.execPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes repeated --env entries onto the stereofold server entry, later duplicates winning', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-config-env-')));
    const localMcp = resolve(temporaryRoot, 'local-mcp.json');
    const server = resolve(temporaryRoot, 'server.mjs');
    await writeFile(localMcp, '{"servers":[]}\n');
    await writeFile(server, '');
    try {
      await execFileAsync('python3', [
        configHelper,
        'claude-install',
        '--target', localMcp,
        '--expected-target', localMcp,
        '--server', server,
        '--env', 'STEREOFOLD_CLOUDFLARED=/opt/homebrew/bin/cloudflared',
        '--env', 'STEREOFOLD_EXTRA=first',
        '--env', 'STEREOFOLD_EXTRA=second',
      ], { cwd: repositoryRoot });
      const configured = JSON.parse(await readFile(localMcp, 'utf8')) as {
        servers?: Array<{ name?: string; env?: Record<string, string> }>;
      };
      expect(configured.servers?.find((entry) => entry.name === 'stereofold')?.env).toEqual({
        STEREOFOLD_CLOUDFLARED: '/opt/homebrew/bin/cloudflared',
        STEREOFOLD_EXTRA: 'second',
      });
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('rejects a malformed --env value without touching the config', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-config-env-bad-')));
    const localMcp = resolve(temporaryRoot, 'local-mcp.json');
    const server = resolve(temporaryRoot, 'server.mjs');
    const original = '{"servers":[]}\n';
    await writeFile(localMcp, original);
    await writeFile(server, '');
    try {
      await expect(execFileAsync('python3', [
        configHelper,
        'claude-install',
        '--target', localMcp,
        '--expected-target', localMcp,
        '--server', server,
        '--env', 'NOT_KEY_VALUE',
      ], { cwd: repositoryRoot })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Refusing malformed --env value'),
      });
      expect(await readFile(localMcp, 'utf8')).toBe(original);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('refuses a lost config update after the parsed target changes', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-config-lost-update-')));
    const marketplace = resolve(temporaryRoot, 'marketplace.json');
    await writeFile(marketplace, '{"name":"personal","plugins":[]}\n');
    const probe = `
import importlib.util
import pathlib
import sys
spec = importlib.util.spec_from_file_location("safe_config_update", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
path = pathlib.Path(sys.argv[2])
parent_fd = module.open_parent_no_follow(path.parent)
try:
    payload, original = module.codex_payload(path, parent_fd, remove=False)
    path.write_text('{"name":"personal","plugins":[{"name":"concurrent"}]}\\n')
    module.atomic_write(path, parent_fd, payload, original, backup=False)
finally:
    import os
    os.close(parent_fd)
`;
    try {
      await expect(execFileAsync('python3', ['-c', probe, configHelper, marketplace], {
        cwd: repositoryRoot,
      })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Refusing to overwrite concurrently changed config target'),
      });
      expect(await readFile(marketplace, 'utf8')).toContain('concurrent');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('serializes cooperating config writers with the descriptor-held sidecar lock', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-config-lock-')));
    const marketplace = resolve(temporaryRoot, 'marketplace.json');
    const lock = resolve(temporaryRoot, '.marketplace.json.stereofold.lock');
    await writeFile(marketplace, '{"name":"personal","plugins":[]}\n');
    const holder = spawn('python3', ['-c', `
import fcntl, os, sys, time
descriptor = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT, 0o600)
fcntl.flock(descriptor, fcntl.LOCK_EX)
print('LOCKED', flush=True)
time.sleep(0.5)
os.close(descriptor)
`, lock]);
    try {
      await once(holder.stdout, 'data');
      const started = Date.now();
      await execFileAsync('python3', [
        configHelper,
        'codex-install',
        '--target', marketplace,
        '--expected-target', marketplace,
      ]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
      const configured = JSON.parse(await readFile(marketplace, 'utf8')) as { plugins?: Array<{ name?: string }> };
      expect(configured.plugins?.map((plugin) => plugin.name)).toEqual(['stereofold']);
      const source = await readFile(configHelper, 'utf8');
      expect(source.indexOf('lock_fd = acquire_update_lock')).toBeLessThan(source.indexOf('payload, original = codex_payload'));
      expect(source).toContain('(replaced.st_dev, replaced.st_ino) != (temporary_details.st_dev, temporary_details.st_ino)');
    } finally {
      if (holder.exitCode == null) {
        holder.kill();
        await once(holder, 'exit').catch(() => undefined);
      }
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('swaps and removes plugin directories relative to a held parent without following target links', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-plugin-swap-')));
    const victim = resolve(temporaryRoot, 'victim');
    const target = resolve(temporaryRoot, 'stereofold');
    await mkdir(victim);
    await writeFile(resolve(victim, 'keep.txt'), 'untouched');
    await symlink(victim, target);
    try {
      await expect(execFileAsync('python3', [
        directoryHelper,
        'preflight',
        '--target', target,
        '--expected-target', target,
      ])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('symlinked plugin target'),
      });
      expect(await readFile(resolve(victim, 'keep.txt'), 'utf8')).toBe('untouched');

      await rm(target);
      await mkdir(target);
      await writeFile(resolve(target, 'old.txt'), 'old');
      const stage = await mkdtemp(resolve(temporaryRoot, '.stereofold-stage-'));
      await writeFile(resolve(stage, 'new.txt'), 'new');
      const swapped = await execFileAsync('python3', [
        directoryHelper,
        'swap',
        '--stage', stage,
        '--target', target,
        '--expected-target', target,
      ]);
      expect(await readFile(resolve(target, 'new.txt'), 'utf8')).toBe('new');
      expect(swapped.stdout).toContain('PREVIOUS PLUGIN RETAINED');
      expect((await readdir(temporaryRoot)).some((name) => name.startsWith('.stereofold-backup-'))).toBe(true);

      await execFileAsync('python3', [
        directoryHelper,
        'remove',
        '--target', target,
        '--expected-target', target,
      ]);
      await expect(access(target)).rejects.toThrow();
      expect(await readFile(resolve(victim, 'keep.txt'), 'utf8')).toBe('untouched');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('keeps the current plugin intact when a later source file changes during install copying', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-plugin-concurrent-')));
    const source = resolve(temporaryRoot, 'artifact');
    const target = resolve(temporaryRoot, 'stereofold');
    await mkdir(resolve(source, '.codex-plugin'), { recursive: true });
    await writeFile(resolve(source, '.codex-plugin/plugin.json'), '{"name":"stereofold","version":"0.1.0"}\n');
    await writeFile(resolve(source, 'README.md'), 'initial source');
    await mkdir(target);
    await writeFile(resolve(target, 'keep.txt'), 'current plugin');
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
target = pathlib.Path(sys.argv[3])
copy_file = module.copy_file
def copy_then_change(source_fd, target_fd, name, expected):
    copy_file(source_fd, target_fd, name, expected)
    if name == "plugin.json":
        (source / "README.md").write_text("concurrent source")
module.copy_file = copy_then_change
parent_fd = module.open_directory_no_follow(target.parent)
try:
    module.install(source, target, parent_fd)
except ValueError as error:
    if "Plugin source changed while staging" not in str(error):
        raise
    print(str(error))
else:
    raise AssertionError("concurrent install source mutation was accepted")
finally:
    os.close(parent_fd)
`;
    try {
      const result = await execFileAsync('python3', ['-c', probe, directoryHelper, source, target]);
      expect(result.stdout).toContain('Plugin source changed while staging; current plugin left intact');
      expect(await readFile(resolve(target, 'keep.txt'), 'utf8')).toBe('current plugin');
      await expect(readFile(resolve(target, 'README.md'))).rejects.toThrow();
      expect((await readdir(temporaryRoot))
        .some((name) => name.startsWith('.stereofold-stage-'))).toBe(true);

      const helperSource = await readFile(directoryHelper, 'utf8');
      expect(helperSource).toContain('source_names, source_snapshot = snapshot_complete_root(source_fd)');
      expect(helperSource).toContain('portable_snapshot(staged_snapshot) == portable_snapshot(source_snapshot)');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});

async function runInstallCheck(arguments_: string[], input: unknown) {
  const child = spawn('python3', [installCheckHelper, ...arguments_], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(JSON.stringify(input));
  const [code] = await once(child, 'close') as [number | null];
  return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}

async function writeInstalledPlugin(
  profile: string, source: string, name: string, version: string, servers: string[], descriptor = './.mcp.json',
) {
  const root = resolve(profile, 'plugins', 'cache', source, name, version);
  await mkdir(resolve(root, '.codex-plugin'), { recursive: true });
  await writeFile(resolve(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, version, mcpServers: descriptor }));
  await writeFile(resolve(root, '.mcp.json'), JSON.stringify({
    mcpServers: Object.fromEntries(servers.map((server) => [server, { command: 'node' }])),
  }));
}

const viewerPlaceholder = 'stereofold-viewer-build-unstamped-000000000000000000000000000000';

async function fixtureTree(root: string, relative = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(files, await fixtureTree(root, path));
    else files[path] = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex');
  }
  return files;
}

async function installerFixture(options: { withStructureViewer?: boolean; omitInspectorHost?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-profile-install-')));
  const repo = resolve(root, 'repo');
  const script = resolve(repo, 'harness/kits/install-codex.sh');
  const scripts = resolve(repo, 'plugin/scripts');
  const artifact = resolve(repo, 'plugin/release/stereofold');
  const profile = resolve(root, 'selected profile');
  const otherProfile = resolve(root, 'other-profile');
  const staging = resolve(root, 'plugins/stereofold');
  const marketplace = resolve(root, '.agents/plugins/marketplace.json');
  const bin = resolve(root, 'bin');
  for (const path of [resolve(repo, 'harness/kits'), scripts, resolve(artifact, '.codex-plugin'), resolve(artifact, 'dist'), profile, otherProfile, staging, resolve(root, '.agents/plugins'), bin]) {
    await mkdir(path, { recursive: true });
  }
  // The installer receives its local marketplace root through its public option.
  // Real guards and helpers run within this temporary tree.
  await cp(installer, script);
  for (const helper of [configHelper, directoryHelper, installCheckHelper]) {
    await cp(helper, resolve(scripts, helper.slice(helper.lastIndexOf('/') + 1)));
  }
  const unstamped = `<!doctype html><script>const viewerBuild = '${viewerPlaceholder}';</script>`;
  const stamp = createHash('sha256').update(unstamped).digest('hex');
  await writeFile(resolve(artifact, '.codex-plugin/plugin.json'), '{"name":"stereofold","version":"0.1.0","mcpServers":"./.mcp.json"}\n');
  await writeFile(resolve(artifact, '.mcp.json'), '{"mcpServers":{"stereo_structure":{"command":"node"}}}\n');
  await writeFile(resolve(artifact, 'dist/viewer.html'), unstamped.replace(viewerPlaceholder, stamp));
  await writeFile(resolve(artifact, 'dist/inspector.html'), unstamped.replace(viewerPlaceholder, stamp));
  await writeFile(resolve(artifact, 'dist/server.mjs'), 'export const serverBuild = "prepared";\n');
  await writeFile(resolve(artifact, 'dist/inspector.css'), 'body{}\n');
  if (!options.omitInspectorHost) await writeFile(resolve(artifact, 'dist/inspector-host.js'), '// prepared host\n');
  await writeFile(resolve(staging, 'keep.txt'), 'previous plugin');
  await writeFile(marketplace, '{"name":"personal","plugins":[{"name":"unrelated","source":{"path":"./unrelated"}}]}\n');
  await writeFile(resolve(otherProfile, 'untouched.txt'), 'other profile');
  if (options.withStructureViewer) {
    await writeInstalledPlugin(profile, 'openai-curated-remote', 'structure-viewer', '0.1.80', ['structure-viewer']);
    await writeFile(resolve(root, 'with-structure-viewer'), 'enabled');
  }
  const codex = resolve(bin, 'codex');
  await writeFile(codex, String.raw`#!/usr/bin/env python3
import hashlib, json, os, pathlib, shutil, sys
root = pathlib.Path(os.environ["STEREOFOLD_TEST_ROOT"])
profile = root / "selected profile"
with (root / "codex-calls.jsonl").open("a") as log:
    log.write(json.dumps({"profile": os.environ.get("CODEX_HOME"), "arguments": sys.argv[1:]}) + "\n")
if os.environ.get("CODEX_HOME") != str(profile):
    raise SystemExit(91)
args = sys.argv[1:]
state_file = root / "codex-state.json"
existing = {"pluginId": "stereofold@personal", "name": "stereofold", "version": "older", "installed": True, "enabled": True}
state = json.loads(state_file.read_text()) if state_file.exists() else existing
if args == ["plugin", "list", "--json"]:
    upstream = {"pluginId": "structure-viewer@openai-curated-remote", "name": "structure-viewer", "version": "0.1.80", "installed": True, "enabled": True}
    installed = ([] if state is None else [state]) + ([upstream] if (root / "with-structure-viewer").exists() else [])
    print(json.dumps({"installed": installed, "available": []}))
    raise SystemExit(int(os.environ.get("STEREOFOLD_DISCOVERY_EXIT", "0")))
if args == ["plugin", "remove", "stereofold@personal"]:
    if os.environ.get("STEREOFOLD_FAIL_COMMAND") == "remove":
        raise SystemExit(42)
    state_file.write_text("null")
elif args == ["plugin", "marketplace", "add", str(root)]:
    pass
elif args == ["plugin", "add", "stereofold@personal"]:
    if os.environ.get("STEREOFOLD_FAIL_COMMAND") == "add":
        raise SystemExit(43)
    stage = root / "plugins/stereofold"
    version = json.loads((stage / ".codex-plugin/plugin.json").read_text())["version"]
    cache = profile / "plugins/cache/personal/stereofold" / version
    cache.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(stage, cache)
    stale = os.environ.get("STEREOFOLD_STALE_FILE")
    if stale in ("dist/viewer.html", "dist/inspector.html"):
        placeholder = "stereofold-viewer-build-unstamped-000000000000000000000000000000"
        old_viewer = "<script>const oldBuild = '" + placeholder + "';</script>"
        (cache / stale).write_text(old_viewer.replace(placeholder, hashlib.sha256(old_viewer.encode()).hexdigest()))
    elif stale:
        (cache / stale).write_text("stale artifact")
    registration = {**existing, "version": version}
    if os.environ.get("STEREOFOLD_REGISTRATION_STATE") == "disabled":
        registration["enabled"] = False
    elif os.environ.get("STEREOFOLD_REGISTRATION_STATE") == "older":
        registration["version"] = "older"
    state_file.write_text(json.dumps(registration))
else:
    raise SystemExit(92)
`);
  const pnpm = resolve(bin, 'pnpm');
  await writeFile(pnpm, String.raw`#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["STEREOFOLD_TEST_ROOT"])
with (root / "build-calls.jsonl").open("a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")
if sys.argv[1:] == ["--filter", "stereo-structure", "smoke"]:
    print("SMOKE PASS viewer build " + os.environ["STEREOFOLD_TEST_STAMP"])
elif sys.argv[1:] != ["--filter", "stereo-structure", "release"]:
    raise SystemExit(93)
`);
  await chmod(codex, 0o755);
  await chmod(pnpm, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    CODEX_HOME: otherProfile,
    STEREOFOLD_TEST_ROOT: root,
    STEREOFOLD_INSTALL_ROOT: root,
    STEREOFOLD_TEST_STAMP: stamp,
  };
  return { root, repo, script, artifact, profile, otherProfile, staging, marketplace, codex, stamp, env };
}

async function prepareReusableStage(fixture: Awaited<ReturnType<typeof installerFixture>>) {
  await rm(fixture.staging, { force: true, recursive: true });
  await cp(fixture.artifact, fixture.staging, { recursive: true });
  await writeFile(fixture.marketplace, JSON.stringify({
    name: 'personal',
    plugins: [
      { name: 'unrelated', source: { path: './unrelated' } },
      { name: 'stereofold', source: { source: 'local', path: './plugins/stereofold' } },
    ],
  }));
}

describe('Codex profile routing and artifact verification', () => {
  it('requires an explicit target before invoking the CLI or building', async () => {
    const fixture = await installerFixture();
    try {
      await expect(execFileAsync('/bin/bash', [fixture.script], { env: fixture.env })).rejects.toMatchObject({ code: 2 });
      await expect(access(resolve(fixture.root, 'codex-calls.jsonl'))).rejects.toThrow();
      await expect(access(resolve(fixture.root, 'build-calls.jsonl'))).rejects.toThrow();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rejects an artifact missing only inspector-host.js', async () => {
    const fixture = await installerFixture({ omitInspectorHost: true });
    try {
      const result = await runInstallCheck(['fingerprint', '--artifact', fixture.artifact], {});
      expect(result.code, 'missing inspector host blocks installer').toBe(1);
      expect(result.stderr).toContain('inspector-host.js');
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('previews all runtime asset hashes and shared paths without writes or CLI calls', async () => {
    const fixture = await installerFixture();
    try {
      const before = await fixtureTree(fixture.root);
      const { stdout } = await execFileAsync('/bin/bash', [fixture.script, '--codex-home', fixture.profile, '--codex-bin', fixture.codex, '--preview'], { env: fixture.env });
      const preview = JSON.parse(stdout);
      expect(preview).toMatchObject({
        codexProfile: fixture.profile,
        codexExecutable: fixture.codex,
        sharedStaging: fixture.staging,
        sharedMarketplace: fixture.marketplace,
        cliInvoked: false,
        buildRun: false,
        installedPluginDiscovery: 'not_run',
        artifact: { viewerBuild: fixture.stamp },
      });
      for (const path of ['dist/viewer.html', 'dist/server.mjs', 'dist/inspector.html', 'dist/inspector.css', 'dist/inspector-host.js']) {
        expect(preview.artifact.files[path].sha256).toBe(createHash('sha256').update(await readFile(resolve(fixture.artifact, path))).digest('hex'));
      }
      expect(await fixtureTree(fixture.root)).toEqual(before);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('previews a verified reusable release without a build, staging swap, or profile change', async () => {
    const fixture = await installerFixture();
    try {
      await prepareReusableStage(fixture);
      const before = await fixtureTree(fixture.root);
      const { stdout } = await execFileAsync('/bin/bash', [
        fixture.script, '--codex-home', fixture.profile, '--codex-bin', fixture.codex,
        '--reuse-release', fixture.artifact, '--preview',
      ], { env: fixture.env });
      const preview = JSON.parse(stdout);
      expect(preview).toMatchObject({
        codexProfile: fixture.profile,
        artifactRoot: fixture.artifact,
        sharedStaging: fixture.staging,
        artifact: { viewerBuild: fixture.stamp },
        cliInvoked: false,
        buildRun: false,
      });
      expect(await fixtureTree(fixture.root)).toEqual(before);
      await expect(access(resolve(fixture.root, 'codex-calls.jsonl'))).rejects.toThrow();
      await expect(access(resolve(fixture.root, 'build-calls.jsonl'))).rejects.toThrow();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('routes discovery, removal, installation, and verification to the selected profile', async () => {
    const fixture = await installerFixture();
    try {
      const { stdout } = await execFileAsync('/bin/bash', [fixture.script, '--codex-home', fixture.profile, '--codex-bin', fixture.codex], { env: fixture.env });
      expect(stdout).toContain(`CODEX INSTALL OK ${fixture.stamp}`);
      const calls = (await readFile(resolve(fixture.root, 'codex-calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(calls.map((call) => call.arguments)).toEqual([
        ['plugin', 'list', '--json'],
        ['plugin', 'marketplace', 'add', fixture.root],
        ['plugin', 'remove', 'stereofold@personal'],
        ['plugin', 'add', 'stereofold@personal'],
        ['plugin', 'list', '--json'],
      ]);
      expect(calls.every((call) => call.profile === fixture.profile)).toBe(true);
      expect(await readdir(fixture.otherProfile)).toEqual(['untouched.txt']);
      const configured = JSON.parse(await readFile(fixture.marketplace, 'utf8'));
      expect(configured.plugins.map((plugin: { name: string }) => plugin.name)).toEqual(['unrelated', 'stereofold']);
      const backups = (await readdir(resolve(fixture.root, 'plugins'))).filter((name) => name.startsWith('.stereofold-backup-'));
      expect(backups).toHaveLength(1);
      expect(await readFile(resolve(fixture.root, 'plugins', backups[0], 'keep.txt'), 'utf8')).toBe('previous plugin');
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('reuses an exact staged release in the selected profile without rebuilding or swapping shared staging', async () => {
    const fixture = await installerFixture();
    try {
      await prepareReusableStage(fixture);
      const marketplaceBefore = await readFile(fixture.marketplace, 'utf8');
      const { stdout } = await execFileAsync('/bin/bash', [
        fixture.script, '--codex-home', fixture.profile, '--codex-bin', fixture.codex,
        '--reuse-release', fixture.artifact,
      ], { env: fixture.env });
      expect(stdout).toContain(`CODEX REUSE INSTALL OK ${fixture.stamp}`);
      await expect(access(resolve(fixture.root, 'build-calls.jsonl'))).rejects.toThrow();
      expect(await readFile(fixture.marketplace, 'utf8')).toBe(marketplaceBefore);
      const backups = (await readdir(resolve(fixture.root, 'plugins'))).filter((name) => name.startsWith('.stereofold-backup-'));
      expect(backups).toHaveLength(0);
      const calls = (await readFile(resolve(fixture.root, 'codex-calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(calls.map((call) => call.arguments)).toEqual([
        ['plugin', 'list', '--json'],
        ['plugin', 'marketplace', 'add', fixture.root],
        ['plugin', 'remove', 'stereofold@personal'],
        ['plugin', 'add', 'stereofold@personal'],
        ['plugin', 'list', '--json'],
      ]);
      expect(calls.every((call) => call.profile === fixture.profile)).toBe(true);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rejects a reusable stage that differs from its source contract before invoking Codex', async () => {
    const fixture = await installerFixture();
    try {
      await prepareReusableStage(fixture);
      await writeFile(resolve(fixture.staging, 'dist/server.mjs'), 'changed after source contract');
      const marketplaceBefore = await readFile(fixture.marketplace, 'utf8');
      const result = await execFileAsync('/bin/bash', [
        fixture.script, '--codex-home', fixture.profile, '--codex-bin', fixture.codex,
        '--reuse-release', fixture.artifact,
      ], { env: fixture.env }).catch((error) => error);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Artifact does not match the prepared release: dist/server.mjs');
      expect(await readFile(fixture.marketplace, 'utf8')).toBe(marketplaceBefore);
      await expect(access(resolve(fixture.root, 'codex-calls.jsonl'))).rejects.toThrow();
      await expect(access(resolve(fixture.root, 'build-calls.jsonl'))).rejects.toThrow();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rejects a reusable release when the marketplace does not point to shared staging before invoking Codex', async () => {
    const fixture = await installerFixture();
    try {
      await prepareReusableStage(fixture);
      await writeFile(fixture.marketplace, JSON.stringify({
        name: 'personal',
        plugins: [{ name: 'stereofold', source: { source: 'local', path: './plugins/other' } }],
      }));
      const result = await execFileAsync('/bin/bash', [
        fixture.script, '--codex-home', fixture.profile, '--codex-bin', fixture.codex,
        '--reuse-release', fixture.artifact,
      ], { env: fixture.env }).catch((error) => error);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('does not contain exactly one Stereofold entry for local shared staging');
      await expect(access(resolve(fixture.root, 'codex-calls.jsonl'))).rejects.toThrow();
      await expect(access(resolve(fixture.root, 'build-calls.jsonl'))).rejects.toThrow();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('updates Stereofold alongside a verified separately namespaced Structure Viewer', async () => {
    const fixture = await installerFixture({ withStructureViewer: true });
    try {
      const { stdout } = await execFileAsync('/bin/bash', [fixture.script, '--codex-home', fixture.profile], { env: fixture.env });
      expect(stdout).toContain('CODEX COEXISTENCE CHECK PASS 1 non-conflicting structure-viewer plugin(s)');
      const calls = (await readFile(resolve(fixture.root, 'codex-calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(calls.map((call) => call.arguments)).toEqual([
        ['plugin', 'list', '--json'],
        ['plugin', 'marketplace', 'add', fixture.root],
        ['plugin', 'remove', 'stereofold@personal'],
        ['plugin', 'add', 'stereofold@personal'],
        ['plugin', 'list', '--json'],
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it.each(['remove', 'add'])('reports a %s failure and retains the previous staged plugin', async (command) => {
    const fixture = await installerFixture();
    try {
      const result = await execFileAsync('/bin/bash', [fixture.script, '--codex-home', fixture.profile], {
        env: { ...fixture.env, STEREOFOLD_FAIL_COMMAND: command },
      }).catch((error) => error);
      expect(result.code).toBe(command === 'remove' ? 42 : 43);
      expect(result.stdout).not.toContain('CODEX INSTALL OK');
      const backups = (await readdir(resolve(fixture.root, 'plugins'))).filter((name) => name.startsWith('.stereofold-backup-'));
      expect(backups).toHaveLength(1);
      expect(await readFile(resolve(fixture.root, 'plugins', backups[0], 'keep.txt'), 'utf8')).toBe('previous plugin');
      const calls = (await readFile(resolve(fixture.root, 'codex-calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(calls.at(-1).arguments).toEqual(['plugin', command, 'stereofold@personal']);
      expect(await readdir(fixture.otherProfile)).toEqual(['untouched.txt']);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it.each(['dist/server.mjs', 'dist/viewer.html', 'dist/inspector.html', 'dist/inspector.css', 'dist/inspector-host.js'])('rejects stale cached %s despite successful CLI installation', async (file) => {
    const fixture = await installerFixture();
    try {
      const result = await execFileAsync('/bin/bash', [fixture.script, '--codex-home', fixture.profile], {
        env: { ...fixture.env, STEREOFOLD_STALE_FILE: file },
      }).catch((error) => error);
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain('CODEX INSTALL OK');
      expect(result.stderr).toContain(`does not match the prepared release: ${file}`);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rejects a smoke/build identity mismatch before staging or changing the marketplace', async () => {
    const fixture = await installerFixture();
    try {
      const marketplaceBefore = await readFile(fixture.marketplace, 'utf8');
      const result = await execFileAsync('/bin/bash', [fixture.script, '--codex-home', fixture.profile], {
        env: { ...fixture.env, STEREOFOLD_TEST_STAMP: 'f'.repeat(64) },
      }).catch((error) => error);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Release viewer stamp does not match the smoke result');
      expect(await readFile(fixture.marketplace, 'utf8')).toBe(marketplaceBefore);
      expect(await readFile(resolve(fixture.staging, 'keep.txt'), 'utf8')).toBe('previous plugin');
      expect(await readdir(resolve(fixture.root, 'plugins'))).toEqual(['stereofold']);
      const calls = (await readFile(resolve(fixture.root, 'codex-calls.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(calls.map((call) => call.arguments)).toEqual([['plugin', 'list', '--json']]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it.each(['disabled', 'older'])('rejects a %s catalog registration even when cached bundles match', async (state) => {
    const fixture = await installerFixture();
    try {
      const result = await execFileAsync('/bin/bash', [fixture.script, '--codex-home', fixture.profile], {
        env: { ...fixture.env, STEREOFOLD_REGISTRATION_STATE: state },
      }).catch((error) => error);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('expected Stereofold version installed and enabled');
      expect(result.stdout).not.toContain('CODEX INSTALL OK');
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it('rejects a profile cache symlink before invoking the CLI', async () => {
    const fixture = await installerFixture();
    try {
      await symlink(fixture.otherProfile, resolve(fixture.profile, 'plugins'));
      await expect(execFileAsync('/bin/bash', [fixture.script, '--codex-home', fixture.profile], { env: fixture.env })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('symlinked profile/cache path'),
      });
      await expect(access(resolve(fixture.root, 'codex-calls.jsonl'))).rejects.toThrow();
      expect(await readdir(fixture.otherProfile)).toEqual(['untouched.txt']);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

/**
 * The Claude Science daemon is the host that cannot compensate for anything
 * left unset: its `PATH` has no Homebrew and it has no window to raise a macOS
 * consent dialog in. Every setting here is one a terminal host gets for free,
 * so an installer that stops naming one degrades that host alone, silently,
 * while every check in the kit still passes.
 */
describe('Claude Science daemon environment', () => {
  it('pins whisper, so the daemon never waits on a consent dialog it cannot show', async () => {
    const script = await readFile(claudeInstaller, 'utf8');
    // Unset, the server picks Apple whenever `applespeech` is present, and the
    // release artifact this daemon launches stages that binary.
    expect(script).toContain('--env "STEREOFOLD_PTT_TRANSCRIBER=whisper"');
  });

  it('names an adb that really exists, and writes none when the Mac has none', async () => {
    const script = await readFile(claudeInstaller, 'utf8');
    expect(script).toContain('STEREOFOLD_ADB_BIN=$candidate');
    // Guarded by an executable test: a Mac without platform-tools must keep
    // capture_headset_view's own "no adb was found" sentence rather than gain
    // an env entry pointing at nothing.
    expect(script).toContain('if [ -x "$candidate" ]; then');
  });

  it('keeps the hand-install template and the installer naming the same settings', async () => {
    const script = await readFile(claudeInstaller, 'utf8');
    const template = JSON.parse(await readFile(resolve(repositoryRoot, 'harness/kits/claude-science-local-mcp.json'), 'utf8')) as {
      servers: Array<{ name: string; env?: Record<string, string> }>;
    };
    const entry = template.servers.find((server) => server.name === 'stereofold');
    expect(entry).toBeDefined();
    for (const name of Object.keys(entry?.env ?? {})) {
      expect(script).toContain(name);
    }
    expect(Object.keys(entry?.env ?? {}).sort()).toEqual([
      'STEREOFOLD_ADB_BIN', 'STEREOFOLD_BRIDGE_DIR', 'STEREOFOLD_CLOUDFLARED',
      'STEREOFOLD_PTT_TRANSCRIBE', 'STEREOFOLD_PTT_TRANSCRIBER',
      'STEREOFOLD_SCENE_SERVICE', 'STEREOFOLD_SCENE_SOCKET',
    ]);
  });

  it('offers the same settings in docs/install.md as the kit does', async () => {
    const doc = await readFile(resolve(repositoryRoot, 'docs/install.md'), 'utf8');
    // An empty env block is a working registration that quietly does less than
    // every other host; the document used to show one as the complete template.
    expect(doc).not.toContain('"env": {}');
    for (const name of ['STEREOFOLD_ADB_BIN', 'STEREOFOLD_BRIDGE_DIR', 'STEREOFOLD_CLOUDFLARED', 'STEREOFOLD_PTT_TRANSCRIBER']) {
      expect(doc).toContain(name);
    }
  });
});

/** Every update route keeps the complete runtime asset set together. */
describe('Codex complete artifact update route', () => {
  const runtimeBundles = ['dist/server.mjs', 'dist/viewer.html', 'dist/inspector.html', 'dist/inspector.css', 'dist/inspector-host.js'];

  it('names the same runtime assets in the checker, the doctor and the kit', async () => {
    const checker = await readFile(installCheckHelper, 'utf8');
    const doctor = await readFile(resolve(repositoryRoot, 'plugin/scripts/setup-doctor.ts'), 'utf8');
    const kit = await readFile(codexKit, 'utf8');
    for (const bundle of runtimeBundles) {
      expect(checker).toContain(bundle);
      expect(doctor).toContain(bundle.replace('dist/', ''));
      expect(kit).toContain(bundle);
    }
    // Fingerprinting and the update instructions cover the same runtime.
    expect(checker).toContain('BUNDLE_PATHS = ("dist/viewer.html", "dist/server.mjs", "dist/inspector.html", "dist/inspector.css", "dist/inspector-host.js")');
  });

  it('checks the mounted build after an artifact update', async () => {
    const kit = await readFile(codexKit, 'utf8');
    expect(kit).toContain('diagnostics.viewerBuild');
    expect(kit).toContain('viewer build');
  });

  it('sends install documentation to the same runtime assets', async () => {
    const doc = await readFile(resolve(repositoryRoot, 'docs/install.md'), 'utf8');
    const notes = await readFile(resolve(repositoryRoot, 'plugin/codex/INSTALL.md'), 'utf8');
    for (const bundle of runtimeBundles) expect(doc).toContain(bundle);
    expect(doc).toContain('diagnostics.viewerBuild');
    for (const bundle of runtimeBundles) expect(notes).toContain(bundle.replace('dist/', ''));
  });
});

/**
 * Claude Code reaches the server through the standalone host, which replaces
 * the process environment with an allow-list. A name the child reads and the
 * list omits is a setting the owner can export and watch do nothing.
 */
describe('standalone host environment forwarding', () => {
  it('forwards the relay and opener names the MCP child reads', async () => {
    const host = await readFile(resolve(repositoryRoot, 'plugin/scripts/serve-inspection.ts'), 'utf8');
    const child = await readFile(resolve(repositoryRoot, 'plugin/src/inspection-quest-link.ts'), 'utf8');
    const opener = await readFile(resolve(repositoryRoot, 'plugin/src/quest-launch.ts'), 'utf8');
    expect(child).toContain('STEREOFOLD_CLOUDFLARED');
    expect(opener).toContain('STEREOFOLD_OPENER');
    expect(host).toContain("'STEREOFOLD_CLOUDFLARED','STEREOFOLD_OPENER'");
    expect(host).toContain('...relayEnvironment');
  });
});

/**
 * Every host on this machine runs its own copy of `dist/`, and a wearer cannot
 * see which. One number is the answer everywhere: the identity the bundles
 * hash into themselves at build time. These assertions keep the launcher, the
 * doctor, the skill and the kit naming the same thing, so a reader comparing
 * two hosts is comparing the same field.
 */
describe('one build identity across the hosts', () => {
  it('prints the build line from the launcher and the doctor', async () => {
    const [launcher, doctor] = await Promise.all([
      readFile(resolve(repositoryRoot, 'plugin/scripts/quest-share.ts'), 'utf8'),
      readFile(resolve(repositoryRoot, 'plugin/scripts/setup-doctor.ts'), 'utf8'),
    ]);
    expect(launcher).toContain('formatBuildIdentities(report.build.stamps)');
    expect(doctor).toContain('formatBuildIdentities(report.build.stamps)');
    // The doctor reads the shipped bundles rather than trusting a timestamp.
    expect(doctor).toContain('readStampedBuildId');
  });

  it('tells the owner release docs and kit to compare it with the mounted panel', async () => {
    const [release, kit] = await Promise.all([
      readFile(resolve(repositoryRoot, 'docs/release.md'), 'utf8'),
      readFile(resolve(repositoryRoot, 'harness/kits/claude-code.md'), 'utf8'),
    ]);
    for (const text of [release, kit]) {
      expect(text).toContain('build · viewer');
      expect(text).toContain('diagnostics.viewerBuild');
    }
    // Recipients have the share identity, not the repository launcher.
    const skill = await readFile(resolve(repositoryRoot, 'plugin/claude-code/skills/stereofold-quest/SKILL.md'), 'utf8');
    expect(skill).toContain('diagnostics.viewerBuild');
    expect(skill).toContain('`viewer:` line in the share\'s `SHARE.md`');
  });
});

/**
 * The recognizer the implementation picks, in the documents a new user reads.
 * `transcriberKind` answers Apple on a Mac that has the helper built, and the
 * documents said the opposite for long enough to send someone installing a
 * whisper model they did not need.
 */
describe('the documented push-to-talk default matches the code', () => {
  const documents = [
    'plugin/claude-code/skills/stereofold-quest/SKILL.md',
    'plugin/skills/stereo-structure/SKILL.md',
    'harness/kits/claude-code.md',
    'harness/kits/codex-personal-plugin.md',
    'docs/install.md',
    'docs/headset-walkthrough.md',
    'plugin/README.md',
  ];

  it('never calls Apple opt-in or whisper the default', async () => {
    for (const relative of documents) {
      const text = (await readFile(resolve(repositoryRoot, relative), 'utf8')).toLowerCase();
      expect(text, relative).not.toContain('whisper is the default');
      expect(text, relative).not.toContain('whisper remains the default');
      // `STEREOFOLD_PTT_TRANSCRIBER=apple` as the only way to reach Apple is
      // the same claim written as a command.
      expect(text, relative).not.toContain('with `stereofold_ptt_transcriber=apple`, whenever');
    }
  });

  it('keeps the selection rule the code implements in the source that states it', async () => {
    const implementation = await readFile(resolve(repositoryRoot, 'plugin/src/push-to-talk-transcribe.ts'), 'utf8');
    // Unset on macOS with the helper present is Apple; everything else whisper.
    expect(implementation).toContain("if (platform !== 'darwin') return 'whisper';");
    expect(implementation).toContain("? 'apple' : 'whisper'");
    const voice = await readFile(resolve(repositoryRoot, 'plugin/skills/stereo-structure/references/voice.md'), 'utf8');
    expect(voice).toContain('STEREOFOLD_PTT_TRANSCRIBER');
    expect(voice).toContain('selects Apple on macOS');
    expect(voice).toMatch(/helper is\s+built/u);
    expect(voice).toContain('Whisper otherwise');
  });
});
