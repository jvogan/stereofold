import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  buildHostRuntimePolicy,
  extractUiResourceMetadata,
  HOST_PROFILES,
  mergeUiResourceMetadata,
  profileFromArg,
  type HostProfile,
  type HostProfileId,
  type HostRuntimePolicy,
  type UiResourceMetadata,
} from './profiles.js';
import { classifyConsoleError, classifyCspViolation, type Verdict } from './classify.js';
import { canvasStats, decodePng, type CanvasStats } from './png.js';
import { judgeFillAgreement, STAGE_FILL_FRACTION, FILL_AGREEMENT_TOLERANCE, type EyeBoxReport } from './eye-box.js';
import {
  fillForCheck,
  IdentityUnavailableError,
  isFresherReport,
  markFromIdentity,
  observedLoadSince,
  pairedReportFailures,
  resolveSettleMark,
  eyeWindowFor,
  FIT_SCENARIOS,
  fitButtonLine,
  judgeFrame,
  measurementLine,
  measuredSilhouetteRatio,
  quiesceStage,
  readDiagnostics,
  readPanelState,
  type FitButtonCheck,
  type FitDiagnosticsReading,
  type FitMeasurement,
  type PanelBox,
  type ReportMark,
} from './fit-scenarios.js';

const UNPHOTOGRAPHED_EYE: EyeBoxReport = {
  box: null,
  marginLeftCssPx: 0,
  marginRightCssPx: 0,
  marginTopCssPx: 0,
  marginBottomCssPx: 0,
  offsetXCssPx: 0,
  offsetYCssPx: 0,
  widthCssPx: 0,
  heightCssPx: 0,
};

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const serverPath = fileURLToPath(new URL('../../plugin/dist/server.mjs', import.meta.url));
const viewerResourceUri = 'ui://stereo-structure/viewer';
/** All run artifacts use this directory. Relative arguments resolve from cwd. */
const outFlagIndex = process.argv.indexOf('--out');
const outArg = process.argv.find((value) => value.startsWith('--out='))?.slice('--out='.length)
  ?? (outFlagIndex === -1 ? undefined : process.argv[outFlagIndex + 1]);
if (outFlagIndex !== -1 && (outArg == null || outArg.startsWith('--'))) {
  throw new Error('--out needs a directory path, as `--out <dir>` or `--out=<dir>`.');
}
if (outArg != null && outArg.length === 0) {
  throw new Error('--out was given an empty directory path.');
}
const outDir = outArg == null
  ? fileURLToPath(new URL('../out/', import.meta.url))
  : resolve(outArg);
// Preserve historical paths for default runs; custom runs identify their destination.
const artifactReportPath = (name: string): string => outArg == null ? `out/${name}` : resolve(outDir, name);
const DEVICE_SCALE_FACTORS = [1, 2];
const MODES = ['off', 'parallel', 'cross', 'anaglyph'] as const;

function sessionIdFromResult(result: unknown, source: string): string {
  const content = typeof result === 'object' && result != null && 'structuredContent' in result
    ? (result as { structuredContent?: { sessionId?: unknown } }).structuredContent
    : undefined;
  if (typeof content?.sessionId !== 'string' || content.sessionId.length === 0) {
    throw new Error(`${source} did not return a sessionId.`);
  }
  return content.sessionId;
}

/** Server lifecycle UUID scopes the render token that a reused frame accepts. */
function serverEpochFromResult(result: unknown, source: string): string {
  const content = typeof result === 'object' && result != null && 'structuredContent' in result
    ? (result as { structuredContent?: { serverEpoch?: unknown } }).structuredContent
    : undefined;
  if (typeof content?.serverEpoch !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(content.serverEpoch)) {
    throw new Error(`${source} did not return a serverEpoch.`);
  }
  return content.serverEpoch;
}

// Synthetic, public, non-sensitive fixture. It is deliberately small so the
// host-protocol test never needs RCSB/network access.
const FIXTURE_PDB = [
  'HEADER    HOST HARNESS FIXTURE                         01-JAN-26   HARN',
  'TITLE     SYNTHETIC THREE RESIDUE HELIX',
  'ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00 20.00           N',
  'ATOM      2  CA  ALA A   1       1.450   0.250   0.100  1.00 20.00           C',
  'ATOM      3  C   ALA A   1       2.000   1.650   0.300  1.00 20.00           C',
  'ATOM      4  O   ALA A   1       1.350   2.650   0.350  1.00 20.00           O',
  'ATOM      5  N   GLY A   2       3.250   1.800   0.500  1.00 20.00           N',
  'ATOM      6  CA  GLY A   2       4.000   3.050   0.750  1.00 20.00           C',
  'ATOM      7  C   GLY A   2       5.450   2.750   0.900  1.00 20.00           C',
  'ATOM      8  O   GLY A   2       6.100   3.700   1.100  1.00 20.00           O',
  'ATOM      9  N   SER A   3       5.950   1.500   0.750  1.00 20.00           N',
  'ATOM     10  CA  SER A   3       7.300   1.050   0.900  1.00 20.00           C',
  'ATOM     11  C   SER A   3       8.300   2.100   1.200  1.00 20.00           C',
  'ATOM     12  O   SER A   3       9.500   1.850   1.300  1.00 20.00           O',
  'ATOM     13  OG  SER A   3       7.650  -0.250   1.000  1.00 20.00           O',
  'TER',
  'END',
].join('\n');

type ConsoleErrorRecord = {
  text: string;
  count: number;
  kind: 'console' | 'pageerror';
  firstLocation: string | null;
  verdict: Verdict;
};

type CspViolationRecord = {
  count: number;
  effectiveDirective: string;
  violatedDirective: string;
  blockedURI: string;
  documentURI: string;
  sourceFile: string;
  lineNumber: number | null;
  columnNumber: number | null;
  sample: string;
  disposition: string;
  originalPolicy: string;
  sources: string[];
  verdict: Verdict;
};

type ToolCallRecord = {
  seq: number;
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  error?: string;
};

type RunResult = {
  profile: HostProfileId;
  deviceScaleFactor: number;
  panel: { widthCssPx: number; heightCssPx: number; widthSource: string; heightSource: string };
  uiMetadata: {
    found: boolean;
    csp: UiResourceMetadata['csp'];
    permissions: string[];
    sources: string[];
  };
  sandbox: HostRuntimePolicy['sandbox'];
  mounted: boolean;
  webgl2: boolean;
  modeSwitchSucceeded: boolean;
  consoleErrors: ConsoleErrorRecord[];
  consoleErrorTotal: number;
  cspViolations: CspViolationRecord[];
  cspViolationTotal: number;
  toolCalls: ToolCallRecord[];
  /** Does the viewer document fit the host panel it was given? */
  layout: {
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
    overflowXPx: number;
    overflowYPx: number;
    stageWidth: number;
    stageHeight: number;
    /** Interactive controls outside the drawer that are cut off by the panel edge or overlap another control, union over all modes. */
    clippedControls: string[];
  };
  timingMs: Record<string, number>;
  screenshots: Array<{ mode: string; path: string; panelPx: { width: number; height: number }; canvas: CanvasStats | { error: string } }>;
  failed: boolean;
  failureReasons: string[];
};

/**
 * How the host page models the card the app is mounted into.
 *
 * The default is the profile's own panel, and nothing about it moves: that is
 * the surface every existing measurement was taken against. The fit scenarios
 * pass `fullscreen` as well, which is the box a dock moves the app into, and
 * they let the host resize the iframe between the two inside one page load —
 * which is the point, because a dock is not a remount.
 */
type HostPageOptions = {
  inline?: { width: number; height: number };
  fullscreen?: { width: number; height: number };
  displayMode?: 'inline' | 'fullscreen';
  /** Empty leaves `availableDisplayModes` off the host context entirely. */
  availableDisplayModes?: string[];
};

/**
 * The host page is exactly the size of the modelled host surface, so the
 * `#app-frame` screenshot is the panel the plugin actually gets. Without the
 * explicit size the iframe falls back to the HTML default of 300x150 CSS px.
 *
 * The iframe's own size is written by `host-bridge.js` from the data
 * attributes below, so a scenario can change it without a reload. The page
 * itself is sized to the larger of the two boxes so a docked frame is never
 * clipped by the viewport.
 */
