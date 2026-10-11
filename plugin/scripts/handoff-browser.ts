import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Frame, type Page } from 'playwright';

/**
 * Isolated acceptance for the source-identity handoff and same-context Mol*
 * workbench actions.
 *
 * Usage: pnpm exec tsx scripts/handoff-browser.ts /absolute/fresh-artifact-dir
 *
 * The host is an in-process AppBridge fixture. It records the two official
 * host requests without opening a browser tab or attempting a native viewer.
 */
const artifactArg = process.argv[2];
assert.ok(artifactArg, 'Supply a fresh artifact directory.');
const artifactDir = resolve(artifactArg);
await mkdir(artifactDir, { recursive: false });

const report: { status: string; cases: string[]; errors: string[]; inspectorBuild?: string; events?: unknown[]; screenshot?: string } = {
  status: 'failed', cases: [], errors: [],
};
const pass = (name: string) => { report.cases.push(name); console.log(`Passed: ${name}`); };
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const expectCanvasChange = async (read: () => Promise<string>, before: string, message: string) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await read() !== before) return;
    await sleep(150);
  }
  assert.fail(message);
};
const client = new Client({ name: 'Stereofold handoff acceptance', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('dist/server.mjs')],
  cwd: process.cwd(),
  stderr: 'pipe',
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let host: ReturnType<typeof createServer> | undefined;
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += String(chunk); });

const call = async (name: string, args: Record<string, unknown>) => {
  const response: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!response.isError, `${name} failed: ${JSON.stringify(response)}`);
  return response;
};
const inspection = async (sessionId: string) => {
  const response: any = await call('get_inspection', { sessionId });
  return response._meta['stereo_structure/inspection'];
};
async function waitForSavedScene(sessionId: string, predicate: (scene: any) => boolean = () => true) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const data = await inspection(sessionId);
    if (data.scene && predicate(data.scene)) return data.scene;
    await sleep(100);
  }
  throw Error('Timed out waiting for the initial Stereofold scene to save.');
}

// This is deliberately separate from inspector-host.ts: it advertises only
// the AppBridge capabilities needed by this acceptance and records requests.
const fixtureSource = String.raw`
  import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
  let bridge: AppBridge | undefined;
  window.__host = {
    connected: false, events: [], failNextOpenLink: false,
    async mount(html: string, opened: any) {
      if (bridge) await bridge.close();
      this.connected = false; this.events = [];
      const frame = document.querySelector('iframe') as HTMLIFrameElement;
      bridge = new AppBridge(null, { name: 'Stereofold handoff fixture', version: '1' }, {
        openLinks: {}, message: {}, serverTools: {}, serverResources: {},
      }, { hostContext: { displayMode: 'inline', containerDimensions: { maxWidth: 1100, maxHeight: 720 }, theme: 'dark' } });
      bridge.oncalltool = (payload: any) => window.__call(payload);
      bridge.onupdatemodelcontext = async () => ({});
      bridge.onsizechange = () => {};
      bridge.onopenlink = async (params: any) => {
        this.events.push({ kind: 'openLink', params });
        if (this.failNextOpenLink) { this.failNextOpenLink = false; return { isError: true }; }
        return {};
      };
      bridge.onmessage = async (params: any) => { this.events.push({ kind: 'message', params }); return {}; };
      bridge.oninitialized = async () => { this.connected = true; await bridge!.sendToolResult(opened); };
      await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
      frame.srcdoc = html;
    },
  };
`;
const fixture = await build({
  stdin: { contents: fixtureSource, resolveDir: process.cwd(), sourcefile: 'handoff-host.ts', loader: 'ts' },
  bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022',
});
const fixtureHtml = `<!doctype html><html><body style="margin:0;background:#071015"><iframe title="Stereofold" style="border:0;width:100vw;height:100vh"></iframe><script>${fixture.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
host = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(fixtureHtml); });
await new Promise<void>(done => host!.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(host.address() as any).port}`;

