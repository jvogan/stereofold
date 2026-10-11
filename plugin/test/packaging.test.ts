import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { MINIMAL_DIAGNOSTICS } from './fixtures/diagnostics.js';
import {
  CLAUDE_SCIENCE_VIEWER_BINDING,
  createStereoStructureServer,
} from '../src/server.js';
import { PRIVATE_STRUCTURE_META_KEY } from '../src/structure-result.js';
import { APP_ONLY_TOOL_NAMES, MODEL_VISIBLE_TOOL_NAMES, REGISTERED_TOOL_NAMES } from '../scripts/tool-inventory.js';

const pluginRoot = new URL('..', import.meta.url);
const manifestUrl = new URL('../.codex-plugin/plugin.json', import.meta.url);
const claudeCodeManifestUrl = new URL('../.claude-plugin/plugin.json', import.meta.url);
const questSkillUrl = new URL('../claude-code/skills/stereofold-quest/SKILL.md', import.meta.url);
const releaseScriptUrl = new URL('../scripts/release.ts', import.meta.url);
const setupSkillUrl = new URL('../skills/stereofold-setup/SKILL.md', import.meta.url);
const setupCheckUrl = new URL('../skills/stereofold-setup/scripts/setup-check.mjs', import.meta.url);
const mcpConfigUrl = new URL('../.mcp.json', import.meta.url);
const licenseUrl = new URL('../LICENSE', import.meta.url);
const noticesUrl = new URL('../THIRD_PARTY_NOTICES.md', import.meta.url);
const STRUCTURE_TEXT = 'ATOM      1  N   THR A   1      17.047  14.099   3.625  1.00 13.79           N\nEND\n';

async function createSession(client: Client): Promise<string> {
  const opened = await client.callTool({
    name: 'stereo_structure.open',
    arguments: { structureText: STRUCTURE_TEXT, format: 'pdb' },
  });
  expect(opened.isError).not.toBe(true);
  const sessionId = (opened.structuredContent as { sessionId?: unknown } | undefined)?.sessionId;
  expect(typeof sessionId).toBe('string');
  return sessionId as string;
}