function hostPage(profile: HostProfile, options: HostPageOptions = {}): string {
  const sandbox = profile.id.startsWith('codex') ? ` sandbox="${profile.iframeSandbox}"` : '';
  const inline = options.inline ?? { width: profile.panel.widthCssPx, height: profile.panel.heightCssPx };
  const fullscreen = options.fullscreen ?? inline;
  const pageWidth = Math.max(inline.width, fullscreen.width);
  const pageHeight = Math.max(inline.height, fullscreen.height);
  const modes = options.availableDisplayModes ?? [];
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Host emulation: ${profile.id}</title>
<style>
  html, body { margin: 0; padding: 0; background: #000; width: ${pageWidth}px; height: ${pageHeight}px; overflow: hidden; }
  #app-frame { display: block; border: 0; }
</style>
</head>
<body data-profile="${profile.id}"
      data-inline-width="${inline.width}" data-inline-height="${inline.height}"
      data-fullscreen-width="${fullscreen.width}" data-fullscreen-height="${fullscreen.height}"
      data-display-mode="${options.displayMode ?? 'inline'}"
      data-available-display-modes="${modes.join(',')}">
  <iframe id="app-frame" title="MCP App"${sandbox}></iframe>
  <script src="/host-bridge.js"></script>
</body>
</html>`;
}

function proxyPage(runtime: HostRuntimePolicy): string {
  const innerSandbox = runtime.sandbox.appliedTokens.join(' ');
  const innerCsp = JSON.stringify(runtime.innerCspHeader);
  const sandbox = JSON.stringify(innerSandbox);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MCP-UI Proxy</title>
<style>html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }</style>
</head>
<body><iframe id="inner" title="MCP App inner sandbox" sandbox="${innerSandbox}" style="width:100%;height:100%;border:0;display:block"></iframe>
<script>
(() => {
  const inner = document.getElementById('inner');
  const defaultSandbox = ${sandbox};
  const innerCsp = ${innerCsp};
  const addCsp = (html) => {
    const tag = '<meta http-equiv="Content-Security-Policy" content="' + innerCsp.replaceAll('&', '&amp;').replaceAll('"', '&quot;') + '">';
    return /<head(?:\\s[^>]*)?>/i.test(html) ? html.replace(/<head(\\s[^>]*)?>/i, (m) => m + tag) : tag + html;
  };
  const permissionAllow = (permissions) => {
    const mapping = { camera: 'camera', microphone: 'microphone', geolocation: 'geolocation', clipboardWrite: 'clipboard-write' };
    if (!permissions || typeof permissions !== 'object') return 'fullscreen *';
    const values = Object.keys(permissions).filter((key) => mapping[key] && permissions[key] != null).map((key) => mapping[key] + ' *');
    return ['fullscreen *', ...values].join('; ');
  };
  window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, '*');
  window.addEventListener('message', (event) => {
    if (event.source === window.parent) {
      const message = event.data;
      if (message && message.jsonrpc === '2.0' && message.method === 'ui/notifications/sandbox-resource-ready') {
        const params = message.params || {};
        inner.setAttribute('sandbox', params.sandbox || defaultSandbox);
        inner.setAttribute('allow', permissionAllow(params.permissions));
        inner.srcdoc = addCsp(params.html || '');
      } else if (inner.contentWindow) {
        inner.contentWindow.postMessage(message, '*');
      }
      return;
    }
    if (event.source === inner.contentWindow) window.parent.postMessage(event.data, '*');
  });
})();
</script></body></html>`;
}

function writeResponse(response: ServerResponse, status: number, contentType: string, body: string, csp?: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Cache-Control', 'no-store');
  if (csp != null) response.setHeader('Content-Security-Policy', csp);
  response.end(body);
}

async function startHostServer(
  profile: HostProfile,
  viewerHtml: string,
  runtime: HostRuntimePolicy,
  pageOptions: HostPageOptions = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const bridgeScript = await readFile(fileURLToPath(new URL('../dist/host-bridge.js', import.meta.url)), 'utf8');
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/') return writeResponse(response, 200, 'text/html; charset=utf-8', hostPage(profile, pageOptions));
    if (path === '/host-bridge.js') return writeResponse(response, 200, 'text/javascript; charset=utf-8', bridgeScript, "default-src 'none'; script-src 'self';");
    if (path === '/viewer') return writeResponse(response, 200, 'text/html; charset=utf-8', viewerHtml, runtime.cspHeader);
    if (path === '/proxy') return writeResponse(response, 200, 'text/html; charset=utf-8', proxyPage(runtime), runtime.cspHeader);
    return writeResponse(response, 404, 'text/plain; charset=utf-8', 'not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('Host emulation server did not expose a TCP address.');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error == null ? resolve() : reject(error))),
  };
}

async function waitForViewerFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (await frame.locator('#stereo-app').count().catch(() => 0) > 0) return frame;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Viewer frame did not mount. Frames: ${page.frames().map((frame) => frame.url()).join(', ')}`);
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
}

async function modeButtonState(frame: Frame, mode: string): Promise<boolean> {
  return frame.locator(`[data-mode="${mode}"]`).getAttribute('aria-pressed').then((value) => value === 'true');
}

const CSP_INIT_SCRIPT = `
(() => {
  const violations = [];
  window.__stereoCspViolations = violations;
  window.addEventListener('securitypolicyviolation', (event) => {
    const item = {
      blockedURI: event.blockedURI,
      violatedDirective: event.violatedDirective,
      effectiveDirective: event.effectiveDirective,
      documentURI: event.documentURI,
      sourceFile: event.sourceFile || '',
      lineNumber: typeof event.lineNumber === 'number' ? event.lineNumber : null,
      columnNumber: typeof event.columnNumber === 'number' ? event.columnNumber : null,
      sample: event.sample || '',
      disposition: event.disposition || '',
      originalPolicy: event.originalPolicy || '',
    };
    violations.push(item);
    try { if (window.parent !== window) window.parent.postMessage({ __stereoCspViolation: item }, '*'); } catch (error) { /* opaque origin */ }
  });
})();`;

function cspKey(item: Record<string, unknown>): string {
  return [item.effectiveDirective, item.violatedDirective, item.blockedURI, item.documentURI, item.sourceFile, item.lineNumber, item.sample]
    .map((value) => String(value ?? ''))
    .join('|');
}

function shortLocation(url: string | undefined, line: number | undefined, column: number | undefined): string | null {
  if (url == null || url === '') return null;
  return `${url}:${line ?? 0}:${column ?? 0}`;
}

async function runProfile(profileId: HostProfileId, browser: Browser, deviceScaleFactor: number): Promise<RunResult> {
  const profile = HOST_PROFILES[profileId];
  const consoleErrors = new Map<string, ConsoleErrorRecord>();
  const cspSeen = new Map<string, CspViolationRecord>();
  const toolCalls: ToolCallRecord[] = [];
  let declaredUiCsp: UiResourceMetadata['csp'] | undefined;
  const timingMs: Record<string, number> = {};
  const screenshots: RunResult['screenshots'] = [];
  const started = Date.now();
  let mark = started;
  const lap = (label: string): void => {
    const now = Date.now();
    timingMs[label] = now - mark;
    mark = now;
  };

  const recordConsole = (kind: 'console' | 'pageerror', raw: string, location: string | null): void => {
    // Mol*'s SMAA lookup textures are ~100 KB data: URIs. Chromium echoes the
    // whole URI into the console message; keeping it verbatim would bury the
    // JSON report and defeat deduplication.
    const text = raw.replace(/(base64,[A-Za-z0-9+/=]{24})[A-Za-z0-9+/=]+/gu, (_match, head: string, offset: number) => {
      const tail = raw.slice(offset).match(/base64,([A-Za-z0-9+/=]+)/u)?.[1] ?? '';
      return `${head}...<${tail.length} base64 chars elided>`;
    });
    const existing = consoleErrors.get(text);
    if (existing != null) {
      existing.count += 1;
      return;
    }
    consoleErrors.set(text, { text, count: 1, kind, firstLocation: location, verdict: classifyConsoleError(text) });
  };

  const recordCsp = (item: Record<string, unknown>, source: string): void => {
    const key = cspKey(item);
    const existing = cspSeen.get(key);
    if (existing != null) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    cspSeen.set(key, {
      count: 1,
      effectiveDirective: String(item.effectiveDirective ?? ''),
      violatedDirective: String(item.violatedDirective ?? ''),
      blockedURI: String(item.blockedURI ?? ''),
      documentURI: String(item.documentURI ?? ''),
      sourceFile: String(item.sourceFile ?? ''),
      lineNumber: typeof item.lineNumber === 'number' ? item.lineNumber : null,
      columnNumber: typeof item.columnNumber === 'number' ? item.columnNumber : null,
      sample: String(item.sample ?? ''),
      disposition: String(item.disposition ?? ''),
      originalPolicy: String(item.originalPolicy ?? ''),
      sources: [source],
      verdict: classifyCspViolation(item, declaredUiCsp),
    });
  };

  let serverHost: Awaited<ReturnType<typeof startHostServer>> | undefined;
  let page: Page | undefined;
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
  let client: Client | undefined;

  try {
    client = new Client({ name: `Stereo host harness ${profileId}`, version: '0.1.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: repoRoot, stderr: 'pipe' });
    await client.connect(transport);
    lap('mcpConnect');

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    if (!toolNames.includes('stereo_structure.open') || !toolNames.includes('stereo_structure.set_mode')) {
      throw new Error(`MCP tool list missing expected names: ${toolNames.join(', ')}`);
    }
    const resources = await client.listResources();
    if (!resources.resources.some((resource) => resource.uri === viewerResourceUri)) {
      throw new Error(`MCP resource list missing ${viewerResourceUri}`);
    }
    const resource = await client.readResource({ uri: viewerResourceUri });
    const resourceContent = resource.contents[0];
    if (resourceContent == null || !('text' in resourceContent) || typeof resourceContent.text !== 'string') {
      throw new Error('MCP viewer resource did not return text/html.');
    }
    const viewerHtml = resourceContent.text;
    const resourceMetadata = extractUiResourceMetadata(resourceContent, 'resources/read');
    lap('mcpRegistrationSurface');

    // STEREO_HARNESS_STRUCTURE (a path to a PDB file) swaps the synthetic
    // tripeptide for a real structure so the panel screenshots show a protein.
    // The defect gates below do not depend on which structure is loaded.
    const structureOverride = process.env.STEREO_HARNESS_STRUCTURE;
    const structureText = structureOverride ? await readFile(structureOverride, 'utf8') : FIXTURE_PDB;
    const fixtureResult = await client.callTool({
      name: 'stereo_structure.open',
      arguments: { structureText, format: 'pdb' },
    });
    sessionIdFromResult(fixtureResult, 'stereo_structure.open');
    serverEpochFromResult(fixtureResult, 'stereo_structure.open');
    const toolResultMetadata = extractUiResourceMetadata(fixtureResult, 'tools/call result');
    const toolMetadata = tools.tools.map((tool) => extractUiResourceMetadata(tool, `tools/list:${tool.name}`));
    const uiMetadata = mergeUiResourceMetadata(resourceMetadata, toolResultMetadata, ...toolMetadata);
    declaredUiCsp = uiMetadata.found ? uiMetadata.csp : undefined;
    const runtime = buildHostRuntimePolicy(profile, uiMetadata);
    lap('fixtureToolCall');

    serverHost = await startHostServer(profile, viewerHtml, runtime);
    context = await browser.newContext({
      viewport: { width: profile.panel.widthCssPx, height: profile.panel.heightCssPx },
      deviceScaleFactor,
    });
    await context.addInitScript({ content: CSP_INIT_SCRIPT });
    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location();
      recordConsole('console', message.text(), shortLocation(location.url, location.lineNumber, location.columnNumber));
    });
    page.on('pageerror', (error) => recordConsole('pageerror', `pageerror: ${error.message}`, null));
    await page.exposeFunction('__stereoCallServer', async (params: { name: string; arguments?: Record<string, unknown> }) => {
      const seq = toolCalls.length + 1;
      const callStart = Date.now();
      // The viewer reports its fit diagnostics about once a second and each
      // report is a few kilobytes, so the record keeps the identifying fields
      // rather than the whole object. The object itself is on the server, and
      // `get_state` is how anything reads it.
      const recorded = params.name === 'stereo_structure.report_diagnostics'
        ? { diagnostics: summariseDiagnosticsArgument(params.arguments) }
        : params.arguments ?? {};
      try {
        const result = await client?.callTool({ name: params.name, arguments: params.arguments ?? {} });
        toolCalls.push({ seq, name: params.name, arguments: recorded, ok: true, durationMs: Date.now() - callStart });
        return result;
      } catch (error) {
        toolCalls.push({
          seq,
          name: params.name,
          arguments: recorded,
          ok: false,
          durationMs: Date.now() - callStart,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
    await page.exposeFunction('__stereoReadResource', async () => ({
      html: viewerHtml,
      sandbox: runtime.sandbox.appliedTokens.join(' '),
      csp: uiMetadata.csp,
      permissions: uiMetadata.permissions,
    }));

    await page.goto(serverHost.url, { waitUntil: 'domcontentloaded' });
    const activePage = page;
    lap('hostPageLoad');
    await activePage.waitForFunction(() => window.__stereoHostState?.viewerReady === true, undefined, { timeout: 35_000 });
    lap('uiInitialize');
    const frame = await waitForViewerFrame(activePage);
    await frame.waitForSelector('#connection', { timeout: 35_000 });
    await waitFor(
      () => frame.locator('#connection').textContent(),
      (value) => value === 'CONNECTED',
      35_000,
      'viewer ui/initialize connection',
    );
    lap('viewerConnected');
    await activePage.evaluate((result) => window.__stereoDeliverFixture?.(result), fixtureResult as CallToolResult);
    await frame.waitForSelector('#molstar-stage canvas', { timeout: 35_000 });
    await waitFor(
      () => frame.locator('#overlay-readout').textContent(),
      (value) => value?.includes('Loaded') === true || value?.includes('OFF') === true || value?.includes('off') === true,
      35_000,
      'fixture delivery',
    );
    lap('fixtureRendered');

    const webgl2 = await frame.evaluate(() => {
      const canvas = document.createElement('canvas');
      return canvas.getContext('webgl2') != null;
    });
    const mounted = await frame.locator('#stereo-app').count() > 0
      && await frame.locator('#connection').textContent() === 'CONNECTED'
      && await frame.locator('#molstar-stage canvas').count() > 0;

    const layout = await frame.evaluate(() => {
      const root = document.documentElement;
      const stage = document.querySelector('#molstar-stage');
      const stageBox = stage?.getBoundingClientRect();
      return {
        clientWidth: root.clientWidth,
        clientHeight: root.clientHeight,
        scrollWidth: root.scrollWidth,
        scrollHeight: root.scrollHeight,
        overflowXPx: Math.max(0, root.scrollWidth - root.clientWidth),
        overflowYPx: Math.max(0, root.scrollHeight - root.clientHeight),
        stageWidth: Math.round(stageBox?.width ?? 0),
        stageHeight: Math.round(stageBox?.height ?? 0),
        clippedControls: [] as string[],
      };
    });
    // Measured per mode, because the stereo modes reveal extra toolbar controls.
    const measureClippedControls = async (mode: string): Promise<string[]> => frame.evaluate((currentMode) => {
      // No inner named functions: esbuild's keepNames would inject a `__name`
      // helper that does not exist inside the page.
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const drawer = document.querySelector('#drawer, .drawer, [data-drawer]');
      const controls = Array.from(document.querySelectorAll<HTMLElement>('button, input, select, textarea, [data-mode]'))
        .filter((el) => !(drawer != null && drawer.contains(el)))
        .filter((el) => el.offsetParent != null && getComputedStyle(el).visibility !== 'hidden')
        .map((el) => ({
          el,
          r: el.getBoundingClientRect(),
          label: el.tagName.toLowerCase()
            + (el.id ? `#${el.id}` : '')
            + (el.getAttribute('data-mode') ? `[data-mode=${el.getAttribute('data-mode')}]` : '')
            + ((el.textContent ?? '').trim() ? ` "${(el.textContent ?? '').trim().slice(0, 24)}"` : ''),
        }))
        .filter(({ r }) => r.width > 0 && r.height > 0);
      const found = new Set<string>();
      for (const { label, r } of controls) {
        if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) {
          found.add(`${currentMode}: ${label} cut off by the panel edge (rect ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)} in ${vw}x${vh})`);
        }
      }
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
          const a = controls[i];
          const b = controls[j];
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
          const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
          if (ox > 3 && oy > 3) found.add(`${currentMode}: ${a.label} overlaps ${b.label} by ${Math.round(ox)}x${Math.round(oy)} px`);
        }
      }
      return Array.from(found);
    }, mode);

    let modeSwitchSucceeded = true;
    for (const mode of MODES) {
      const button = frame.locator(`[data-mode="${mode}"]`);
      await button.click();
      const active = await waitFor(
        () => modeButtonState(frame, mode),
        (value) => value,
        8_000,
        `${mode} mode button state`,
      );
      modeSwitchSucceeded &&= active;
      // Let the renderer settle so the screenshot is of a drawn frame.
      await activePage.waitForTimeout(400);
      for (const entry of await measureClippedControls(mode)) if (!layout.clippedControls.includes(entry)) layout.clippedControls.push(entry);
      const suffix = deviceScaleFactor === 1 ? '' : `@${deviceScaleFactor}x`;
      const imageName = `${profileId}-${mode}${suffix}.png`;
      const absolutePath = resolve(outDir, imageName);
      const panelBuffer = await activePage.locator('#app-frame').screenshot({ path: absolutePath });
      const panelPng = decodePng(panelBuffer);
      let canvas: CanvasStats | { error: string };
      try {
        canvas = canvasStats(decodePng(await frame.locator('#molstar-stage canvas').screenshot()));
      } catch (error) {
        canvas = { error: error instanceof Error ? error.message : String(error) };
      }
      screenshots.push({
        mode,
        path: artifactReportPath(imageName),
        panelPx: { width: panelPng.width, height: panelPng.height },
        canvas,
      });
    }
    lap('modeSwitch');

    await waitFor(
      () => activePage.evaluate(() => window.__stereoHostState?.toolCalls.length ?? 0),
      (value) => value >= MODES.length,
      8_000,
      'host tool-call relay',
    );
    const hostState = await activePage.evaluate(() => window.__stereoHostState);
    for (const violation of hostState?.cspViolations ?? []) recordCsp(violation, 'host-relay');
    const perFrame = await Promise.all(activePage.frames().map(async (currentFrame) => {
      const url = currentFrame.url();
      const items = await currentFrame
        .evaluate(() => (window as Window & { __stereoCspViolations?: Array<Record<string, unknown>> }).__stereoCspViolations ?? [])
        .catch(() => [] as Array<Record<string, unknown>>);
      return items.map((item) => ({ item, url }));
    }));
    for (const { item, url } of perFrame.flat()) recordCsp(item, `frame:${url || 'srcdoc'}`);
    lap('collect');

    const consoleErrorList = [...consoleErrors.values()];
    const cspList = [...cspSeen.values()];
    const relaySucceeded = toolCalls.filter((call) => call.name === 'stereo_structure.sync_view').length >= MODES.length
      && toolCalls.every((call) => call.ok);
    const failureReasons: string[] = [];
    if (!mounted) failureReasons.push('mount failed');
    if (!webgl2) failureReasons.push('WebGL2 unavailable');
    if (!(modeSwitchSucceeded && relaySucceeded)) failureReasons.push('mode switch or tool relay failed');
    for (const record of consoleErrorList) {
      if (record.verdict.fails) failureReasons.push(`console ${record.verdict.category}: ${record.text.slice(0, 160)}`);
    }
    for (const record of cspList) {
      if (record.verdict.fails) {
        failureReasons.push(`csp ${record.verdict.category}: ${record.effectiveDirective} ${record.blockedURI}`);
      }
    }
    timingMs.total = Date.now() - started;

    return {
      profile: profileId,
      deviceScaleFactor,
      panel: profile.panel,
      uiMetadata: {
        found: uiMetadata.found,
        csp: uiMetadata.csp,
        permissions: Object.keys(uiMetadata.permissions).sort(),
        sources: uiMetadata.sources,
      },
      sandbox: runtime.sandbox,
      mounted,
      webgl2,
      modeSwitchSucceeded: modeSwitchSucceeded && relaySucceeded,
      consoleErrors: consoleErrorList,
      consoleErrorTotal: consoleErrorList.reduce((sum, record) => sum + record.count, 0),
      cspViolations: cspList,
      cspViolationTotal: cspList.reduce((sum, record) => sum + record.count, 0),
      toolCalls,
      layout,
      timingMs,
      screenshots,
      failed: failureReasons.length > 0,
      failureReasons,
    };
  } finally {
    if (page != null) await page.evaluate(() => window.__stereoHostStop?.()).catch(() => undefined);
    if (context != null) await context.close().catch(() => undefined);
    if (serverHost != null) await serverHost.close().catch(() => undefined);
    if (client != null) await client.close().catch(() => undefined);
  }
}

