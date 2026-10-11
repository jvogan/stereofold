import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Browser, type Frame, type Page } from 'playwright';

assert.equal(process.env.STEREOFOLD_ALLOW_PUBLIC_RELAY, '1', 'This legacy test publishes public 1CRN through Cloudflare. Set STEREOFOLD_ALLOW_PUBLIC_RELAY=1 only for an explicitly authorized relay test. Use test:lan for private Wi-Fi.');
const argument = process.argv[2];
assert.ok(argument, 'Supply a fresh artifact directory.');
const out = resolve(argument);
await mkdir(out, { recursive: false });

const redact = (value: string) => value
  .replace(/https:\/\/[^\s"']+\.trycloudflare\.com[^\s"']*/gi, '[quest-link]')
  .replace(/#[a-f0-9]{64}\b/gi, '#[capability]')
  .replace(/Bearer\s+[a-f0-9]{64}\b/gi, 'Bearer [capability]');
const pageErrors:string[]=[];
const report: any = { status: 'failed', host: 'Controlled MCP Apps AppBridge plus real stdio and Cloudflare HTTPS relay.', cases: [], screenshots: [], cleanup: {} };
const passed = (name: string) => { report.cases.push(name); console.log(`Passed: ${name}`); };
const delay = (milliseconds: number) => new Promise<void>(resolveDelay => setTimeout(resolveDelay, milliseconds));
const client = new Client({ name: 'Stereofold Quest HTTPS acceptance', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.mjs')], cwd: process.cwd(), stderr: 'pipe' });
transport.stderr?.on('data',()=>{});
let browser: Browser | undefined;
let host: ReturnType<typeof createServer> | undefined;

const call = async (name: string, args: Record<string, unknown>) => {
  const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!result.isError, `stereo_structure.${name} failed: ${redact(result.isError ? String(result.content?.[0]?.text ?? '').slice(0,500) : '')}`);
  return result;
};
const inspection = async (sessionId: string) => (await call('get_inspection', { sessionId }))._meta?.['stereo_structure/inspection'];
const binding = (state: any, sessionId: string) => ({ sessionId, serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
  baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision });

async function waitState(sessionId: string, predicate: (state: any) => boolean, commandId?: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = (await call('get_inspection_state', { sessionId, ...(commandId ? { commandId } : {}) })).structuredContent;
    if (predicate(state)) return state;
    if (commandId && ['rejected', 'expired', 'conflict', 'unconfirmed'].includes(state.command?.status)) throw Error(`Command ${commandId}: ${state.command.status}: ${state.command.reason ?? ''}`);
    await delay(100);
  }
  throw Error('Timed out waiting for inspection state.');
}

async function mountDesktop(origin: string, html: string, opened: any) {
  const context = await browser!.newContext({ viewport: { width: 1120, height: 760 }, deviceScaleFactor: 1 });
  const page = await context.newPage(); page.setDefaultTimeout(120_000);
  await page.addInitScript({ content: 'globalThis.__name = value => value;' });
  page.on('pageerror', error => { pageErrors.push(redact(error.message)); });
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.exposeFunction('__call', async (payload: any) => {
    const result:any=await client.callTool({ name: payload.name, arguments: payload.arguments ?? {} });
    if(payload.name.endsWith('open_companion')) console.log(JSON.stringify({connectionError:result.isError?redact(String(result.content?.[0]?.text)):null}));
    return result;
  });
  await page.goto(origin);
  await page.evaluate(({ resource, result }) => (window as any).__host.mount(resource, result, { theme: 'dark' }), { resource: html, result: opened });
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  assert.ok(frame, 'The controlled host must mount an app frame.');
  await page.waitForFunction(() => (window as any).__host.connected);
  return { context, page, frame };
}

async function waitReady(sessionId: string, surface: 'desktop' | 'companion', panelId?: string) {
  return waitState(sessionId, state => state.panels.some((panel: any) => panel.surface === surface && panel.current && panel.availability === 'ready'
    && (panelId === undefined || panel.panelId === panelId)));
}

async function captureCanvas(frame: Frame | Page, name: string) {
  const png = await frame.locator('.stage canvas').screenshot();
  assert.ok(png.length > 1_000 && png.length < 15 * 1024 * 1024, 'Expected a bounded rendered canvas.');
  const file = `${name}.png`;
  await writeFile(resolve(out, file), png);
  report.screenshots.push({ file, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') });
}

const hostBundle = await build({ entryPoints: [resolve('scripts/inspector-host.ts')], bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
const hostHtml = `<!doctype html><html><body style="margin:0;background:#071015"><iframe title="Stereofold" style="border:0;width:100vw;height:100vh"></iframe><script>${hostBundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
host = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(hostHtml); });
await new Promise<void>(resolveListen => host!.listen(0, '127.0.0.1', resolveListen));
const desktopOrigin = `http://127.0.0.1:${(host.address() as any).port}`;

try {
  await client.connect(transport);
  const fixture = await readFile(resolve('../fixtures/1CRN.cif'), 'utf8');
  const fixtureSha256 = createHash('sha256').update(fixture).digest('hex');
  const opened = await call('inspect', { structureText: fixture });
  const sessionId = opened.structuredContent.sessionId as string;
  assert.ok(sessionId && !/_atom_site\./i.test(JSON.stringify(opened)), 'The public inspection result must not expose coordinates.');
  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  const html = (resource.contents[0] as any).text as string;

  browser = await chromium.launch({ headless: true }); report.browserVersion = browser.version();
  const desktop = await mountDesktop(desktopOrigin, html, opened);
  await desktop.frame.locator('body[data-ready="true"]').waitFor();
  await desktop.frame.locator('.stage canvas').waitFor({ state: 'visible' });
  await waitState(sessionId, state => state.hasScene === true);
  await waitReady(sessionId, 'desktop');
  const saved = await inspection(sessionId);
  assert.equal(saved?.catalog?.source?.sha256, fixtureSha256, 'Desktop must save the fixture before opening Quest.');
  passed('1CRN renders and saves through the controlled AppBridge desktop host');

  const current = await waitReady(sessionId, 'desktop');
  const connected = await call('open_companion', { ...binding(current, sessionId), connection: 'https' });
  const launch = new URL(connected.structuredContent.companion.webLaunchUrl);
  assert.equal(launch.origin, 'https://www.oculus.com');
  assert.equal(launch.pathname, '/open_url/');
  const capabilityUrl = launch.searchParams.get('url'); // Never serialize this capability.
  assert.ok(capabilityUrl);
  passed('The explicitly requested legacy relay returns a ready HTTPS link and official Meta chooser');
  const publicOrigin = new URL(capabilityUrl).origin;
  assert.match(publicOrigin, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);

  const questContext = await browser.newContext({ viewport: { width: 600, height: 800 }, deviceScaleFactor: 1 });
  const quest = await questContext.newPage(); quest.setDefaultTimeout(120_000);
  await quest.addInitScript({content:'globalThis.__name = value => value;'});
  const externalRequests: string[] = [];
  quest.on('pageerror', error => externalRequests.push(`pageerror:${redact(error.message)}`));
  await quest.route('**/*', route => {
    if (route.request().url().startsWith(publicOrigin)) return route.continue();
    externalRequests.push('blocked-cross-origin-request'); return route.abort();
  });
  await quest.goto(capabilityUrl);
  await quest.locator('body[data-ready="true"]').waitFor();
  await quest.locator('.stage canvas').waitFor({ state: 'visible' });
  const companionPanel = await quest.locator('body').getAttribute('data-panel-id');
  assert.ok(companionPanel, 'HTTPS companion must register a panel.');
  await waitReady(sessionId, 'companion', companionPanel);
  const source = await quest.evaluate(async () => {
    const response = await fetch('/source', { headers: { Authorization: `Bearer ${location.hash.slice(1)}` } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { status: response.status, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''), announced: response.headers.get('x-stereofold-source-sha256') };
  });
  assert.deepEqual(source, { status: 200, sha256: fixtureSha256, announced: fixtureSha256 });
  assert.deepEqual(externalRequests, []);
  await captureCanvas(quest, 'quest-https-1crn');
  passed('The isolated browser loads the actual HTTPS companion, registers ready, and verifies the 1CRN source digest');

  const menu = quest.locator('[data-tour-menu]');
  await expectCount(menu.locator('option:not([value=""])'), 10);
  await menu.selectOption('fold-detective');
  await quest.locator('[data-tour-start]').click();
  await quest.locator('[data-tour-progress]').waitFor({ state: 'visible' });
  await quest.waitForFunction(() => /SCENE\s+1/i.test(document.querySelector('[data-tour-progress]')?.textContent ?? ''));
  const firstScene = await quest.locator('[data-tour-progress]').textContent();
  await quest.locator('[data-tour-next]').click();
  await quest.waitForFunction(previous => (document.querySelector('[data-tour-progress]')?.textContent ?? '') !== previous, firstScene);
  await waitState(sessionId,state=>state.panels.some((p:any)=>p.panelId===companionPanel&&p.current&&p.availability==='ready'&&p.tour?.step===1));
  await quest.locator('[data-tour-back]').click();
  await quest.waitForFunction(previous => (document.querySelector('[data-tour-progress]')?.textContent ?? '') === previous, firstScene);
  passed('The HTTPS companion exposes all ten tour menu entries and completes Next then Back');

  const ready = await waitState(sessionId,state=>state.panels.some((p:any)=>p.panelId===companionPanel&&p.current&&p.availability==='ready'&&p.tour?.step===0));
  const commandId = 'quest-https-shared-appearance';
  const queued = await call('update_inspection', { ...binding(ready, sessionId), panelId: companionPanel, commandId,
    change: { kind: 'appearance', patch: { background: '#123456', color: 'uniform', uniformColor: '#7ee6ff' } } });
  assert.equal(queued.structuredContent.command.status, 'queued');
  await waitState(sessionId, state => state.command?.status === 'rendered', commandId);
  await desktop.frame.waitForFunction(() => (document.querySelector('[data-control="background"]') as HTMLInputElement | null)?.value === '#123456');
  await quest.waitForFunction(() => (document.querySelector('[data-control="background"]') as HTMLInputElement | null)?.value === '#123456');
  passed('A companion-targeted rendered appearance change returns through the shared desktop session');
  const tourReady=await waitReady(sessionId,'companion',companionPanel);
  const tourCommand='quest-https-remote-tour-next';
  await call('control_tour',{...binding(tourReady,sessionId),panelId:companionPanel,commandId:tourCommand,action:'next'});
  await waitState(sessionId,state=>state.command?.status==='rendered',tourCommand);
  await quest.waitForFunction(()=>/SCENE\s+2\s*\//i.test(document.querySelector('[data-tour-progress]')?.textContent??''));
  passed('Codex-style control_tour Next receives a rendered receipt from the HTTPS panel');
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(pageErrors, []);
  report.status = 'passed';
} catch (error) {
  report.failure = redact(error instanceof Error ? error.message : String(error));
  process.exitCode=1;
} finally {
  await disposeStep('browserClosed', () => browser?.close() ?? Promise.resolve());
  await disposeStep('mcpClosed', () => client.close());
  await disposeStep('hostClosed', () => new Promise<void>(resolveClose => host ? host.close(() => resolveClose()) : resolveClose()));
  await disposeStep('reportWritten', () => writeFile(resolve(out, 'quest-browser-report.json'), JSON.stringify(report, null, 2) + '\n'));
  console.log(JSON.stringify(report, null, 2));
}

// Each disposal step is isolated: a throwing browser.close() must not skip the
// MCP child process, the loopback listener, or the report that explains the
// failure this cleanup exists for.
async function disposeStep(step: string, work: () => Promise<unknown>) {
  try { await work(); report.cleanup[step] = true; }
  catch (cleanupError) { report.cleanup[step] = false; (report.cleanupErrors ??= []).push(`${step}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
}

async function expectCount(locator: ReturnType<Page['locator']>, expected: number) {
  await locator.first().waitFor({ state: 'attached' });
  assert.equal(await locator.count(), expected, `Expected ${expected} tour menu entries.`);
}
