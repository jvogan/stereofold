import { readInlineHtml } from '../src/inline-html.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { stampedBuildId } from '../src/build-identity.js';
import { demoLessonPaths, type DemoIndexLike } from './demo-lesson-paths.js';

const execFileAsync = promisify(execFile);

const REQUIRED_FILES = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'INSPECTOR.md',
  'LICENSE',
  'QUICKSTART.md',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'assets/icon-256.png',
  'assets/logo-1024.png',
  'assets/oauth-transcribe.py',
  // Claude Code reads `.claude-plugin/` and Codex reads `.codex-plugin/`, and
  // both install this whole directory, so the two hosts run one build of
  // `dist/server.mjs`. The Quest skill is Claude Code's alone: Codex reads
  // `skills/` only, and the Claude Code manifest adds `claude-code/skills/`.
  '.claude-plugin/plugin.json',
  '.claude-plugin/icon.png',
  'claude-code/skills/stereofold-quest/SKILL.md',
  'codex/INSTALL.md',
  // Growth reads `../demos/index.json` beside the bundle, so the demo index
  // travels with the share rather than only with a checkout.
  'demos/index.json',
  'dist/inspector.html',
  'dist/inspector.css',
  'dist/inspector-host.js',
  'dist/server.mjs',
  'dist/headset-host.mjs',
  'dist/serve-inspection.mjs',
  // The Unix-socket relay QUICKSTART names for sandboxed hosts, run with
  // node alone from the share.
  'dist/scene-socket-relay.mjs',
  'dist/viewer.html',
  'dist/molstar/molstar.js',
  'dist/molstar/molstar.css',
  'dist/molstar/LICENSE',
  // The Swift speech tool travels as source and a build script, so the Apple
  // voice route exists for a share recipient and not only for someone working
  // in a checkout.
  'native/applespeech/transcribe.swift',
  'native/applespeech/Info.plist',
  'native/applespeech/build.sh',
  'skills/stereo-structure/SKILL.md',
  'skills/molecular-presentation/SKILL.md',
  'skills/molecular-presentation/scripts/lesson.mjs',
  // A share is handed to someone whose machine has never run this. The setup
  // skill and its bare-`node` check are what they read first, so a share
  // without them is a share that assumes the recipient already knows.
  'skills/stereofold-setup/SKILL.md',
  'skills/stereofold-setup/scripts/setup-check.mjs',
] as const;

// Exact recipient paths from the audited share tree. Extensions alone are not
// sufficient: lesson JSON must not admit unrelated credential JSON. New shipped
// files require an explicit addition here and coverage in the packaging fixture.
const ALLOWED_ARTIFACT_FILES = new Set<string>([
  // The build stamp lets setup-doctor answer fresh/stale by content on an
  // installed copy; older builds have none, so it is allowed, not required.
  'dist/build-inputs.json',
  'skills/stereo-structure/references/commands.md',
  'skills/stereo-structure/references/handoffs.md',
  'skills/stereo-structure/references/headsets.md',
  'skills/stereo-structure/references/stereo-viewer.md',
  'skills/stereo-structure/references/voice.md',
  'skills/stereofold-setup/references/hosts.md',
  'skills/stereofold-setup/references/voice.md',

  ...REQUIRED_FILES,
  'demos/README.md',
  'demos/atp-synthase.json',
  'demos/crispr-cas9.json',
  'demos/daraxonrasib.json',
  'demos/glucose-transporter.json',
  'demos/hemoglobin.json',
  'demos/microtubule-arrival/build.json',
  'demos/microtubule-arrival/density.json',
  'demos/microtubule-growth/dimer.json',
  'demos/microtubule-growth/filament.json',
  'demos/microtubule-growth/monomer.json',
  'demos/microtubule-growth/protofilament.json',
  'demos/microtubule-growth/tip.json',
  'demos/microtubule-growth/tube.json',
  'demos/microtubule-growth/wall.json',
  'demos/microtubule-lattice.json',
  'demos/nucleosome.json',
  'demos/spike.json',
  'demos/telomerase-haca.json',
  'demos/tubulin-dimer.json',
  'skills/molecular-presentation/assets/9kj6-guided.json',
  'skills/molecular-presentation/assets/9qb3-guided.json',
  'skills/molecular-presentation/assets/9ax6-daraxonrasib.json',
  'skills/molecular-presentation/assets/LICENSE',
  'skills/molecular-presentation/assets/ZOD-LICENSE',
  'skills/molecular-presentation/assets/own-molecule-guided.json',
  'skills/stereofold-setup/scripts/open-check.mjs',
  'skills/stereofold-setup/scripts/setup-check.d.mts',
  // Accepted as a release input only; copyTree omits this local build.
  'native/applespeech/bin/applespeech',
]);

