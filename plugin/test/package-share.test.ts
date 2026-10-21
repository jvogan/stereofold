import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createStereoStructureServer } from '../src/server.js';
import { detailedViewHtml } from '../src/detailed-view-page.js';
import { TOOL_SET_VERSION } from '../src/tool-text-state.js';
import { packageShare, shareGuide, sourceRevision, validateArtifact } from '../scripts/package-share.js';
import { releaseEntries, stageRelease } from '../scripts/release.js';
import { APP_ONLY_TOOL_NAMES, MODEL_VISIBLE_TOOL_NAMES } from '../scripts/tool-inventory.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

const execFileAsync = promisify(execFile);
const BUILD_PLACEHOLDER = 'stereofold-viewer-build-unstamped-000000000000000000000000000000';

const fixtureFiles: Record<string, string> = {
  '.codex-plugin/plugin.json': JSON.stringify({
    name: 'stereofold',
    version: '0.1.0',
    interface: { displayName: 'Stereofold' },
  }),
  '.mcp.json': JSON.stringify({
    mcpServers: {
      stereo_structure: { command: 'node', args: ['./dist/server.mjs'], cwd: '.' },
    },
  }),
  'INSPECTOR.md': 'inspection guide\n',
  'LICENSE': 'MIT License\n',
  'QUICKSTART.md': 'first run\n',
  'README.md': 'Stereofold\n',
  'THIRD_PARTY_NOTICES.md': 'notices\n',
  'assets/icon-256.png': 'icon\n',
  'assets/logo-1024.png': 'logo\n',
  'assets/oauth-transcribe.py': '#!/usr/bin/env python3\n',
  // The layout `scripts/release.ts` actually stages: both host plugins and the
  // Swift speech source, not the Codex half alone.
  '.claude-plugin/plugin.json': JSON.stringify({
    name: 'stereofold',
    version: '0.1.0',
    skills: ['./skills/', './claude-code/skills/'],
    mcpServers: { stereo_structure: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs'] } },
  }),
  '.claude-plugin/icon.png': 'claude icon\n',
  'claude-code/skills/stereofold-quest/SKILL.md': '---\nname: stereofold-quest\n---\n',
  'codex/INSTALL.md': 'install\n',
  'demos/index.json': JSON.stringify({
    version: 1,
    cacheDirectory: '~/Library/Caches/Stereofold/demos',
    demos: [{ name: 'fixture', lesson: 'hemoglobin.json' }, {
      name: 'microtubule-arrival', lesson: 'microtubule-arrival/build.json',
      stages: [{ lesson: 'microtubule-arrival/build.json' }, { lesson: 'microtubule-arrival/density.json' }],
    }],
  }),
  'demos/hemoglobin.json': '{"id":"fixture"}\n',
  'dist/inspector.html': '<!doctype html><p>inspector</p>\n',
  'dist/inspector.css': 'body{}\n',
  'dist/inspector-host.js': '(()=>{})();\n',
  'dist/inspector-script-1.js': '// fixed inspector chunk 1\n',
  'dist/inspector-script-2.js': '// fixed inspector chunk 2\n',
  'dist/server.mjs': 'export {};\n',
  'dist/headset-host.mjs': 'export {};\n',
  'dist/serve-inspection.mjs': 'export {};\n',
  'dist/scene-socket-relay.mjs': 'export {};\n',
  'dist/viewer.html': '<!doctype html><p>viewer</p>\n',
  'dist/molstar/molstar.js': 'export {};\n',
  'dist/molstar/molstar.css': '/* molstar */\n',
  'dist/molstar/LICENSE': 'MIT License\n',
  'native/applespeech/transcribe.swift': 'import Speech\n',
  'native/applespeech/Info.plist': '<plist/>\n',
  'native/applespeech/build.sh': '#!/bin/sh\n',
  // A Mach-O left behind by a local build. Staging copies `native/` whole, so
  // it reaches the artifact; the share must leave it there.
  'native/applespeech/bin/applespeech': 'not really a binary\n',
  'skills/stereo-structure/SKILL.md': '# Skill\n',
  'skills/molecular-presentation/SKILL.md': '# Presentation skill\n',
  'skills/molecular-presentation/scripts/lesson.mjs': 'export {};\n',
  'skills/molecular-presentation/references/live-authoring.md': '# Live authoring\n',
  // The setup skill and the one command a recipient can run before any
  // install. A share without them assumes the recipient already knows.
  'skills/stereofold-setup/SKILL.md': '# Setup skill\n',
  'skills/stereofold-setup/scripts/setup-check.mjs': 'export {};\n',
  // Remaining recipient files from the audited share tree. Keep every member
  // represented so recursive allowlisting cannot silently drop runtime assets.
  'demos/README.md': 'recipient fixture\n',
  'demos/atp-synthase.json': '{}\n',
  'demos/crispr-cas9.json': '{}\n',
  'demos/daraxonrasib.json': '{}\n',
  'demos/glucose-transporter.json': '{}\n',
  'demos/microtubule-arrival/build.json': '{"id":"microtubule-arrival-build"}\n',
  'demos/microtubule-arrival/density.json': '{"id":"microtubule-arrival-density"}\n',
  'demos/microtubule-growth/dimer.json': '{}\n',
  'demos/microtubule-growth/filament.json': '{}\n',
  'demos/microtubule-growth/monomer.json': '{}\n',
  'demos/microtubule-growth/protofilament.json': '{}\n',
  'demos/microtubule-growth/tip.json': '{}\n',
  'demos/microtubule-growth/tube.json': '{}\n',
  'demos/microtubule-growth/wall.json': '{}\n',
  'demos/microtubule-lattice.json': '{}\n',
  'demos/nucleosome.json': '{}\n',
  'demos/spike.json': '{}\n',
  'demos/telomerase-haca.json': '{}\n',
  'demos/tubulin-dimer.json': '{}\n',
  'skills/molecular-presentation/assets/9kj6-guided.json': '{}\n',
  'skills/molecular-presentation/assets/9qb3-guided.json': '{}\n',
  'skills/molecular-presentation/assets/LICENSE': 'recipient fixture\n',
  'skills/molecular-presentation/assets/ZOD-LICENSE': 'recipient fixture\n',
  'skills/molecular-presentation/assets/own-molecule-guided.json': '{}\n',
  'skills/stereofold-setup/scripts/open-check.mjs': 'recipient fixture\n',
  'skills/stereofold-setup/scripts/setup-check.d.mts': 'recipient fixture\n',
};

// Scan prose, code fences and link destinations, not only a manually selected
// set of links. Every local artifact token must resolve inside the staged share.
// Non-path slash prose and external/generated inputs are reviewed EXACT tokens;
// no extension or directory-prefix exemption can admit a new missing script.
const recipientPages = [
  'README.md', 'QUICKSTART.md', 'INSPECTOR.md', 'codex/INSTALL.md', 'demos/README.md',
  'skills/stereofold-setup/SKILL.md', 'skills/stereo-structure/SKILL.md',
  'skills/molecular-presentation/SKILL.md', 'claude-code/skills/stereofold-quest/SKILL.md',
];
const nonPathTokens = new Set([
  '/', '//', '/s', 'Node.js', '@stereo/anaglyph', '@stereo/geometry', '@stereo/motion',
  'Autoplay/Pause', 'Meta/Cloudflare', 'Next/Back', 'B/Y', 'PDB/mmCIF', 'WebM/Opus',
  'amplitude/period', 'axis/scale', 'front/back', 'left/right', 'px/inch', 'room/world',
  'stereo_structure/structure', 'Play/Pause', 'author/label', 'cartoon/sticks',
  'chain/element', 'fit/focus/orbit/dolly', 'identity/selection/viewpoint',
  'missing/evicted', 'rotation/pause', 'stereo_structure/inspection', 'H/ACA',
  'camera/style/selection', 'chain/component', 'inspect/open', 'saved/shared',
  'source/assembly', 'stereo/depth', 'Play/Next', 'Stereofold/Quest',
  'annotations/layers', 'appearance/placement', 'duration/frame', 'intent/session',
  'object/representation', 'public/source', 'session/pairing',
]);
const externalPaths: Record<string, string> = {
  '.agents/skills/': 'Codex project skill installation destination',
  '.claude/skills/': 'Claude Code project skill installation destination',
  '~/.claude/skills/': 'Claude Code personal skill installation destination',
  '~/.codex/skills/': 'default Codex skill installation destination',
  '/usr/bin/open': 'macOS browser opener',
  '/usr/bin/say': 'macOS system speech executable',
  ...Object.fromEntries(['/usr/bin/openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/bin/openssl',
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/homebrew/bin/applespeech', '/usr/local/bin/applespeech',
    '~/.cache/whisper-cpp/ggml-base.en.bin', 'release/stereofold']
    .map(path => [path, 'documented runtime tool or model lookup location'])),
  '~/.stereofold/config.json': 'recipient configuration, created by setup-check',
  '~/.stereofold': 'runtime directory the scene service and the socket relay share',
  '~/.stereofold/scene-service.json': 'scene owner record written at runtime by continue_session',
  '~/.stereofold/scene-service.sock': 'Unix socket served at runtime by dist/scene-socket-relay.mjs',
  '~/.claude-science/mcp/local-mcp.json': 'optional host configuration',
  '~/.claude-science/config.toml': 'optional host sandbox configuration',
  '/absolute/path/to/home': 'Mac user home directory',
  '/absolute/path/to/home/.stereofold': 'Mac user scene-service directory',
  '/absolute/path/to/home/.stereofold/scene-service.json': 'scene owner record written at runtime',
  '/absolute/path/to/home/.stereofold/scene-service.sock': 'Unix socket served at runtime',
  'jvogan/stereofold': 'GitHub marketplace source for a repository install',
  'plugin/': 'plugin directory in a clone of the repository',
  '/absolute/path/to/stereofold/plugin/dist/server.mjs': 'server path in a clone of the repository',
  '~/Downloads': 'recipient download directory',
  '~/Downloads/9KJ6.cif': 'public coordinates downloaded by the adjacent curl example',
  '~/Library/Caches/Stereofold/demos': 'runtime coordinate download cache',
  'native/applespeech/bin/applespeech': 'generated locally by the shipped Swift build script',
  'ggml-base.en.bin': 'separately obtained Whisper model',
  'stereofold-oauth-auth.py': 'explicitly unbundled optional OAuth module',
  '/absolute/path/to/': 'placeholder notation explained in the install instructions',
  '/absolute/path/to/node': 'discovered Node executable',
  '/absolute/path/to/readable/ggml-model.bin': 'separately obtained Whisper model',
  '/absolute/path/to/state.molj': 'recipient state export',
  'lesson.json': 'user-created planner input',
  'new-lesson.json': 'new planner output',
  'new-plan.json': 'new planner output',
};
// These placeholders denote delivered files, so check their suffixes too.
const sharePlaceholders: Record<string, string> = {
  '/absolute/path/to/stereofold-share': '.',
  '/absolute/path/to/stereofold': 'plugins/stereofold',
  '/absolute/path/to/stereofold-marketplace.tar.gz': 'stereofold-marketplace.tar.gz',
  '/absolute/path/to/plugins/stereofold/dist/server.mjs': 'plugins/stereofold/dist/server.mjs',
  '/absolute/path/to/stereofold/dist/server.mjs': 'plugins/stereofold/dist/server.mjs',
  '/absolute/path/to/stereofold/dist/headset-host.mjs': 'plugins/stereofold/dist/headset-host.mjs',
  'plugin/dist/headset-host.mjs': 'plugins/stereofold/dist/headset-host.mjs',
  '/absolute/path/to/stereofold-share/plugins/stereofold/dist/server.mjs': 'plugins/stereofold/dist/server.mjs',
  '/absolute/path/to/stereofold-share/plugins/stereofold/dist/headset-host.mjs': 'plugins/stereofold/dist/headset-host.mjs',
  '/absolute/path/to/stereofold-share/plugins/stereofold/dist/scene-socket-relay.mjs': 'plugins/stereofold/dist/scene-socket-relay.mjs',
  '/absolute/path/to/stereofold-share/plugins/stereofold': 'plugins/stereofold',
  '/absolute/path/to/stereofold-share/plugins/stereofold/skills/stereofold-setup/scripts/setup-check.mjs': 'plugins/stereofold/skills/stereofold-setup/scripts/setup-check.mjs',
};

// --root locates the installation only after Node has opened the script.
// Check the whole section so a claim following the command is covered too.
function relativeSetupCommandsFromAnywhere(markdown: string): string[] {
  return markdown.split(/^#{1,6}\s/gmu).flatMap(section => {
    if (!/from (?:anywhere|any (?:working )?(?:directory|folder))/iu.test(section)) return [];
    return [...section.matchAll(/\bnode\s+(?:"([^"]+)"|'([^']+)'|([^\s`]+))/gu)]
      .map(match => match[1] ?? match[2] ?? match[3])
      .filter(script => script.endsWith('/setup-check.mjs') && !script.startsWith('/'));
  });
}
function pathTokens(markdown: string): string[] {
  const withoutUris = markdown.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s`)]+/giu, '');
  const tokens = [...withoutUris.matchAll(
    /(?:[~@.$\w<>-]+\/|\/)[~@.$\w<>/{}-]*|[\w.-]+\.(?:md|mjs|cjs|js|ts|py|sh|json|html|css|pdb|cif|bin|swift|plist|png|jpg|gz)(?![\w.-])|\b(?:SHA256SUMS|LICENSE|node_modules)\b/gu,
  )].map(match => match[0].replace(/\.+$/u, ''));
  // Markdown destinations may use arbitrary extensions; always check them.
  const links = [...withoutUris.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)]
    .map(match => match[1].split('#')[0]).filter(Boolean);
  return [...new Set([...tokens, ...links])];
}
async function missingRecipientPaths(markdown: string, page: string, share: string): Promise<string[]> {
  const plugin = resolve(share, 'plugins/stereofold');
  const pageRoot = page === 'SHARE.md' ? share : dirname(resolve(plugin, page));
  const missing: string[] = [];
  for (const token of pathTokens(markdown)) {
    if (nonPathTokens.has(token) || externalPaths[token]) continue;
    const candidates = sharePlaceholders[token]
      ? [resolve(share, sharePlaceholders[token])]
      : token.startsWith('../') ? [resolve(pageRoot, token)]
        : [resolve(pageRoot, token), resolve(plugin, token), resolve(share, token)];
    const found = await Promise.all(candidates.map(async candidate => {
      const within = relative(share, candidate);
      if (within === '..' || within.startsWith('../') || within.startsWith('/')) return false;
      return Boolean(await lstat(candidate).catch(() => undefined));
    }));
    if (!found.some(Boolean)) missing.push(token);
  }
  return missing;
}

// Walk the release entry list so a new shipped skill, script or demo joins the
// guard automatically. Bundles, binary art and third-party licenses are not
// recipient instructions; their packaging is checked separately below.
async function recipientSourceFiles(): Promise<Array<{ page: string; text: string }>> {
  const files: Array<{ page: string; text: string }> = [];
  async function visit(page: string): Promise<void> {
    if (page === 'dist') return;
    const path = resolve(pluginRoot, page);
    const info = await lstat(path);
    if (info.isDirectory()) {
      for (const child of await readdir(path)) await visit(`${page}/${child}`);
    } else if (/\.(?:md|json|mjs|mts|py|sh|swift)$/u.test(page)
      && page !== 'THIRD_PARTY_NOTICES.md') {
      files.push({ page, text: await readFile(path, 'utf8') });
    }
  }
  for (const entry of releaseEntries) await visit(entry);
  // This generated page carries source comments inside the server bundle.
  files.push({ page: 'detailed-view.html', text: detailedViewHtml() });
  files.push({ page: 'SHARE.md', text: shareGuide('0.1.0', {
    viewer: 'viewer', inspector: 'inspector', commit: 'a'.repeat(40),
  }) });
  return files;
}

const recipientRegressionRules = [
  { name: 'OAuth-required wording', applies: (page: string) => page.endsWith('.md'),
    forbidden: /(?:only to.{0,60}OAuth transcription|replies use short OAuth|(?:requires?|needs?|must use) OAuth (?:transcription|replies)|OAuth (?:transcription|replies) (?:is |are )?(?:required|mandatory))/iu },
  { name: 'wrong Whisper model name', applies: (_page: string) => true,
    forbidden: /ggml-small\.en\.bin/u },
  { name: 'app-only tools in shipped skills', applies: (page: string) => page.endsWith('/SKILL.md'),
    forbidden: new RegExp(`\\b(?:${APP_ONLY_TOOL_NAMES.map(name => name.split('.')[1]).join('|')})\\b`, 'u') },
  { name: 'development recovery in shipped scripts and skills',
    applies: (page: string) => page.includes('/scripts/') || page.endsWith('/SKILL.md') || /\.(?:py|sh|swift)$/u.test(page),
    forbidden: /\bpnpm\b|\bcheck[ -]?out\b|workspace (?:dependencies|dependency|build)|workspace-build/iu },
  { name: 'internal campaign and test wording', applies: (_page: string) => true,
    forbidden: /\bcampaigns?\b|scratchpad|human-evaluation|numeric[- ]test|numeric geometry checks|tested preview|acceptance path|measured on (?:the rendered fixture|the same frame)|previous near-black|rules that cost a headset session/iu },
  { name: 'internal work labels', applies: (_page: string) => true,
    forbidden: /\blanes?\b|\bwaves?\b|\bcampaigns?\b|\b(?:review[\w-]*|[\w-]+-review[\w-]*|finalreview)\b|\b(?:acceptance|finish)[- ](?:lane|wave|review|campaign|pass|round|evidence)\b|(?:^|\n)\s*(?:(?:\/\/|\/\*+|\*|<!--)\s*)?(?:acceptance|finish)\s*:/iu },
  { name: 'internal wording in shipped skills', applies: (page: string) => page.includes('skills/'),
    forbidden: /\b(?:campaign|evidence|tested)\b/iu },
  { name: 'claims of delivered tests', applies: (_page: string) => true,
    forbidden: /\b(?:included|bundled|shipped)\s+tests?\b|\btests?\s+(?:(?:are|is)\s+)?(?:included|bundled|shipped)\b/iu },
  { name: 'internal timeout and qualification reports', applies: (page: string) => page.endsWith('.md'),
    forbidden: /native standard-viewer presentation request.*timed out|hardware qualification remains\s*pending|hardware remains unqualified|rules that (?:each )?cost a headset session/iu },
  { name: 'OpenSSL PATH readiness claim', applies: (page: string) => page.endsWith('.md'),
    forbidden: /(?:needs? |requires? )?`openssl`\s+on (?:the host )?PATH/iu },
  { name: 'dated capture and authoring notes',
    applies: (page: string) => page.startsWith('demos/') || page.endsWith('/SKILL.md'),
    forbidden: /\b20\d{2}-\d{2}-\d{2}\b|wearer[- ]view captures?|wearer[- ]captures?|\b(?:Rewritten|Reframed)\b|cas9frame/iu },
];

function recipientRegressionText(page: string, text: string, ruleName: string): string {
  if (page.endsWith('/SKILL.md') && ruleName === 'dated capture and authoring notes') {
    // A schema version is a runtime contract, not a dated authoring note.
    // Exempt only the exact current declaration; keep all other date checks.
    return text.replaceAll('`toolSetVersion: "' + TOOL_SET_VERSION + '"`', '`toolSetVersion`');
  }
  if (page !== '.codex-plugin/plugin.json' || ruleName !== 'internal work labels') return text;
  let manifest;
  try { manifest = JSON.parse(text); } catch { return text; }
  const extension = manifest?.extensions?.['com.openai'];
  const review = extension?.review;
  if (!review || typeof review !== 'object' || Array.isArray(review)
    || Object.hasOwn(extension, 'submission_metadata')) return text;
  // The official schema calls this object "review". Keep scanning its contents
  // and every other field; only normalize that exact key and this device role.
  delete extension.review;
  extension.submission_metadata = review;
  if (Array.isArray(review.test_cases?.positive)) {
    for (const testCase of review.test_cases.positive) {
      if (typeof testCase?.expected_behavior === 'string') {
        testCase.expected_behavior = testCase.expected_behavior.replaceAll(
          'The reviewer completes browser/certificate/pairing/immersive gestures on their device.',
          'The wearer completes browser/certificate/pairing/immersive gestures on their device.',
        );
      }
    }
  }
  return JSON.stringify(manifest, null, 2);
}

// These example placeholders stand for values returned by the preceding state
// read. Only the capability table declares automatic binding fields; a complete
// example elsewhere (and open_inspector before a panel exists) gets none added.
// The table's preamble names that convention in this sentence.
const BINDING_CONVENTION = 'The table shows only the action-specific arguments';
const exampleBinding = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  serverEpoch: '22222222-2222-4222-8222-222222222222',
  sourceToken: '33333333-3333-4333-8333-333333333333',
  baseStateRevision: 0, baseInspectionRevision: 0,
  panelId: '44444444-4444-4444-8444-444444444444', commandId: 'example-command',
};
function invalidToolExamples(markdown: string, tools: Tool[]): string[] {
  const errors: string[] = [];
  const validator = new AjvJsonSchemaValidator();
  const hasBindingConvention = markdown.includes(BINDING_CONVENTION);
  for (const [index, line] of markdown.split('\n').entries()) {
    // JSON arguments in Markdown tool tables or inline `tool` calls.
    const match = /`(?:stereo_structure\.)?([a-z]+_[a-z_]+|open|inspect|control|emphasize)`\s*(?:\|\s*|\(\s*)`?(\{[^`]*\})`?/u.exec(line);
    if (!match) continue;
    const [, name, json] = match;
    const tool = tools.find(tool => tool.name === `stereo_structure.${name}`);
    if (!tool || !MODEL_VISIBLE_TOOL_NAMES.some(publicName => publicName === tool.name)) {
      errors.push(`${index + 1}: ${name} is not a model-visible tool`);
      continue;
    }
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(json.replace(/"<sessionId>"/gu, JSON.stringify(exampleBinding.sessionId)));
    } catch {
      errors.push(`${index + 1}: ${name} has invalid JSON`);
      continue;
    }
    if (hasBindingConvention && line.startsWith('|') && name !== 'open_inspector') {
      for (const [key, value] of Object.entries(exampleBinding)) {
        if (tool.inputSchema.properties?.[key] && !(key in args)) args[key] = value;
      }
    }
    const result = validator.getValidator(tool.inputSchema)(args);
    if (!result.valid) errors.push(`${index + 1}: ${name}: ${result.errorMessage}`);
  }
  return errors;
}

describe('recipient regression classes', () => {
  it('pins every shipped skill to the runtime schema version without admitting dated notes', async () => {
    const declaration = '`toolSetVersion: "' + TOOL_SET_VERSION + '"`';
    const rule = recipientRegressionRules.find(rule => rule.name === 'dated capture and authoring notes')!;
    for (const name of ['stereo-structure', 'molecular-presentation', 'stereofold-setup']) {
      const page = `skills/${name}/SKILL.md`;
      const skill = await readFile(resolve(pluginRoot, page), 'utf8');
      expect(skill).toContain(declaration);
      expect(rule.forbidden.test(recipientRegressionText(page, declaration, rule.name))).toBe(false);
      for (const dated of ['Authored 2026-10-11', '`toolSetVersion: "2026-10-11.authoring.0"`']) {
        expect(rule.forbidden.test(recipientRegressionText(page, `${declaration}\n${dated}`, rule.name))).toBe(true);
      }
    }
    expect(rule.forbidden.test(recipientRegressionText('demos/example.json', declaration, rule.name))).toBe(true);
  });

  it('validates shipped tool examples against the live registry, including required arguments', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(resolve(pluginRoot, 'dist/viewer.html'));
    const client = new Client({ name: 'recipient example check', version: '1' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = (await client.listTools()).tools;
      const violations = (await recipientSourceFiles()).flatMap(({ page, text }) =>
        page.endsWith('.md') ? invalidToolExamples(text, tools).map(error => `${page}:${error}`) : []);
      expect(violations).toEqual([]);
      // No binding exemption may hide the original pre-panel missing sessionId.
      const preamble = BINDING_CONVENTION;
      expect(invalidToolExamples(`${preamble}\n| Session | Render | \`open_inspector\` | \`{}\` |`, tools))
        .toEqual([expect.stringContaining('sessionId')]);
      expect(invalidToolExamples('\`get_readiness\` | \`{}\`', tools))
        .toEqual([expect.stringContaining('sessionId')]);
      expect(invalidToolExamples('\`poll_inspection\` | \`{}\`', tools))
        .toEqual([expect.stringContaining('not a model-visible tool')]);
      expect(invalidToolExamples('\`open_inspector\` | \`{"sessionId":"<sessionId>"}\`', tools)).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

  it.each([
    ['internal work labels', 'review lane', 'release wave', 'review pass', 'campaign note', 'acceptance evidence', 'finish: polish'],
    ['internal wording in shipped skills', 'campaign', 'evidence', 'tested'],
    ['claims of delivered tests', 'The included tests verify projected geometry only.', 'Tests are included.', 'Bundled tests verify it.'],
    ['internal timeout and qualification reports', 'A native standard-viewer presentation request for a fixture timed out without acknowledgement.'],
    ['OpenSSL PATH readiness claim', 'needs `openssl` on the host PATH', 'needs `openssl`\non PATH'],
  ])('recognizes previous defects: %s', (name, ...examples) => {
    const rule = recipientRegressionRules.find(rule => rule.name === name)!;
    for (const text of examples) expect(rule.forbidden.test(text), text).toBe(true);
  });

  it('allows only official submission metadata terms and still detects internal prose', () => {
    const rule = recipientRegressionRules.find(rule => rule.name === 'internal work labels')!;
    const deviceAction = 'The reviewer completes browser/certificate/pairing/immersive gestures on their device.';
    const manifest = (expectedBehavior = deviceAction, extra: Record<string, unknown> = {}) => JSON.stringify({
      ...extra,
      extensions: { 'com.openai': { review: {
        test_cases: { positive: [{ expected_behavior: expectedBehavior }] },
      } } },
    });
    const catches = (text: string, page = '.codex-plugin/plugin.json') =>
      rule.forbidden.test(recipientRegressionText(page, text, rule.name));
    expect(catches(manifest())).toBe(false);
    expect(catches(manifest(deviceAction, { description: 'Internal review pass notes.' }))).toBe(true);
    expect(catches(manifest(deviceAction, { interface: { review: 'Internal notes.' } }))).toBe(true);
    expect(catches(manifest(`${deviceAction} Internal reviewer notes follow.`))).toBe(true);
    expect(catches(manifest('Finish the finalreview lane.'))).toBe(true);
    expect(catches(manifest(), 'README.md')).toBe(true);
    expect(catches('Internal reviewer notes.')).toBe(true);
  });

  it('requires an absolute setup-check script path for instructions that work from anywhere', async () => {
    const violations = (await recipientSourceFiles()).flatMap(({ page, text }) => page.endsWith('.md')
      ? relativeSetupCommandsFromAnywhere(text).map(command => `${page}: ${command}`) : []);
    expect(violations).toEqual([]);
    const relativeScript = 'skills/stereofold-setup/scripts/setup-check.mjs';
    for (const script of [relativeScript, `./${relativeScript}`, `"${relativeScript}"`]) {
      // The original defect put the claim and --root after the fenced command.
      expect(relativeSetupCommandsFromAnywhere(
        `## Discover\n\n\`\`\`sh\nnode ${script}\n\`\`\`\nRun it from inside the plugin. From anywhere else, pass the root:\n\`--root /absolute/path/to/stereofold\`.`,
      )).toHaveLength(1);
    }
    expect(relativeSetupCommandsFromAnywhere(
      `From the plugin root:\n\`node ${relativeScript}\``,
    )).toEqual([]);
    expect(relativeSetupCommandsFromAnywhere(
      `From anywhere:\n\`node /absolute/path/to/stereofold/${relativeScript}\``,
    )).toEqual([]);
  });

  it.each(recipientRegressionRules)('$name', async ({ name, applies, forbidden }) => {
    const violations = (await recipientSourceFiles()).flatMap(({ page, text: sourceText }) => {
      if (!applies(page)) return [];
      const text = recipientRegressionText(page, sourceText, name);
      return [...text.matchAll(new RegExp(forbidden.source, `${forbidden.flags}g`))]
        .map(match => `${page}:${text.slice(0, match.index).split('\n').length}: ${match[0]}`);
    });
    expect(violations).toEqual([]);
  });

  it('uses the public listening tool and the same local voice instructions in all entry guides', async () => {
    expect(MODEL_VISIBLE_TOOL_NAMES).toContain('stereo_structure.listen_voice');
    for (const page of ['README.md', 'QUICKSTART.md', 'INSPECTOR.md']) {
      const text = (await readFile(resolve(pluginRoot, page), 'utf8')).replace(/\s+/gu, ' ');
      expect(text, page).toContain('Setting `STEREOFOLD_PTT_TRANSCRIBE=1` is recommended to make transcription explicit.');
      expect(text, page).toContain('Unset, the runtime auto-detects a local transcriber: an Apple helper with `ffmpeg` or a complete Whisper route enables transcription');
      expect(text, page).toContain('STEREOFOLD_REPLY_VOICE_PROVIDER=system');
      expect(text, page).toContain('Keep an already configured spoken-reply provider.');
      expect(text, page).toContain('Do not change a working OAuth setup during transcription setup or silently switch providers after a failed reply.');
      expect(text, page).toContain('`say`');
      expect(text, page).toContain('`ffmpeg`');
      expect(text, page).toMatch(/does not ship/u);
      if (page !== 'QUICKSTART.md') {
        expect(text, page).toContain('set `STEREOFOLD_REPLY_VOICE_PROVIDER=system`; it uses local `say` and `ffmpeg`.');
        expect(text, page).toContain('helper Stereofold does not ship; without it, replies are captions with no sound.');
      }
    }
  });

  it('names release archive and checksums for missing-server recovery', async () => {
    // @ts-expect-error Standalone recipient ESM has no TypeScript declaration.
    const { openCheck } = await import('../skills/stereofold-setup/scripts/open-check.mjs');
    const root = await mkdtemp(join(tmpdir(), 'stereofold-open-missing-'));
    await expect(openCheck({ root })).rejects.toThrow(/Re-extract stereofold-marketplace\.tar\.gz and verify SHA256SUMS/u);
  });
});

async function createArtifact(parent: string): Promise<string> {
  const artifact = resolve(parent, 'stereofold');
  for (const [relative, content] of Object.entries(fixtureFiles)) {
    const path = resolve(artifact, relative);
    await mkdir(resolve(path, '..'), { recursive: true });
    if (relative === 'dist/inspector.html' || relative === 'dist/viewer.html') {
      const stamped = content.replace('<!doctype html>', `<!doctype html>${BUILD_PLACEHOLDER}`);
      await writeFile(path, stamped.replace(BUILD_PLACEHOLDER, createHash('sha256').update(stamped, 'utf8').digest('hex')));
    } else {
      await writeFile(path, content);
    }
  }
  return artifact;
}

describe('local share packaging', () => {
  it('omits host ownership and extended metadata from every archive member', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-metadata-'));
    const artifact = await createArtifact(temporaryRoot);
    const output = resolve(temporaryRoot, 'share');
    const result = await packageShare({ artifact, output });
    const { stdout } = await execFileAsync('python3', ['-c', `
import json, sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    print(json.dumps([
        {"path": entry.name, "uid": entry.uid, "gid": entry.gid,
         "named_owner": bool(entry.uname or entry.gname),
         "extended_metadata": sorted(entry.pax_headers)}
        for entry in archive.getmembers()
    ]))
`, result.archive]);
    const members = JSON.parse(stdout) as Array<{
      path: string; uid: number; gid: number; named_owner: boolean; extended_metadata: string[];
    }>;
    expect(members.length).toBeGreaterThan(30);
    for (const member of members) {
      expect(member.uid, member.path).toBe(0);
      expect(member.gid, member.path).toBe(0);
      expect(member.named_owner, member.path).toBe(false);
      expect(member.extended_metadata, member.path).toEqual([]);
    }
    const extracted = resolve(temporaryRoot, 'extracted');
    await mkdir(extracted);
    await execFileAsync('tar', ['-xzf', result.archive, '-C', extracted]);
    await execFileAsync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: extracted });
  });

  it('documents a standalone Claude Code scene and both transcription prerequisites', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-guide-'));
    const artifact = await createArtifact(temporaryRoot);
    const output = resolve(temporaryRoot, 'share');
    await packageShare({ artifact, output });
    const guide = await readFile(resolve(output, 'SHARE.md'), 'utf8');
    expect(guide).toContain('stereo_structure.open_inspector');
    expect(guide).toContain('first scene can be saved from Claude Code alone');
    expect(guide).not.toContain('cannot save the first');
    expect(guide).toContain('Both transcription routes require `ffmpeg`');
  });

  it('documents explicit recipient voice and never redirects the share to a checkout', async () => {
    const guide = shareGuide('0.1.0', { viewer: 'viewer', inspector: 'inspector', commit: 'a'.repeat(40) });
    expect(guide).not.toMatch(/checkout|repository/iu);
    for (const text of [guide, await readFile(resolve(pluginRoot, 'QUICKSTART.md'), 'utf8')]) {
      expect(text).toContain('STEREOFOLD_PTT_TRANSCRIBE=1');
      expect(text).toContain('recommended to make transcription explicit');
      expect(text).toContain('Unset, the runtime auto-detects a local transcriber');
      expect(text).toContain('local recognizer resolved');
      expect(text).toContain('With none detected, voice stays off and readiness names the missing prerequisites');
      expect(text).toContain('instead reports the missing prerequisites');
      expect(text).not.toContain('runtime needs the transcription switch');
      expect(text).toContain('STEREOFOLD_REPLY_VOICE_PROVIDER=system');
      expect(text.replace(/\s+/gu, ' ')).toContain('Keep an already configured spoken-reply provider.');
      expect(text.replace(/\s+/gu, ' ')).toContain('On a Mac without an OAuth narration helper,');
      expect(text.replace(/\s+/gu, ' ')).toMatch(/narration helper,? (?:that )?Stereofold does not ship/u);
    }
    for (const page of recipientPages) {
      const text = await readFile(resolve(pluginRoot, page), 'utf8');
      expect(text, page).not.toMatch(/(?:pnpm|npm)\s+(?:--|install|exec|run)|git clone|<plugin>/u);
    }
  });

  it('never requires STEREOFOLD_PTT_TRANSCRIBE in recipient documents or skills', async () => {
    const pages = await Promise.all(recipientPages.map(async page => ({
      page, text: await readFile(resolve(pluginRoot, page), 'utf8'),
    })));
    pages.push({ page: 'SHARE.md', text: shareGuide('0.1.0', {
      viewer: 'viewer', inspector: 'inspector', commit: 'a'.repeat(40),
    }) });
    for (const { page, text } of pages) {
      const prose = text.replace(/\s+/gu, ' ');
      expect(prose, page).not.toMatch(/nothing leaves|no audio leaves/iu);
      expect(prose, page).not.toMatch(/runtime needs the transcription switch|later builds? may auto-detect|later build auto-detects|transcription is on only when|Set the transcription switch/iu);
      expect(prose, page).not.toMatch(/(?:must(?: be)? set|required|requires?|needs?|only when|explicitly set|(?:^|[.!?] )Set)\b[^.!?`|]*`STEREOFOLD_PTT_TRANSCRIBE(?:=1)?`|`STEREOFOLD_PTT_TRANSCRIBE(?:=1)?` (?:is |must be |is [^.!?`|]*? )?(?:required|mandatory|set before)/iu);
      expect(prose, page).not.toMatch(/\| Headset transcription \| `STEREOFOLD_PTT_TRANSCRIBE=1`/u);
      if (/STEREOFOLD_PTT_TRANSCRIBE\b/u.test(text)) {
        expect(prose, page).toContain('recommended to make transcription explicit');
        expect(prose, page).toContain('Keep an already configured spoken-reply provider.');
        expect(prose, page).toContain('Do not change a working OAuth setup during transcription setup or silently switch providers after a failed reply.');
        expect(prose, page).toContain('Unset, the runtime auto-detects a local transcriber: an Apple helper with `ffmpeg` or a complete Whisper route enables transcription, and readiness reports the local recognizer resolved (Apple still needs Speech Recognition consent).');
      }
    }
  });

  it.each([
    'README.md', 'QUICKSTART.md', 'codex/INSTALL.md', 'INSPECTOR.md',
    'skills/stereo-structure/SKILL.md',
  ])('keeps recipient documentation independent of private acceptance records: %s', async (page) => {
    const source = await readFile(resolve(pluginRoot, page), 'utf8');
    expect(source, page).not.toMatch(/\bcampaigns?\b|scratchpad|acceptance[-_/ ]evidence/iu);
  });

  it.each([
    'assets/credentials.json',
    'dist/credentials.json',
    'demos/credentials.json',
    'demos/microtubule-arrival/credentials.json',
    'demos/microtubule-arrival/extra.json',
    'skills/molecular-presentation/assets/credentials.json',
    'assets/private.pem',
    'skills/stereofold-setup/scripts/.env.local',
    'assets/.npmrc',
    'assets/id_rsa',
    'assets/unexpected.png',
    'assets/.env',
    'skills/.env.production',
    'native/.git/config',
    'assets/node_modules/example/index.js',
    'demos/scratchpad/notes.txt',
    'skills/.git/config',
    'assets/acceptance-evidence/result.json',
  ])('rejects nested private or development residue: %s', async (entry) => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-residue-'));
    const artifact = await createArtifact(temporaryRoot);
    const input = resolve(artifact, entry);
    await mkdir(resolve(input, '..'), { recursive: true });
    await writeFile(input, 'private fixture; preserve the input\n');
    const output = resolve(temporaryRoot, 'share');
    const rejectedPath = entry.replace(
      /\/(?:\.git|node_modules|scratchpad|acceptance-evidence)\/.*$/u,
      match => match.slice(0, match.indexOf('/', 1)),
    );
    await expect(packageShare({ artifact, output })).rejects.toThrow(
      `forbidden share entry: ${rejectedPath}.`,
    );
    await expect(lstat(output)).rejects.toThrow();
    expect(await readFile(input, 'utf8')).toBe('private fixture; preserve the input\n');
  });

  it('creates both host descriptors, the archive, guide, and verifiable checksums', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-test-'));
    try {
      const artifact = await createArtifact(temporaryRoot);
      const output = resolve(temporaryRoot, 'share');
      const result = await packageShare({ artifact, output });

      const checksummedPluginFiles = (await readFile(result.checksums, 'utf8'))
        .split('\n').flatMap(line => line.includes('  plugins/stereofold/')
          ? [line.split('  plugins/stereofold/')[1]] : []);
      expect(checksummedPluginFiles.sort()).toEqual(Object.keys(fixtureFiles)
        .filter(path => path !== 'native/applespeech/bin/applespeech').sort());
      expect(result.output).toBe(output);
      expect(result.plugin).toBe(resolve(output, 'plugins/stereofold'));
      expect(result.marketplace).toBe(resolve(output, '.agents/plugins/marketplace.json'));
      expect(await readFile(result.plugin + '/dist/server.mjs', 'utf8')).toBe('export {};\n');
      expect(JSON.parse(await readFile(result.marketplace, 'utf8'))).toEqual({
        name: 'stereofold-local',
        interface: { displayName: 'Stereofold local' },
        plugins: [{
          name: 'stereofold',
          source: { source: 'local', path: './plugins/stereofold' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Education & Research',
        }],
      });

      // Claude Code reads its own descriptor and never the Codex one, so a
      // share that carried only `.agents/` left `claude plugin marketplace
      // add` with no file to read and the documented route with no command.
      expect(result.claudeMarketplace).toBe(resolve(output, '.claude-plugin/marketplace.json'));
      expect(JSON.parse(await readFile(result.claudeMarketplace, 'utf8'))).toEqual({
        name: 'stereofold-local',
        owner: { name: 'Stereofold Contributors' },
        metadata: {
          description: 'Local Stereofold share: the same plugin directory Codex installs, with its shipped MCP server.',
          version: '0.1.0',
        },
        plugins: [{
          name: 'stereofold',
          source: './plugins/stereofold',
          description: 'Registers the shipped stereo_structure MCP server, its skills, and the headset skill for Claude Code, including Meta Quest, Apple Vision Pro and other WebXR headset browsers.',
          version: '0.1.0',
        }],
      });

      const guide = await readFile(resolve(output, 'SHARE.md'), 'utf8');
      expect(guide).toContain('codex plugin marketplace add /absolute/path/to/stereofold-share');
      expect(guide).toContain('codex plugin add stereofold@stereofold-local');
      expect(guide).toContain('claude plugin marketplace add /absolute/path/to/stereofold-share');
      expect(guide).toContain('claude plugin install stereofold@stereofold-local');
      expect(guide).toContain('dist/server.mjs');
      expect(guide).toContain('openssl');
      expect(guide).toContain('cloudflared');
      expect(guide).toContain('STEREOFOLD_CLOUDFLARED');
      expect(guide).toMatch(/viewer: `[0-9a-f]{64}`/u);
      expect(guide).toMatch(/inspector: `[0-9a-f]{64}`/u);

      const checksum = await readFile(resolve(output, 'SHA256SUMS'), 'utf8');
      expect(checksum).toContain('  .agents/plugins/marketplace.json\n');
      expect(checksum).toContain('  .claude-plugin/marketplace.json\n');
      expect(checksum).not.toContain('stereofold-marketplace.tar.gz');
      expect(checksum).not.toContain(temporaryRoot);
      await execFileAsync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: output });
      expect(await readFile(result.archiveChecksum, 'utf8')).toMatch(/^[0-9a-f]{64}  stereofold-marketplace\.tar\.gz\n$/u);
      await execFileAsync('shasum', ['-a', '256', '-c', 'stereofold-marketplace.tar.gz.sha256'], { cwd: output });

      const { stdout: archiveListing } = await execFileAsync('tar', ['-tzf', result.archive]);
      expect(archiveListing).toContain('.agents/plugins/marketplace.json');
      expect(archiveListing).toContain('.claude-plugin/marketplace.json');
      expect(archiveListing).toContain('plugins/stereofold/dist/server.mjs');
      expect(archiveListing).toContain('SHARE.md');
      expect(archiveListing).toContain('SHA256SUMS');
      expect(archiveListing).not.toContain('stereofold-marketplace.tar.gz.sha256');

      const extracted = resolve(temporaryRoot, 'extracted');
      await mkdir(extracted);
      await execFileAsync('tar', ['-xzf', result.archive, '-C', extracted]);
      await execFileAsync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: extracted });
      await expect(lstat(resolve(extracted, '.claude-plugin/marketplace.json'))).resolves.toBeDefined();
      expect(await readFile(resolve(extracted, 'plugins/stereofold/dist/server.mjs'), 'utf8')).toBe('export {};\n');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('carries both host manifests and the speech source, and never the compiled helper', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-hosts-'));
    try {
      const artifact = await createArtifact(temporaryRoot);
      const output = resolve(temporaryRoot, 'share');
      const result = await packageShare({ artifact, output });

      // Codex reads one manifest and Claude Code the other. A share with only
      // the Codex half is how the two hosts end up on different builds.
      expect(await readFile(resolve(result.plugin, '.claude-plugin/plugin.json'), 'utf8')).toContain('${CLAUDE_PLUGIN_ROOT}/dist/server.mjs');
      expect(await readFile(resolve(result.plugin, '.claude-plugin/icon.png'), 'utf8')).toBe(fixtureFiles['.claude-plugin/icon.png']);
      expect(await readFile(resolve(result.plugin, 'claude-code/skills/stereofold-quest/SKILL.md'), 'utf8')).toContain('name: stereofold-quest');
      expect(await readFile(resolve(result.plugin, 'native/applespeech/build.sh'), 'utf8')).toBe('#!/bin/sh\n');
      // The recipient builds the Mach-O; this Mac's copy is not theirs to run.
      await expect(lstat(resolve(result.plugin, 'native/applespeech/bin'))).rejects.toThrow();
      const checksums = await readFile(resolve(output, 'SHA256SUMS'), 'utf8');
      expect(checksums).toContain('  plugins/stereofold/claude-code/skills/stereofold-quest/SKILL.md\n');
      expect(checksums).not.toContain('applespeech/bin/');

      const { stdout: archiveListing } = await execFileAsync('tar', ['-tzf', result.archive]);
      expect(archiveListing).toContain('plugins/stereofold/native/applespeech/transcribe.swift');
      expect(archiveListing).not.toContain('applespeech/bin/');
      const guide = await readFile(resolve(output, 'SHARE.md'), 'utf8');
      expect(guide).toContain('sh plugins/stereofold/native/applespeech/build.sh');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('records the source revision when the artifact sits in a checkout, and nothing when it does not', async () => {
    // The share is the whole delivery and names no repository, so the commit
    // identifies the delivery in a problem report. A build outside a checkout
    // records nothing rather than guessing.
    const checkout = await sourceRevision(pluginRoot);
    expect(checkout).toMatch(/^[0-9a-f]{40}( \(built with uncommitted changes\))?$/u);

    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-revision-'));
    try {
      expect(await sourceRevision(temporaryRoot)).toBeUndefined();
      const artifact = await createArtifact(temporaryRoot);
      const output = resolve(temporaryRoot, 'share');
      await packageShare({ artifact, output });
      expect(await readFile(resolve(output, 'SHARE.md'), 'utf8')).not.toContain('source commit');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('refuses a release missing the Claude Code half or the speech source', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-halves-'));
    try {
      const withoutClaudeCode = await createArtifact(resolve(temporaryRoot, 'a'));
      await rm(resolve(withoutClaudeCode, 'claude-code'), { recursive: true });
      await expect(packageShare({ artifact: withoutClaudeCode, output: resolve(temporaryRoot, 'a/share') }))
        .rejects.toThrow('claude-code');

      // The Claude Code manifest is the server registration for that host, so
      // a release without it installs into Claude Code with nothing to start.
      const withoutClaudeManifest = await createArtifact(resolve(temporaryRoot, 'c'));
      await rm(resolve(withoutClaudeManifest, '.claude-plugin'), { recursive: true });
      await expect(packageShare({ artifact: withoutClaudeManifest, output: resolve(temporaryRoot, 'c/share') }))
        .rejects.toThrow('.claude-plugin');

      const withoutClaudeIcon = await createArtifact(resolve(temporaryRoot, 'd'));
      await rm(resolve(withoutClaudeIcon, '.claude-plugin/icon.png'));
      await expect(packageShare({ artifact: withoutClaudeIcon, output: resolve(temporaryRoot, 'd/share') }))
        .rejects.toThrow('.claude-plugin/icon.png');

      const withoutNative = await createArtifact(resolve(temporaryRoot, 'b'));
      await rm(resolve(withoutNative, 'native/applespeech/build.sh'));
      await expect(packageShare({ artifact: withoutNative, output: resolve(temporaryRoot, 'b/share') }))
        .rejects.toThrow('native/applespeech/build.sh');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('rejects symlinked release inputs before creating a share', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-symlink-'));
    try {
      const artifact = await createArtifact(temporaryRoot);
      const outside = resolve(temporaryRoot, 'outside.txt');
      await writeFile(outside, 'outside\n');
      await rm(resolve(artifact, 'README.md'));
      await symlink(outside, resolve(artifact, 'README.md'));

      const output = resolve(temporaryRoot, 'share');
      await expect(packageShare({ artifact, output })).rejects.toThrow('symlink');
      await expect(lstat(output)).rejects.toThrow();
      expect(await readFile(outside, 'utf8')).toBe('outside\n');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('does not overwrite an existing output directory', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-output-'));
    try {
      const artifact = await createArtifact(temporaryRoot);
      const output = resolve(temporaryRoot, 'share');
      await mkdir(output);
      await writeFile(resolve(output, 'keep.txt'), 'keep\n');

      await expect(packageShare({ artifact, output })).rejects.toThrow('already exists');
      expect(await readFile(resolve(output, 'keep.txt'), 'utf8')).toBe('keep\n');
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('refuses a release missing a lesson the demo index lists', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-lesson-'));
    try {
      const artifact = await createArtifact(temporaryRoot);
      await rm(resolve(artifact, 'demos/hemoglobin.json'));
      const output = resolve(temporaryRoot, 'share');

      await expect(packageShare({ artifact, output })).rejects.toThrow(/demos\/hemoglobin\.json/);
      await expect(lstat(output)).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it.each(['build', 'density'])('refuses an arrival release missing its %s lesson', async stage => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-arrival-'));
    try {
      const artifact = await createArtifact(temporaryRoot);
      const lesson = `demos/microtubule-arrival/${stage}.json`;
      await rm(resolve(artifact, lesson));
      const output = resolve(temporaryRoot, 'share');
      await expect(packageShare({ artifact, output })).rejects.toThrow(lesson);
      await expect(lstat(output)).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('refuses a release missing a staged lesson the demo index lists', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-stage-lesson-'));
    try {
      const artifact = await createArtifact(temporaryRoot);
      await writeFile(resolve(artifact, 'demos/extra-tier.json'), '{"id":"extra-tier"}\n');
      await writeFile(resolve(artifact, 'demos/index.json'), JSON.stringify({
        version: 1,
        cacheDirectory: '~/Library/Caches/Stereofold/demos',
        demos: [{ name: 'fixture', lesson: 'hemoglobin.json', stages: [{ lesson: 'extra-tier.json' }] }],
      }));
      await rm(resolve(artifact, 'demos/extra-tier.json'));
      const output = resolve(temporaryRoot, 'share');

      await expect(packageShare({ artifact, output })).rejects.toThrow(/demos\/extra-tier\.json/);
      await expect(lstat(output)).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('refuses a release that is missing a skill file the release verifier requires', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-skill-'));
    try {
      const artifact = await createArtifact(temporaryRoot);
      await rm(resolve(artifact, 'skills/molecular-presentation/scripts/lesson.mjs'));
      const output = resolve(temporaryRoot, 'share');

      await expect(packageShare({ artifact, output })).rejects.toThrow('skills/molecular-presentation/scripts/lesson.mjs');
      await expect(lstat(output)).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  /**
   * The fixture above is a hand-written copy of the layout. This one is the
   * layout: it stages this checkout's real plugin entries with the same
   * function `pnpm run release` calls, into a temporary source tree so the
   * checkout's own `release/` is untouched, and then packages what came out.
   * A `releaseEntries` addition that the packager's allowlist does not know
   * about fails here rather than on the first share someone tries to build.
   */
  it('packages what the real release staging produces', async () => {
    const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-share-staged-')));
    try {
      const source = resolve(temporaryRoot, 'plugin');
      await mkdir(source, { recursive: true });
      for (const entry of releaseEntries) {
        await cp(resolve(pluginRoot, entry), resolve(source, entry), { recursive: true, verbatimSymlinks: true });
      }

      const staged = await stageRelease(source);
      expect(staged.artifact).toBe(resolve(source, 'release/stereofold'));
      expect(staged.contents).toEqual([...releaseEntries].sort());

      const output = resolve(temporaryRoot, 'share');
      const result = await packageShare({ artifact: staged.artifact, output });
      for (const required of [
        '.codex-plugin/plugin.json',
        '.claude-plugin/plugin.json',
        '.claude-plugin/icon.png',
        'claude-code/skills/stereofold-quest/SKILL.md',
        'demos/index.json',
        'demos/microtubule-arrival/build.json',
        'demos/microtubule-arrival/density.json',
        'dist/server.mjs',
        'dist/headset-host.mjs',
        'dist/scene-socket-relay.mjs',
        'dist/inspector-host.js',
        'native/applespeech/transcribe.swift',
        'native/applespeech/build.sh',
        'skills/stereo-structure/SKILL.md',
      ]) {
        await expect(lstat(resolve(result.plugin, required))).resolves.toBeDefined();
      }
      await expect(lstat(resolve(result.plugin, 'native/applespeech/bin'))).rejects.toThrow();
      const stagedSkills = (await readFile(result.checksums, 'utf8')).split('\n')
        .flatMap(line => line.endsWith('/SKILL.md') ? [line.split('  plugins/stereofold/')[1]] : []);
      expect(stagedSkills.sort()).toEqual(recipientPages.filter(page => page.endsWith('/SKILL.md')).sort());
      for (const page of [...recipientPages, 'SHARE.md']) {
        const text = await readFile(resolve(page === 'SHARE.md' ? output : result.plugin, page), 'utf8');
        expect(await missingRecipientPaths(text, page, output), page).toEqual([]);
        expect(relativeSetupCommandsFromAnywhere(text), page).toEqual([]);
      }
      // Execute the documented command from outside the plugin, using only
      // the release payload: no package.json, source imports or dependencies.
      const setupSkill = await readFile(resolve(result.plugin, 'skills/stereofold-setup/SKILL.md'), 'utf8');
      const setupCommand = setupSkill.match(/node "([^"]+\/setup-check\.mjs)" --root "([^"]+)"/u);
      expect(setupCommand).not.toBeNull();
      const setupArgs = setupCommand!.slice(1).map(path => path.replace('/absolute/path/to/stereofold-share', output));
      const { stdout: setupJson } = await execFileAsync(process.execPath,
        [setupArgs[0], '--root', setupArgs[1], '--no-write', '--json'], {
          cwd: temporaryRoot, env: { PATH: '', STEREOFOLD_CONFIG: resolve(temporaryRoot, 'setup-config.json') },
        });
      expect(JSON.parse(setupJson).facts.root).toBe(result.plugin);
      // Regression probes for each formerly missing file class. These use the
      // same scanner as the real docs, including bare names and fenced commands.
      for (const reference of [
        'docs/headset-walkthrough.md', 'plugin/scripts/smoke.ts',
        'scripts/inspector-browser.ts', 'test/fixtures/three-depth-markers.pdb',
        '<plugin>/demos/crispr-cas9.json', 'scripts/setup-check.ts',
        'scripts/release.ts', 'scripts/safe-directory-swap.py',
        'scripts/package-share.ts', 'plugin/scripts/inspection-agent.ts',
        'src/inspection-voice.ts', 'plugin/scripts/fresh-user-check.ts',
        'docs/CITATIONS.md', 'scripts/quest-demo.ts', 'scripts/demo-browser.ts',
        'package.json', 'node_modules', 'scripts/new-unshipped-command.mjs',
      ]) {
        expect(await missingRecipientPaths(`Run node ${reference}`, 'README.md', output), reference)
          .toContain(reference);
      }
      // Real bundles are stamped, so the guide carries the identities a host
      // reports back rather than the unstamped placeholder.
      const guide = await readFile(resolve(output, 'SHARE.md'), 'utf8');
      expect(guide).toMatch(/viewer: `[0-9a-f]{64}`/u);
      expect(guide).toMatch(/inspector: `[0-9a-f]{64}`/u);
      await execFileAsync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: output });
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }, 120_000);

  it('rejects unallowlisted release files before they can enter the archive', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-allowlist-'));
    try {
      const artifact = await createArtifact(temporaryRoot);
      await writeFile(resolve(artifact, 'credentials.json'), 'must stay out\n');
      const output = resolve(temporaryRoot, 'share');

      await expect(packageShare({ artifact, output })).rejects.toThrow('unallowlisted');
      await expect(lstat(output)).rejects.toThrow();
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});

describe('indexed modelled composite packaging', () => {
  it('requires, verifies and checksums the exact recipe and local CIF from a staged composite', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-modelled-'));
    try {
      const artifact = await createArtifact(temporaryRoot);
      const output = resolve(temporaryRoot, 'share');
      const cif = 'data_linkers\nloop_\n_atom_site.id\n1\n';
      const digest = createHash('sha256').update(cif).digest('hex');
      const recipe = { version: 1, id: 'modelled-fixture', title: 'Modelled fixture',
        sources: [{ id: 'linkers', file: 'linkers.cif', sha256: digest, modelled: 'Synthetic linkers' }],
        bodies: [{ source: 'linkers', authChains: ['A'], atoms: 'all', chain: 'L', matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] }] };
      const index = JSON.parse(fixtureFiles['demos/index.json']);
      index.demos[0].stages = [{ lesson: 'hemoglobin.json', coordinates: {
        derivation: { kind: 'prepared-rigid-composite', recipe: 'custom/recipe.json' },
      } }];
      await writeFile(resolve(artifact, 'demos/index.json'), JSON.stringify(index));
      const custom = resolve(artifact, 'demos/custom');
      await mkdir(custom);
      const recipeText = JSON.stringify(recipe);
      await writeFile(resolve(custom, 'recipe.json'), recipeText);
      await expect(packageShare({ artifact, output })).rejects.toThrow(/ENOENT/);
      await writeFile(resolve(custom, 'linkers.cif'), cif + '# tampered\n');
      await expect(packageShare({ artifact, output })).rejects.toThrow('sha256 mismatch');
      const outside = resolve(temporaryRoot, 'outside.cif');
      await writeFile(outside, cif);
      await rm(resolve(custom, 'linkers.cif'));
      await symlink(outside, resolve(custom, 'linkers.cif'));
      await expect(packageShare({ artifact, output })).rejects.toThrow('inside demos/');
      await rm(resolve(custom, 'linkers.cif'));
      await writeFile(resolve(custom, 'linkers.cif'), cif);
      await writeFile(resolve(custom, 'unreferenced.cif'), cif);
      await expect(packageShare({ artifact, output })).rejects.toThrow('forbidden share entry');
      await rm(resolve(custom, 'unreferenced.cif'));
      const result = await packageShare({ artifact, output });
      expect(await readFile(resolve(result.plugin, 'demos/custom/linkers.cif'), 'utf8')).toBe(cif);
      const sums = await readFile(result.checksums, 'utf8');
      expect(sums).toContain(`${digest}  plugins/stereofold/demos/custom/linkers.cif\n`);
      expect(sums).toContain(`${createHash('sha256').update(recipeText).digest('hex')}  plugins/stereofold/demos/custom/recipe.json\n`);
      await execFileAsync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: output });
      const extracted = resolve(temporaryRoot, 'extracted');
      await mkdir(extracted);
      await execFileAsync('tar', ['-xzf', result.archive, '-C', extracted]);
      expect(await readFile(resolve(extracted, 'plugins/stereofold/demos/custom/linkers.cif'), 'utf8')).toBe(cif);
      await execFileAsync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: extracted });
    } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
  });
});

describe('unindexed composite packaging', () => {
  it('requires every shipped recipe source file even when the index does not reference the recipe', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-share-recipe-source-'));
    try {
      const artifact = await createArtifact(temporaryRoot), output = resolve(temporaryRoot, 'share');
      const directory = resolve(artifact, 'demos/kinesin-walk');
      await mkdir(directory, { recursive: true });
      const cif = 'data_local\n', digest = createHash('sha256').update(cif).digest('hex');
      await writeFile(resolve(directory, 'cycle-recipe.json'), JSON.stringify({ version: 1, id: 'local-fixture', title: 'Local fixture',
        sources: [{ id: 'local', file: 'local.cif', sha256: digest, modelled: 'Synthetic fixture' }],
        bodies: [{ source: 'local', authChains: ['A'], atoms: 'all', chain: 'L', matrix: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] }] }));
      await expect(packageShare({ artifact, output })).rejects.toThrow(/local\.cif/);
      await expect(lstat(output)).rejects.toThrow();
      await writeFile(resolve(directory, 'local.cif'), cif);
      const result = await packageShare({ artifact, output });
      expect(await readFile(resolve(result.plugin, 'demos/kinesin-walk/local.cif'), 'utf8')).toBe(cif);
      expect(await readFile(result.checksums, 'utf8')).toContain(`${digest}  plugins/stereofold/demos/kinesin-walk/local.cif\n`);
    } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
  });
});


describe('bundled gallery artifact validation', () => {
  it.each(['dist/inspector-script-1.js', 'dist/inspector-script-2.js'])
  ('requires the fixed inspector companion before any share is created: %s', async file => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-inspector-companion-'));
    try {
      const artifact = await createArtifact(root);
      await rm(resolve(artifact, file));
      await expect(validateArtifact(artifact)).rejects.toThrow(file);
      expect(await readdir(root)).toEqual(['stereofold']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  async function galleryArtifact(root: string, extended = false) {
    const artifact = await createArtifact(root);
    await cp(resolve(pluginRoot, 'demos/binder-gallery'), resolve(artifact, 'demos/binder-gallery'), { recursive: true });
    await cp(resolve(pluginRoot, 'skills/molecular-presentation/references/binder-gallery.md'),
      resolve(artifact, 'skills/molecular-presentation/references/binder-gallery.md'));
    const index = JSON.parse(await readFile(resolve(pluginRoot, 'demos/index.json'), 'utf8'));
    const gallery = index.demos.find((entry: any) => entry.name === 'binder-gallery');
    expect(gallery).toBeDefined();
    await writeFile(resolve(artifact, 'demos/index.json'), JSON.stringify({ version: 1, demos: extended
      ? index.demos.filter((entry: any) => ['binder-gallery', 'binder-gallery-extended'].includes(entry.name))
      : [gallery] }));
    return artifact;
  }

  it('accepts the complete published gallery and both indexed stages without producing a share', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-gallery-validation-'));
    try {
      const artifact = await galleryArtifact(root);
      await expect(validateArtifact(artifact)).resolves.toMatchObject({ name: 'stereofold' });
      const manifest = JSON.parse(await readFile(resolve(artifact, 'demos/binder-gallery/manifest.json'), 'utf8'));
      expect(manifest.entries).toHaveLength(17);
      expect(await readdir(resolve(artifact, 'demos/binder-gallery/structures'))).toHaveLength(17);
      expect(await readdir(root)).toEqual(['stereofold']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('packages all eleven extended stages with their exact coordinates and retained provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-extended-share-'));
    try {
      const artifact = await galleryArtifact(root, true);
      const result = await packageShare({ artifact, output: resolve(root, 'share') });
      const index = JSON.parse(await readFile(resolve(result.plugin, 'demos/index.json'), 'utf8'));
      const extended = index.demos.find((entry: any) => entry.name === 'binder-gallery-extended');
      expect(extended.stages).toHaveLength(11);
      const checksums = await readFile(result.checksums, 'utf8');
      for (const stage of extended.stages) {
        const file = `demos/${stage.coordinates.derivation.path}`;
        expect(createHash('sha256').update(await readFile(resolve(result.plugin, file))).digest('hex'))
          .toBe(stage.coordinates.sha256);
        expect(checksums).toContain(`${stage.coordinates.sha256}  plugins/stereofold/${file}\n`);
      }
      const required = [
        'catalog.json', 'upstream/in_silico_scores.csv', 'upstream/LICENSE.md',
        'extended/README.md', 'extended/source-lock.json', 'extended/manifest.json',
        'extended/selected17/lesson.json', 'extended/batch-10/manifest.json',
      ];
      const lock = JSON.parse(await readFile(resolve(result.plugin, 'demos/binder-gallery/extended/source-lock.json'), 'utf8'));
      expect(Object.keys(lock)).toHaveLength(194);
      required.push(...Object.keys(lock).map(file => `extended/upstream/${file}`));
      for (const file of required) {
        const shipped = `demos/binder-gallery/${file}`;
        expect(await readFile(resolve(result.plugin, shipped))).toEqual(await readFile(resolve(artifact, shipped)));
        expect(checksums).toContain(`  plugins/stereofold/${shipped}\n`);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    'catalog.json', 'upstream/in_silico_scores.csv', 'extended/source-lock.json',
    'extended/batch-10/manifest.json', 'extended/upstream/structures/05efdf6e/05efdf6e_esmfold2-cn2.pdb',
  ])('requires extended-gallery provenance before creating a share: %s', async file => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-extended-missing-'));
    try {
      const artifact = await galleryArtifact(root, true);
      await rm(resolve(artifact, 'demos/binder-gallery', file));
      await expect(packageShare({ artifact, output: resolve(root, 'share') })).rejects.toThrow(file);
      await expect(lstat(resolve(root, 'share'))).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects modified extended coordinates and does not admit extra files from the source lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-extended-boundary-'));
    try {
      const artifact = await galleryArtifact(root, true);
      const cif = resolve(artifact, 'demos/binder-gallery/extended/batch-10/gallery.cif');
      const original = await readFile(cif);
      await writeFile(cif, 'changed coordinates');
      await expect(validateArtifact(artifact)).rejects.toThrow('sha256 mismatch');
      await writeFile(cif, original);
      const privateFile = 'demos/binder-gallery/extended/credentials.json';
      await writeFile(resolve(artifact, privateFile), 'unapproved fixture');
      const lockPath = resolve(artifact, 'demos/binder-gallery/extended/source-lock.json');
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      lock['credentials.json'] = { sha256: 'a'.repeat(64) };
      await writeFile(lockPath, JSON.stringify(lock));
      await expect(validateArtifact(artifact)).rejects.toThrow(`forbidden share entry: ${privateFile}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    'demos/binder-gallery/structures/Binder17.cif',
    'demos/binder-gallery/upstream/structures/03131527/03131527_esmfold2-aah1.pdb',
    'demos/binder-gallery/upstream/structures/INDEX.csv',
    'demos/binder-gallery/upstream/LICENSE.md',
    'demos/binder-gallery/manifest.json',
    'demos/binder-gallery/PROVENANCE.md',
    'demos/binder-gallery/original-pairs.json',
    'skills/molecular-presentation/references/binder-gallery.md',
  ])('requires the complete gallery asset: %s', async file => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-gallery-required-'));
    try {
      const artifact = await galleryArtifact(root);
      await rm(resolve(artifact, file));
      await expect(validateArtifact(artifact)).rejects.toThrow(file);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('checks the bundled coordinate digest before any share is created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-gallery-digest-'));
    try {
      const artifact = await galleryArtifact(root);
      await writeFile(resolve(artifact, 'demos/binder-gallery/gallery.cif'), 'changed coordinates');
      await expect(validateArtifact(artifact)).rejects.toThrow('sha256 mismatch');
      expect(await readdir(root)).toEqual(['stereofold']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['../credentials.json', '/tmp/private.cif', 'binder-gallery/private.cif', 'hemoglobin.json'])
  ('does not let an indexed bundled path extend the explicit share boundary: %s', async path => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-gallery-path-'));
    try {
      const artifact = await galleryArtifact(root);
      const indexPath = resolve(artifact, 'demos/index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      index.demos[0].stages[0].coordinates.derivation.path = path;
      await writeFile(indexPath, JSON.stringify(index));
      await expect(validateArtifact(artifact)).rejects.toThrow('explicitly approved share file');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    'demos/binder-gallery/credentials.json',
    'demos/binder-gallery/upstream/structures/03131527/private.pdb',
    'demos/binder-gallery/structures/private.cif',
    'skills/molecular-presentation/references/private.md',
  ])('still rejects extra nested files even when the gallery manifest names them: %s', async file => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-gallery-private-'));
    try {
      const artifact = await galleryArtifact(root);
      await writeFile(resolve(artifact, file), 'unapproved fixture');
      const manifestPath = resolve(artifact, 'demos/binder-gallery/manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.upstreamFiles.push({ file, sha256: 'a'.repeat(64) });
      await writeFile(manifestPath, JSON.stringify(manifest));
      await expect(validateArtifact(artifact)).rejects.toThrow(`forbidden share entry: ${file}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects symlinks in the approved gallery paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-gallery-symlink-'));
    try {
      const artifact = await galleryArtifact(root);
      const file = resolve(artifact, 'demos/binder-gallery/structures/Binder17.cif');
      await rm(file);
      await symlink(resolve(artifact, 'demos/binder-gallery/structures/Binder01.cif'), file);
      await expect(validateArtifact(artifact)).rejects.toThrow('symlink');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