/** Cached coordinates are intentionally available only to the component. */
function privateStructure(result: unknown): Record<string, unknown> {
  const metadata = (result as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const payload = metadata?.[PRIVATE_STRUCTURE_META_KEY];
  expect(payload).toBeTypeOf('object');
  expect(payload).not.toBeNull();
  return payload as Record<string, unknown>;
}

function expectCoordinateFreePublicResult(result: unknown, coordinates: string): void {
  const publicResult = result as { content?: unknown; structuredContent?: { structureText?: unknown } };
  expect(publicResult.structuredContent?.structureText).toBeUndefined();
  expect(JSON.stringify(publicResult.content) ?? '').not.toContain(coordinates);
  expect(JSON.stringify(publicResult.structuredContent) ?? '').not.toContain(coordinates);
}

describe('Stereofold packaging metadata', () => {
  it('keeps the documented tool totals aligned with the shipped inventory', async () => {
    expect(REGISTERED_TOOL_NAMES).toHaveLength(64);
    expect(MODEL_VISIBLE_TOOL_NAMES).toHaveLength(37);
    expect(APP_ONLY_TOOL_NAMES).toHaveLength(27);
    expect(APP_ONLY_TOOL_NAMES).toContain('stereo_structure.report_detailed_selection');
    expect(APP_ONLY_TOOL_NAMES).toContain('stereo_structure.report_source_failure');
    expect(MODEL_VISIBLE_TOOL_NAMES).not.toContain('stereo_structure.report_source_failure');

    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const inspector = await readFile(new URL('../INSPECTOR.md', import.meta.url), 'utf8');
    const install = await readFile(new URL('../codex/INSTALL.md', import.meta.url), 'utf8');
    const skills = await Promise.all([
      new URL('../skills/stereo-structure/SKILL.md', import.meta.url),
      new URL('../skills/stereofold-setup/SKILL.md', import.meta.url),
      new URL('../claude-code/skills/stereofold-quest/SKILL.md', import.meta.url),
    ].map(url => readFile(url, 'utf8')));

    expect(readme).toContain('thirty-seven of the sixty-four\nregistered tools; the other twenty-seven are app-only');
    expect(inspector).toContain('thirty-seven model-visible tools');
    expect(install).toContain('64 registered tools, 37 of them model-visible');
    for (const text of [readme, inspector, install, ...skills]) {
      expect(text).not.toMatch(/\b55 registered tools\b|\b31 model-visible\b|\b24 app-only\b|fifty-eight\s+registered tools|twenty-four (?:are )?app-only/iu);
    }
  });

  it('keeps setup, Git eligibility and release docs aligned with the runtime bundles', async () => {
    const bundles = ['server.mjs', 'viewer.html', 'inspector.html', 'inspector.css', 'inspector-host.js'];
    const skill = await readFile(setupSkillUrl, 'utf8');
    const release = await readFile(new URL('../../docs/release.md', import.meta.url), 'utf8');
    const notices = await readFile(noticesUrl, 'utf8');
    const codexKit = await readFile(new URL('../../harness/kits/codex-personal-plugin.md', import.meta.url), 'utf8');
    // Recipients check prebuilt files; Git eligibility belongs to owner docs.
    const runtimeSection = skill.split('## 4. Check the runtime')[1]?.split('## 5.')[0] ?? '';
    const gitSection = release.split('## Git eligibility and release layout')[1]?.split('\n## ')[0] ?? '';
    for (const bundle of bundles) {
      expect(runtimeSection, 'setup runtime bundle').toContain(`\`dist/${bundle}\``);
      expect(gitSection, 'Git-eligible bundle').toContain(`\`dist/${bundle}\``);
      expect(release, 'release bundle').toContain(`dist/${bundle}`);
      // CSS dependencies are inventoried by the reconstructed inspector HTML.
      if (bundle !== 'inspector.css') expect(notices, 'generated notices bundle').toContain(`\`dist/${bundle}\``);
      expect(codexKit, 'Codex kit bundle').toContain(`dist/${bundle}`);
    }
    expect(gitSection).toContain('parent ignore rule before release');
    expect(runtimeSection).toMatch(/`stereo_structure\.open_inspector`[\s\S]*requires `dist\/inspector-host\.js`/u);
    expect(skill).not.toContain('three runtime files');
    for (const asset of ['molstar.js', 'molstar.css', 'LICENSE']) {
      expect(release).toContain(`dist/molstar/${asset}`);
    }
  });

  it('keeps harness kit tool counts aligned with the inventory', async () => {
    for (const file of ['codex-personal-plugin.md', 'claude-science.md']) {
      const kit = await readFile(new URL(`../../harness/kits/${file}`, import.meta.url), 'utf8');
      expect(kit, file).toMatch(new RegExp(`(?:registers|has) ${REGISTERED_TOOL_NAMES.length} `));
      expect(kit, file).toContain(`${MODEL_VISIBLE_TOOL_NAMES.length} model-visible`);
      expect(kit, file).toContain(`${APP_ONLY_TOOL_NAMES.length} app-only`);
    }
  });

  it('keeps first-run, install and host-verification counts aligned with the inventory', async () => {
    const total = REGISTERED_TOOL_NAMES.length;
    const model = MODEL_VISIBLE_TOOL_NAMES.length;
    const app = APP_ONLY_TOOL_NAMES.length;
    for (const file of ['first-run-and-sharing.md', 'install.md', 'host-verification.md']) {
      const doc = await readFile(new URL(`../../docs/${file}`, import.meta.url), 'utf8');
      expect(doc, file).toContain(`${total} registered tools`);
      expect(doc, file).toContain(`${model} model-visible`);
      expect(doc, file).toContain(`${app} app-only`);
      expect(doc, file).not.toMatch(/\b53(?: registered)?(?: tools|:| at)|\b30 model-visible|\b23 app-only|thirty model-visible|twenty-three app-only|it is thirty:|remaining twenty-three/iu);
    }
  });

  it('parses the Codex manifest and points to the packaged skill and MCP entry', async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8')) as Record<string, unknown>;
    const mcpConfig = JSON.parse(await readFile(mcpConfigUrl, 'utf8')) as {
      mcpServers?: Record<string, { command?: unknown; args?: unknown; cwd?: unknown }>;
    };

    expect(manifest).toMatchObject({
      name: 'stereofold',
      version: '0.1.21',
      description: 'Explore molecular structures with Codex or Claude and keep changing the same scene on your computer and WebXR headset.',
      author: { name: 'Jacob Vogan' },
      skills: './skills/',
      mcpServers: './.mcp.json',
      interface: {
        displayName: 'Stereofold',
        shortDescription: 'Put molecules in your headset',
        developerName: 'Jacob Vogan',
        websiteURL: 'https://jvogan.github.io/stereofold/',
        supportURL: 'https://jvogan.github.io/stereofold/support.html',
        privacyPolicyURL: 'https://jvogan.github.io/stereofold/privacy.html',
        termsOfServiceURL: 'https://jvogan.github.io/stereofold/terms.html',
        category: 'Education & Research',
        brandColor: '#137D70',
        brandColorDark: '#65E4D2',
        composerIcon: './assets/icon-256.png',
        logo: './assets/logo-1024.png',
      },
    });
    const submission = (manifest.extensions as {
      'com.openai': {
        review: { commerce: boolean; test_cases: { positive: unknown[]; negative: unknown[] } };
        publication: { countries: string[] };
        onboardingSkill: string;
      };
    })['com.openai'];
    expect(submission.review.commerce).toBe(false);
    expect(submission.review.test_cases.positive).toHaveLength(5);
    expect(submission.review.test_cases.negative).toHaveLength(3);
    expect(submission.publication.countries).toEqual([]);
    expect(submission.onboardingSkill).toBe('./skills/stereofold-setup/SKILL.md');
    expect(mcpConfig.mcpServers?.stereo_structure).toEqual({
      command: 'node',
      args: ['./dist/server.mjs'],
      cwd: '.',
    });
    // Codex ignores the entire field when more than three starters are supplied.
    const prompts = (manifest.interface as { defaultPrompt: unknown[] }).defaultPrompt;
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.length).toBeLessThanOrEqual(3);
    expect(prompts.every(prompt => typeof prompt === 'string' && prompt.trim().length > 0)).toBe(true);

    const [license, notices, composerIcon, logo] = await Promise.all([
      readFile(licenseUrl, 'utf8'),
      readFile(noticesUrl, 'utf8'),
      readFile(new URL('../assets/icon-256.png', import.meta.url)),
      readFile(new URL('../assets/logo-1024.png', import.meta.url)),
    ]);
    expect(license).toContain('MIT License');
    expect(license).toContain('Stereofold Contributors');
    const noticeTitles = [...notices.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
    // Mol*'s stock React controls intentionally add React, ReactDOM and the
    // react-markdown parser chain to the generated notices. Keep the direct
    // and previously reviewed packages required while allowing that upstream
    // transitive chain to grow without hiding duplicate or unstable sections.
    expect(noticeTitles).toEqual(expect.arrayContaining([
      '@modelcontextprotocol/ext-apps 1.7.5',
      '@modelcontextprotocol/sdk 1.29.0',
      'react 19.2.8',
      'react-dom 19.2.8',
      'react-markdown 10.1.0',
      'scheduler 0.27.0',
      'ajv 8.20.0',
      'ajv-formats 3.0.1',
      'fast-deep-equal 3.1.3',
      'fast-uri 3.1.6',
      'immutable 5.1.9',
      'json-schema-traverse 1.0.0',
      'molstar 5.11.0',
      'mutative 1.3.0',
      'rxjs 7.8.2',
      'tslib 2.8.1',
      'zod 4.3.0',
      'zod-to-json-schema 3.25.2',
      'SourceSans3 embedded fonts',
      'IBMPlexMono embedded fonts',
    ]));
    expect(new Set(noticeTitles).size).toBe(noticeTitles.length);
    const packageTitles = noticeTitles.filter((title) => !title.endsWith('embedded fonts'));
    expect(packageTitles).toEqual([...packageTitles].sort((left, right) => left.localeCompare(right)));
    expect(noticeTitles.slice(-2)).toEqual(['SourceSans3 embedded fonts', 'IBMPlexMono embedded fonts']);
    expect(notices).toContain('Apache License\n                           Version 2.0');
    expect(notices).toContain('- License metadata: BSD-3-Clause');
    expect(notices).toContain('- License metadata: ISC');
    expect(composerIcon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(logo.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('parses the Claude Code manifest and starts the shipped server from the plugin root', async () => {
    const manifest = JSON.parse(await readFile(claudeCodeManifestUrl, 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: 'stereofold',
      version: '0.1.21',
      license: 'MIT',
      author: { name: 'Jacob Vogan' },
      skills: ['./skills/', './claude-code/skills/'],
      privacyPolicyUrl: 'https://jvogan.github.io/stereofold/privacy.html',
      supportUrl: 'https://jvogan.github.io/stereofold/support.html',
      documentationUrl: 'https://github.com/jvogan/stereofold/blob/main/docs/install.md',
      termsOfServiceUrl: 'https://jvogan.github.io/stereofold/terms.html',
    });
    expect(manifest).not.toHaveProperty('icon');
    const icon = await readFile(new URL('../.claude-plugin/icon.png', import.meta.url));
    expect(icon).toEqual(await readFile(new URL('../assets/logo-1024.png', import.meta.url)));
    expect(icon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const width = icon.readUInt32BE(16), height = icon.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
    expect(icon.length).toBeLessThan(2 * 1024 * 1024);
    const marketplace = JSON.parse(await readFile(new URL('../../.claude-plugin/marketplace.json', import.meta.url), 'utf8')) as {
      plugins: Array<{ name: string; author: unknown; description: unknown }>;
    };
    expect(marketplace.plugins.find(plugin => plugin.name === manifest.name)).toMatchObject({
      author: manifest.author,
      description: manifest.description,
    });
    // Claude Code copies the plugin directory into its cache and expands
    // `${CLAUDE_PLUGIN_ROOT}` to that copy, so the manifest lives at the
    // artifact root beside `dist/` and names the same server Codex starts.
    expect(manifest.mcpServers).toEqual({
      stereo_structure: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.mjs'] },
    });

    const skill = await readFile(questSkillUrl, 'utf8');
    expect(skill.startsWith('---')).toBe(true);
    expect(skill).toMatch(/^name: stereofold-quest$/mu);
    expect(skill).not.toMatch(/^allowed-tools: (?:Bash, Read|Read, Bash)$/mu);
  });

  it('stages both host manifests in the release, and no development source with them', async () => {
    const release = await readFile(releaseScriptUrl, 'utf8');
    const entries = release.slice(release.indexOf('const releaseEntries'), release.indexOf('] as const'));
    // Codex reads `.codex-plugin`; Claude Code reads `.claude-plugin` and
    // `claude-code/skills`, and both install the whole directory.
    // Staging one without the other is what left the two hosts on different
    // builds of the same plugin.
    // `native` carries the Swift speech tool, without which the Apple voice
    // route would exist only for people working in a repository checkout.
    // `demos` carries the demo index and its lessons: growth reads them from
    // beside the bundle, and Claude Science runs the release artifact rather
    // than a checkout.
    // `QUICKSTART.md` is the first-run page. A release that leaves it behind
    // points its user at repository docs they do not have.
    for (const entry of ['.claude-plugin', '.codex-plugin', '.mcp.json', 'QUICKSTART.md', 'assets', 'claude-code', 'codex', 'demos', 'dist', 'native', 'skills']) {
      expect(entries).toContain(`'${entry}'`);
    }
    // The artifact launches without node_modules, so it carries neither the
    // workspace manifest nor the TypeScript the launchers are written in.
    for (const entry of ['package.json', 'node_modules', 'src', 'test', 'scripts']) {
      expect(entries).not.toContain(`'${entry}'`);
    }
    // Which is exactly why the setup check rides inside `skills/` as plain
    // ESM. It is the first command a fresh agent runs, before any install, and
    // `node <this file>` is the only form that works from this artifact.
    expect(release).toContain('skills/stereofold-setup/scripts/setup-check.mjs');
    const setupCheck = await readFile(setupCheckUrl, 'utf8');
    expect(setupCheck).toContain('export function run(');
    expect(setupCheck).not.toMatch(/^import .* from '(?!node:)/mu);
  });

  it('ships a setup skill an agent can follow from discovery to a recovery command', async () => {
    const skill = await readFile(setupSkillUrl, 'utf8');
    expect(skill.startsWith('---')).toBe(true);
    expect(skill).toMatch(/^name: stereofold-setup$/mu);
    const hosts = await readFile(new URL('../skills/stereofold-setup/references/hosts.md', import.meta.url), 'utf8');
    const voice = await readFile(new URL('../skills/stereofold-setup/references/voice.md', import.meta.url), 'utf8');
    expect(skill).toContain('references/hosts.md');
    expect(skill).toContain('references/voice.md');
    for (const host of ['### Codex', '### Claude Science', '### Claude Code']) {
      expect(hosts).toContain(host);
    }
    for (const setting of ['~/.stereofold/config.json', 'python3Bin', 'agentVoiceBin',
      'STEREOFOLD_CONFIG', 'STEREOFOLD_PYTHON3_BIN', 'STEREOFOLD_AGENT_VOICE_BIN']) {
      expect(voice).toContain(setting);
    }
    expect(skill).toContain('node skills/stereofold-setup/scripts/open-check.mjs');
    expect(skill).toContain('hasScene: true');
    expect(skill).toContain('availability: "ready"');
    expect(skill).toContain('OPEN PASS');
    expect(skill).toContain('SHA256SUMS');
    expect(skill).not.toMatch(/pnpm install|pnpm run build/u);
  });

  it('publishes the Claude Science file-viewer binding only on the coordinate-opening tool', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(new URL('./does-not-need-to-exist.html', pluginRoot).pathname);
    const client = new Client({ name: 'Stereofold packaging test', version: '0.1.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const viewerBoundTools = listed.tools.filter((tool) => tool._meta?.['operon.dev/viewer'] != null);

      expect(viewerBoundTools.map((tool) => tool.name)).toEqual(['stereo_structure.open']);
      expect(viewerBoundTools[0]?._meta?.['operon.dev/viewer']).toEqual(CLAUDE_SCIENCE_VIEWER_BINDING);
      expect(viewerBoundTools[0]?._meta?.ui).toMatchObject({
        resourceUri: 'ui://stereo-structure/viewer',
      });
      expect(viewerBoundTools[0]?._meta?.['ui/resourceUri']).toBe('ui://stereo-structure/viewer');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('hides the structure cache from the model and mounts no panel for it', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(new URL('./does-not-need-to-exist.html', pluginRoot).pathname);
    const client = new Client({ name: 'Stereofold visibility test', version: '0.1.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const cacheTool = listed.tools.find((tool) => tool.name === 'stereo_structure.get_structure');
      const ui = cacheTool?._meta?.ui as { visibility?: unknown; resourceUri?: unknown } | undefined;

      // ['app'] controls who may invoke it; the coordinate boundary itself is
      // the component-private result metadata asserted below.
      expect(ui?.visibility).toEqual(['app']);
      // No resourceUri on either key: a host mounts a panel for a tool that
      // names a UI resource, and this tool is a data read, not a view.
      expect(ui?.resourceUri).toBeUndefined();
      expect(cacheTool?._meta?.['ui/resourceUri']).toBeUndefined();
      expect(cacheTool?.annotations?.readOnlyHint).toBe(true);
      // Coordinate hydration, scene persistence, diagnostics, and renderer
      // delivery/receipts stay app-only. Public commands carry no coordinates.
      const appOnly = listed.tools
        .filter((tool) => (tool._meta?.ui as { visibility?: unknown } | undefined)?.visibility != null)
        .map((tool) => tool.name)
        .sort();
      expect(appOnly).toEqual(APP_ONLY_TOOL_NAMES);
      const modelVisible = listed.tools.filter((tool) => (tool._meta?.ui as { visibility?: unknown } | undefined)?.visibility == null);
      expect(modelVisible.map(tool=>tool.name).sort()).toEqual(MODEL_VISIBLE_TOOL_NAMES);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps the fit diagnostics app-only, mounts no panel, and returns them verbatim', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(new URL('./does-not-need-to-exist.html', pluginRoot).pathname);
    const client = new Client({ name: 'Stereofold diagnostics test', version: '0.1.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const tool = listed.tools.find((entry) => entry.name === 'stereo_structure.report_diagnostics');
      const ui = tool?._meta?.ui as { visibility?: unknown; resourceUri?: unknown } | undefined;
      // The viewer reports about once a second. A tool that named a UI
      // resource would mount a fresh Codex panel on every one of those.
      expect(ui?.visibility).toEqual(['app']);
      expect(ui?.resourceUri).toBeUndefined();
      expect(tool?._meta?.['ui/resourceUri']).toBeUndefined();

      const sessionId = await createSession(client);
      const before = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId } });
      expect((before.structuredContent as { diagnostics?: unknown }).diagnostics).toBeUndefined();

      await client.callTool({ name: 'stereo_structure.report_diagnostics', arguments: { sessionId, diagnostics: MINIMAL_DIAGNOSTICS } });
      const after = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId } });
      expect((after.structuredContent as { diagnostics?: unknown }).diagnostics).toEqual(MINIMAL_DIAGNOSTICS);
      // A report is a read of the panel, not a write to the session.
      expect(after.structuredContent).toMatchObject({ mode: 'off', depthBudgetArcmin: 20 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps the view-state sync app-only and mounts no panel for it', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(new URL('./does-not-need-to-exist.html', pluginRoot).pathname);
    const client = new Client({ name: 'Stereofold sync visibility test', version: '0.1.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const syncTool = listed.tools.find((tool) => tool.name === 'stereo_structure.sync_view');
      const ui = syncTool?._meta?.ui as { visibility?: unknown; resourceUri?: unknown } | undefined;

      // The whole point of this tool is that it can be called while the Depth
      // slider is being dragged. Only `open` carries a resourceUri; sync_view
      // must stay app-only and non-rendering.
      expect(syncTool).toBeDefined();
      expect(ui?.visibility).toEqual(['app']);
      expect(ui?.resourceUri).toBeUndefined();
      expect(syncTool?._meta?.['ui/resourceUri']).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('round-trips colour and style through sync_view, open, set_look, and the fresh-panel cache', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(new URL('./does-not-need-to-exist.html', pluginRoot).pathname);
    const client = new Client({ name: 'Stereofold look test', version: '0.1.0' });
    const look = (result: unknown): { color?: unknown; style?: unknown } =>
      (result as { structuredContent?: unknown }).structuredContent as { color?: unknown; style?: unknown };

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const sessionId = await createSession(client);

      // The default is the look this viewer already drew.
      expect(look(await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId } })))
        .toMatchObject({ color: 'chain-id', style: 'polymer-and-ligand' });

      // The panel's own write, which merges into the state get_state reports.
      await client.callTool({
        name: 'stereo_structure.sync_view',
        arguments: { sessionId, mode: 'parallel', depthBudgetArcmin: 37, swapEyes: true, color: 'sequence-id', style: 'atomic-detail' },
      });
      const synced = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId } });
      expect(synced.structuredContent).toMatchObject({
        mode: 'parallel',
        depthBudgetArcmin: 37,
        swapEyes: true,
        color: 'sequence-id',
        style: 'atomic-detail',
        // Untouched fields keep the value the model last set.
        variant: 'balanced',
      });

      // A fresh panel is handed the same look with the cached structure.
      await client.callTool({ name: 'stereo_structure.open', arguments: { sessionId, structureText: STRUCTURE_TEXT, format: 'pdb' } });
      expect(privateStructure(await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId } })) as { color?: unknown; style?: unknown })
        .toMatchObject({ color: 'sequence-id', style: 'atomic-detail' });

      // The model's two routes: a look on open, and set_look on what is loaded.
      const opened = await client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId, structureText: STRUCTURE_TEXT, format: 'pdb', color: 'element-symbol', style: 'molecular-surface' },
      });
      expect(look(opened)).toMatchObject({ color: 'element-symbol', style: 'molecular-surface' });
      const relooked = await client.callTool({
        name: 'stereo_structure.control',
        arguments: { sessionId, action: 'set_look', color: 'plddt-confidence' },
      });
      // set_look merges: naming only the colour leaves the style alone.
      expect(look(relooked)).toMatchObject({ color: 'plddt-confidence', style: 'molecular-surface' });

      // A look change never carries coordinates back to the model.
      expect((relooked.structuredContent as { structureText?: unknown }).structureText).toBeUndefined();
      // A set_look that names neither is refused rather than silently doing
      // nothing; the SDK reports a schema failure as an error result.
      const empty = await client.callTool({ name: 'stereo_structure.control', arguments: { sessionId, action: 'set_look' } });
      expect(empty.isError).toBe(true);
      expect(JSON.stringify(empty.content)).toContain('exact action-specific fields');
      // …and the refusal leaves the look it already had.
      expect(look(await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId } })))
        .toMatchObject({ color: 'plddt-confidence', style: 'molecular-surface' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('hydrates coordinates only through private app result metadata for a session', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(new URL('./does-not-need-to-exist.html', pluginRoot).pathname);
    const client = new Client({ name: 'Stereofold cache test', version: '0.1.0' });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const view = {
        color: 'chain-id',
        style: 'polymer-and-ligand',
        mode: 'off',
        depthBudgetArcmin: 20,
        swapEyes: false,
        variant: 'balanced',
        motion: { mode: 'rock' },
        stateRevision: 0,
      };
      const opened = await client.callTool({ name: 'stereo_structure.open', arguments: { structureText: STRUCTURE_TEXT, format: 'pdb' } });
      const sessionId = (opened.structuredContent as { sessionId?: string }).sessionId;
      const serverEpoch = (opened.structuredContent as { serverEpoch?: string }).serverEpoch;
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(serverEpoch).toMatch(/^[0-9a-f-]{36}$/i);
      const initialView = { ...view, serverEpoch };
      // Model-visible open carries only a concise summary; get_structure puts
      // the coordinate hydration payload in component-private metadata.
      expect(opened.structuredContent).toMatchObject({ kind: 'open', sessionId, hasStructure: true, ...initialView });
      expect(JSON.stringify(opened.content)).not.toContain(STRUCTURE_TEXT);
      expect(JSON.stringify(opened.structuredContent)).not.toContain(STRUCTURE_TEXT);

      const after = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId } });
      expect(after.structuredContent).toEqual({ kind: 'structure', sessionId, serverEpoch, empty: false, stateRevision: 0 });
      expectCoordinateFreePublicResult(after, STRUCTURE_TEXT);
      expect(privateStructure(after)).toEqual({ kind: 'structure', sessionId, empty: false, structureText: STRUCTURE_TEXT, format: 'pdb', sourceKind: 'pasted', ...initialView });

      // A mode set through the tool reaches a freshly mounted panel.
      await client.callTool({ name: 'stereo_structure.set_mode', arguments: { sessionId, mode: 'parallel', depthBudgetArcmin: 30, swapEyes: true } });
      const afterMode = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId } });
      expect(afterMode.structuredContent).toEqual({ kind: 'structure', sessionId, serverEpoch, empty: false, stateRevision: 1 });
      expect(privateStructure(afterMode)).toMatchObject({ mode: 'parallel', depthBudgetArcmin: 30, swapEyes: true });
      await client.callTool({ name: 'stereo_structure.set_mode', arguments: { sessionId, mode: 'off', depthBudgetArcmin: 20, swapEyes: false } });

      await client.callTool({ name: 'stereo_structure.open', arguments: { sessionId, fixture: 'three-depth-markers' } });
      const fixture = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId } });
      expect(fixture.structuredContent).toEqual({ kind: 'structure', sessionId, serverEpoch, empty: false, stateRevision: 2 });
      expect(privateStructure(fixture).fixture).toBe('three-depth-markers');

      // The results the model reads must never carry coordinates.
      const control = await client.callTool({ name: 'stereo_structure.control', arguments: { sessionId, action: 'set_look', color: 'element-symbol' } });
      const state = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId } });
      const mode = await client.callTool({ name: 'stereo_structure.set_mode', arguments: { sessionId, mode: 'parallel' } });
      const motion = await client.callTool({ name: 'stereo_structure.set_motion', arguments: { sessionId, mode: 'rock' } });
      for (const result of [opened, after, afterMode, fixture, control, state, mode, motion]) {
        expectCoordinateFreePublicResult(result, STRUCTURE_TEXT);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