const REQUIRED_DIRECTORIES = [
  '.claude-plugin',
  '.codex-plugin',
  'assets',
  'claude-code',
  'codex',
  'demos',
  'dist',
  'native',
  'skills',
] as const;

const ALLOWED_TOP_LEVEL_ENTRIES = new Set([
  '.claude-plugin',
  '.codex-plugin',
  '.mcp.json',
  'INSPECTOR.md',
  'LICENSE',
  'QUICKSTART.md',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'assets',
  'claude-code',
  'codex',
  'demos',
  'dist',
  'native',
  'skills',
]);

/**
 * The one staged input a share does not carry.
 *
 * `scripts/release.ts` copies `native/` whole, so a `bin/applespeech` built
 * before staging rides along into the release artifact. That is right for the
 * artifact, which is the build machine's own. It is wrong for a share, which is a
 * file handed to someone else: the binary is an unsigned Mach-O for whichever
 * architecture happened to build it, the repository already treats it as
 * output rather than source (`plugin/.gitignore` excludes it), and the
 * recipient reproduces it in one step with `sh native/applespeech/build.sh`.
 * Leaving it out also keeps the archive checksum a function of source alone.
 */
const EXCLUDED_FROM_SHARE = ['native/applespeech/bin'];

const ARCHIVE_NAME = 'stereofold-marketplace.tar.gz';
const ARCHIVE_CHECKSUM_NAME = `${ARCHIVE_NAME}.sha256`;
const CHECKSUM_NAME = 'SHA256SUMS';
const SHARE_GUIDE_NAME = 'SHARE.md';
const MARKETPLACE_NAME = 'stereofold-local';
const CODEX_MARKETPLACE_PATH = '.agents/plugins/marketplace.json';
/**
 * Claude Code reads its own marketplace file and never the Codex one.
 *
 * A share that carried only `.agents/plugins/marketplace.json` answered
 * `claude plugin marketplace add` with "Marketplace file not found", so the
 * documented Claude Code route had no command that worked. Both descriptors
 * name the same share root and the same plugin directory, `plugins/stereofold`.
 * Claude Code copies that directory into its own plugin cache and expands
 * `${CLAUDE_PLUGIN_ROOT}` to the copy, which is why the Claude Code manifest
 * sits at the artifact root beside `dist/`: a plugin rooted one level down was
 * copied without `dist/` and had no server to start.
 */
const CLAUDE_MARKETPLACE_PATH = '.claude-plugin/marketplace.json';
const CLAUDE_PLUGIN_SOURCE = './plugins/stereofold';
const CLAUDE_SERVER_ARGS = ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs'];

export interface PackageShareOptions {
  artifact: string;
  output: string;
}

export interface PackageShareResult {
  archive: string;
  archiveChecksum: string;
  checksums: string;
  claudeMarketplace: string;
  marketplace: string;
  output: string;
  plugin: string;
}

interface PluginManifest {
  name?: unknown;
  version?: unknown;
  interface?: {
    displayName?: unknown;
  };
}

interface McpConfig {
  mcpServers?: {
    stereo_structure?: {
      command?: unknown;
      args?: unknown;
      cwd?: unknown;
    };
  };
}

interface ClaudeManifest {
  name?: unknown;
  mcpServers?: {
    stereo_structure?: { command?: unknown; args?: unknown };
  };
}

interface MarketplaceDescriptor {
  name: string;
  interface: { displayName: string };
  plugins: Array<{
    name: string;
    source: { source: 'local'; path: './plugins/stereofold' };
    policy: { installation: 'AVAILABLE'; authentication: 'ON_INSTALL' };
    category: 'Education & Research';
  }>;
}

interface ClaudeMarketplaceDescriptor {
  name: string;
  owner: { name: string };
  metadata: { description: string; version: string };
  plugins: Array<{
    name: string;
    source: typeof CLAUDE_PLUGIN_SOURCE;
    description: string;
    version: string;
  }>;
}

