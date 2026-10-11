import { access, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const safeDirectorySwap = resolve(pluginRoot, 'scripts/safe-directory-swap.py');
const execFileAsync = promisify(execFile);

/**
 * Codex and Claude Code install this one directory, each through its own
 * manifest.
 *
 * Codex reads `.codex-plugin/plugin.json`, which points at `.mcp.json`,
 * `skills/` and `dist/server.mjs`. Claude Code reads `.claude-plugin/plugin.json`
 * at the same root, which starts the same `dist/server.mjs` through
 * `${CLAUDE_PLUGIN_ROOT}`, reads the same `skills/`, and adds
 * `claude-code/skills/` for the Quest skill. Both manifests are staged at the
 * root: Claude Code copies the plugin directory into its cache, so a manifest
 * staged one level down was copied without `dist/` and had no server to start.
 */
export const releaseEntries = [
  '.claude-plugin',
  '.codex-plugin',
  '.mcp.json',
  'LICENSE',
  'README.md',
  // The one page a newcomer needs, and the reason it is staged rather than
  // linked: a release that points at the repository's docs for its first five
  // minutes hands an installed plugin a path its user does not have.
  'QUICKSTART.md',
  'INSPECTOR.md',
  'THIRD_PARTY_NOTICES.md',
  'assets',
  'claude-code',
  'codex',
  // Growth reads `../demos/index.json` beside the bundle
  // (`src/molecular-growth.ts`), and Claude Science runs the release
  // artifact's `dist/server.mjs` rather than a checkout, so the demo index
  // and every lesson it lists travel with the artifact. Coordinates stay
  // downloads: they live in the demo cache, never here.
  'demos',
  'dist',
  // The Swift speech tool, as source and a build script. A Codex user runs
  // from this directory, so without it the Apple voice route would exist only
  // for people working in a repository checkout. What ships is the source: the
  // staging helper copies a tree whole, so a `native/applespeech/bin` that was
  // built before staging rides along, and one that was not is built in place
  // with `sh native/applespeech/build.sh`.
  'native',
  // Two kinds of skill travel here. `stereo-structure` and
  // `molecular-presentation` are read mid-session, once the plugin already
  // works. `stereofold-setup` is read before it does, and carries the one
  // command a fresh agent can run on bare `node`:
  // `skills/stereofold-setup/scripts/setup-check.mjs`. It is plain ESM for
  // that reason — this artifact has no `package.json`, no `node_modules` and
  // no `scripts/`, so a setup step written in TypeScript could not run here.
  'skills',
] as const;

export interface StageReleaseResult {
  artifact: string;
  contents: string[];
  output: string;
}

/**
 * Stage one plugin source tree into its own `release/stereofold`.
 *
 * `source` exists so a test can stage a real tree into a temporary directory
 * rather than swapping this checkout's artifact: the staging helper insists
 * the target sit at `<source>/release/stereofold`, so a temporary target means
 * a temporary source. That keeps the packaging test on the same entry list and
 * the same copy path a release uses, instead of a second list that can drift
 * from this one.
 */
export async function stageRelease(source = pluginRoot): Promise<StageReleaseResult> {
  const sourceRoot = resolve(source);
  const releaseRoot = resolve(sourceRoot, 'release', 'stereofold');
  const manifest = JSON.parse(await readFile(resolve(sourceRoot, '.codex-plugin/plugin.json'), 'utf8')) as {
    name?: unknown;
  };
  if (manifest.name !== 'stereofold') {
    throw new Error(`Manifest name must be stereofold, received ${String(manifest.name)}.`);
  }

  // The helper opens the plugin root and release parent component-by-component
  // with O_NOFOLLOW, copies only regular inputs relative to held descriptors,
  // and exclusively renames the complete sibling into place. The prior
  // generated artifact is retained as a recovery sibling; nothing is removed
  // recursively through a pathname.
  const { stdout } = await execFileAsync('python3', [
    safeDirectorySwap,
    'release',
    '--source', sourceRoot,
    '--expected-source', sourceRoot,
    '--target', releaseRoot,
    '--expected-target', releaseRoot,
    ...releaseEntries.flatMap((entry) => ['--entry', entry]),
  ]);

  const contents = (await readdir(releaseRoot)).sort();
  await access(resolve(releaseRoot, 'dist/server.mjs'));
  return { artifact: releaseRoot, contents, output: stdout };
}

async function main(): Promise<void> {
  const staged = await stageRelease();
  process.stdout.write(staged.output);
  console.log(`RELEASE STAGED ${staged.artifact}`);
  console.log(`RELEASE CONTENTS ${staged.contents.join(', ')}`);
}

const invokedScript = process.argv[1] == null ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedScript === import.meta.url) void main();
