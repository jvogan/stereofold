/**
 * An acceptance test, run on this Mac without a second Mac.
 *
 * A fresh Claude Code or Codex installation is handed the plugin and asked to
 * open a structure. It has to finish local setup from the shipped instructions
 * alone. The three things that make that claim false on a developer machine
 * are a warm home directory, a rich PATH, and a Python the user installed
 * years ago, so this script takes all three away:
 *
 *   HOME  a fresh temporary directory, so `~/.stereofold/config.json` starts absent
 *   PATH  one temporary directory holding symlinks to node, pnpm and npx only
 *   PATH  no python3, so `scripts/safe-directory-swap.py` and the voice route
 *         are both out of reach of the simulated user
 *
 * Staging the release runs first, in the ordinary environment, because that is
 * the maintainer's step: the fresh user receives the artifact, they do not
 * build it. Everything after it runs inside the stripped environment.
 *
 * Every step carries the command that recovers it, and the first failure ends
 * the run with that line, because a fresh user reading three failures cannot
 * tell which one caused the other two.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { stageRelease } from './release.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const execFileAsync = promisify(execFile);

/** The only programs the simulated machine can run. */
export const FRESH_PATH_COMMANDS = ['node', 'pnpm', 'npx'] as const;
/** The setup command the shipped skill issues first, from the artifact root. */
export const SETUP_CHECK_ENTRY = 'skills/stereofold-setup/scripts/setup-check.mjs';
/** The command section 6 issues to prove an open, also from the artifact root. */
export const OPEN_CHECK_ENTRY = 'skills/stereofold-setup/scripts/open-check.mjs';

export type StepFailure = { step: string; reason: string; recovery: string };

class FreshUserFailure extends Error {
  constructor(readonly failure: StepFailure) {
    super(`${failure.step}: ${failure.reason}`);
  }
}

/** Fail this step and stop, naming the one command that recovers it. */
function fail(step: string, reason: string, recovery: string): never {
  throw new FreshUserFailure({ step, reason, recovery });
}

async function step<T>(name: string, recovery: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof FreshUserFailure) throw error;
    fail(name, (error as Error).message, recovery);
  }
}

/**
 * A PATH with three programs on it.
 *
 * Symlinks rather than copies, so the simulated machine runs the same node and
 * pnpm this one does; what changes is that nothing else is reachable.
 */
async function makeFreshPath(binDirectory: string): Promise<Record<string, string>> {
  await mkdir(binDirectory, { recursive: true });
  const resolved: Record<string, string> = {};
  for (const command of FRESH_PATH_COMMANDS) {
    const found = command === 'node' ? process.execPath : await which(command);
    if (found == null) {
      fail('build a fresh machine', `${command} is not on this Mac's PATH, so the simulation cannot offer it`,
        command === 'pnpm' ? 'npm install -g pnpm' : `install ${command} and run this check again`);
    }
    await symlink(found, join(binDirectory, command));
    resolved[command] = found;
  }
  return resolved;
}

async function which(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/which', [command], { encoding: 'utf8' });
    const path = stdout.trim().split('\n')[0];
    return path && isAbsolute(path) ? path : undefined;
  } catch { return undefined; }
}

/** The environment the simulated user's processes see. Nothing is inherited. */
export function freshEnvironment(binDirectory: string, home: string): NodeJS.ProcessEnv {
  return {
    PATH: binDirectory,
    HOME: home,
    TMPDIR: join(home, 'tmp'),
    LANG: 'C',
    NODE_PATH: '',
    NODE_OPTIONS: '',
  };
}

async function runFresh(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }):
Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd, env: options.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 600_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message ?? '',
    };
  }
}

/** Check the delivered runtime before the fresh-user flow launches it. */
export async function assertFreshRuntime(artifact: string): Promise<void> {
  const files = await readdir(join(artifact, 'dist'));
  for (const required of ['server.mjs', 'viewer.html', 'inspector.html', 'inspector.css', 'inspector-host.js']) {
    assert.ok(files.includes(required), `the artifact is missing dist/${required}`);
  }
}

export type FreshUserReport = {
  artifact: string;
  home: string;
  setupBlock: string;
  storedConfig: Record<string, unknown>;
  toolCount: number;
  structureRoute: string;
  notes: string[];
};