/**
 * The identifying fields of a diagnostics report, for the tool-call record.
 *
 * A whole report is a few kilobytes and the viewer sends one a second, so
 * storing every one verbatim would make each profile's JSON tens of megabytes
 * of the same object. These four say which panel reported, when, and what it
 * thought the fill was, which is enough to line the record up against the
 * measurements that carry the full reading.
 */
function summariseDiagnosticsArgument(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const diagnostics = (args?.diagnostics ?? {}) as Record<string, unknown>;
  const camera = (diagnostics.camera ?? {}) as Record<string, unknown>;
  return {
    at: diagnostics.at,
    sequence: diagnostics.sequence,
    viewerBuild: diagnostics.viewerBuild,
    trigger: diagnostics.trigger,
    fill: camera.fill,
  };
}

/* ------------------------------------------------------ fit scenarios */

/** How long a scenario waits for the fallback load or a delivered result. */
const STRUCTURE_WAIT_MS = 40_000;
/**
 * Whether the scenarios stop the default rock before measuring.
 *
 * On by default: a ±4° rock is a moving silhouette and the measurement has to
 * be repeatable. `STEREO_FIT_KEEP_MOTION=1` leaves the shipped default running,
 * which is how the rock was ruled in or out as a cause of a stale fit.
 */
const STOP_MOTION = process.env.STEREO_FIT_KEEP_MOTION !== '1';
/** Consecutive stable polls that count as "the fit has stopped moving". */
const SETTLE_POLLS = 5;
const SETTLE_INTERVAL_MS = 120;
/**
 * How long a measurement waits for the panel to report the frame it just
 * photographed, ms.
 *
 * The viewer reports on a one-second heartbeat, so a fresh report is normally
 * one heartbeat away. The budget is generous because the alternative to
 * waiting is reading a report about the previous frame and calling it
 * evidence, which is the mistake this whole harness exists to stop making.
 */
