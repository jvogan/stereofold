/**
 * Claude Science host emulation for the Stereofold inspector panel.
 *
 * Reproduces the parts of the Claude Science host that the panel actually meets:
 *
 *   - an outer proxy page (the real one is served at http://localhost:<port>/mcp_apps)
 *     that creates an inner <iframe sandbox="allow-scripts allow-forms"> — no
 *     allow-same-origin, no allow-popups — and only then assigns `srcdoc`;
 *   - the ui/notifications/sandbox-proxy-ready -> ui/notifications/sandbox-resource-ready
 *     handshake, with the SAFE_SANDBOX_TOKENS clamp and the buildAllowAttribute mapping;
 *   - bidirectional postMessage forwarding between window.parent and inner.contentWindow;
 *   - the documented CSP, applied to the guest document;
 *   - host capabilities WITHOUT `openLinks`, and no ui/open-link handler, so
 *     `app.openLink()` rejects exactly as it does in Claude Science;
 *   - the widget-call guard behind POST /api/mcp-apps/:serverId/call, which rejects a
 *     tool whose `_meta.ui.visibility` is present and does not include "app".
 *
 * The MCP side is the real packaged server (plugin/dist/server.mjs) over stdio, and
 * the panel HTML is read through `resources/read` on the ui:// URI, which is what the
 * host's GET /api/mcp-apps/:serverId/resource does.
 *
 * This is an emulation, not the real Claude Science host: see docs/host-verification.md
 * for what it proves and does not prove. Nothing in the repo is written; nothing
 * under ~/.claude-science is touched.
 *
 * Run:  pnpm --dir plugin run test:claude-science [-- --out /absolute/artifact/directory]
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile, readFile, rm as rmDirectory } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Page, type Frame, type Browser } from 'playwright';
import { findLeakedSecrets, redactLinkSecrets, scrubSecrets } from './report-redaction.js';

const OPTION_USAGE = 'Optional usage: --out /absolute/artifact/directory (defaults under os.tmpdir())';
const options = new Map<string, string>();
const rawArguments = process.argv.slice(2);
for (let index = 0; index < rawArguments.length; index += 2) {
  const flag = rawArguments[index], value = rawArguments[index + 1];
  assert.ok(flag === '--out' && !options.has(flag) && value !== undefined, OPTION_USAGE);
  options.set(flag, value);
}
const out = resolve(options.get('--out') ?? resolve(tmpdir(), `stereofold-claude-science-${Date.now()}`));
await mkdir(out, { recursive: true });

/** The host's panel CSP, minus its built-in CDN allowlist,
 *  which Stereofold does not use — a strictly tighter policy than the real host's. */
const CSP = [
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:",
  "worker-src 'self' blob:",
  "media-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'none'",
].join('; ');

type Scenario = { id: string; name: string; status: 'passed' | 'failed' | 'skipped'; evidence: any };
const report: any = {
  status: 'failed',
  host: 'emulated Claude Science MCP App host (double iframe, sandbox clamp, no openLink) against real stdio plugin/dist/server.mjs',
  startedAt: new Date().toISOString(),
  csp: CSP,
  scenarios: [] as Scenario[],
  screenshots: [] as any[],
  consoleErrors: [] as any[],
  pageErrors: [] as any[],
  cspViolations: [] as any[],
  popups: [] as string[],
  externalRequests: [] as string[],
  widgetCalls: [] as any[],
  rejectedWidgetCalls: [] as any[],
  hostEvents: [] as any[],
  timings: {} as any,
  defects: [] as any[],
  cleanup: {} as any,
};
/**
 * Live capabilities this run minted: a pairing code, a page key. Each scenario
 * records the shape of its own evidence, and this list is the second pass, so
 * a value that reaches the report by some other route — a sentence, an error
 * message, a console line — still never lands on disk.
 */
const liveSecrets: string[] = [];
const scenario = (id: string, name: string, status: Scenario['status'], evidence: any) => {
  report.scenarios.push({ id, name, status, evidence });
  console.log(`${status.toUpperCase()}: ${id} ${name}`);
};
const defect = (severity: string, where: string, detail: string) => {
  report.defects.push({ severity, where, detail });
  console.log(`DEFECT (${severity}) ${where}: ${detail}`);
};

/* ------------------------------------------------------------------ MCP side */

/**
 * The server's LAN companion binds STEREOFOLD_LAN_PORT (falling back to the
 * documented default of 8443) when a session opens connection="lan". A busy
 * default port used to hang scenario S3 waiting for a LAN URL that never
 * arrived, so this harness's own spawned server process gets a free port of
 * its own, picked the same way the rest of the harness picks its loopback
 * listener port.
 */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolveListen, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolveListen); });
  const address = probe.address();
  if (!address || typeof address === 'string') { probe.close(); throw Error('Could not allocate a free LAN companion port for the harness.'); }
  await new Promise<void>(resolveClose => probe.close(() => resolveClose()));
  return address.port;
}
const lanCompanionPort = await freePort();