export async function freshUserCheck({ keep = false }: { keep?: boolean } = {}): Promise<FreshUserReport> {
  const notes: string[] = [];

  const staged = await step('stage the release',
    'pnpm --dir plugin run release',
    async () => stageRelease(pluginRoot));

  // macOS hands out `/var/folders/...` and resolves it to `/private/var/...`,
  // so a path written here would never equal the one the child process reports.
  const created = await mkdtemp(join(tmpdir(), 'stereofold-fresh-user-'));
  const sandbox = await realpath(created);
  try {
    const home = join(sandbox, 'home');
    const binDirectory = join(sandbox, 'bin');
    await mkdir(join(home, 'tmp'), { recursive: true });
    const commands = await step('build a fresh machine',
      'install node and pnpm, then run this check again',
      async () => makeFreshPath(binDirectory));
    const environment = freshEnvironment(binDirectory, home);
    notes.push(`PATH is ${binDirectory} alone: ${FRESH_PATH_COMMANDS.map((name) => `${name} -> ${commands[name]}`).join(', ')}`);

    await step('prove the machine has no python3',
      'remove python3 from the temporary bin directory',
      async () => {
        const present = await readdir(binDirectory);
        assert.deepEqual(present.sort(), [...FRESH_PATH_COMMANDS].sort(),
          `the temporary bin holds more than the three allowed commands: ${present.join(', ')}`);
        const probe = await runFresh(process.execPath, ['-e',
          'process.stdout.write(String(require("node:child_process").spawnSync("python3",["-V"]).error?.code ?? "found"))'],
        { cwd: sandbox, env: environment });
        assert.equal(probe.stdout.trim(), 'ENOENT', `python3 was reachable from the stripped PATH: ${probe.stdout}`);
        notes.push('python3 is unreachable: spawning it returns ENOENT');
      });

    // The fresh user extracts an archive; they do not run the packager.
    const artifact = join(home, 'stereofold');
    await step('deliver the plugin',
      'pnpm --dir plugin exec tsx scripts/package-share.ts --out /absolute/path/to/share',
      async () => { await cp(staged.artifact, artifact, { recursive: true }); });

    const setup = await step('run the shipped setup check',
      `node ${SETUP_CHECK_ENTRY}`,
      async () => runFresh(process.execPath, [SETUP_CHECK_ENTRY], { cwd: artifact, env: environment }));
    if (setup.code !== 0) {
      const blockedLine = setup.stdout.split('\n').find((line) => line.includes('fix: ')) ?? setup.stderr.trim();
      fail('run the shipped setup check',
        `setup-check exited ${setup.code}\n${setup.stdout.trimEnd()}`,
        blockedLine.replace(/^\s*fix:\s*/u, ''));
    }
    const setupBlock = setup.stdout.trimEnd();
    assert.ok(setupBlock.includes('release artifact'), 'setup-check did not recognise the delivered artifact');

    const storedConfig = await step('store the configuration',
      `node ${SETUP_CHECK_ENTRY} writes ~/.stereofold/config.json; check that HOME is writable`,
      async () => {
        const path = join(home, '.stereofold/config.json');
        const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        assert.equal(stored.stereofoldRoot, artifact, 'the stored root is not the delivered artifact');
        assert.equal(stored.serverEntry, join(artifact, 'dist/server.mjs'), 'the stored server entry is wrong');
        assert.equal(stored.python3Bin, undefined, 'a machine with no python3 must not have a python3Bin setting');
        return stored;
      });
    notes.push(`optional features stayed off: ${setupBlock.split('\n').at(-1)?.trim() ?? ''}`);

    await step('install and build only when needed',
      'pnpm install && pnpm --dir plugin run build',
      async () => {
        await assertFreshRuntime(artifact);
        const entries = await readdir(artifact);
        assert.equal(entries.includes('package.json'), false, 'a release artifact must carry no package.json');
        assert.equal(entries.includes('node_modules'), false, 'a release artifact must carry no node_modules');
        notes.push('no install and no build: the artifact ships dist/ and depends on nothing');
      });

    const registration = await step('register the local MCP connection',
      'copy .mcp.json from the artifact and give the host an absolute path to dist/server.mjs',
      async () => {
        const mcp = JSON.parse(await readFile(join(artifact, '.mcp.json'), 'utf8')) as {
          mcpServers?: { stereo_structure?: { command?: string; args?: string[]; cwd?: string } };
        };
        const server = mcp.mcpServers?.stereo_structure;
        assert.ok(server != null, '.mcp.json registers no stereo_structure server');
        assert.equal(server.command, 'node');
        assert.deepEqual(server.args, ['./dist/server.mjs']);
        return { command: 'node', args: [join(artifact, 'dist/server.mjs')], cwd: artifact };
      });

    // Everything below this line drives the server through the MCP SDK, which
    // only a checkout has. The fresh user has the shipped command instead, so
    // run that first and on its own terms: if it cannot open the fixture here,
    // nothing the SDK proves afterwards is available to them.
    await step('run the shipped open check',
      `node ${OPEN_CHECK_ENTRY}`,
      async () => {
        const opened = await runFresh(process.execPath, [OPEN_CHECK_ENTRY], { cwd: artifact, env: environment });
        assert.equal(opened.code, 0,
          `open-check exited ${opened.code}\n${opened.stdout.trimEnd()}\n${opened.stderr.trimEnd()}`);
        assert.ok(opened.stdout.includes('OPEN PASS'),
          `open-check did not report OPEN PASS\n${opened.stdout.trimEnd()}`);
        notes.push('the shipped open check opened the fixture with no package.json and no MCP SDK');
      });

    const client = new Client({ name: 'Stereofold fresh-user check', version: '0.1.0' });
    let childStderr = '';
    const transport = new StdioClientTransport({
      command: join(binDirectory, 'node'),
      args: registration.args,
      cwd: registration.cwd,
      env: environment as Record<string, string>,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk) => { childStderr += String(chunk); });

    try {
      await step('start the registered server',
        `cd ${artifact} && node ./dist/server.mjs`,
        async () => {
          try { await client.connect(transport); } catch (error) {
            throw new Error(`${(error as Error).message}${childStderr === '' ? '' : `\n${childStderr}`}`);
          }
        });

      const toolCount = await step('list the tools',
        'restart the server and read its stderr; a tools/list failure means the bundle did not load',
        async () => {
          const listed = await client.listTools();
          assert.ok(listed.tools.some((tool) => tool.name === 'stereo_structure.open'),
            'the server advertised no stereo_structure.open');
          return listed.tools.length;
        });

      const structureRoute = await step('open a structure',
        'call stereo_structure.open with {"fixture":"three-depth-markers"}',
        async () => {
          const opened = await client.callTool({
            name: 'stereo_structure.open', arguments: { fixture: 'three-depth-markers' },
          });
          assert.equal(opened.isError, undefined, `open returned an error: ${JSON.stringify(opened.content)}`);
          const state = opened.structuredContent as { sessionId?: string; hasStructure?: boolean };
          assert.equal(state.hasStructure, true, 'the opened session holds no structure');
          assert.ok(typeof state.sessionId === 'string' && state.sessionId.length > 0, 'open returned no sessionId');

          const cached = await client.callTool({
            name: 'stereo_structure.get_structure', arguments: { sessionId: state.sessionId },
          });
          assert.equal((cached.structuredContent as { empty?: boolean }).empty, false,
            'the session cached no coordinates for the panel to hydrate');
          const priv = (cached._meta as Record<string, { fixture?: string }> | undefined)?.['stereo_structure/structure'];
          assert.equal(priv?.fixture, 'three-depth-markers', 'the cached source is not the bundled fixture');
          return 'bundled fixture three-depth-markers: no network request, no PDB id';
        });

      await step('read the viewer resource',
        'rebuild the artifact; ui://stereo-structure/viewer is generated by pnpm --dir plugin run build',
        async () => {
          const resource = await client.readResource({ uri: 'ui://stereo-structure/viewer' });
          const first = resource.contents[0];
          const html = first != null && 'text' in first ? String(first.text) : '';
          assert.ok(html.includes('Stereofold'), 'the viewer resource is not the Stereofold viewer');
          assert.equal(/<script[^>]+src=["']https?:\/\//iu.test(html), false, 'the viewer loads a remote script');
        });

      return { artifact, home, setupBlock, storedConfig, toolCount, structureRoute, notes };
    } finally {
      await client.close().catch(() => undefined);
    }
  } finally {
    if (!keep) await rm(created, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');
  try {
    const report = await freshUserCheck({ keep });
    console.log(report.setupBlock);
    console.log('');
    for (const note of report.notes) console.log(`- ${note}`);
    console.log(`- stored ${Object.keys(report.storedConfig).sort().join(', ')} in <fresh home>/.stereofold/config.json`);
    console.log(`- the registered server advertised ${report.toolCount} tools`);
    console.log(`- opened ${report.structureRoute}`);
    console.log('');
    console.log('PASS — a fresh machine with only node, pnpm and npx completed setup and opened a structure.');
  } catch (error) {
    if (error instanceof FreshUserFailure) {
      console.error(`FAIL ${error.failure.step}`);
      console.error(error.failure.reason);
      console.error(`recovery: ${error.failure.recovery}`);
    } else {
      console.error('FAIL before the first step');
      console.error((error as Error).stack ?? (error as Error).message);
    }
    process.exitCode = 1;
  }
}

const invokedScript = process.argv[1] == null ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedScript === import.meta.url) void main();

export { FreshUserFailure };
export const freshPathDelimiter = delimiter;