const DIAGNOSTICS_WAIT_MS = 4_000;
const DIAGNOSTICS_POLL_MS = 120;
/**
 * How many times a measurement may retake the photograph before the failure
 * to bracket it is itself the defect.
 */
const MEASURE_ATTEMPTS = 3;

/** A `get_state` read, with whether it describes the frame that was asked about. */
type DiagnosticsFetch = { reading?: FitDiagnosticsReading; raw?: unknown; stale: boolean };

/**
 * Mark the panel in the frame: who it is, how far its own report counter has
 * got, and what its fit ring held, at this instant.
 *
 * Read from the panel rather than from the server. The server holds the last
 * report of every panel the run has mounted, and it answers `get_state` with
 * one of them; a mark taken from that answer can therefore name a panel that
 * is not the one on screen, and — worse — can be behind a report this panel
 * had already assembled and put in flight. The panel's own counter has neither
 * problem: a report with a higher sequence than this was assembled after this
 * call, full stop.
 *
 * A viewer with no probe (an older build) throws
 * {@link IdentityUnavailableError}; the scenario runner records that as a FIT
 * DEFECT `identity-unavailable`. A mark with no `panelId` is never returned.
 */
async function panelMark(frame: Frame): Promise<ReportMark> {
  const identity = await frame
    .evaluate(() => (window as unknown as {
      __stereoStructureProbe?: { identity?(): { panelId: string; sequence: number; fitEventCount: number; lastFitAt?: string } };
    }).__stereoStructureProbe?.identity?.() ?? null)
    .catch(() => null);
  return markFromIdentity(identity, new Date().toISOString());
}

/**
 * Ask the panel to redraw the frame it is showing and report at once.
 *
 * The viewer heartbeats every ten seconds once nothing has changed for five,
 * so waiting for a beat would add minutes to a run and could time out. The
 * probe redraws the same scene, which republishes the stereo draw pass's eye
 * split, and flushes a report. It moves nothing.
 */
async function pokePanel(frame: Frame): Promise<void> {
  await frame
    .evaluate(async () => {
      await (window as unknown as { __stereoStructureProbe?: { refresh(): Promise<void> } }).__stereoStructureProbe?.refresh();
    })
    .catch(() => undefined);
}

/**
 * Whether delivering this tool result will make the panel load a structure.
 *
 * Current `open` results carry an opaque session capability and a monotonic
 * server render token scoped by a random server lifecycle UUID, never
 * coordinates. Delivering one makes the panel
 * hydrate the matching app-only coordinate cache, while state/control results
 * leave the currently displayed structure alone. The settle therefore keys on
 * the complete render result contract itself.
 */
function deliversStructure(result: CallToolResult | undefined): boolean {
  const content = (result as { structuredContent?: Record<string, unknown> } | undefined)?.structuredContent;
  return content?.kind === 'open'
    && typeof content.sessionId === 'string'
    && typeof content.serverEpoch === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(content.serverEpoch)
    && typeof content.renderToken === 'number'
    && Number.isSafeInteger(content.renderToken)
    && content.renderToken > 0;
}

async function readDiagnosticsNow(client: Client, sessionId: string): Promise<FitDiagnosticsReading | undefined> {
  const result = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId } });
  return readDiagnostics(result);
}

/**
 * The panel's own numbers, newer than a mark taken before the thing that
 * changed them.
 *
 * Read through `stereo_structure.get_state`, which is the same call a real
 * Codex conversation makes: a channel that only works when a test reaches into
 * the frame is not the channel that has to work in a host nobody can reach.
 */
async function waitForDiagnostics(client: Client, frame: Frame, mark: ReportMark, sessionId: string): Promise<DiagnosticsFetch> {
  const deadline = Date.now() + DIAGNOSTICS_WAIT_MS;
  let latest: DiagnosticsFetch = { stale: true };
  for (;;) {
    await pokePanel(frame);
    const result = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId } });
    const reading = readDiagnostics(result);
    if (reading != null) {
      const raw = (result.structuredContent as { diagnostics?: unknown } | undefined)?.diagnostics;
      // A panel that closed leaves its last report on the server, so a
      // reading no newer than the mark belongs to a frame nobody
      // photographed. It is returned flagged rather than dropped, because
      // "the newest report predates the frame" and "no panel ever reported"
      // are different failures and the caller has to be able to say which.
      latest = { reading, raw, stale: !isFresherReport(reading, mark) };
      if (!latest.stale) return latest;
    }
    if (Date.now() >= deadline) return latest;
    await new Promise((resolve) => setTimeout(resolve, DIAGNOSTICS_POLL_MS));
  }
}

/**
 * Drive the five fit scenarios on one profile at one device pixel ratio.
 *
 * One MCP client and one browser context are shared across the scenarios; each
 * scenario gets its own host server and its own page, because a scenario is a
 * fresh panel mount and the display mode has to be in the very first host
 * context. The server's view state is reset between scenarios, since scenario
 * five deliberately leaves it in parallel.
 */