export { demoLessonPaths } from './demo-lesson-paths.js';
export type { DemoIndexLike } from './demo-lesson-paths.js';

async function requireRegularFile(root: string, relativePath: string): Promise<void> {
  const path = resolve(root, relativePath);
  const details = await lstat(path).catch(() => undefined);
  if (details == null) throw new Error(`Release artifact is missing ${relativePath}.`);
  if (details.isSymbolicLink()) throw new Error(`Release artifact contains a symlink at ${relativePath}.`);
  if (!details.isFile()) throw new Error(`Release artifact entry ${relativePath} is not a regular file.`);
}

async function requireDirectory(root: string, relativePath: string): Promise<void> {
  const path = resolve(root, relativePath);
  const details = await lstat(path).catch(() => undefined);
  if (details == null) throw new Error(`Release artifact is missing ${relativePath}/.`);
  if (details.isSymbolicLink()) throw new Error(`Release artifact contains a symlink at ${relativePath}/.`);
  if (!details.isDirectory()) throw new Error(`Release artifact entry ${relativePath} is not a directory.`);
}

async function walkRegularFiles(
  root: string,
  allowedFiles?: ReadonlySet<string>,
  directory = root,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name);
    const relativePath = relative(root, absolutePath).split(sep).join('/');
    const details = await lstat(absolutePath);
    if (details.isSymbolicLink()) throw new Error(`Release artifact contains a symlink at ${relativePath}.`);
    // Validate directories too, including empty ones. Only ancestors of an
    // explicitly named recipient file can be traversed.
    if (allowedFiles != null && !(details.isDirectory()
      ? [...allowedFiles].some(file => file.startsWith(`${relativePath}/`))
      : allowedFiles.has(relativePath))) {
      throw new Error(`Release artifact contains forbidden share entry: ${relativePath}.`);
    }
    if (details.isDirectory()) {
      files.push(...await walkRegularFiles(root, allowedFiles, absolutePath));
    } else if (details.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Release artifact contains a non-regular entry at ${relativePath}.`);
    }
  }
  return files.sort();
}

async function validateArtifact(artifactRoot: string): Promise<PluginManifest> {
  const details = await lstat(artifactRoot).catch(() => undefined);
  if (details == null) throw new Error(`Release artifact does not exist: ${artifactRoot}`);
  if (details.isSymbolicLink()) throw new Error('Release artifact root must not be a symlink.');
  if (!details.isDirectory()) throw new Error(`Release artifact is not a directory: ${artifactRoot}`);
  if (basename(artifactRoot) !== 'stereofold') {
    throw new Error(`Release artifact directory must be named stereofold (received ${basename(artifactRoot)}).`);
  }

  for (const entry of await readdir(artifactRoot, { withFileTypes: true })) {
    if (!ALLOWED_TOP_LEVEL_ENTRIES.has(entry.name)) {
      throw new Error(`Release artifact contains an unallowlisted top-level entry: ${entry.name}.`);
    }
  }
  for (const requiredDirectory of REQUIRED_DIRECTORIES) await requireDirectory(artifactRoot, requiredDirectory);
  for (const requiredFile of REQUIRED_FILES) await requireRegularFile(artifactRoot, requiredFile);

  // Every lesson the demo index lists travels too: a grow reads the target
  // tier's lesson from beside the index, so an artifact with the index but
  // without a lesson fails mid-session instead of at packaging time.
  const demoIndex = JSON.parse(
    await readFile(resolve(artifactRoot, 'demos/index.json'), 'utf8'),
  ) as DemoIndexLike;
  for (const lesson of demoLessonPaths(demoIndex)) {
    await requireRegularFile(artifactRoot, `demos/${lesson}`);
  }

  const files = await walkRegularFiles(artifactRoot, ALLOWED_ARTIFACT_FILES);
  if (files.some((file) => file === 'package.json' || file.startsWith('node_modules/'))) {
    throw new Error('Release artifact must not contain package.json or node_modules.');
  }
  if (files.some((file) => file.startsWith('src/') || file.startsWith('test/'))) {
    throw new Error('Release artifact must not contain development source or tests.');
  }

  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(await readFile(resolve(artifactRoot, '.codex-plugin/plugin.json'), 'utf8')) as PluginManifest;
  } catch (error) {
    throw new Error('Release artifact manifest is not valid JSON.', { cause: error });
  }
  if (manifest.name !== 'stereofold') throw new Error(`Manifest name must be stereofold, received ${String(manifest.name)}.`);
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('Manifest version must be a non-empty string.');
  }
  if (manifest.interface?.displayName !== 'Stereofold') {
    throw new Error('Manifest interface.displayName must be Stereofold.');
  }

  let mcp: McpConfig;
  try {
    mcp = JSON.parse(await readFile(resolve(artifactRoot, '.mcp.json'), 'utf8')) as McpConfig;
  } catch (error) {
    throw new Error('Release artifact .mcp.json is not valid JSON.', { cause: error });
  }
  if (JSON.stringify(mcp.mcpServers?.stereo_structure) !== JSON.stringify({
    command: 'node',
    args: ['./dist/server.mjs'],
    cwd: '.',
  })) {
    throw new Error('Release artifact .mcp.json does not point at ./dist/server.mjs.');
  }

  let claude: ClaudeManifest;
  try {
    claude = JSON.parse(await readFile(resolve(artifactRoot, '.claude-plugin/plugin.json'), 'utf8')) as ClaudeManifest;
  } catch (error) {
    throw new Error('Release artifact Claude Code manifest is not valid JSON.', { cause: error });
  }
  if (claude.name !== 'stereofold') {
    throw new Error(`Claude Code manifest name must be stereofold, received ${String(claude.name)}.`);
  }
  if (JSON.stringify(claude.mcpServers?.stereo_structure) !== JSON.stringify({ command: 'node', args: CLAUDE_SERVER_ARGS })) {
    throw new Error('Release artifact Claude Code manifest does not start ${CLAUDE_PLUGIN_ROOT}/dist/server.mjs.');
  }

  return manifest;
}

async function copyTree(sourceRoot: string, targetRoot: string, prefix = ''): Promise<void> {
  await mkdir(targetRoot, { recursive: true });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const sourcePath = resolve(sourceRoot, entry.name);
    const targetPath = resolve(targetRoot, entry.name);
    const relativePath = `${prefix}${entry.name}`;
    if (EXCLUDED_FROM_SHARE.includes(relativePath)) continue;
    const details = await lstat(sourcePath);
    if (details.isSymbolicLink()) throw new Error(`Cannot package symlinked release input ${relative(sourceRoot, sourcePath)}.`);
    if (details.isDirectory()) {
      await copyTree(sourcePath, targetPath, `${relativePath}/`);
    } else if (details.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    } else {
      throw new Error(`Cannot package non-regular release input ${relative(sourceRoot, sourcePath)}.`);
    }
  }
}

function marketplaceDescriptor(): MarketplaceDescriptor {
  return {
    name: MARKETPLACE_NAME,
    interface: { displayName: 'Stereofold local' },
    plugins: [{
      name: 'stereofold',
      source: { source: 'local', path: './plugins/stereofold' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Education & Research',
    }],
  };
}

function claudeMarketplaceDescriptor(version: string): ClaudeMarketplaceDescriptor {
  return {
    name: MARKETPLACE_NAME,
    owner: { name: 'Stereofold Contributors' },
    metadata: {
      description: 'Local Stereofold share: the same plugin directory Codex installs, with its shipped MCP server.',
      version,
    },
    plugins: [{
      name: 'stereofold',
      source: CLAUDE_PLUGIN_SOURCE,
      description: 'Registers the shipped stereo_structure MCP server, its skills, and the headset skill for Claude Code, including Meta Quest, Apple Vision Pro and other WebXR headset browsers.',
      version,
    }],
  };
}

/**
 * The revision the share was built from, when the artifact sits in a checkout.
 *
 * A share is a complete local delivery: its recipient installs from the share
 * without cloning the repository. The commit identifies a delivery in a problem
 * report and tells two shares apart when their versions match. A build outside a
 * checkout records nothing rather than guessing.
 */
export async function sourceRevision(artifactRoot: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', artifactRoot, 'rev-parse', 'HEAD']);
    const commit = stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(commit)) return undefined;
    const { stdout: dirty } = await execFileAsync('git', ['-C', artifactRoot, 'status', '--porcelain']);
    return dirty.trim().length === 0 ? commit : `${commit} (built with uncommitted changes)`;
  } catch {
    return undefined;
  }
}

export function shareGuide(version: string, builds: { inspector: string; viewer: string; commit?: string }): string {
  return `# Stereofold local share

This directory is a generated, local distribution of the complete Stereofold
plugin artifact (version ${version}). It does not publish anything and it does
not modify a Codex or Claude profile by itself.

Build identity:

- viewer: \`${builds.viewer}\`
- inspector: \`${builds.inspector}\`
${builds.commit ? `- source commit: \`${builds.commit}\`\n` : ''}
The first two are the self-stamped bundle identities from the shipped HTML
files; use them when comparing a mounted panel with this share.${builds.commit
    ? '\n\nThe source commit identifies this delivery when reporting a problem.'
    : ''}

