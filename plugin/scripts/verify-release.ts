import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = resolve(pluginRoot, '..');
const execFileAsync = promisify(execFile);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function walk(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    const relative = absolute.slice(root.length + 1);
    const details = await lstat(absolute);
    assert.equal(details.isSymbolicLink(), false, `release artifact contains a symlink: ${relative}`);
    if (details.isDirectory()) files.push(...await walk(root, absolute));
    else files.push(relative);
  }
  return files.sort();
}

import { demoLessonPaths } from './demo-lesson-paths.js';

export { demoLessonPaths } from './demo-lesson-paths.js';
export type { DemoIndexLike } from './demo-lesson-paths.js';

export async function verifyLayout(artifactRoot: string): Promise<void> {
  const files = await walk(artifactRoot);
  // The Claude directory reads each installed file, including the inline
  // browser runtime. Reject an artifact that cannot enter that review flow.
  for (const file of files) {
    const details = await lstat(resolve(artifactRoot, file));
    assert.ok(details.size < 5 * 1024 * 1024,
      `release file must be below the Claude directory 5 MiB limit: ${file}`);
  }
  for (const required of [
    '.codex-plugin/plugin.json',
    '.mcp.json',
    'LICENSE',
    'README.md',
    // A release whose first-run page is missing sends the user back to a
    // checkout they do not have.
    'QUICKSTART.md',
    'INSPECTOR.md',
    'THIRD_PARTY_NOTICES.md',
    'assets/icon-256.png',
    'assets/logo-1024.png',
    'assets/oauth-transcribe.py',
    '.claude-plugin/plugin.json',
    '.claude-plugin/icon.png',
    'claude-code/skills/stereofold-quest/SKILL.md',
    'codex/INSTALL.md',
    // Growth resolves `../demos/index.json` beside the bundle, and Claude
    // Science runs this artifact rather than a checkout, so a release without
    // the demo index opens but can never grow a staged lesson.
    'demos/index.json',
    'dist/server.mjs',
    'dist/headset-host.mjs',
    'dist/serve-inspection.mjs',
    'dist/scene-socket-relay.mjs',
    'dist/viewer.html',
    'dist/inspector.html',
    'dist/inspector.css',
    'dist/inspector-host.js',
    'dist/molstar/molstar.js',
    'dist/molstar/molstar.css',
    'dist/molstar/LICENSE',
    // Headset voice on a Mac needs no whisper install, but it does need this
    // one compile step, so the source and its build script travel with the
    // artifact rather than only with a checkout.
    'native/applespeech/transcribe.swift',
    'native/applespeech/Info.plist',
    'native/applespeech/build.sh',
    'skills/stereo-structure/SKILL.md',
    'skills/molecular-presentation/SKILL.md',
    'skills/molecular-presentation/scripts/lesson.mjs',
    // The setup skill is the one an agent reads before the plugin works, so
    // its check has to run on bare `node`: this artifact carries no
    // `package.json`, no `node_modules` and no `scripts/`.
    'skills/stereofold-setup/SKILL.md',
    'skills/stereofold-setup/scripts/setup-check.mjs',
  ]) {
    assert.ok(files.includes(required), `release artifact is missing ${required}`);
  }
  // Every lesson the index lists travels too: a grow reads the target tier's
  // lesson from beside the index, so a release with the index but without a
  // tier's lesson fails the grow mid-session instead of at verify time.
  const demoIndex = JSON.parse(await readFile(resolve(artifactRoot, 'demos/index.json'), 'utf8'));
  for (const lesson of demoLessonPaths(demoIndex)) {
    assert.ok(files.includes(`demos/${lesson}`), `release artifact is missing demos/${lesson}`);
  }
  assert.equal(files.some((file) => file === 'package.json' || file.startsWith('node_modules/')), false,
    'release artifact must not depend on package.json or node_modules');
  assert.equal(files.some((file) => file.startsWith('src/') || file.startsWith('test/')), false,
    'release artifact must not contain development source or tests');

  const manifest = JSON.parse(await readFile(resolve(artifactRoot, '.codex-plugin/plugin.json'), 'utf8')) as {
    name?: unknown;
    license?: unknown;
    skills?: unknown;
    mcpServers?: unknown;
    interface?: { composerIcon?: unknown; logo?: unknown; defaultPrompt?: unknown };
  };
  assert.equal(manifest.name, 'stereofold');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(manifest.interface?.composerIcon, './assets/icon-256.png');
  assert.equal(manifest.interface?.logo, './assets/logo-1024.png');
  const starterPrompts = manifest.interface?.defaultPrompt;
  assert.ok(Array.isArray(starterPrompts) && starterPrompts.length > 0 && starterPrompts.length <= 3
    && starterPrompts.every(prompt => typeof prompt === 'string' && prompt.trim().length > 0),
  'Codex accepts at most three nonempty interface.defaultPrompt entries; larger lists are ignored');

  // The Claude Code manifest sits at the artifact root beside the Codex one,
  // because Claude Code copies the plugin directory into its cache and expands
  // `${CLAUDE_PLUGIN_ROOT}` to that copy: a manifest one level down was copied
  // without `dist/` and registered nothing that could start. It names the same
  // server Codex starts, reads the same `skills/`, and adds the Quest skill.
  const claudeCode = JSON.parse(await readFile(resolve(artifactRoot, '.claude-plugin/plugin.json'), 'utf8')) as {
    name?: unknown;
    license?: unknown;
    skills?: unknown;
    mcpServers?: { stereo_structure?: unknown };
  };
  assert.equal(claudeCode.name, 'stereofold');
  assert.equal(claudeCode.license, 'MIT');
  assert.deepEqual(claudeCode.skills, ['./skills/', './claude-code/skills/']);
  assert.deepEqual(claudeCode.mcpServers?.stereo_structure, {
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs'],
  }, 'the Claude Code plugin must start the shipped server from its own root');
  const questSkill = await readFile(resolve(artifactRoot, 'claude-code/skills/stereofold-quest/SKILL.md'), 'utf8');
  assert.ok(questSkill.startsWith('---'), 'the Claude Code skill must open with its frontmatter');
  assert.ok(/^name:\s*stereofold-quest$/mu.test(questSkill),
    'the Claude Code skill must declare name: stereofold-quest');

  const notices = await readFile(resolve(artifactRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const dependency of [
    '@modelcontextprotocol/ext-apps 1.7.5',
    '@modelcontextprotocol/sdk 1.29.0',
    'molstar 5.11.0',
    'zod 4.3.0',
  ]) {
    assert.ok(notices.includes(`## ${dependency}`), `third-party notices are missing ${dependency}`);
  }

  const mcp = JSON.parse(await readFile(resolve(artifactRoot, '.mcp.json'), 'utf8')) as {
    mcpServers?: { stereo_structure?: { command?: unknown; args?: unknown; cwd?: unknown } };
  };
  assert.deepEqual(mcp.mcpServers?.stereo_structure, {
    command: 'node',
    args: ['./dist/server.mjs'],
    cwd: '.',
  });
}

/**
 * These files `scripts/build.ts` writes from source. A staged copy is the
 * built copy or it is stale: the artifact is staged from `dist/`, so a rebuild
 * after staging leaves a release that launches an older server than the one
 * the checkout just tested, and a byte comparison is what catches that.
 */
const BUILT_BUNDLES = ['server.mjs', 'headset-host.mjs', 'serve-inspection.mjs', 'scene-socket-relay.mjs',
  'inspector-host.js', 'inspector.html', 'inspector.css', 'viewer.html'] as const;

/**
 * Every staged bundle is byte for byte the built one, and the staged server
 * registers the loopback panel tool, which a server built before that tool
 * existed cannot. Presence is `verifyLayout`'s check; this one reads content.
 */
export async function verifyBuiltCopies(artifactRoot: string, builtDist: string): Promise<void> {
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  for (const name of BUILT_BUNDLES) {
    const builtPath = resolve(builtDist, name);
    const built = await readFile(builtPath).catch(() => undefined);
    assert.ok(built != null, `built dist/${name} is missing at ${builtPath}; run the build before verifying a release`);
    const staged = await readFile(resolve(artifactRoot, 'dist', name));
    const [stagedDigest, builtDigest] = [digest(staged), digest(built)];
    assert.equal(stagedDigest, builtDigest,
      `release artifact dist/${name} differs from the built dist/${name} (staged ${stagedDigest.slice(0, 12)}, built ${builtDigest.slice(0, 12)}); rebuild and restage`);
  }
  const server = await readFile(resolve(artifactRoot, 'dist/server.mjs'), 'utf8');
  assert.ok(server.includes('stereo_structure.open_inspector'),
    'release artifact dist/server.mjs does not register stereo_structure.open_inspector; it was built before the panel host');
}

async function verifyServerLaunch(isolatedRoot: string, label: string): Promise<void> {
  const client = new Client({ name: 'Stereofold release verifier', version: '0.1.0' });
  let childStderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(isolatedRoot, 'dist/server.mjs')],
    cwd: isolatedRoot,
    env: {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'C',
      NODE_PATH: '',
      NODE_OPTIONS: '',
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => { childStderr += String(chunk); });

  assert.equal(await readdir(isolatedRoot).then((entries) => entries.includes('node_modules')), false,
    'isolated release unexpectedly contains node_modules');
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'stereo_structure.open'),
      'isolated server did not advertise stereo_structure.open');
    assert.ok(tools.tools.some((tool) => tool.name === 'stereo_structure.open_inspector'),
      'isolated server did not advertise stereo_structure.open_inspector');
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === 'ui://stereo-structure/viewer'),
      'isolated server did not advertise its viewer resource');
    const resource = await client.readResource({ uri: 'ui://stereo-structure/viewer' });
    const first = resource.contents[0];
    const html = first != null && 'text' in first ? first.text : undefined;
    if (typeof html !== 'string') throw new Error('viewer resource did not return HTML text');
    assert.ok(html.includes('Stereofold'));
    assert.ok(!/<script[^>]+src=["']https?:\/\//iu.test(html), 'viewer must not load remote scripts');
    assert.ok(!/<link[^>]+href=["']https?:\/\//iu.test(html), 'viewer must not load remote styles');
    const inspector=await client.readResource({uri:'ui://stereo-structure/inspector'});
    assert.ok(inspector.contents[0] && 'text' in inspector.contents[0] && inspector.contents[0].text.includes('Stereofold Inspector'));
    assert.ok(tools.tools.some(tool=>tool.name==='stereo_structure.inspect'));
    const coordinateText=await readFile(resolve(repositoryRoot,'fixtures/1CRN.cif'),'utf8');
    const opened=await client.callTool({name:'stereo_structure.inspect',arguments:{structureText:coordinateText}});
    assert.ok(!opened.isError,'Relocated inspector must extract a source without repository dependencies');
    const sessionId=(opened.structuredContent as {sessionId:string}).sessionId;
    const hydrated=await client.callTool({name:'stereo_structure.get_inspection',arguments:{sessionId}});
    const catalog=(hydrated._meta?.['stereo_structure/inspection'] as {catalog:{rows:unknown[]}})?.catalog;
    assert.equal(catalog?.rows.length,46,'Relocated server must privately hydrate the canonical catalog');
    assert.ok(!JSON.stringify(opened.structuredContent).includes('_atom_site'));

    console.log(`RELEASE LAUNCH PASS ${label}`);
  } catch (error) {
    throw new Error(`${label} server launch failed${childStderr === '' ? '' : `:\n${childStderr}`}`, { cause: error });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function verifyIsolatedLaunch(artifactRoot: string): Promise<void> {
  const temporaryParent = await mkdtemp(join(tmpdir(), 'stereofold-release-'));
  const isolatedRoot = resolve(temporaryParent, 'stereofold');
  try {
    await cp(artifactRoot, isolatedRoot, { recursive: true });
    await verifyServerLaunch(isolatedRoot, 'staged artifact temp copy');
  } finally {
    await rm(temporaryParent, { force: true, recursive: true });
  }
}

/**
 * Reconstruct the plugin from files Git currently tracks or would accept as
 * additions. This catches the easy-to-miss case where a local dist/ exists but
 * a parent .gitignore silently drops it from marketplace clones.
 */
async function verifyGitEligibleLaunch(): Promise<void> {
  const { stdout } = await execFileAsync('git', [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'plugin',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  const paths = stdout.split('\n').filter(Boolean);
  for (const required of [
    'plugin/.codex-plugin/plugin.json',
    'plugin/.mcp.json',
    'plugin/LICENSE',
    'plugin/QUICKSTART.md',
    'plugin/THIRD_PARTY_NOTICES.md',
    'plugin/assets/icon-256.png',
    'plugin/assets/logo-1024.png',
    'plugin/assets/oauth-transcribe.py',
    'plugin/.claude-plugin/plugin.json',
    'plugin/.claude-plugin/icon.png',
    'plugin/claude-code/skills/stereofold-quest/SKILL.md',
    'plugin/codex/INSTALL.md',
    'plugin/demos/index.json',
    'plugin/dist/server.mjs',
    'plugin/dist/viewer.html',
    'plugin/dist/inspector.html',
    'plugin/dist/inspector.css',
    'plugin/dist/inspector-host.js',
    'plugin/dist/molstar/molstar.js',
    'plugin/dist/molstar/molstar.css',
    'plugin/dist/molstar/LICENSE',
    'plugin/native/applespeech/transcribe.swift',
    'plugin/native/applespeech/Info.plist',
    'plugin/native/applespeech/build.sh',
    'plugin/skills/stereo-structure/SKILL.md',
    'plugin/skills/molecular-presentation/SKILL.md',
    'plugin/skills/molecular-presentation/scripts/lesson.mjs',
    'plugin/skills/stereofold-setup/SKILL.md',
    'plugin/skills/stereofold-setup/scripts/setup-check.mjs',
  ]) {
    assert.ok(paths.includes(required), `${required} is ignored and would be absent from a fresh clone`);
  }
  // The staged lessons travel in the artifact, so they must survive a fresh
  // clone too. The list comes from this checkout's index, matching what the
  // staged artifact check above requires of its own index.
  const gitDemoIndex = JSON.parse(
    await readFile(resolve(repositoryRoot, 'plugin/demos/index.json'), 'utf8'));
  for (const lesson of demoLessonPaths(gitDemoIndex)) {
    const required = `plugin/demos/${lesson}`;
    assert.ok(paths.includes(required), `${required} is ignored and would be absent from a fresh clone`);
  }

  const temporaryParent = await mkdtemp(join(tmpdir(), 'stereofold-git-package-'));
  try {
    for (const relative of paths) {
      const source = resolve(repositoryRoot, relative);
      const details = await lstat(source).catch(() => undefined);
      if (details == null || !details.isFile()) continue;
      const target = resolve(temporaryParent, relative);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
    await verifyServerLaunch(resolve(temporaryParent, 'plugin'), 'prospective Git checkout');
  } finally {
    await rm(temporaryParent, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const artifactRoot = resolve(argument('--artifact') ?? resolve(pluginRoot, 'release/stereofold'));
  assert.equal(basename(artifactRoot), 'stereofold', 'release artifact directory must be named stereofold');
  await verifyLayout(artifactRoot);
  await verifyBuiltCopies(artifactRoot, resolve(pluginRoot, 'dist'));
  await verifyIsolatedLaunch(artifactRoot);
  await verifyGitEligibleLaunch();
  console.log(`RELEASE VERIFY PASS ${artifactRoot}`);
  console.log('Staged artifact and prospective fresh Git checkout launched without node_modules.');
}

const invokedScript = process.argv[1] == null ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedScript === import.meta.url) void main();