async function runFitScenarios(
  profileId: HostProfileId,
  browser: Browser,
  deviceScaleFactor: number,
): Promise<{ measurements: FitMeasurement[]; buttonChecks: FitButtonCheck[]; error?: string }> {
  const profile = HOST_PROFILES[profileId];
  const sidePanel = HOST_PROFILES['codex-side-panel'].panel;
  const inline: PanelBox = { width: profile.panel.widthCssPx, height: profile.panel.heightCssPx };
  const fullscreen: PanelBox = { width: sidePanel.widthCssPx, height: sidePanel.heightCssPx };
  const measurements: FitMeasurement[] = [];
  const buttonChecks: FitButtonCheck[] = [];
  /** Every diagnostics object the panel produced, verbatim, one per measurement. */
  const rawReports: Array<{ scenario: string; step: string; mode: string; diagnostics: unknown }> = [];
  const fitDir = resolve(outDir, 'fit');
  await mkdir(fitDir, { recursive: true });

  const structureOverride = process.env.STEREO_HARNESS_STRUCTURE;
  const structureText = structureOverride ? await readFile(structureOverride, 'utf8') : FIXTURE_PDB;

  let client: Client | undefined;
  let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
  try {
    client = new Client({ name: `Stereo fit scenarios ${profileId}`, version: '0.1.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: repoRoot, stderr: 'pipe' }));
    const activeClient = client;
    const tools = await activeClient.listTools();
    const resource = await activeClient.readResource({ uri: viewerResourceUri });
    const resourceContent = resource.contents[0];
    if (resourceContent == null || !('text' in resourceContent) || typeof resourceContent.text !== 'string') {
      throw new Error('MCP viewer resource did not return text/html.');
    }
    const viewerHtml = resourceContent.text;
    const uiMetadata = mergeUiResourceMetadata(
      extractUiResourceMetadata(resourceContent, 'resources/read'),
      ...tools.tools.map((tool) => extractUiResourceMetadata(tool, `tools/list:${tool.name}`)),
    );
    const runtime = buildHostRuntimePolicy(profile, uiMetadata);

    // The scenarios need a box larger than either card so a docked frame is
    // never clipped by the viewport; the modelled card is the iframe.
    context = await browser.newContext({
      viewport: {
        width: Math.max(inline.width, fullscreen.width),
        height: Math.max(inline.height, fullscreen.height),
      },
      deviceScaleFactor,
    });
    await context.addInitScript({ content: CSP_INIT_SCRIPT });
    const activeContext = context;

    /**
     * The raw call. Used unmarked for the per-scenario mount result, which is
     * fetched before any panel exists, and behind a mark everywhere else.
     */
    const callOpenStructure = (sessionId?: string): Promise<CallToolResult> => activeClient
      .callTool({
        name: 'stereo_structure.open',
        arguments: { ...(sessionId == null ? {} : { sessionId }), structureText, format: 'pdb' },
      }) as Promise<CallToolResult>;

    for (const scenario of FIT_SCENARIOS) {
      // Every scenario owns an explicit server session. Seed its structure,
      // set the server-side mode, then ask the sole render tool to produce the
      // result that mounts the panel with that final state.
      const seeded = await callOpenStructure();
      const sessionId = sessionIdFromResult(seeded, 'fit scenario stereo_structure.open');
      await activeClient.callTool({
        name: 'stereo_structure.set_mode',
        arguments: { sessionId, mode: scenario.serverMode ?? 'off', depthBudgetArcmin: 20, swapEyes: false, variant: 'balanced' },
      });
      const mountResult = await activeClient.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId },
      }) as CallToolResult;
      const initialSize = scenario.initialDisplayMode === 'fullscreen' ? fullscreen : inline;
      const host = await startHostServer(profile, viewerHtml, runtime, {
        inline,
        fullscreen,
        displayMode: scenario.initialDisplayMode,
        availableDisplayModes: ['inline', 'fullscreen'],
      });
      const page = await activeContext.newPage();
      try {
        await page.exposeFunction('__stereoCallServer', async (params: { name: string; arguments?: Record<string, unknown> }) => activeClient.callTool({ name: params.name, arguments: params.arguments ?? {} }));
        await page.exposeFunction('__stereoReadResource', async () => ({
          html: viewerHtml,
          sandbox: runtime.sandbox.appliedTokens.join(' '),
          csp: uiMetadata.csp,
          permissions: uiMetadata.permissions,
        }));
        await page.goto(host.url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__stereoHostState?.viewerReady === true, undefined, { timeout: 35_000 });
        const frame = await waitForViewerFrame(page);
        await waitFor(() => frame.locator('#connection').textContent(), (value) => value === 'CONNECTED', 35_000, 'viewer connection');
        await quiesceStage(frame, { stopMotion: STOP_MOTION });

        let panel: PanelBox = { ...initialSize };
        let index = 0;
        /**
         * Where the panel's own report counter stood just before the last step
         * acted.
         *
         * Taken by every context method that can change what the panel draws,
         * and consumed by the settle that follows it. An earlier gate run produced
         * a false FIT DEFECT because the settle keyed on the mode, the camera
         * status line and the canvas size, none of which move when an `open`
         * result's load is still running: under machine load 230 the
         * photograph caught Mol*'s own post-load camera before
         * `fitCameraToStage` had run, and the report taken afterwards
         * described the corrected frame. A mark taken before the delivery is
         * what makes "the load this step started has finished" answerable.
         */
        let pendingMark: ReportMark | undefined;
        /**
         * True when the marked step handed the panel a structure, so the
         * settle that follows has a load to observe before it may conclude
         * anything. Set from the delivered result itself rather than declared
         * by the caller: only an `open` render result initiates app-only
         * coordinate hydration, and a `state` result does
         * not, so a settle after one must not sit waiting for a load that was
         * never going to happen.
         */
        let pendingLoad = false;
        /** Settles that could not prove what they waited for, for the next measurement. */
        let settleFailures: string[] = [];
        /** True after a settle that must not be followed by a photograph. */
        let skipPhotograph = false;

        const abortSettle = (reason: string): void => {
          settleFailures.push(reason);
          skipPhotograph = true;
        };

        const markPanel = async (options: { load?: boolean } = {}): Promise<void> => {
          pendingMark = await panelMark(frame);
          pendingLoad = options.load === true;
        };

        const unphotographedMeasurement = (step: string, expectedMode: string | undefined, settleFailed: string[]): FitMeasurement => {
          const measurement: FitMeasurement = {
            scenario: scenario.id,
            step,
            profile: profileId,
            deviceScaleFactor,
            mode: 'unphotographed',
            ...(expectedMode == null ? {} : { expectedMode }),
            panelCssPx: { ...panel },
            canvasCssPx: { width: 0, height: 0 },
            eyeWindowCssPx: { width: 0, height: 0 },
            cameraStatus: 'unphotographed',
            left: UNPHOTOGRAPHED_EYE,
            right: UNPHOTOGRAPHED_EYE,
            sizeDeltaCssPx: { width: 0, height: 0 },
            pairOffsetDeltaCssPx: { x: 0, y: 0 },
            silhouetteRatioMeasured: null,
            fillSource: 'none',
            fillFailures: [],
            reportPairing: [],
            measureAttempts: 0,
            settleFailures: settleFailed,
            pass: false,
            failures: settleFailed,
            screenshot: '',
            panelScreenshot: '',
          };
          measurements.push(measurement);
          return measurement;
        };

        // Marked like every other delivery: without this the mark was taken
        // after `waitForStructure` had already resolved, so the settle could
        // pass on a report that predates the load it was waiting for. This is
        // scenario s7's whole path. The load flag is set before the mark so a
        // path that later drops `markPanel` still tells settle a structure
        // was delivered.
        if (scenario.deliverOnMount) {
          const load = deliversStructure(mountResult as CallToolResult);
          if (load) pendingLoad = true;
          await markPanel({ load });
          await page.evaluate((result) => window.__stereoDeliverFixture?.(result), mountResult as CallToolResult);
        }
        await frame.waitForSelector('#molstar-stage canvas', { timeout: 35_000 });

        const settle = async (): Promise<void> => {
          const decision = resolveSettleMark({ pendingMark, deliveredStructure: pendingLoad });
          pendingMark = undefined;
          pendingLoad = false;
          const where = `${scenario.id} ${profileId} dpr=${deviceScaleFactor}`;
          if (decision.kind === 'mark-missing') {
            abortSettle(`mark-missing: ${where}: a structure was delivered and no panel mark was taken before the delivery`);
            return;
          }
          if (decision.kind === 'identity-unavailable') {
            abortSettle(`identity-unavailable: ${where}: the pending mark named no panel`);
            return;
          }
          let mark: ReportMark;
          try {
            mark = decision.kind === 'use' ? decision.mark : await panelMark(frame);
          } catch (error) {
            if (error instanceof IdentityUnavailableError) {
              abortSettle(`identity-unavailable: ${where}: ${error.message}`);
              return;
            }
            throw error;
          }
          if (mark.panelId == null) {
            abortSettle(`identity-unavailable: ${where}: the mark named no panel`);
            return;
          }
          const awaitingLoad = decision.kind === 'use' && decision.awaitingLoad;
          await quiesceStage(frame, { stopMotion: STOP_MOTION });
          let previous = '';
          let stable = 0;
          // A delivery has to be seen to have happened before anything after it
          // can be believed. `settle` flushes a report on every poll, and under
          // machine load that flush can be assembled before `loadStructure`
          // sets `loadInFlight`: the result carries a newer sequence, no load
          // in flight and no transition, which satisfied every condition below
          // while describing the camera as it was before the delivery. The
          // photograph then caught Mol*'s own post-load reset. So the load is
          // observed first — running, or already over and visible as a fit
          // event the mark did not have — and only then does the settle proper
          // begin.
          let loadObserved = !awaitingLoad;
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            await page.waitForTimeout(SETTLE_INTERVAL_MS);
            if (!loadObserved) {
              await pokePanel(frame);
              const reading = await readDiagnosticsNow(activeClient, sessionId);
              if (reading != null && isFresherReport(reading, mark) && observedLoadSince(reading, mark)) {
                loadObserved = true;
              }
              continue;
            }
            // Two conditions, and both have to hold at once. The document has
            // stopped moving, which was the original settle key; and the panel has
            // reported since the step started, with no load in flight and no
            // camera transition running. The report is asked for only once the
            // key has held still, so it cannot be a heartbeat that slipped out
            // between the mark and the step reaching the app.
            const state = await readPanelState(frame);
            const key = `${state.mode}|${state.cameraStatus}|${Math.round(state.canvas.width)}x${Math.round(state.canvas.height)}`;
            stable = key === previous ? stable + 1 : 0;
            previous = key;
            if (stable < SETTLE_POLLS) continue;
            await pokePanel(frame);
            const reading = await readDiagnosticsNow(activeClient, sessionId);
            if (reading != null && isFresherReport(reading, mark) && !reading.loadInFlight && !reading.inTransition) break;
          }
          // A delivery that never produced a load is a defect, not a pass. The
          // frame that follows describes something, but not the delivery, and
          // calling it evidence is the mistake this harness exists to stop making.
          if (!loadObserved) {
            settleFailures.push(
              `load-never-observed: a structure was delivered to panel ${mark.panelId ?? 'unidentified'}`
              + ` and no report inside 30 s carried a load in flight or a fit event newer than`
              + ` ${mark.lastFitAt ?? 'none'} (ring ${mark.fitEventCount ?? 0} at the mark)`,
            );
          }
          await page.waitForTimeout(250);
        };

        /**
         * Photograph the frame and pair it with the panel's own numbers.
         *
         * A report timestamped after a mark taken before the shutter proves
         * nothing about the frame in the photograph: a heartbeat between the
         * mark and the shutter passes, and so does a fit between the shutter
         * and the report. So the frame is bracketed. A report is taken
         * immediately before the screenshots and another immediately after,
         * and the measurement is accepted only when the two agree that
         * nothing happened in between: the same number of fit events, the
         * same newest fit event, no camera transition either side, and the
         * same camera distance to a millionth of an angstrom. When they do
         * not agree the panel is settled again and the photograph retaken, up
         * to three times; after that the mismatch is the defect.
         */
        const measure = async (step: string, expectedMode?: string): Promise<FitMeasurement> => {
          index += 1;
          const suffix = deviceScaleFactor === 1 ? '' : `@${deviceScaleFactor}x`;
          const stem = `${profileId}-${scenario.id}-${String(index).padStart(2, '0')}${suffix}`;
          const canvasPath = resolve(fitDir, `${stem}-canvas.png`);
          const panelPath = resolve(fitDir, `${stem}-panel.png`);
          if (skipPhotograph) {
            skipPhotograph = false;
            const settleFailed = settleFailures;
            settleFailures = [];
            return unphotographedMeasurement(step, expectedMode, settleFailed);
          }
          let attempts = 0;
          let state = await readPanelState(frame);
          let buffer: Buffer = Buffer.alloc(0);
          let beforeFetch: DiagnosticsFetch = { stale: true };
          let afterFetch: DiagnosticsFetch = { stale: true };
          let pairing: string[] = [];
          try {
          for (;;) {
            attempts += 1;
            await quiesceStage(frame, { stopMotion: STOP_MOTION });
            beforeFetch = await waitForDiagnostics(activeClient, frame, await panelMark(frame), sessionId);
            state = await readPanelState(frame);
            // Clipped from the page rather than taken off the element: an
            // element screenshot waits for the element to be stable, which is
            // the known flake under machine load, and the canvas box is
            // already known exactly.
            buffer = await page.screenshot({
              path: canvasPath,
              clip: {
                x: Math.round(state.canvas.x),
                y: Math.round(state.canvas.y),
                width: Math.round(state.canvas.width),
                height: Math.round(state.canvas.height),
              },
            });
            // The shutter mark is read from the panel between the two
            // screenshots, so "after" is provably after rather than merely
            // later-numbered. Marking from the report the server happened to
            // hold instead let a report the panel had already assembled and
            // put in flight before the shutter close the bracket, which is a
            // pair of pre-shutter readings agreeing with each other about a
            // frame neither of them describes.
            const shutterMark = await panelMark(frame);
            await page.screenshot({ path: panelPath, clip: { x: 0, y: 0, width: panel.width, height: panel.height } });
            afterFetch = await waitForDiagnostics(activeClient, frame, shutterMark, sessionId);
            pairing = pairedReportFailures(
              beforeFetch.stale ? undefined : beforeFetch.reading,
              afterFetch.stale ? undefined : afterFetch.reading,
            );
            if (pairing.length === 0 || attempts >= MEASURE_ATTEMPTS) break;
            await settle();
            if (skipPhotograph) break;
          }
          } catch (error) {
            if (!(error instanceof IdentityUnavailableError)) throw error;
            abortSettle(`identity-unavailable: ${scenario.id} / ${step} ${profileId} dpr=${deviceScaleFactor}: ${error.message}`);
          }
          if (skipPhotograph) {
            skipPhotograph = false;
            const settleFailed = settleFailures;
            settleFailures = [];
            return unphotographedMeasurement(step, expectedMode, settleFailed);
          }
          // The bracket proves the two readings describe one camera state, so
          // either is the frame's own report. The earlier one is kept because
          // its draw-pass reading is the closer of the two to the shutter.
          const report = beforeFetch;
          const diagnostics = report.reading;
          // Everything the settles before this frame could not prove, including
          // the ones the retry loop above ran.
          const settleFailed = settleFailures;
          settleFailures = [];
          // The whole object, kept verbatim beside the frame it describes.
          // The trimmed reading above is what the run log needs; this is what
          // a reader has to be able to compare against a live host's own
          // get_state, field for field.
          if (report.raw != null && !report.stale) rawReports.push({ scenario: scenario.id, step, mode: state.mode, diagnostics: report.raw });
          const png = decodePng(buffer);
          const scale = state.canvas.width > 0 ? png.width / Math.round(state.canvas.width) : deviceScaleFactor;
          const verdict = judgeFrame({ png, scale, mode: state.mode, cameraStatus: state.cameraStatus });
          const canvasCssPx: PanelBox = { width: state.canvas.width, height: state.canvas.height };
          const failures = [...verdict.failures];
          // A panel framed correctly for mono while the session is in parallel
          // is framed correctly and still the wrong picture, so the mode is
          // asserted wherever the scenario states one.
          if (expectedMode != null && state.mode !== expectedMode) {
            failures.unshift(`panel is in ${state.mode}, the session is in ${expectedMode}`);
          }
          const eyeWindowCssPx = eyeWindowFor(state.mode, canvasCssPx);
          const silhouetteRatioMeasured = measuredSilhouetteRatio({ left: verdict.left, right: verdict.right, eyeWindowCssPx });
          // The panel's own number against the pixels it produced. In a stereo
          // mode that number is the draw pass's own fill, not the viewer's CSS
          // estimate: the two agree exactly when the estimate is right, and
          // only the draw pass's moves when it is not. A frame that reports no
          // fill at all fails too: the channel out of a live webview not
          // working is the one thing this harness cannot tolerate.
          const checked = fillForCheck(state.mode, diagnostics);
          const fillFailures = report.stale && diagnostics != null
            ? [`the panel's newest report (${diagnostics.at}, sequence ${diagnostics.sequence}) predates this frame; it describes a frame nobody measured`]
            : judgeFillAgreement({ fill: checked.fill, silhouetteRatio: silhouetteRatioMeasured, label: checked.source });
          failures.push(...fillFailures);
          failures.push(...settleFailed);
          if (pairing.length > 0) {
            failures.push(`report-photo-mismatch after ${attempts} attempts: ${pairing.join('; ')}`);
          }
          const measurement: FitMeasurement = {
            scenario: scenario.id,
            step,
            profile: profileId,
            deviceScaleFactor,
            mode: state.mode,
            ...(expectedMode == null ? {} : { expectedMode }),
            panelCssPx: { ...panel },
            canvasCssPx,
            eyeWindowCssPx,
            cameraStatus: state.cameraStatus,
            left: verdict.left,
            right: verdict.right,
            sizeDeltaCssPx: verdict.sizeDeltaCssPx,
            pairOffsetDeltaCssPx: verdict.pairOffsetDeltaCssPx,
            ...(diagnostics == null ? {} : { diagnostics }),
            silhouetteRatioMeasured,
            ...(checked.fill == null ? {} : { fillChecked: checked.fill }),
            fillSource: checked.source,
            fillFailures,
            reportPairing: pairing,
            measureAttempts: attempts,
            settleFailures: settleFailed,
            pass: failures.length === 0,
            failures,
            screenshot: artifactReportPath(`fit/${stem}-canvas.png`),
            panelScreenshot: artifactReportPath(`fit/${stem}-panel.png`),
          };
          measurements.push(measurement);
          return measurement;
        };

        try {
        await scenario.run({
          page,
          frame,
          profileId,
          deviceScaleFactor,
          inline,
          fullscreen,
          // Every method below that can change what the panel draws takes the
          // mark first, so the settle that follows it knows what "since this
          // step started" means.
          callTool: async (name, args) => {
            await markPanel();
            return activeClient.callTool({ name, arguments: { ...(args ?? {}), sessionId } }) as Promise<CallToolResult>;
          },
          openStructure: async () => {
            await markPanel();
            return callOpenStructure(sessionId);
          },
          deliverResult: async (result, args) => {
            const load = deliversStructure(result);
            if (load) pendingLoad = true;
            await markPanel({ load });
            await page.evaluate(([value, callArgs]) => window.__stereoDeliverResult?.(value as CallToolResult, callArgs as Record<string, unknown>), [result, args ?? {}] as [CallToolResult, Record<string, unknown>]);
          },
          clickMode: async (mode) => {
            await markPanel();
            // Dispatched rather than clicked: Playwright's actionability check
            // hit-tests a point on a canvas that repaints every frame, and it
            // stalled on the dock round trip. The listener under test is the
            // same one either way.
            await frame.locator(`[data-mode="${mode}"]`).dispatchEvent('click');
            await waitFor(() => modeButtonState(frame, mode), (value) => value, 8_000, `${mode} mode button state`);
          },
          setDisplayMode: async (mode) => {
            await markPanel();
            panel = mode === 'fullscreen' ? { ...fullscreen } : { ...inline };
            await page.evaluate((value) => window.__stereoSetDisplayMode?.(value), mode);
          },
          setPanelSize: async (box) => {
            await markPanel();
            panel = { ...box };
            await page.evaluate(([width, height]) => window.__stereoSetPanelSize?.(width, height), [box.width, box.height] as [number, number]);
          },
          clickDisplayModeToggle: async () => {
            await markPanel();
            const before = await page.evaluate(() => window.__stereoHostState?.displayModeRequests.length ?? 0);
            await frame.locator('#display-mode-toggle').dispatchEvent('click');
            // Wait for the host to have answered, not merely for the click:
            // the app's refit runs off the response and the resize that comes
            // with it.
            await waitFor(
              () => page.evaluate(() => window.__stereoHostState?.displayModeRequests.length ?? 0),
              (count) => count > before,
              8_000,
              'display mode request reaching the host',
            );
            const granted = await page.evaluate(() => window.__stereoHostState?.displayMode ?? 'inline');
            panel = granted === 'fullscreen' ? { ...fullscreen } : { ...inline };
          },
          waitForStructure: async () => {
            await waitFor(
              () => frame.locator('#notice').textContent(),
              (value) => (value ?? '').startsWith('Loaded '),
              STRUCTURE_WAIT_MS,
              'structure on the stage',
            );
          },
          setServerMode: async (mode) => {
            await markPanel();
            await activeClient.callTool({ name: 'stereo_structure.set_mode', arguments: { sessionId, mode } });
          },
          checkFitButton: async (step) => {
            const beforeFetch = await waitForDiagnostics(activeClient, frame, await panelMark(frame), sessionId);
            const before = beforeFetch.stale ? undefined : beforeFetch.reading;
            const button = frame.locator('#fit-view');
            const visible = await button.isVisible().catch(() => false);
            const mark = await panelMark(frame);
            pendingMark = mark;
            // The press runs a fit, not a load.
            pendingLoad = false;
            // Dispatched rather than clicked, for the same reason the mode
            // buttons are: Playwright's actionability check hit-tests against
            // a canvas that repaints every frame.
            if (visible) await button.dispatchEvent('click');
            await settle();
            const settleFailed = settleFailures;
            settleFailures = [];
            skipPhotograph = false;
            const afterFetch = visible && settleFailed.length === 0
              ? await waitForDiagnostics(activeClient, frame, mark, sessionId)
              : undefined;
            const after = afterFetch?.stale === false ? afterFetch.reading : undefined;
            const failures: string[] = [...settleFailed];
            if (!visible) failures.push('the Fit button is not visible in a stereo mode');
            if (visible && after == null) {
              failures.push(afterFetch?.reading == null
                ? 'no diagnostics report followed the Fit button'
                : `the newest report (${afterFetch.reading.at}, sequence ${afterFetch.reading.sequence}) predates the Fit button press`);
            }
            const lastTrigger = after?.fitEventTriggers.at(-1);
            if (after != null && lastTrigger !== 'button') {
              failures.push(`the newest fit event is ${lastTrigger ?? 'none'}, not button: the press did not run a fit`);
            }
            if (after != null) {
              failures.push(...judgeFillAgreement({ fill: after.fill, silhouetteRatio: null }));
              if (after.fill != null && after.fill < STAGE_FILL_FRACTION * (1 - FILL_AGREEMENT_TOLERANCE)) {
                failures.push(`fill after the press is ${after.fill.toFixed(4)}, below ${STAGE_FILL_FRACTION} less ${(FILL_AGREEMENT_TOLERANCE * 100).toFixed(0)}%`);
              }
            }
            const check: FitButtonCheck = {
              scenario: scenario.id,
              step,
              profile: profileId,
              deviceScaleFactor,
              visible,
              ...(before?.fill == null ? {} : { fillBefore: before.fill }),
              ...(after?.fill == null ? {} : { fillAfter: after.fill }),
              ...(lastTrigger == null ? {} : { lastTrigger }),
              pass: failures.length === 0,
              failures,
            };
            buttonChecks.push(check);
            return check;
          },
          settle,
          measure,
        });
        } catch (error) {
          if (!(error instanceof IdentityUnavailableError)) throw error;
          abortSettle(`identity-unavailable: ${scenario.id} ${profileId} dpr=${deviceScaleFactor}: ${error.message}`);
        }
        // Every scenario ends in a measurement, so an unclaimed settle failure
        // means the scenario changed shape. It attaches to the last frame of
        // the scenario rather than being dropped: a defect the run cannot
        // attribute is still a defect.
        if (settleFailures.length > 0 || skipPhotograph) {
          const last = measurements.at(-1);
          if (last != null) {
            last.settleFailures = [...last.settleFailures, ...settleFailures];
            last.failures = [...last.failures, ...settleFailures];
            last.pass = false;
          } else {
            unphotographedMeasurement('before any measurement', undefined, settleFailures);
          }
          settleFailures = [];
          skipPhotograph = false;
        }
      } finally {
        await page.evaluate(() => window.__stereoHostStop?.()).catch(() => undefined);
        await page.close().catch(() => undefined);
        await host.close().catch(() => undefined);
      }
    }
    await writeFile(
      resolve(outDir, `diagnostics-${profileId}-dpr${deviceScaleFactor}.json`),
      `${JSON.stringify({ profile: profileId, deviceScaleFactor, generatedAt: new Date().toISOString(), reports: rawReports }, null, 2)}\n`,
      'utf8',
    );
    return { measurements, buttonChecks };
  } catch (error) {
    return { measurements, buttonChecks, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  } finally {
    if (context != null) await context.close().catch(() => undefined);
    if (client != null) await client.close().catch(() => undefined);
  }
}