/**
 * The daemon starts this server with a stripped PATH, so anything the server
 * launches has to be named by absolute path. The harness reproduces that below
 * and points STEREOFOLD_OPENER at a recorder, so scenario 6 can read the exact
 * link the server would have handed the browser without a browser ever opening.
 */
// The recorded link carries a live pairing code, so it is kept out of the
// artifact directory the report advertises and only its shape is reported.
const openerDirectory = await mkdtemp(resolve(tmpdir(), 'stereofold-cs-opener-'));
const openerLog = resolve(openerDirectory, 'opened.txt');
const openerPath = resolve(openerDirectory, 'record-open.sh');
await writeFile(openerPath, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(openerLog)}\n`, { mode: 0o700 });
const openedLinks = async (): Promise<string[]> =>
  (await readFile(openerLog, 'utf8').catch(() => '')).split('\n').map(line => line.trim()).filter(Boolean);
/**
 * The server detaches the opener and does not wait for it, exactly as it must
 * not block a tool call on a browser. So the recorder's line arrives after the
 * result does, and the harness waits for it rather than reading once.
 */
const openedLinksAtLeast = async (count: number): Promise<string[]> => {
  const until = Date.now() + 15_000;
  for (;;) {
    const lines = await openedLinks();
    if (lines.length >= count || Date.now() > until) return lines;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
};

const client = new Client({ name: 'Claude Science host emulation', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('dist/server.mjs')],
  cwd: process.cwd(),
  stderr: 'pipe',
  env: { ...getDefaultEnvironment(), PATH: '', STEREOFOLD_LAN_PORT: String(lanCompanionPort), STEREOFOLD_OPENER: openerPath,
    STEREOFOLD_LAN_CERTIFICATE_STORE: resolve(openerDirectory, 'lan'), STEREOFOLD_REPLY_AUDIO: '0', STEREOFOLD_PTT_TRANSCRIBE: '0' },
});
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += String(chunk); });

const call = async (name: string, args: any) => {
  const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!result.isError, `${name} failed: ${JSON.stringify(result).slice(0, 800)}`);
  return result;
};
const privateView = async (id: string) =>
  (await call('get_inspection', { sessionId: id }))._meta['stereo_structure/inspection'];
const waitSaved = async (id: string, predicate: (d: any) => boolean, label = 'saved inspection') => {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const data = await privateView(id);
    if (predicate(data)) return data;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 120));
  }
  throw Error(`Timed out waiting for ${label}`);
};
const waitState = async (id: string, predicate: (s: any) => boolean, commandId?: string) => {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const state = (await call('get_inspection_state', { sessionId: id, ...(commandId ? { commandId } : {}) }))
      .structuredContent;
    if (predicate(state)) return state;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 120));
  }
  throw Error('Timed out waiting for public inspection state');
};

/* ------------------------------------------- host widget-call visibility rule */

/**
 * The host refuses a widget call to a tool whose `_meta.ui.visibility` is
 * present and does not include "app", with one exception: the tool that opened
 * the panel, when it is annotated read-only and not destructive. The refusal
 * reads "Tool '<name>' is not exposed to the widget (model-only visibility)."
 */
let toolsByName = new Map<string, any>();
let openToolName = '';
function widgetCallDecision(name: string, isHostMount = false) {
  const tool = toolsByName.get(name);
  if (!tool) return { allowed: false, message: `Server 'stereofold' does not expose tool '${name}'.` };
  const visibility = tool._meta?.ui?.visibility;
  const hostMountExempt =
    isHostMount === true &&
    name === openToolName &&
    tool.annotations?.readOnlyHint === true &&
    tool.annotations?.destructiveHint !== true;
  if (!hostMountExempt && visibility !== undefined && !(Array.isArray(visibility) && visibility.includes('app')))
    return { allowed: false, message: `Tool '${name}' is not exposed to the widget (model-only visibility).` };
  return { allowed: true, message: '' };
}

/**
 * Host-side resolution of the operon.dev/viewer name parameter: the filename field is sent only when the tool's advertised input schema
 * declares a property of that name and it differs from the content parameter.
 */
function resolveViewerBinding(tool: any) {
  const binding = tool?._meta?.['operon.dev/viewer'];
  if (!binding) return undefined;
  const ident = /^[A-Za-z_$][\w$]*$/;
  const contentParam = typeof binding.contentParam === 'string' && ident.test(binding.contentParam) ? binding.contentParam : 'content';
  const contentEncoding = binding.contentEncoding === 'base64' ? 'base64' : 'utf8';
  const requested = typeof binding.nameParam === 'string' && ident.test(binding.nameParam) ? binding.nameParam : 'filename';
  const properties = tool.inputSchema?.properties;
  const nameParam =
    tool.inputSchema === undefined
      ? requested
      : typeof properties === 'object' && properties !== null && Object.hasOwn(properties, requested) && requested !== contentParam
        ? requested
        : undefined;
  return { contentParam, contentEncoding, nameParam, opensExtensions: binding.opensExtensions, opensMimeTypes: binding.opensMimeTypes };
}

/* ---------------------------------------------------------------- browser host */

const hostEntry = `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
let bridge, hostContext;
function setContext(context) {
  hostContext = { displayMode:'inline', containerDimensions:{maxWidth:1100,maxHeight:760}, ...context };
  document.body.style.background = context.theme === 'dark' ? '#071015' : '#ffffff';
  bridge?.setHostContext(hostContext);
}
window.__host = {
  connected:false, sandboxProxyReady:false, resourceSentAt:0, initializedAt:0, proxySrcAt:0,
  async mount(html, opened, context = {theme:'dark'}, sandbox = 'allow-scripts allow-forms', permissions = undefined) {
    if (bridge) await bridge.close();
    bridge = undefined;
    setContext(context);
    Object.assign(window.__host, {connected:false, sandboxProxyReady:false, resourceSentAt:0, initializedAt:0, proxySrcAt:0});
    for (const existing of [...document.querySelectorAll('iframe')]) existing.remove();
    const proxy = document.createElement('iframe');
    proxy.id = 'sandbox-proxy';
    proxy.style.cssText = 'border:0;width:100vw;height:100vh;display:block';
    document.body.appendChild(proxy);
    await new Promise(r => setTimeout(r, 0));
    // Host capabilities deliberately omit openLinks: Claude Science never assigns it.
    bridge = new AppBridge(null, {name:'Claude Science', version:'0.1.0-dev'}, {serverTools:{}, serverResources:{}}, {hostContext});
    bridge.oncalltool = p => window.__call(p);
    bridge.onupdatemodelcontext = async p => { window.__log({kind:'update-model-context'}); return {}; };
    bridge.onsizechange = () => {};
    bridge.oninitialized = async () => {
      window.__host.connected = true;
      window.__host.initializedAt = performance.now();
      window.__log({kind:'app-initialized'});
      if (opened) await bridge.sendToolResult(opened);
    };
    bridge.onsandboxready = () => {
      window.__host.sandboxProxyReady = true;
      window.__log({kind:'sandbox-proxy-ready'});
      window.__host.resourceSentAt = performance.now();
      void bridge.sendSandboxResourceReady({ html, sandbox, ...(permissions ? {permissions} : {}) });
    };
    await bridge.connect(new PostMessageTransport(proxy.contentWindow, proxy.contentWindow));
    window.__host.proxySrcAt = performance.now();
    proxy.src = '/mcp_apps';
  },
  setContext,
  async send(result) { await bridge.sendToolResult(result); },
  async close() { await bridge?.close(); bridge = undefined; for (const f of [...document.querySelectorAll('iframe')]) f.remove(); },
};
`;

const hostBundle = await build({
  stdin: { contents: hostEntry, resolveDir: resolve('.'), loader: 'ts', sourcefile: 'cs-host-entry.ts' },
  bundle: true,
  format: 'iife',
  write: false,
  platform: 'browser',
  target: 'es2022',
});
const hostScript = hostBundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Claude Science (emulated)</title></head>
<body style="margin:0;background:#071015"><script>${hostScript}</script></body></html>`;