let page: Page | undefined;
let frame: Frame | undefined;
try {
  await client.connect(transport);
  report.inspectorBuild = (await stat(resolve('dist/inspector.html'))).mtime.toISOString();
  const opened = await call('inspect', { pdbId: '1CRN' });
  const sessionId = opened.structuredContent.sessionId as string;
  const before = await inspection(sessionId);
  assert.equal(before.nativeStructureViewerHandoff?.kind, 'public-pdb', 'public PDB source identity must be hydrated privately');
  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  const html = (resource.contents[0] as any).text as string;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30_000);
  await page.addInitScript({ content: `
    window.__handoffXrRequests = 0;
    const xr = navigator.xr;
    if (xr && typeof xr.requestSession === 'function') {
      try {
        const requestSession = xr.requestSession.bind(xr);
        Object.defineProperty(xr, 'requestSession', {
          configurable: true,
          value(...args) { window.__handoffXrRequests++; return requestSession(...args); },
        });
      } catch { /* A locked browser API is still not invoked by this desktop test. */ }
    }
  ` });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.exposeFunction('__call', (payload: any) => client.callTool({ name: payload.name, arguments: payload.arguments ?? {} }));
  await page.goto(origin);
  // The panel offers the Codex viewer request only to a
  // host that identified itself as Codex, so this stub says which it is exactly
  // as a real host does, through the handshake's own userAgent field.
  await page.evaluate(({ resource: resourceHtml, result }) => (window as any).__host.mount(resourceHtml, result,
    { theme: 'dark', userAgent: 'codex-cli/1.0' }), { resource: html, result: opened });
  frame = page.frames().find(candidate => candidate !== page!.mainFrame());
  assert.ok(frame, 'The fixture must create an inspector frame.');
  await page.waitForFunction(() => (window as any).__host.connected);
  await frame.locator('body[data-ready="true"]').waitFor();
  const canvas = frame.locator('.stage canvas');
  const canvasHash = async () => createHash('sha256').update(await canvas.screenshot()).digest('hex');
  const firstResidue = frame.locator('.sequence button').first();
  await firstResidue.waitFor({ state: 'visible' });
  const selectionBeforeFocus = await canvasHash();
  await firstResidue.click();
  const selectionDeadline = Date.now() + 15_000;
  while (Date.now() < selectionDeadline && await firstResidue.getAttribute('aria-pressed') !== 'true') await sleep(100);
  assert.equal(await firstResidue.getAttribute('aria-pressed'), 'true', `Selection must be committed by the live Mol* context (count=${await frame.locator('.selection-count').innerText()}, disabled=${await firstResidue.isDisabled()}).`);
  assert.match(await frame.locator('.selection-count').innerText(), /1 residue/, 'Selection must be reflected by the live inspector state.');
  await frame.locator('[data-action="focus"]').click();
  await expectCanvasChange(canvasHash, selectionBeforeFocus, 'Focusing the source-aware selection must redraw the same Mol* canvas.');
  pass('Source-aware residue selection and focus redraw the shared Mol* renderer');
  const workbench = frame.locator('[data-connected-workbench]');
  await workbench.waitFor({ state: 'visible' });
  await workbench.click();
  const workbenchDialog = frame.locator('[data-connected-workbench-dialog][open]');
  await workbenchDialog.waitFor();
  const stockTools = workbenchDialog.locator('[data-stock-molstar-structure-tools]');
  await stockTools.getByText('Structure Tools', { exact: true }).waitFor();
  await stockTools.getByText('Quick Styles', { exact: true }).waitFor();
  await workbenchDialog.locator('[data-stock-molstar-selection-tools] .msp-selection-viewport-controls').waitFor();
  const selectionTools = workbenchDialog.locator('[data-stock-molstar-selection-tools]');
  const stockSelectionBefore = await canvasHash();
  await selectionTools.locator('button[title^="Set Selection"]').click();
  const typeSection = selectionTools.getByRole('button', { name: 'Type', exact: true });
  if (await typeSection.count()) await typeSection.click();
  await selectionTools.getByRole('button', { name: 'Polymer', exact: true }).click();
  await expectCanvasChange(canvasHash, stockSelectionBefore, 'A stock Mol* selection query must redraw the shared canvas.');
  const selectionReceipt = workbenchDialog.locator('[data-connected-workbench-status]');
  const selectionReceiptDeadline = Date.now() + 15_000;
  while (Date.now() < selectionReceiptDeadline && !(await selectionReceipt.innerText()).includes('Live Mol* change applied')) await sleep(100);
  assert.ok((await selectionReceipt.innerText()).includes('Live Mol* change applied'), `Stock Mol* selection receipt missing: ${await selectionReceipt.innerText()}`);
  const stockSelected = await waitForSavedScene(sessionId, scene => (scene.selectionKeys?.length ?? 0) > 1);
  assert.ok(stockSelected.selectionKeys.length > 1, 'A stock Mol* selection must be adopted as canonical residue keys.');
  pass('Stock Mol* selection query updates canonical Stereofold residue selection');
  const appearanceBefore = await canvasHash();
  await stockTools.getByRole('button', { name: 'Spacefill', exact: true }).click();
  await expectCanvasChange(canvasHash, appearanceBefore, 'Mol* Spacefill control must redraw the live Stereofold canvas.');
  const stockStatus = workbenchDialog.locator('[data-connected-workbench-status]');
  const stockReceiptDeadline = Date.now() + 15_000;
  while (Date.now() < stockReceiptDeadline && !(await stockStatus.innerText()).includes('Live Mol* change applied')) await sleep(100);
  assert.ok((await stockStatus.innerText()).includes('Live Mol* change applied'), `Stock Mol* receipt missing: ${await stockStatus.innerText()}`);
  pass('Stock Mol* Structure Tools appearance control redraws the shared renderer');
  await workbenchDialog.locator('[aria-label="Close Mol* workbench"]').click();
  const stereofoldAppearanceBefore = await canvasHash();
  await frame.locator('[data-control="representation"]').selectOption('molecular-surface');
  await expectCanvasChange(canvasHash, stereofoldAppearanceBefore,
    `Stereofold appearance controls must redraw after a stock Mol* preset (status=${await frame.locator('.last-action').innerText()}, message=${await frame.locator('#status').innerText()}, value=${await frame.locator('[data-control="representation"]').inputValue()}).`);
  const savedAfterAppearance = await waitForSavedScene(sessionId, scene => scene.inspection?.appearance?.representation === 'molecular-surface');
  assert.equal(savedAfterAppearance.inspection.appearance.representation, 'molecular-surface', 'Stereofold must save its own representation after stock Mol* controls run.');
  pass('Stereofold appearance remains synchronized after closing stock Mol* controls');
  const savedScene = await waitForSavedScene(sessionId, scene => (scene.selectionKeys?.length ?? 0) > 1);
  // The companion, Quest and handoff buttons live under the header's More
  // menu, a closed <details>. Setting open is idempotent, unlike a summary click.
  await frame.locator('[data-header-menu]').evaluate((menu: any) => { menu.open = true; });
  const handoff = frame.locator('[data-handoff-open]');
  await handoff.waitFor({ state: 'visible' });
  assert.ok(await handoff.isEnabled(), 'A public PDB should expose a usable handoff action.');
  let events = await page.evaluate(() => (window as any).__host.events);
  assert.deepEqual(events, [], 'No handoff request may be dispatched while the menu is unopened.');
  await handoff.click();
  const dialog = frame.locator('[data-handoff-dialog][open]');
  await dialog.waitFor();
  assert.equal(await dialog.locator('[data-handoff-summary]').innerText(),
    'PDB 1CRN');
  assert.equal(await dialog.locator('[data-handoff-native-title]').innerText(), 'Molecular Structure Viewer in Codex',
    'A host that identified itself as Codex is named as Codex.');
  assert.ok(await dialog.locator('[data-handoff-native-optin]').isHidden(),
    'An identified host is never asked to opt into the Codex request.');
  assert.deepEqual(await page.evaluate(() => (window as any).__host.events), [], 'Opening the menu must not dispatch a host request.');

  await dialog.locator('[data-handoff-web]').click();
  await frame.locator('[data-handoff-status]').filter({ hasText: 'Opened the independent Mol* website view.' }).waitFor();
  events = await page.evaluate(() => (window as any).__host.events);
  assert.deepEqual(events, [{ kind: 'openLink', params: { url: 'https://molstar.org/viewer/?pdb=1CRN' } }], 'Mol* URL must be exact and click-gated.');
  pass('Public PDB handoff opens the exact Mol* URL only after the explicit action click');

  await dialog.locator('[data-handoff-native]').click();
  await frame.locator('[data-handoff-status]').filter({ hasText: 'Requested Molecular Structure Viewer in Codex.' }).waitFor();
  events = await page.evaluate(() => (window as any).__host.events);
  assert.equal(events.length, 2, 'Native handoff should produce one additional host event.');
  assert.deepEqual(events[1], { kind: 'message', params: {
    role: 'user', content: [{ type: 'text', text: 'Open public PDB 1CRN in Molecular Structure Viewer.' }],
  } }, 'Native handoff must send only the source identity prompt.');
  const after = await inspection(sessionId);
  assert.deepEqual(after.scene, savedScene, 'Handoff actions must preserve the current Stereofold scene on return.');
  assert.ok(!JSON.stringify(events[1]).includes('_atom_site.'), 'Native handoff must not send coordinate bytes.');
  report.events = events;
  pass('Codex handoff sends the exact public identity prompt and preserves Stereofold state');

  await page.evaluate(() => { (window as any).__host.failNextOpenLink = true; });
  await dialog.locator('[data-handoff-web]').click();
  await frame.locator('[data-handoff-status]').filter({ hasText: 'This host could not open the Mol* website.' }).waitFor();
  assert.equal((await page.evaluate(() => (window as any).__host.events)).length, 3, 'The simulated failure must remain an explicit click-gated host request.');
  const screenshot = resolve(artifactDir, 'handoff-error-960x720.png');
  await page.screenshot({ path: screenshot });
  report.screenshot = screenshot;
  pass('A rejected viewer request remains visible in the menu without changing Stereofold');
  assert.deepEqual((await inspection(sessionId)).scene, savedScene, 'The rejected handoff must also leave the saved scene unchanged.');
  assert.equal(await frame.evaluate(() => (window as any).__handoffXrRequests), 0, 'Desktop handoff must not request an XR session.');
  pass('Handoff acceptance does not auto-enter XR');
  report.status = 'passed';
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(report.errors.at(-1));
  if (stderr.trim()) console.error(stderr.trim());
  process.exitCode = 1;
} finally {
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await client.close().catch(() => {});
  await new Promise<void>(done => host?.close(() => done()) ?? done());
  await mkdir(artifactDir, { recursive: true });
  await (await import('node:fs/promises')).writeFile(resolve(artifactDir, 'handoff-report.json'), JSON.stringify(report, null, 2));
}