function summaryLine(result: RunResult): string {
  return `SUMMARY ${result.profile}: mounted ${result.mounted ? 'yes' : 'no'}, console errors ${result.consoleErrorTotal}, CSP violations ${result.cspViolationTotal}, WebGL2 available ${result.webgl2 ? 'yes' : 'no'}, mode switch succeeded ${result.modeSwitchSucceeded ? 'yes' : 'no'}`;
}

function blockedSummaryLine(profile: HostProfileId): string {
  return `SUMMARY ${profile}: mounted no, console errors unknown, CSP violations unknown, WebGL2 available unknown, mode switch succeeded unknown`;
}

type PluginDefect = { profile: HostProfileId; deviceScaleFactor: number; site: string; message: string; note: string };
type HarnessDefect = { profile: HostProfileId; deviceScaleFactor: number; category: Verdict['category']; message: string; note: string };

function collectPluginDefects(results: RunResult[]): PluginDefect[] {
  const defects = new Map<string, PluginDefect>();
  for (const result of results) {
    const add = (verdict: Verdict, message: string): void => {
      if (verdict.category !== 'plugin' || verdict.echo === true) return;
      const site = verdict.pluginSite ?? 'plugin/src (site not pinned)';
      const key = `${site}::${message}`;
      if (!defects.has(key)) {
        defects.set(key, { profile: result.profile, deviceScaleFactor: result.deviceScaleFactor, site, message, note: verdict.note });
      }
    };
    for (const record of result.consoleErrors) add(record.verdict, record.text);
    for (const record of result.cspViolations) add(record.verdict, `${record.effectiveDirective} blocked ${record.blockedURI}`);
    // Measured rather than logged: the viewer document does not shrink to the
    // panel the host gives it, so the bottom of the UI is simply cut off.
    if (result.layout.overflowYPx > 0 || result.layout.overflowXPx > 0) {
      add(
        {
          ruleId: 'viewer-does-not-fit-host-panel',
          category: 'plugin',
          fails: false,
          pluginSite: 'plugin/src/viewer.css:29',
          note: "The viewer lays out to a fixed height and never shrinks: .shell sets min-height 580px (plugin/src/viewer.css:29) and the stage adds min-height 370px (plugin/src/viewer.css:105,118), for a document 690 CSS px tall. Neither host panel is that tall, so the bottom of the control strip is clipped with no scroll affordance. Codex is the worse case because its 560 px height hint is declared by OpenAI's structure-viewer plugin.",
        },
        `viewer overflows the ${result.profile} panel (${result.panel.widthCssPx}x${result.panel.heightCssPx} CSS px) by ${result.layout.overflowYPx}px vertically and ${result.layout.overflowXPx}px horizontally; document lays out to ${result.layout.scrollWidth}x${result.layout.scrollHeight}`,
      );
    }
    // Measured per mode: a toolbar that does not wrap at a narrow host card
    // pushes its controls past the panel edge or over one another, while the
    // document itself still reports no overflow.
    for (const entry of result.layout.clippedControls) {
      add(
        {
          ruleId: 'toolbar-control-clipped-or-overlapping',
          category: 'plugin',
          fails: false,
          pluginSite: 'plugin/src/viewer.css',
          note: 'A visible control outside the drawer extends beyond the host panel or overlaps another control. Seen first on the codex-narrow profile (440 CSS px), measured from a live Codex card on 2026-09-01.',
        },
        `${result.profile} @${result.deviceScaleFactor}x ${entry}`,
      );
    }
  }
  return [...defects.values()];
}