## Requirements

The staged server requires Node.js 22 or newer. **Connect over Wi-Fi** also
needs \`openssl\` at a fixed runtime location to create the private LAN certificate, plus
an assigned RFC1918 IPv4 address on the intended interface. OpenSSL searches
\`/usr/bin/openssl\`, \`/opt/homebrew/bin/openssl\`, \`/usr/local/bin/openssl\`,
then \`/bin/openssl\`; it has no PATH fallback or environment override.
**Send using Meta**
requires an already installed \`cloudflared\` executable on the host PATH, or
an absolute executable path in \`STEREOFOLD_CLOUDFLARED\`; Stereofold never
downloads or updates it. The Meta route is an explicit public HTTPS relay.

Headset push-to-talk on a Mac uses Apple's on-device recognizer, which is one
compile step away and is *not* shipped compiled: a Mach-O built on one Mac is
the wrong file to hand another one. Build it in the extracted plugin:

\`\`\`sh
sh plugins/stereofold/native/applespeech/build.sh
\`\`\`

The setup skill lists the fixed helper paths, PATH fallbacks and absolute
\`STEREOFOLD_FFMPEG_BIN\`, \`STEREOFOLD_WHISPER_BIN\` and
\`STEREOFOLD_APPLESPEECH_BIN\` overrides. Spoken replies have no ffmpeg PATH
fallback; set its override for a nonstandard installation.

Both transcription routes require \`ffmpeg\` on the host. Without the Apple
helper the host transcribes with \`whisper-cli\`, which also needs a readable
model named by \`STEREOFOLD_WHISPER_MODEL\`. Set \`STEREOFOLD_PTT_TRANSCRIBER=whisper\` to stay
on whisper on a Mac that has the Apple helper built.

Setting \`STEREOFOLD_PTT_TRANSCRIBE=1\` in the MCP server environment is
recommended to make transcription explicit; restart the host after changing it.
Unset, the runtime auto-detects a local transcriber: an Apple helper with \`ffmpeg\` or a complete Whisper route enables transcription, and readiness reports the
local recognizer resolved (Apple still needs Speech Recognition consent).
With none detected, voice stays off and readiness names the missing prerequisites;
no headset speech is transcribed. With \`=1\` and no transcriber, readiness
instead reports the missing prerequisites. \`0\` explicitly turns transcription
off. Recording still requires microphone permission and a held talk control.
Keep an already configured spoken-reply provider. On a Mac without an OAuth narration helper, set \`STEREOFOLD_REPLY_VOICE_PROVIDER=system\`; it uses local \`say\` and
\`ffmpeg\`. Do not change a working OAuth setup during transcription setup or silently switch providers after a failed reply. The runtime's unset reply provider is OAuth, whose narration
helper Stereofold does not ship; without it, replies are captions with no sound.
Follow \`plugins/stereofold/QUICKSTART.md\` for consent and readiness checks.

## Two hosts, one plugin directory

Codex reads \`plugins/stereofold/.codex-plugin/plugin.json\` and Claude Code
reads \`plugins/stereofold/.claude-plugin/plugin.json\`. Both install the whole
\`plugins/stereofold/\` directory and both start the same \`dist/server.mjs\`,
so the two hosts run one build. The build identities above are the check:
every host should report the same pair.

## Verify the share

Run this from the extracted share directory:

\`\`\`sh
shasum -a 256 -c SHA256SUMS
# Linux alternative:
sha256sum -c SHA256SUMS
\`\`\`

The archive contains this checksum manifest, so an archive-only recipient can
extract it and verify the complete marketplace root. When the adjacent archive
sidecar is available, verify the outer archive before extracting it:

\`\`\`sh
shasum -a 256 -c stereofold-marketplace.tar.gz.sha256
\`\`\`

## Use the local Codex marketplace

The generated root contains \`.agents/plugins/marketplace.json\` and
\`plugins/stereofold/\`. The descriptor uses Codex's local marketplace shape
and the relative source \`./plugins/stereofold\`:

\`\`\`sh
codex plugin marketplace add /absolute/path/to/stereofold-share
codex plugin marketplace list --json
codex plugin add stereofold@stereofold-local
\`\`\`

The last command installs into the selected Codex profile. Run these commands
only on the machine and profile where you want the plugin installed. The
packager itself performs no installation, profile write, or marketplace
registration.

## Use the local Claude Code marketplace

Claude Code reads \`.claude-plugin/marketplace.json\`, which this root carries
beside the Codex descriptor. The plugin it installs registers the shipped
\`stereo_structure\` MCP server, loads the same skills Codex reads, and adds the
\`stereofold-quest\` skill for a paired headset.

\`\`\`sh
claude plugin marketplace add /absolute/path/to/stereofold-share
claude plugin install stereofold@${MARKETPLACE_NAME}
\`\`\`

Claude Code opens the bundled panel in this Mac's browser through
\`stereo_structure.open_inspector\`, so the first scene can be saved from Claude Code alone.
Follow \`plugins/stereofold/claude-code/skills/stereofold-quest/SKILL.md\`
for the scene and headset steps. Codex can also render the same panel inside
its own window.

## Use the artifact with Claude Science

Claude Science does not consume the Codex marketplace descriptor. Add one
object to the \`servers\` array in \`~/.claude-science/mcp/local-mcp.json\`,
keeping every entry already there, then restart it and reconnect the connector:

\`\`\`json
{
  "name": "stereofold",
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/stereofold-share/plugins/stereofold/dist/server.mjs"],
  "env": {}
}
\`\`\`

Both paths are absolute because that daemon runs with a stripped PATH, which is
also why every optional helper it should reach has to be named in \`env\`.
\`plugins/stereofold/skills/stereofold-setup/SKILL.md\` covers the whole route,
including which variable turns on which feature.

Keep the \`.agents\` descriptor for Codex; do not copy it into Claude's MCP
configuration. Physical Quest entry remains a separate hardware qualification
and is not established by this local package check.
`;
}