/** Verbatim structure of the Claude Science sandbox proxy (docs section 4). */
const proxyHtml = `<!doctype html><html><head><meta charset="utf-8"><title>MCP-UI Proxy</title>
<style>html,body{margin:0;height:100%;background:#071015}</style></head><body><script>
var SAFE_SANDBOX_TOKENS = ['allow-scripts','allow-forms','allow-popups','allow-modals','allow-downloads','allow-pointer-lock','allow-presentation'];
function clampSandbox(value) {
  if (typeof value !== 'string') return 'allow-scripts allow-forms';
  var clamped = value.split(/\\s+/).filter(function (t) {
    return SAFE_SANDBOX_TOKENS.indexOf(t.toLowerCase()) !== -1;
  }).join(' ');
  // Emulator note: an empty clamp would strip allow-scripts and kill every app,
  // so fall back to the documented default rather than to "".
  return clamped || 'allow-scripts allow-forms';
}
function buildAllowAttribute(permissions) {
  if (!permissions || typeof permissions !== 'object') return '';
  var mapping = { camera:'camera', microphone:'microphone', geolocation:'geolocation', clipboardWrite:'clipboard-write' };
  return Object.keys(permissions).filter(function (k) { return mapping[k] && permissions[k] != null; })
    .map(function (k) { return mapping[k] + ' *'; }).join('; ');
}
var inner = document.createElement('iframe');
inner.style = 'width:100%; height:100%; border:none;';
inner.setAttribute('sandbox', 'allow-scripts allow-forms');
document.body.appendChild(inner);
var pending = [];
var loaded = false;
inner.addEventListener('load', function () {
  loaded = true;
  while (pending.length) inner.contentWindow.postMessage(pending.shift(), '*');
});
window.addEventListener('message', function (event) {
  if (event.source === window.parent) {
    var message = event.data;
    if (message && message.method === 'ui/notifications/sandbox-resource-ready') {
      var params = message.params || {};
      var allow = buildAllowAttribute(params.permissions);
      inner.setAttribute('allow', allow ? 'fullscreen *; ' + allow : 'fullscreen *');
      inner.setAttribute('sandbox', clampSandbox(params.sandbox));
      inner.srcdoc = params.html;
      return;
    }
    if (loaded && inner.contentWindow) inner.contentWindow.postMessage(message, '*');
    else pending.push(message);
    return;
  }
  if (event.source === inner.contentWindow) window.parent.postMessage(event.data, '*');
});
window.parent.postMessage({ jsonrpc:'2.0', method:'ui/notifications/sandbox-proxy-ready', params:{} }, '*');
</script></body></html>`;