function collectHarnessDefects(results: RunResult[]): HarnessDefect[] {
  const defects = new Map<string, HarnessDefect>();
  for (const result of results) {
    const add = (verdict: Verdict, message: string): void => {
      if (verdict.category === 'plugin' || verdict.echo === true) return;
      const key = `${verdict.category}::${verdict.ruleId}::${message}`;
      if (!defects.has(key)) {
        defects.set(key, {
          profile: result.profile,
          deviceScaleFactor: result.deviceScaleFactor,
          category: verdict.category,
          message,
          note: verdict.note,
        });
      }
    };
    for (const record of result.consoleErrors) add(record.verdict, record.text);
    for (const record of result.cspViolations) add(record.verdict, `${record.effectiveDirective} blocked ${record.blockedURI}`);
  }
  return [...defects.values()];
}

type FitDefect = {
  profile: HostProfileId;
  deviceScaleFactor: number;
  scenario: string;
  step: string;
  message: string;
  note: string;
};

/**
 * A pair that is not framed inside its eye window is a harness-level failure.
 *
 * It is not filed under PLUGIN DEFECTS, which by construction do not fail the
 * run: this is the thing the viewer exists to do, it is measured rather than
 * inferred, and it was seen in a real Codex side panel. A run that reports it
 * exits non-zero.
 */