async function sha256(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function buildIdentity(path: string, label: string): Promise<string> {
  const identity = stampedBuildId(await readInlineHtml(path));
  if (identity == null) throw new Error(`${label} must carry exactly one self-consistent build identity.`);
  return identity;
}

async function writeChecksums(root: string): Promise<void> {
  const files = await walkRegularFiles(root);
  const included = files.filter((file) => file !== CHECKSUM_NAME);
  const lines = await Promise.all(included.map(async (file) => `${await sha256(resolve(root, file))}  ${file}`));
  const checksums = `${lines.join('\n')}\n`;
  await writeFile(resolve(root, CHECKSUM_NAME), checksums, 'utf8');
}

async function ensureOutputIsSafe(outputRoot: string, artifactRoot: string): Promise<void> {
  const outputDetails = await lstat(outputRoot).catch(() => undefined);
  if (outputDetails?.isSymbolicLink()) throw new Error('Output directory must not be a symlink.');
  if (outputDetails != null && !outputDetails.isDirectory()) throw new Error(`Output path is not a directory: ${outputRoot}`);
  if (outputDetails != null) throw new Error(`Output path already exists: ${outputRoot}`);

  const artifactReal = await resolveRealPath(artifactRoot);
  const outputParentReal = await resolveRealPath(dirname(outputRoot));
  const prospectiveOutput = resolve(outputParentReal, basename(outputRoot));
  if (prospectiveOutput === artifactReal || prospectiveOutput.startsWith(`${artifactReal}${sep}`)) {
    throw new Error('Output directory must be outside the release artifact.');
  }
}

async function resolveRealPath(path: string): Promise<string> {
  const details = await lstat(path).catch(() => undefined);
  if (details != null) {
    if (details.isSymbolicLink()) throw new Error(`Path must not be a symlink: ${path}`);
    return resolve(path);
  }
  const parent = dirname(path);
  if (parent === path) return resolve(path);
  return resolve(await resolveRealPath(parent), basename(path));
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value == null || value.startsWith('--')) return undefined;
  return value;
}