const http = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (path === '/mcp_apps') return response.end(proxyHtml);
  response.end(hostHtml);
});
await new Promise<void>(resolveListen => http.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${(http.address() as any).port}`;

/** The host serves the resource with the CSP header; a srcdoc document has no
 *  response of its own, so the same policy is applied as a <meta> in <head>. */
function withCsp(html: string) {
  const head = /<head[^>]*>/i.exec(html.slice(0, 8192));
  assert.ok(head, 'Panel HTML has no <head> to carry the host CSP');
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}<meta http-equiv="Content-Security-Policy" content="${CSP}">${html.slice(at)}`;
}

let browser: Browser | undefined;

async function newHostPage() {
  const page = await browser!.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(120_000);
  page.on('pageerror', error => report.pageErrors.push({ url: page.url(), message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning')
      report.consoleErrors.push({ type: message.type(), text: message.text() });
  });
  page.on('popup', popup => report.popups.push(popup.url()));
  await page.addInitScript(() => {
    (window as any).__cspViolations = [];
    window.addEventListener('securitypolicyviolation', (event: any) => {
      (window as any).__cspViolations.push({
        directive: event.violatedDirective,
        blocked: String(event.blockedURI).slice(0, 200),
        source: String(event.sourceFile ?? '').slice(0, 200),
        line: event.lineNumber,
      });
    });
  });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('about:') || url.startsWith('data:') || url.startsWith('blob:'))
      return route.continue();
    report.externalRequests.push(url);
    return route.abort();
  });
  await page.exposeFunction('__log', (event: any) => {
    report.hostEvents.push({ at: new Date().toISOString(), ...event });
  });
  await page.exposeFunction('__call', async (p: any) => {
    const decision = widgetCallDecision(p.name, false);
    report.widgetCalls.push({ name: p.name, allowed: decision.allowed });
    if (!decision.allowed) {
      report.rejectedWidgetCalls.push({ name: p.name, message: decision.message });
      return { isError: true, content: [{ type: 'text', text: decision.message }] };
    }
    return await client.callTool({ name: p.name, arguments: p.arguments ?? {} });
  });
  await page.goto(origin);
  return page;
}

async function mount(page: Page, html: string, opened: any, context: any = { theme: 'dark' }) {
  const startedAt = Date.now();
  await page.evaluate(
    ({ html, opened, context }) => (window as any).__host.mount(html, opened, context),
    { html: withCsp(html), opened, context },
  );
  await page.waitForFunction(() => (window as any).__host.sandboxProxyReady, undefined, { timeout: 60_000 });
  await page.waitForFunction(() => (window as any).__host.connected, undefined, { timeout: 120_000 });
  const timings = await page.evaluate(() => ({
    proxyLoadMs: (window as any).__host.resourceSentAt - (window as any).__host.proxySrcAt,
    srcdocMountMs: (window as any).__host.initializedAt - (window as any).__host.resourceSentAt,
  }));
  const guest = page.frames().find(frame => frame.url() === 'about:srcdoc');
  assert.ok(guest, 'No srcdoc guest frame after the sandbox handshake');
  return { guest, timings, wallMs: Date.now() - startedAt };
}