function collectFitDefects(measurements: FitMeasurement[], buttonChecks: FitButtonCheck[] = []): FitDefect[] {
  const defects: FitDefect[] = [];
  for (const check of buttonChecks) {
    if (check.pass) continue;
    defects.push({
      profile: check.profile,
      deviceScaleFactor: check.deviceScaleFactor,
      scenario: check.scenario,
      step: check.step,
      message: check.failures.join('; '),
      note: "plugin/src/viewer.ts `runFit`: the toolbar Fit button reframes the structure in the eye window the panel is rendering into, records a `button` fit event, and reports immediately. It exists so a live check can separate a wrong fit computation from a missing trigger, which it cannot do if the press itself does nothing.",
    });
  }
  for (const measurement of measurements) {
    if (measurement.pass) continue;
    defects.push({
      profile: measurement.profile,
      deviceScaleFactor: measurement.deviceScaleFactor,
      scenario: measurement.scenario,
      step: measurement.step,
      message: `${measurement.failures.join('; ')} (eye window ${measurement.eyeWindowCssPx.width.toFixed(0)}x${measurement.eyeWindowCssPx.height.toFixed(0)} CSS px, camera ${measurement.cameraStatus})`,
      note: 'plugin/src/viewer.ts fit contract: after any load, mode change, host resize, dock or undock, both eye images are framed inside the capped eye window at STAGE_FILL_FRACTION. Measured from the Mol* canvas, see the screenshot on the record. A fill failure means the panel\'s own reported diagnostics.camera.fill and the pixels it produced tell different stories, which makes the number unusable as evidence from a host nobody can measure.',
    });
  }
  return defects;
}

const argv = process.argv.slice(2);
const jsonOnly = argv.includes('--json');
/** `--no-fit` runs only the original per-profile mount, for a quick check. */
const skipFit = argv.includes('--no-fit');
const profileArg = argv.find((value) => value.startsWith('--profile='))?.split('=', 2)[1]
  ?? (argv.includes('--profile') ? argv[argv.indexOf('--profile') + 1] : undefined);
const dprArg = argv.find((value) => value.startsWith('--dpr='))?.split('=', 2)[1]
  ?? (argv.includes('--dpr') ? argv[argv.indexOf('--dpr') + 1] : undefined);
const deviceScaleFactors = dprArg == null
  ? DEVICE_SCALE_FACTORS
  : dprArg.split(',').map((value) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid --dpr value '${value}'.`);
      return parsed;
    });
const profiles = profileFromArg(profileArg);
await mkdir(outDir, { recursive: true });

const say = (line: string): void => { if (!jsonOnly) console.log(line); };

let failures = 0;
const allResults: RunResult[] = [];
const allFit: FitMeasurement[] = [];
const allButtonChecks: FitButtonCheck[] = [];
const configuredBrowser = process.env.STEREO_PLAYWRIGHT_BROWSER;
let browser: Browser | undefined;
try {
  browser = await chromium.launch({
    headless: true,
    ...(configuredBrowser == null ? {} : { executablePath: configuredBrowser }),
  });
} catch (error) {
  failures = profiles.length;
  console.error(`BROWSER START FAILED: ${error instanceof Error ? error.message : String(error)}`);
  for (const profile of profiles) say(blockedSummaryLine(profile));
}
try {
  if (browser == null) process.exitCode = 1;
  for (const profile of profiles) {
    if (browser == null) break;
    const profileResults: RunResult[] = [];
    const profileFit: FitMeasurement[] = [];
    const profileButtonChecks: FitButtonCheck[] = [];
    for (const deviceScaleFactor of deviceScaleFactors) {
      say(`RUN ${profile} dpr=${deviceScaleFactor} panel=${HOST_PROFILES[profile].panel.widthCssPx}x${HOST_PROFILES[profile].panel.heightCssPx} CSS px`);
      try {
        const result = await runProfile(profile, browser, deviceScaleFactor);
        profileResults.push(result);
        allResults.push(result);
        say(summaryLine(result));
        if (result.failed) {
          failures += 1;
          for (const reason of result.failureReasons) say(`  FAIL ${profile} dpr=${deviceScaleFactor}: ${reason}`);
        }
      } catch (error) {
        failures += 1;
        say(blockedSummaryLine(profile));
        console.error(`PROFILE ${profile} dpr=${deviceScaleFactor} FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
      if (!skipFit) {
        const fit = await runFitScenarios(profile, browser, deviceScaleFactor);
        profileFit.push(...fit.measurements);
        allFit.push(...fit.measurements);
        profileButtonChecks.push(...fit.buttonChecks);
        allButtonChecks.push(...fit.buttonChecks);
        for (const measurement of fit.measurements) say(`  ${measurementLine(measurement)}`);
        for (const check of fit.buttonChecks) say(`  ${fitButtonLine(check)}`);
        say(`FIT ${profile} dpr=${deviceScaleFactor}: ${fit.measurements.filter((item) => item.pass).length}/${fit.measurements.length} measurements inside their eye window`);
        // The panel's own reported fill against the pixels it produced. This
        // is the line that says whether `diagnostics.camera.fill` can be
        // trusted as evidence from a host nobody can measure.
        const reported = fit.measurements.filter((item) => item.fillChecked != null);
        const agreed = fit.measurements.filter((item) => item.fillFailures.length === 0);
        const fills = reported.map((item) => item.fillChecked ?? 0);
        const range = fills.length === 0
          ? 'none reported'
          : `fill ${Math.min(...fills).toFixed(4)} to ${Math.max(...fills).toFixed(4)}`;
        const builds = [...new Set(fit.measurements.map((item) => item.diagnostics?.viewerBuild).filter((value): value is string => value != null))];
        say(`FILL ${profile} dpr=${deviceScaleFactor}: ${agreed.length}/${fit.measurements.length} frames agree with the panel's reported fill, ${reported.length} reported, ${range}, build ${builds.map((value) => value.slice(0, 8)).join(',') || 'none'}`);
        say(`BUTTON ${profile} dpr=${deviceScaleFactor}: ${fit.buttonChecks.filter((check) => check.pass).length}/${fit.buttonChecks.length} Fit-button presses ran a fit and left the fill at ${STAGE_FILL_FRACTION}`);
        if (fit.error != null) {
          failures += 1;
          console.error(`FIT SCENARIOS ${profile} dpr=${deviceScaleFactor} FAILED: ${fit.error}`);
        }
      }
    }
    if (profileResults.length > 0 || profileFit.length > 0) {
      const profilePluginDefects = collectPluginDefects(profileResults);
      const profileHarnessDefects = collectHarnessDefects(profileResults);
      await writeFile(
        resolve(outDir, `${profile}.json`),
        `${JSON.stringify({
          profile,
          generatedAt: new Date().toISOString(),
          runs: profileResults,
          fitScenarios: profileFit,
          fitButtonChecks: profileButtonChecks,
          fitDefects: collectFitDefects(profileFit, profileButtonChecks),
          pluginDefects: profilePluginDefects,
          harnessDefects: profileHarnessDefects,
        }, null, 2)}\n`,
        'utf8',
      );
    }
  }
} finally {
  await browser?.close();
}

const pluginDefects = collectPluginDefects(allResults);
const harnessDefects = collectHarnessDefects(allResults);
const fitDefects = collectFitDefects(allFit, allButtonChecks);
failures += fitDefects.length;
if (jsonOnly) {
  console.log(JSON.stringify({ runs: allResults, fitScenarios: allFit, fitButtonChecks: allButtonChecks, fitDefects, pluginDefects, harnessDefects, failures }, null, 2));
} else {
  console.log('');
  console.log('HARNESS DEFECTS');
  if (harnessDefects.length === 0) {
    console.log('- none');
  } else {
    for (const defect of harnessDefects) {
      console.log(`- ${defect.category} ${defect.profile} dpr=${defect.deviceScaleFactor}`);
      console.log(`  message: ${defect.message}`);
      console.log(`  note: ${defect.note}`);
    }
    console.log('These findings fail this harness run and require harness/profile triage.');
  }
  console.log('');
  console.log('FIT DEFECTS');
  if (allFit.length === 0) {
    console.log('- not run');
  } else if (fitDefects.length === 0) {
    console.log(`- none (${allFit.length} measurements, every eye image inside its window; ${allButtonChecks.length} Fit-button presses ran a fit)`);
  } else {
    for (const defect of fitDefects) {
      console.log(`- ${defect.profile} dpr=${defect.deviceScaleFactor} ${defect.scenario} / ${defect.step}`);
      console.log(`  message: ${defect.message}`);
      console.log(`  note: ${defect.note}`);
    }
    console.log('These findings fail this harness run: the pair is not framed inside its eye window.');
  }
  console.log('');
  console.log('PLUGIN DEFECTS');
  if (pluginDefects.length === 0) {
    console.log('- none');
  } else {
    for (const defect of pluginDefects) {
      console.log(`- ${defect.site}`);
      console.log(`  message: ${defect.message}`);
      console.log(`  note: ${defect.note}`);
    }
    console.log('These are category (c) findings for the plugin. They do not fail this harness run.');
  }
}

if (failures > 0) process.exitCode = 1;