export async function packageShare(options: PackageShareOptions): Promise<PackageShareResult> {
  if (isAbsolute(options.artifact) === false) {
    throw new Error(`Artifact path must be absolute after resolution; received ${options.artifact}.`);
  }
  if (isAbsolute(options.output) === false) {
    throw new Error(`Output path must be absolute after resolution; received ${options.output}.`);
  }
  const artifactRoot = resolve(options.artifact);
  const outputRoot = resolve(options.output);
  const manifest = await validateArtifact(artifactRoot);
  await ensureOutputIsSafe(outputRoot, artifactRoot);

  const outputParent = dirname(outputRoot);
  await mkdir(outputParent, { recursive: true });
  const stageRoot = await mkdtemp(join(outputParent, `.${basename(outputRoot)}.stage-`));
  try {
    const pluginRoot = resolve(stageRoot, 'plugins/stereofold');
    await copyTree(artifactRoot, pluginRoot);
    const [viewerBuild, inspectorBuild] = await Promise.all([
      buildIdentity(resolve(pluginRoot, 'dist/viewer.html'), 'Viewer bundle'),
      buildIdentity(resolve(pluginRoot, 'dist/inspector.html'), 'Inspector bundle'),
    ]);
    const marketplacePath = resolve(stageRoot, CODEX_MARKETPLACE_PATH);
    await mkdir(dirname(marketplacePath), { recursive: true });
    await writeFile(marketplacePath, `${JSON.stringify(marketplaceDescriptor(), null, 2)}\n`, 'utf8');
    const claudeMarketplacePath = resolve(stageRoot, CLAUDE_MARKETPLACE_PATH);
    await mkdir(dirname(claudeMarketplacePath), { recursive: true });
    await writeFile(
      claudeMarketplacePath,
      `${JSON.stringify(claudeMarketplaceDescriptor(String(manifest.version)), null, 2)}\n`,
      'utf8',
    );
    await writeFile(resolve(stageRoot, SHARE_GUIDE_NAME), shareGuide(String(manifest.version), {
      commit: await sourceRevision(artifactRoot),
      inspector: inspectorBuild,
      viewer: viewerBuild,
    }), 'utf8');

    const archivePath = resolve(stageRoot, ARCHIVE_NAME);
    await writeChecksums(stageRoot);
    // Native tar records the builder's account and filesystem metadata.
    // The portable writer keeps recipient bytes while clearing those headers.
    await execFileAsync('python3', [
      fileURLToPath(new URL('./share-archive.py', import.meta.url)),
      archivePath,
      stageRoot,
      '.agents',
      '.claude-plugin',
      'plugins',
      SHARE_GUIDE_NAME,
      CHECKSUM_NAME,
    ]);
    const archiveChecksumPath = resolve(stageRoot, ARCHIVE_CHECKSUM_NAME);
    await writeFile(archiveChecksumPath, `${await sha256(archivePath)}  ${ARCHIVE_NAME}\n`, 'utf8');

    await rename(stageRoot, outputRoot);
    return {
      archive: resolve(outputRoot, ARCHIVE_NAME),
      archiveChecksum: resolve(outputRoot, ARCHIVE_CHECKSUM_NAME),
      checksums: resolve(outputRoot, CHECKSUM_NAME),
      claudeMarketplace: resolve(outputRoot, CLAUDE_MARKETPLACE_PATH),
      marketplace: resolve(outputRoot, CODEX_MARKETPLACE_PATH),
      output: outputRoot,
      plugin: resolve(outputRoot, 'plugins/stereofold'),
    };
  } catch (error) {
    await rm(stageRoot, { force: true, recursive: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const artifact = argument('--artifact') ?? resolve(pluginRoot, 'release/stereofold');
  const output = argument('--out');
  if (output == null) throw new Error('Usage: package-share.ts --out /absolute/path/to/share [--artifact /absolute/path/to/stereofold].');
  const result = await packageShare({ artifact: resolve(artifact), output: resolve(output) });
  console.log(`SHARE PACKAGE ${result.output}`);
  console.log(`MARKETPLACE ${result.marketplace}`);
  console.log(`CLAUDE MARKETPLACE ${result.claudeMarketplace}`);
  console.log(`PLUGIN ${result.plugin}`);
  console.log(`ARCHIVE ${result.archive}`);
  console.log(`ARCHIVE CHECKSUM ${result.archiveChecksum}`);
  console.log(`CHECKSUMS ${result.checksums}`);
}

const invokedScript = process.argv[1] == null ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedScript === import.meta.url) void main();