async function shot(page: Page, name: string) {
  const file = `${name}.png`;
  const bytes = await page.screenshot({ path: resolve(out, file) });
  report.screenshots.push({ file, path: resolve(out, file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  return resolve(out, file);
}

async function collectCsp(page: Page) {
  for (const frame of page.frames()) {
    try {
      const violations = await frame.evaluate(() => (window as any).__cspViolations ?? []);
      for (const violation of violations) report.cspViolations.push({ frame: frame.url(), ...violation });
    } catch {
      /* frame gone */
    }
  }
}

/* Each disposal step is isolated: a throwing browser.close() must not skip the
 * MCP child process, the loopback listener, or the report that explains the
 * failure this cleanup exists for. */
async function disposeStep(step: string, work: () => Promise<unknown>) {
  try { await work(); report.cleanup[step] = true; }
  catch (cleanupError) { report.cleanup[step] = false; (report.cleanup.errors ??= []).push(`${step}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
}

/* ------------------------------------------------------------------- scenarios */

let lanSessionId: string | undefined;
let lanBinding: any;
try {
  await client.connect(transport);
  const tools = await client.listTools();
  toolsByName = new Map(tools.tools.map((tool: any) => [tool.name, tool]));
  const openTool = toolsByName.get('stereo_structure.open');
  openToolName = 'stereo_structure.open';
  const binding = resolveViewerBinding(openTool);
  report.viewerBinding = binding;
  report.visibilityMatrix = tools.tools.map((tool: any) => ({
    tool: tool.name,
    visibility: tool._meta?.ui?.visibility ?? null,
    widgetCallAllowed: widgetCallDecision(tool.name, false).allowed,
  }));
  report.modelOnlyTools = report.visibilityMatrix.filter((row: any) => !row.widgetCallAllowed).map((row: any) => row.tool);
  report.modelVisibleTools = tools.tools
    .filter((tool: any) => {
      const visibility = tool._meta?.ui?.visibility;
      return visibility === undefined || (Array.isArray(visibility) && visibility.includes('model'));
    })
    .map((tool: any) => tool.name);

  browser = await chromium.launch({ headless: true });
  report.browserVersion = browser.version();

  /* ---- Scenario 1: inspect 1CRN, mount, render, save --------------------- */
  const cif = await readFile(resolve('../fixtures/1CRN.cif'), 'utf8');
  const opened = await call('inspect', { structureText: cif });
  const sessionId = opened.structuredContent.sessionId;
  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  const inspectorHtml = (resource.contents[0] as any).text as string;
  report.inspectorBytes = Buffer.byteLength(inspectorHtml, 'utf8');

  const page = await newHostPage();
  const mounted = await mount(page, inspectorHtml, opened, { theme: 'dark' });
  await mounted.guest.locator('body[data-ready="true"]').waitFor({ timeout: 120_000 });
  const renderedAt = Date.now();
  await mounted.guest.locator('.stage canvas').first().waitFor({ state: 'visible' });
  const saved = await waitSaved(sessionId, data => data.scene !== null);
  report.timings.scenario1 = {
    ...mounted.timings,
    handshakeToReadyMs: renderedAt - (Date.now() - mounted.wallMs),
    mountWallMs: mounted.wallMs,
    inspectorBytes: report.inspectorBytes,
  };
  const s1shot = await shot(page, 's1-inspector-mounted');
  await collectCsp(page);
  scenario('S1', 'Inspector mounts, renders and saves under the sandbox clamp', 'passed', {
    sessionId,
    srcdocMountMs: Math.round(mounted.timings.srcdocMountMs),
    mountWallMs: mounted.wallMs,
    savedRevision: saved.inspectionRevision,
    residues: await mounted.guest.locator('.sequence button').count(),
    screenshot: s1shot,
  });

  /* ---- Scenario 2: model-side get_inspection_state ----------------------- */
  const publicState = (await call('get_inspection_state', { sessionId })).structuredContent;
  assert.equal(publicState.hasScene, true);
  assert.equal(publicState.inspectionRevision, saved.inspectionRevision);
  assert.ok(publicState.serverEpoch && publicState.sourceToken && publicState.stateRevision >= 0);
  scenario('S2', 'Model-side get_inspection_state reports the revision the panel saved', 'passed', {
    hasScene: publicState.hasScene,
    stateRevision: publicState.stateRevision,
    inspectionRevision: publicState.inspectionRevision,
    privateInspectionRevision: saved.inspectionRevision,
  });

  /* ---- Scenario 3: Open on Quest -> Connect over Wi-Fi ------------------- */
  const s3: any = { steps: [] };
  // The companion, Quest and handoff buttons live under the header's More
  // menu, a closed <details>. Setting open is idempotent, unlike a summary click.
  await mounted.guest.locator('[data-header-menu]').evaluate((menu: any) => { menu.open = true; });
  await mounted.guest.locator('[data-quest-open]').click();
  const dialogOpen = await mounted.guest.locator('[data-quest-connect-dialog]').evaluate((dialog: any) => dialog.open);
  s3.questDialogOpened = dialogOpen;
  if (!dialogOpen)
    defect(
      'blocker',
      'plugin/src/inspector.ts:548 (quest.addEventListener -> questDialog.showModal())',
      'dialog.showModal() is inert under sandbox="allow-scripts allow-forms" (no allow-modals), so Open on Quest opens nothing.',
    );
  assert.ok(dialogOpen, 'Open on Quest did not open the connection dialog under the sandbox clamp');
  await shot(page, 's3a-quest-dialog');

  // The form has its own default, so reserve the harness port there too.
  // The explicit widget argument otherwise overrides STEREOFOLD_LAN_PORT.
  await mounted.guest.locator('[data-lan-port]').evaluate((input: any, port: number) => { input.value = String(port); }, lanCompanionPort);
  await mounted.guest.locator('[data-quest-lan]').click();
  await mounted.guest.locator('[data-lan-dialog]').waitFor({ state: 'attached' });
  await mounted.guest.locator('[data-lan-url]').filter({ hasText: 'https://' }).waitFor({ timeout: 120_000 });
  s3.lanDialogOpened = await mounted.guest.locator('[data-lan-dialog]').evaluate((dialog: any) => dialog.open);
  s3.questDialogClosedAfterLan = !(await mounted.guest.locator('[data-quest-connect-dialog]').evaluate((dialog: any) => dialog.open));
  const address = (await mounted.guest.locator('[data-lan-url]').innerText()).trim();
  const pairingCode = (await mounted.guest.locator('[data-lan-code]').innerText()).trim();
  // The fingerprint lives inside a collapsed <details>; open it so it is visible text.
  await mounted.guest.locator('[data-lan-dialog] details').first().locator('summary').click();
  const fingerprint = (await mounted.guest.locator('[data-lan-fingerprint]').innerText()).trim();
  const expiry = (await mounted.guest.locator('[data-lan-expiry]').innerText()).trim();
  lanSessionId = sessionId;
  lanBinding = (await call('get_inspection_state', { sessionId })).structuredContent;
  s3.address = address;
  // The code is live for as long as the listener is: only its shape is evidence.
  s3.pairingCodeShape = /^\d{8}$/.test(pairingCode) ? '<8 digits>' : '<unexpected shape>';
  liveSecrets.push(pairingCode);
  s3.fingerprint = fingerprint;
  s3.expiry = expiry;
  const s3shot = await shot(page, 's3b-lan-address');
  s3.screenshot = s3shot;
  assert.match(address, /^https:\/\/\d+\.\d+\.\d+\.\d+:\d+\/$/);
  assert.match(pairingCode, /\S/);
  assert.match(fingerprint, /[0-9A-Fa-f:]{20,}/);

  // Copy address: navigator.clipboard is not delegated (no clipboardWrite permission).
  await mounted.guest.locator('[data-lan-copy]').click();
  await mounted.guest.locator('[data-lan-status]').waitFor();
  await page.waitForTimeout(500);
  s3.copyStatus = (await mounted.guest.locator('[data-lan-status]').innerText()).trim();

  // "Open companion" routes through app.openLink, which this host does not implement.
  await mounted.guest.locator('[data-lan-dialog] .lan-dismiss').click();
  const errorsBeforeInert = report.pageErrors.length;
  await mounted.guest.locator('[data-header-menu]').evaluate((menu: any) => { menu.open = true; });
  await mounted.guest.locator('[data-companion-open]').click();
  await mounted.guest.locator('[data-session-outcome]').waitFor({ state: 'attached' });
  await mounted.guest
    .locator('[data-session-outcome]')
    .filter({ hasText: /companion|connected|Save/i })
    .waitFor({ timeout: 60_000 })
    .catch(() => {});
  await page.waitForTimeout(2000);
  s3.companionOutcome = (await mounted.guest.locator('[data-session-outcome]').innerText()).trim();
  s3.companionLinkVisible = await mounted.guest.locator('a.companion-link').isVisible().catch(() => false);
  // The href carries the pairing code in its fragment, so the artifact keeps
  // the address and the shape of the fragment, never the code itself.
  const companionLinkHref = await mounted.guest.locator('a.companion-link').getAttribute('href').catch(() => null);
  s3.companionLinkShape = redactLinkSecrets(companionLinkHref);
  liveSecrets.push((companionLinkHref ?? '').split('#')[1] ?? '');
  s3.openLinkThrewIntoPage = report.pageErrors.length > errorsBeforeInert;
  s3.metaAnchorTested = false;
  s3.metaAnchorNote =
    'Continue to Meta needs open_companion connection:"https", which starts a public Cloudflare relay; not exercised. Its click handler shares the same app.openLink path proven inert here (plugin/src/inspector.ts:547).';
  // A target="_blank" anchor is inert without allow-popups: prove it in the guest.
  s3.blankAnchorOpened = await mounted.guest.evaluate(() => {
    const anchor = document.createElement('a');
    anchor.href = 'https://example.invalid/';
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = 'probe';
    document.body.appendChild(anchor);
    let opened = false;
    try { anchor.click(); opened = true; } catch { opened = false; }
    anchor.remove();
    return opened;
  });
  await collectCsp(page);
  s3.popups = [...report.popups];
  s3.blockedFetchErrors = report.consoleErrors.filter((consoleError: any) => /fetch|Failed to load|Refused to connect/i.test(consoleError.text));
  scenario('S3', 'Open on Quest then Connect over Wi-Fi shows address, pairing code and fingerprint as text', 'passed', s3);
  await shot(page, 's3c-after-inert-controls');

  /* ---- Scenario 6: one tool call puts the page on the headset ------------ */
  // This is the whole point of the launch parameter: a host with no terminal
  // and no way to open a link from the panel can still reach the headset,
  // because the server does the opening itself.
  const s6: any = {};
  const beforeLaunch = (await openedLinks()).length;
  const launchState = (await call('get_inspection_state', { sessionId })).structuredContent;
  const launchResult = await call('open_companion', {
    sessionId,
    serverEpoch: launchState.serverEpoch,
    sourceToken: launchState.sourceToken,
    baseStateRevision: launchState.stateRevision,
    baseInspectionRevision: launchState.inspectionRevision,
    connection: 'lan',
    launch: 'web',
  });
  lanBinding = (await call('get_inspection_state', { sessionId })).structuredContent;
  const launchedCode = launchResult.structuredContent.companion.pairingCode;
  const links = await openedLinksAtLeast(beforeLaunch + 1);
  s6.opened = launchResult.structuredContent.launch.opened;
  s6.sentence = launchResult.content[0].text;
  s6.linksOpened = links.length - beforeLaunch;
  const openedTarget = links.length ? decodeURIComponent(links[links.length - 1].split('url=')[1] ?? '') : '';
  // The report is written to disk and read by other people, so only the shape
  // of the target is evidence. The live code never enters it.
  s6.targetShape = redactLinkSecrets(openedTarget);
  liveSecrets.push(launchedCode);
  s6.codeAppearsOnceInResult = JSON.stringify(launchResult).split(launchedCode).length === 2;
  s6.strippedPath = true;
  assert.equal(s6.opened, true, 'open_companion launch:"web" did not open the link under a stripped PATH');
  assert.equal(s6.linksOpened, 1, 'open_companion launch:"web" opened other than exactly one link');
  assert.equal(openedTarget, `${launchResult.structuredContent.companion.url}#pair=${launchedCode}`);
  assert.ok(s6.codeAppearsOnceInResult, 'The pairing code was echoed more than once in the launch result');
  assert.match(s6.sentence, /click Open/);
  scenario('S6', 'open_companion launch:"web" opens the exact pairing link from the server itself', 'passed', s6);

  /* ---- Scenario 7: the detailed view opens itself on this Mac ------------ */
  // Same problem as S6, one room closer: the panel cannot follow a link, so
  // the full Mol* viewer is reachable here only because the server hands its
  // own loopback address to the desktop.
  const s7: any = {};
  const beforeDetailed = (await openedLinks()).length;
  const detailedState = (await call('get_inspection_state', { sessionId })).structuredContent;
  const detailedResult = await call('open_detailed_view', {
    sessionId,
    serverEpoch: detailedState.serverEpoch,
    sourceToken: detailedState.sourceToken,
    baseStateRevision: detailedState.stateRevision,
    baseInspectionRevision: detailedState.inspectionRevision,
    open: true,
  });
  const detailedView = detailedResult.structuredContent.detailedView;
  const detailedLinks = await openedLinksAtLeast(beforeDetailed + 1);
  const detailedTarget = detailedLinks.length ? detailedLinks[detailedLinks.length - 1] : '';
  s7.opened = detailedView.opened;
  s7.linksOpened = detailedLinks.length - beforeDetailed;
  s7.matchedReturnedAddress = detailedTarget === detailedView.url;
  // The fragment is a live page key, so only the shape of the address is
  // evidence; the key itself never enters the artifact directory.
  s7.targetShape = redactLinkSecrets(detailedTarget);
  liveSecrets.push(detailedTarget.split('#')[1] ?? '');
  // The address is the first line of the result; the sentence about opening is
  // the second, and carries no key.
  s7.sentence = String(detailedResult.content[0].text).split('\n')[1] ?? '';
  s7.strippedPath = true;
  assert.equal(s7.opened, true, 'open_detailed_view open:true did not open the address under a stripped PATH');
  assert.equal(s7.linksOpened, 1, 'open_detailed_view open:true opened other than exactly one link');
  assert.ok(s7.matchedReturnedAddress, 'The opened link was not the address open_detailed_view returned');
  assert.match(detailedTarget, /^http:\/\/127\.0\.0\.1:\d+\/detailed#[0-9a-f]{64}$/);
  assert.match(s7.sentence, /Browser started for the detailed view on your Mac/);
  scenario('S7', 'open_detailed_view open:true opens the full Mol* viewer from the server itself', 'passed', s7);

  /* ---- Scenario 4: model-side update_inspection reaches the panel -------- */
  const panelId = await mounted.guest.locator('body').getAttribute('data-panel-id');
  assert.ok(panelId, 'Panel did not publish a panel id');
  const ready = await waitState(sessionId, s =>
    s.panels.some((panel: any) => panel.panelId === panelId && panel.current && panel.availability === 'ready'),
  );
  const updateRequest = {
    sessionId,
    serverEpoch: ready.serverEpoch,
    sourceToken: ready.sourceToken,
    baseStateRevision: ready.stateRevision,
    baseInspectionRevision: ready.inspectionRevision,
    panelId,
    commandId: 'cs-emu-appearance',
    change: { kind: 'appearance', patch: { background: '#0b2233', representation: 'ball-and-stick', labels: true } },
  };
  const queued = (await call('update_inspection', updateRequest)).structuredContent;
  const rendered = await waitState(sessionId, s => s.command?.status === 'rendered', 'cs-emu-appearance');
  await mounted.guest.locator('[data-control="background"]').waitFor();
  const backgroundValue = await mounted.guest.locator('[data-control="background"]').inputValue();
  assert.equal(backgroundValue, '#0b2233');
  assert.equal(rendered.command.status, 'rendered');
  const s4shot = await shot(page, 's4-tool-command-rendered');
  scenario('S4', 'Model-side update_inspection reaches a rendered receipt in the sandboxed panel', 'passed', {
    queuedStatus: queued.command.status,
    renderedStatus: rendered.command.status,
    renderedRevision: rendered.command.renderedRevision,
    panelBackground: backgroundValue,
    screenshot: s4shot,
  });

  /* ---- Scenario 5: native drop-file binding mounts the viewer ------------ */
  const s5: any = { binding };
  const hostArgs: any = { [binding!.contentParam]: cif, ...(binding!.nameParam ? { [binding!.nameParam]: '1CRN.cif' } : {}) };
  s5.hostArgs = Object.keys(hostArgs);
  s5.hostMountDecision = widgetCallDecision('stereo_structure.open', true);
  const droppedRaw: any = await client.callTool({ name: 'stereo_structure.open', arguments: hostArgs });
  assert.ok(!droppedRaw.isError, `host-mount open failed: ${JSON.stringify(droppedRaw).slice(0, 600)}`);
  // The naive default (sending "filename" without the schema gate) is recorded, not asserted.
  const naive: any = await client.callTool({
    name: 'stereo_structure.open',
    arguments: { [binding!.contentParam]: cif, filename: '1CRN.cif' },
  });
  s5.naiveFilenameRejected = Boolean(naive.isError);
  s5.naiveFilenameError = naive.isError ? JSON.stringify(naive.content).slice(0, 300) : null;

  const viewerResource = await client.readResource({ uri: 'ui://stereo-structure/viewer' });
  const viewerHtml = (viewerResource.contents[0] as any).text as string;
  const viewerPage = await newHostPage();
  const viewerMount = await mount(viewerPage, viewerHtml, droppedRaw, { theme: 'dark' });
  await viewerMount.guest.locator('#stereo-app canvas').first().waitFor({ state: 'visible', timeout: 120_000 });
  const viewerSession = droppedRaw.structuredContent.sessionId;
  const until = Date.now() + 120_000;
  let loadedStructure = false;
  while (Date.now() < until) {
    const state = (await call('get_state', { sessionId: viewerSession })).structuredContent;
    if (state.diagnostics?.state?.structureLoaded) { loadedStructure = true; break; }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  s5.structureLoaded = loadedStructure;
  s5.srcdocMountMs = Math.round(viewerMount.timings.srcdocMountMs);
  s5.screenshot = await shot(viewerPage, 's5-viewer-drop-file');
  await collectCsp(viewerPage);
  assert.ok(loadedStructure, 'Dropped-file viewer never reported a loaded structure');
  scenario('S5', 'Native drop-file binding (operon.dev/viewer) mounts the stereo viewer', 'passed', s5);

  report.timings.viewer = viewerMount.timings;
  report.status =
    report.scenarios.every((s: Scenario) => s.status === 'passed') && report.defects.length === 0 ? 'passed' : 'passed-with-defects';
} catch (error) {
  report.failure = (error as Error).stack;
  report.stderr = stderr.slice(-4000);
  console.error(error);
} finally {
  await disposeStep('companionClosed', async () => {
    if (!lanSessionId || !lanBinding) return;
    const result: any = await client.callTool({
      name: 'stereo_structure.manage_companion',
      arguments: { sessionId: lanSessionId, serverEpoch: lanBinding.serverEpoch, sourceToken: lanBinding.sourceToken, action: 'close' },
    });
    assert.ok(!result.isError, 'manage_companion close failed');
  });
  await disposeStep('openerRecorderRemoved', () => rmDirectory(openerDirectory, { recursive: true, force: true }));
  await disposeStep('browserClosed', () => browser?.close() ?? Promise.resolve());
  await disposeStep('mcpClosed', () => client.close());
  await disposeStep('listenerClosed', () => new Promise<void>(resolveClose => http.close(() => resolveClose())));
  report.finishedAt = new Date().toISOString();
  // Scrub before the write, then prove the written value is clean. A survivor
  // is a defect in this harness, not a reason to spill it: the artifact goes
  // out scrubbed either way and the run reports the failure.
  report.redaction = { secretsTracked: liveSecrets.length, scrubbedBeforeWrite: findLeakedSecrets(report, liveSecrets) };
  const artifact = scrubSecrets(report, liveSecrets);
  const leaked = findLeakedSecrets(artifact, liveSecrets);
  if (leaked.length > 0) {
    artifact.redaction.leakedAfterScrub = leaked;
    artifact.status = 'failed';
    report.status = 'failed';
    console.error(`A live capability survived the scrub at ${leaked.join(', ')}`);
  }
  await disposeStep('reportWritten', () => writeFile(resolve(out, 'browser-report.json'), JSON.stringify(artifact, null, 2) + '\n'));
  console.log(`\nReport: ${resolve(out, 'browser-report.json')}`);
  console.log(JSON.stringify({ status: artifact.status, scenarios: artifact.scenarios.map((s: Scenario) => [s.id, s.status]), defects: artifact.defects }, null, 2));
  // report.status stays at its initial 'failed' unless every scenario ran to
  // completion, and an individual scenario can also be marked 'failed'
  // directly; either way the process must not exit 0 for a failed run.
  if (report.status === 'failed' || report.scenarios.some((s: Scenario) => s.status === 'failed')) {
    process.exitCode = 1;
  }
}
