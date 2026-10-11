import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Browser, type Frame, type Page } from 'playwright';

const [argument, lanHost, ...extra] = process.argv.slice(2).filter(value => value !== '--');
assert.ok(lanHost && extra.length === 0, 'Usage: lan-browser.ts <fresh-artifact-directory> <lan-host>');
assert.ok(argument, 'Supply a fresh artifact directory.');
const out = resolve(argument);
await mkdir(out, { recursive: false });
const privateStore = resolve(out, '.private-lan');
// The first-use launch failure is real subprocess I/O, isolated from any
// developer headset or Meta account present on the test machine.
const launchBin = resolve(out, '.launch-tools');
await mkdir(launchBin);
await writeFile(resolve(launchBin, 'adb'), '#!/bin/sh\nif [ "$1" = devices ]; then echo "List of devices attached"; exit 0; fi\nexit 2\n', { mode: 0o700 });
await writeFile(resolve(launchBin, 'open'), '#!/bin/sh\nexit 3\n', { mode: 0o700 });

const isPrivateIpv4 = (address: string) => {
  const part = address.split('.').map(Number);
  return part.length === 4 && part.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    && (part[0] === 10 || (part[0] === 172 && part[1] >= 16 && part[1] <= 31) || (part[0] === 192 && part[1] === 168));
};
const lanAddresses = Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? [])
  .filter(entry => !entry.internal && entry.family === 'IPv4' && isPrivateIpv4(entry.address)).map(entry => ({ name, address: entry.address })));
const requiredAddress = lanAddresses.find(entry => entry.address === lanHost);
assert.ok(requiredAddress, 'The lan-host argument must be an assigned RFC1918 IPv4 LAN address.');

const report: any = {
  status: 'failed',
  scope: 'Isolated Playwright acceptance through official MCP Apps AppBridge, real local HTTPS LAN listener, and local 1CRN fixture.',
  certificateAcceptance: 'Simulated certificate acceptance: Playwright context uses ignoreHTTPSErrors for this isolated self-signed local listener. Physical Quest certificate acceptance is not tested.',
  lanAddress: requiredAddress.address,
  cases: [], screenshots: [], blockedRequests: [], errors: [], cleanup: {},
};
const pass = (name: string) => { report.cases.push(name); console.log(`Passed: ${name}`); };
const delay = (ms: number) => new Promise<void>(resolveDelay => setTimeout(resolveDelay, ms));
const client = new Client({ name: 'Stereofold LAN browser acceptance', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.mjs')], cwd: process.cwd(),
  env: { STEREOFOLD_REPLY_AUDIO: '0', STEREOFOLD_PTT_TRANSCRIBE: '0', STEREOFOLD_LAN_REMEMBER: '1',
    STEREOFOLD_LAN_CERTIFICATE_STORE: privateStore, STEREOFOLD_CONFIG: resolve(out, '.launch-config.json'),
    PATH: `${launchBin}:${process.env.PATH ?? ''}`, STEREOFOLD_OPENER: resolve(launchBin, 'open') }, stderr: 'pipe' });
transport.stderr?.on('data', () => {});
let browser: Browser | undefined;
let host: ReturnType<typeof createServer> | undefined;
let desktopContext: Awaited<ReturnType<Browser['newContext']>> | undefined;
let lanContext: Awaited<ReturnType<Browser['newContext']>> | undefined;
let companionPage: Page | undefined;
let desktopFrame: Frame | undefined;
let ownedSessionId: string | undefined, ownedDeviceId: string | undefined;

const call = async (name: string, args: Record<string, unknown>) => {
  const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!result.isError, `stereo_structure.${name} failed: ${String(result.content?.[0]?.text ?? '').slice(0, 500)}`);
  return result;
};
const binding = (state: any, sessionId: string) => ({ sessionId, serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
  baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision });
async function waitState(sessionId: string, predicate: (state: any) => boolean, commandId?: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    const state = (await call('get_inspection_state', { sessionId, ...(commandId ? { commandId } : {}) })).structuredContent;
    if (predicate(state)) return state;
    last = { stateRevision: state.stateRevision, inspectionRevision: state.inspectionRevision,
      commandStatus: state.command?.status, commandReason: state.command?.reason,
      wearerPaused: state.command?.wearerPaused, wearer: state.wearer,
      panels: state.panels?.map((panel: any) => ({ surface: panel.surface, current: panel.current, availability: panel.availability })) };
    if (commandId && ['saved', 'render_failed', 'conflict', 'cancelled', 'superseded', 'expired', 'unconfirmed'].includes(state.command?.status))
      throw Error(`Command did not produce a rendered receipt (${commandId}): ${JSON.stringify(last)}`);
    await delay(150);
  }
  throw Error(`Timed out waiting for inspection state${commandId ? ` (${commandId})` : ''}: ${JSON.stringify(last)}`);
}
async function waitReady(sessionId: string, surface: 'desktop' | 'companion', panelId?: string, tourStep?: number) {
  return waitState(sessionId, state => state.panels.some((panel: any) => panel.surface === surface && panel.current && panel.availability === 'ready'
    && (panelId === undefined || panel.panelId === panelId) && (tourStep === undefined || panel.tour?.step === tourStep)
    && (surface !== 'companion' || (panel.xrStartup?.visible === true && panel.xrStartup.ageMs < 1500
      && ['page-open', 'in-vr'].includes(state.wearer?.state) && Date.now() - state.wearer.checkedInAt < 1500))));
}
async function captureCanvas(owner: Page | Frame, name: string) {
  const bytes = await owner.locator('.stage canvas').screenshot();
  assert.ok(bytes.length > 1_000 && bytes.length < 15 * 1024 * 1024, 'Expected a bounded rendered canvas image.');
  const file = `${name}.png`; await writeFile(resolve(out, file), bytes);
  const record = { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  report.screenshots.push(record); return record;
}
async function credentialDigest(page: Page) {
  return page.evaluate(async () => {
    const key = sessionStorage.getItem('stereo_structure/page-key') ?? location.hash.slice(1);
    if (!/^[a-f0-9]{64}$/.test(key)) throw Error('No paired page credential is available.');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  });
}
async function mountDesktop(origin: string, html: string, opened: any) {
  desktopContext = await browser!.newContext({ viewport: { width: 1120, height: 760 }, deviceScaleFactor: 1 });
  const page = await desktopContext.newPage(); page.setDefaultTimeout(120_000);
  page.on('pageerror', error => report.errors.push({ surface: 'desktop', message: error.message }));
  await page.addInitScript({ content: 'globalThis.__name = value => value;' });
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.exposeFunction('__call', async (payload: any) => client.callTool({ name: payload.name, arguments: payload.arguments ?? {} }));
  await page.goto(origin);
  await page.evaluate(({ resource, result }) => (window as any).__host.mount(resource, result, { theme: 'dark' }), { resource: html, result: opened });
  const frame = page.frames().find(candidate => candidate !== page.mainFrame()); assert.ok(frame, 'Controlled host did not mount an app frame.');
  await page.waitForFunction(() => (window as any).__host.connected);
  return { page, frame };
}

const hostBundle = await build({ entryPoints: [resolve('scripts/inspector-host.ts')], bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
const hostHtml = `<!doctype html><iframe title="Stereofold" style="border:0;width:100vw;height:100vh"></iframe><script>${hostBundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`;
host = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(hostHtml); });
await new Promise<void>((resolveListen, reject) => { host!.once('error', reject); host!.listen(0, '127.0.0.1', () => resolveListen()); });
const desktopOrigin = `http://127.0.0.1:${(host.address() as any).port}`;

try {
  await client.connect(transport);
  browser = await chromium.launch({ headless: true }); report.browserVersion = browser.version();
  const fixture = await readFile(resolve('../fixtures/1CRN.cif'), 'utf8');
  const fixtureSha256 = createHash('sha256').update(fixture).digest('hex');
  const opened = await call('inspect', { structureText: fixture });
  const sessionId = opened.structuredContent.sessionId as string; assert.ok(sessionId);
  ownedSessionId = sessionId;
  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  report.runtimeSha256 = Object.fromEntries(await Promise.all(['server.mjs', 'inspector.html', 'inspector.css'].map(async name =>
    [name, createHash('sha256').update(await readFile(resolve('dist', name))).digest('hex')])));
  report.inspectorResourceSha256 = createHash('sha256').update((resource.contents[0] as any).text).digest('hex');
  const desktop = await mountDesktop(desktopOrigin, (resource.contents[0] as any).text, opened);
  desktopFrame = desktop.frame;
  await desktop.frame.locator('body[data-ready="true"]').waitFor(); await desktop.frame.locator('.stage canvas').waitFor({ state: 'visible' });
  await waitState(sessionId, state => state.hasScene === true); await waitReady(sessionId, 'desktop');
  pass('1CRN renders and saves through the controlled official AppBridge host');

  // The companion, Quest and handoff buttons live under the header's More
  // menu, a closed <details>. Setting open is idempotent, unlike a summary click.
  await desktop.frame.locator('[data-header-menu]').evaluate((menu: any) => { menu.open = true; });
  await desktop.frame.locator('[data-quest-open]').click();
  await desktop.frame.locator('[data-quest-web]').click();
  await desktop.frame.waitForFunction(() => document.querySelector('[data-quest-status]')?.textContent?.includes('Continue to Meta'));
  assert.ok(await desktop.frame.locator('[data-quest-launch]').isVisible(), 'A failed desktop dispatch needs a visible fallback.');
  assert.ok(!(await desktop.frame.locator('[data-quest-status]').textContent())?.includes('opened in your browser'), 'A failed dispatcher must not be reported as opened.');
  const launchFailure = 'quest-launch-recovery.png';
  await desktop.page.screenshot({ path: resolve(out, launchFailure) });
  report.screenshots.push({ file: launchFailure, scope: 'Desktop connection UI after rejected OS dispatch; no headset delivery claimed.' });
  pass('A fresh Quest user with no authorized device sees a failed browser launch and usable Meta/manual recovery');
  await desktop.frame.locator('[data-quest-lan]').click();
  const dialog = desktop.frame.locator('[data-lan-dialog]'); await dialog.waitFor({ state: 'visible' });
  // The dialog opens before the asynchronous sharing call populates it.
  await desktop.frame.waitForFunction(() => document.querySelector('[data-lan-url]')?.getAttribute('href')?.startsWith('https://'));
  const bookmark = await dialog.locator('[data-lan-url]').getAttribute('href'); const pairingCode = await dialog.locator('[data-lan-code]').textContent();
  assert.ok(bookmark && /^https:\/\/(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(bookmark), 'Quest dialog must show an RFC1918 HTTPS bookmark.');
  assert.ok(/^\d{8}$/.test(pairingCode ?? ''), 'Quest dialog must display an eight-digit one-time code.');
  const lanUrl = new URL(bookmark); assert.equal(lanUrl.hostname, requiredAddress.address); assert.equal(lanUrl.pathname, '/');
  const fingerprint = await dialog.locator('[data-lan-fingerprint]').textContent(); assert.match(fingerprint ?? '', /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
  pass('Open on Quest defaults to the assigned private LAN HTTPS address and displays pairing identity locally');

  lanContext = await browser.newContext({ viewport: { width: 600, height: 800 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const quest = await lanContext.newPage(); quest.setDefaultTimeout(120_000);
  quest.on('pageerror', error => report.errors.push({ surface: 'companion', message: error.message }));
  companionPage = quest;
  const external: string[] = [];
  await quest.route('**/*', route => {
    const value = route.request().url();
    if (value.startsWith(lanUrl.origin)) return route.continue();
    external.push(value); return route.abort();
  });
  await quest.goto(bookmark);
  // Playwright action errors can echo entered values. Keep the one-time code
  // out of the persisted failure report even when the pairing input fails.
  await quest.getByLabel('Pairing code').fill(pairingCode!).catch(() => { throw Error('Could not enter the LAN pairing code.'); });
  await quest.getByRole('button', { name: 'Pair' }).click();
  await quest.waitForURL(url => url.pathname === '/viewer');
  await credentialDigest(quest);
  ownedDeviceId = await quest.evaluate(() => JSON.parse(localStorage.getItem('stereofold.device') ?? '{}').deviceId);
  assert.match(ownedDeviceId ?? '', /^[a-f0-9]{32}$/);
  await quest.locator('body[data-ready="true"]').waitFor(); await quest.locator('.stage canvas').waitFor({ state: 'visible' });
  await quest.waitForFunction(() => Boolean(document.body.dataset.panelId));
  const panelId = await quest.locator('body').getAttribute('data-panel-id'); assert.ok(panelId, 'Paired LAN viewer did not attach a companion panel.');
  await waitReady(sessionId, 'companion', panelId);
  const rendered = await captureCanvas(quest, 'lan-1crn');
  await quest.waitForFunction(() => {
    try { return JSON.parse(document.querySelector('[data-companion-diagnostics] pre')?.textContent ?? '{}').rendered === true; } catch { return false; }
  });
  const diagnostics = JSON.parse((await quest.locator('[data-companion-diagnostics] pre').textContent()) ?? '{}');
  report.diagnostics = diagnostics; report.render = rendered;
  assert.equal(diagnostics.secureContext, true); assert.equal(diagnostics.molstar, '5.11.0'); assert.equal(diagnostics.rendered, true);
  const source = await quest.evaluate(async () => {
    const key = sessionStorage.getItem('stereo_structure/page-key') ?? location.hash.slice(1);
    const response = await fetch('/source', { headers: { Authorization: `Bearer ${key}` } });
    const bytes = await response.arrayBuffer(); const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { status: response.status, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''), announced: response.headers.get('x-stereofold-source-sha256') };
  });
  assert.deepEqual(source, { status: 200, sha256: fixtureSha256, announced: fixtureSha256 }); assert.deepEqual(external, []);
  pass('Paired LAN viewer renders 1CRN, verifies secure context/Mol* diagnostics, and reads the source digest without WAN requests');

  // Quest's focused landing UI intentionally keeps the desktop sidebar out of
  // view. Exercise the supported public tour control contract and verify each
  // rendered receipt instead of forcing hidden DOM controls into the test.
  let tourState = await waitReady(sessionId, 'companion', panelId);
  const startTour = 'lan-browser-tour-start';
  await call('control_tour', { ...binding(tourState, sessionId), panelId, commandId: startTour, action: 'start', tourId: 'fold-detective' });
  await waitState(sessionId, state => state.command?.commandId === startTour && state.command?.status === 'rendered', startTour);
  tourState = await waitReady(sessionId, 'companion', panelId, 0);
  const nextTour = 'lan-browser-tour-next';
  await call('control_tour', { ...binding(tourState, sessionId), panelId, commandId: nextTour, action: 'next' });
  await waitState(sessionId, state => state.command?.commandId === nextTour && state.command?.status === 'rendered', nextTour);
  // The ready state at scene 1 is a fresh heartbeat before the Back command.
  tourState = await waitReady(sessionId, 'companion', panelId, 1);
  const backTour = 'lan-browser-tour-back';
  await call('control_tour', { ...binding(tourState, sessionId), panelId, commandId: backTour, action: 'back' });
  await waitState(sessionId, state => state.command?.commandId === backTour && state.command?.status === 'rendered', backTour);
  await waitReady(sessionId, 'companion', panelId, 0);
  pass('Public tour controls render Start, Next, and Back receipts through the paired LAN companion');

  const ready = await waitReady(sessionId, 'companion', panelId);
  const commandId = 'lan-browser-source-update';
  await call('update_inspection', { ...binding(ready, sessionId), panelId, commandId, change: { kind: 'appearance', patch: { background: '#123456', color: 'uniform', uniformColor: '#ff8800' } } });
  await waitState(sessionId, state => state.command?.commandId === commandId && state.command?.status === 'rendered', commandId);
  await quest.waitForFunction(() => (document.querySelector('[data-control="background"]') as HTMLInputElement | null)?.value === '#123456');
  assert.deepEqual(external, []); pass('A source-scoped desktop update renders through the paired LAN companion');

  const lookup = (await call('get_inspection_state', { sessionId, residues: { authorChain: 'A', authorResidueRange: [10, 15], limit: 16 } })).structuredContent.residues;
  assert.equal(lookup.rows.length, 6);
  const selectionKeys = lookup.rows.map((row: any) => row.key);
  const selectionReady = await waitReady(sessionId, 'companion', panelId);
  const inspection = async () => (await call('get_inspection', { sessionId }))._meta['stereo_structure/inspection'];
  const selectionBeforeEdit = (await inspection()).scene.selectionKeys;
  const selectionCommand = 'lan-browser-select-region';
  await call('update_inspection', { ...binding(selectionReady, sessionId), panelId, commandId: selectionCommand,
    change: { kind: 'selection', patch: { selectionKeys } } });
  await waitState(sessionId, state => state.command?.status === 'rendered', selectionCommand);
  const selected = (await call('get_inspection_state', { sessionId, residues: { selectedOnly: true } })).structuredContent.residues;
  assert.deepEqual(selected.rows.map((row: any) => row.key), selectionKeys);
  await captureCanvas(quest, 'lan-orange-selected');
  pass('Text-style selection resolves and renders chain A residues 10 through 15 on the paired companion');

  // Exercise the paired browser's real /tool route. The non-immersive landing
  // page keeps editing controls hidden; immersive menu clicks have their own
  // controller acceptance. Do not bypass the LAN hop through the MCP client.
  const historyOnLan = async (action: 'undo' | 'redo', expectedKeys: string[]) => {
    const before = await inspection();
    const activePanelId = await quest.locator('body').getAttribute('data-panel-id');
    assert.ok(activePanelId);
    const current = await waitReady(sessionId, 'companion', activePanelId);
    const id = `lan-${action}-${current.inspectionRevision}`;
    const result = await quest.evaluate(async ({ name, args }) => {
      const key = sessionStorage.getItem('stereo_structure/page-key') ?? location.hash.slice(1);
      const response = await fetch('/tool', { method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args }) });
      const body = await response.json();
      return { status: response.status, isError: !!body.isError };
    }, { name: action === 'undo' ? 'undo_last_change' : 'redo_last_change',
      args: { ...binding(current, sessionId), panelId: activePanelId, commandId: id } });
    assert.deepEqual(result, { status: 200, isError: false });
    await waitState(sessionId, state => state.inspectionRevision > before.inspectionRevision
      && state.command?.status === 'rendered', id);
    const saved = await inspection();
    assert.deepEqual(saved.scene.selectionKeys, expectedKeys);
  };
  await historyOnLan('undo', selectionBeforeEdit);
  await historyOnLan('redo', selectionKeys);
  pass('The paired HTTPS page restores a selection through the LAN Undo and Redo tool route');

  const commandLatencies: number[] = [];
  for (let index = 0; index < 8; index++) {
    const current = await waitReady(sessionId, 'companion', panelId);
    const id = `lan-latency-${index}`;
    const started = performance.now();
    await call('update_inspection', { ...binding(current, sessionId), panelId, commandId: id,
      change: { kind: 'appearance', patch: { background: index % 2 ? '#123456' : '#102030' } } });
    await waitState(sessionId, state => state.command?.commandId === id && state.command?.status === 'rendered', id);
    commandLatencies.push(Math.round(performance.now() - started));
  }
  const sortedLatencies = [...commandLatencies].sort((a, b) => a - b);
  report.commandLatency = { scope: 'Local HTTPS companion, command call through rendered receipt; no model reasoning or physical Wi-Fi hop.',
    sampleMs: commandLatencies, medianMs: (sortedLatencies[Math.floor((sortedLatencies.length - 1) / 2)]!
      + sortedLatencies[Math.floor(sortedLatencies.length / 2)]!) / 2,
    p95Ms: sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1] };
  pass('Eight consecutive appearance commands receive their own rendered receipts');

  const replacementPath = resolve('../fixtures/4HHB.cif');
  const replacementSha256 = createHash('sha256').update(await readFile(replacementPath)).digest('hex');
  const replacementReady = await waitReady(sessionId, 'companion', panelId);
  const previousCredentialDigest = await credentialDigest(quest);
  const replacement = (await call('replace_inspection_source', { ...binding(replacementReady, sessionId), panelId,
    source: { kind: 'file', path: replacementPath }, waitForRenderMs: 60_000 })).structuredContent;
  assert.equal(replacement.sessionId, sessionId);
  assert.equal(replacement.sourceRenderStatus?.rendered, true);
  const finalReady = await waitReady(sessionId, 'companion', panelId);
  assert.notEqual(finalReady.sourceToken, replacementReady.sourceToken);
  assert.equal(await credentialDigest(quest), previousCredentialDigest);
  const replacementSource = await quest.evaluate(async () => {
    const key = sessionStorage.getItem('stereo_structure/page-key') ?? location.hash.slice(1);
    const response = await fetch('/source', { headers: { Authorization: `Bearer ${key}` } });
    const bytes = await response.arrayBuffer(); const digest = await crypto.subtle.digest('SHA-256', bytes);
    return { status: response.status, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') };
  });
  assert.deepEqual(replacementSource, { status: 200, sha256: replacementSha256 });
  await captureCanvas(quest, 'lan-replaced-4hhb');
  assert.deepEqual(external, []);
  pass('4HHB replaces 1CRN in the same session and paired browser without a second pairing, with a rendered source receipt and exact source digest');

  await quest.reload();
  await quest.bringToFront();
  await quest.locator('body[data-ready="true"]').waitFor();
  await quest.waitForFunction(() => Boolean(document.body.dataset.panelId));
  const reloadedPanelId = await quest.locator('body').getAttribute('data-panel-id'); assert.ok(reloadedPanelId);
  await waitReady(sessionId, 'companion', reloadedPanelId);
  assert.equal(await credentialDigest(quest), previousCredentialDigest);
  pass('Reload restores the paired viewer using its session-stored credential without a new code');

  // Replacement starts a new source history. A fresh edit after reload must
  // be reversible without reviving selection keys from the previous molecule.
  const reloadSelection = (await call('get_inspection_state', { sessionId,
    residues: { authorChain: 'A', authorResidueRange: [10, 12], limit: 8 } })).structuredContent.residues.rows.map((row: any) => row.key);
  assert.equal(reloadSelection.length, 3);
  const reloadCommand = 'lan-after-reload-selection';
  const afterReload = await waitReady(sessionId, 'companion', reloadedPanelId);
  const reloadEdit = (await call('update_inspection', { ...binding(afterReload, sessionId), panelId: reloadedPanelId, commandId: reloadCommand,
    change: { kind: 'selection', patch: { selectionKeys: reloadSelection } } })).structuredContent;
  report.afterReloadAdmission = { wearerBefore: afterReload.wearer, wearerAfter: reloadEdit.wearer,
    status: reloadEdit.command?.status, wearerPaused: reloadEdit.command?.wearerPaused };
  await waitState(sessionId, state => state.command?.status === 'rendered', reloadCommand);
  await historyOnLan('undo', []);
  await historyOnLan('redo', reloadSelection);
  pass('After source replacement and page reload, paired Undo/Redo restore only the new molecule selection');

  // A wearer can stop sharing before returning to the laptop. The desktop
  // must follow the final saved headset scene even after the listener closes.
  const beforeStop = (await call('get_inspection_state', { sessionId })).structuredContent;
  report.desktopReturn = { beforeRevision: beforeStop.inspectionRevision,
    wasBehind: beforeStop.panels.some((panel: any) => panel.surface === 'desktop' && !panel.current) };
  const oldPageKey = await quest.evaluate(() => sessionStorage.getItem('stereo_structure/page-key') ?? location.hash.slice(1));
  await call('manage_companion', { sessionId, serverEpoch: finalReady.serverEpoch, sourceToken: finalReady.sourceToken, action: 'close' });
  await expectReject(() => lanContext!.request.get(`${lanUrl.origin}/source`, { timeout: 15_000,
    headers: { Authorization: `Bearer ${oldPageKey}` } }).catch(() => { throw Error('Authenticated LAN source request failed.'); }));
  await desktop.page.bringToFront();
  const restartReady = await waitReady(sessionId, 'desktop');
  report.desktopReturn.afterRevision = restartReady.inspectionRevision;
  assert.deepEqual((await inspection()).scene.selectionKeys, reloadSelection);
  await captureCanvas(desktop.frame, 'desktop-after-share-stopped');
  pass('Returning to the laptop after Stop renders the final saved headset scene');
  const restarted = (await call('open_companion', { ...binding(restartReady, sessionId), connection: 'lan', lanHost })).structuredContent;
  assert.equal(new URL(restarted.companion.url).origin, lanUrl.origin);
  // APIRequestContext failures include the Authorization header in their call
  // log. Never carry that raw error into the report or console, even after
  // revocation of the temporary page credential.
  const stale = await lanContext.request.get(`${lanUrl.origin}/source`, { headers: { Authorization: `Bearer ${oldPageKey}` } })
    .catch(() => { throw Error('Authenticated LAN source request failed after listener restart.'); });
  assert.equal(stale.status(), 401);
  await quest.goto(restarted.companion.url);
  await quest.waitForURL(url => url.pathname === '/viewer');
  await quest.locator('body[data-ready="true"]').waitFor();
  await quest.waitForFunction(() => Boolean(document.body.dataset.panelId));
  const resumedPanelId = await quest.locator('body').getAttribute('data-panel-id'); assert.ok(resumedPanelId);
  const resumed = await waitReady(sessionId, 'companion', resumedPanelId);
  assert.notEqual(await credentialDigest(quest), previousCredentialDigest);
  assert.equal(await quest.evaluate(() => JSON.parse(localStorage.getItem('stereofold.device') ?? '{}').deviceId), ownedDeviceId);
  pass('Restart rejects the old page credential and automatically reconnects the remembered device with a fresh credential');

  const management = await call('manage_companion', { sessionId, serverEpoch: resumed.serverEpoch, sourceToken: resumed.sourceToken, action: 'status' });
  const paired = management.structuredContent.lan.clients[0]; assert.ok(paired?.id);
  assert.equal(management.structuredContent.lan.clients.length, 1);
  await call('manage_companion', { sessionId, serverEpoch: resumed.serverEpoch, sourceToken: resumed.sourceToken, action: 'revoke', clientId: paired.id });
  const revoked = await quest.evaluate(async () => {
    const key = sessionStorage.getItem('stereo_structure/page-key') ?? location.hash.slice(1);
    return (await fetch('/source', { headers: { Authorization: `Bearer ${key}` } })).status;
  }); assert.equal(revoked, 401);
  await call('manage_companion', { sessionId, serverEpoch: resumed.serverEpoch, sourceToken: resumed.sourceToken, action: 'forget', deviceId: ownedDeviceId });
  const forgotten = (await call('manage_companion', { sessionId, serverEpoch: resumed.serverEpoch, sourceToken: resumed.sourceToken, action: 'status' })).structuredContent;
  assert.ok(!forgotten.rememberedDevices.some((device: any) => device.id === ownedDeviceId));
  ownedDeviceId = undefined;
  pass('Forgetting removes only the remembered device created by this test');
  await call('manage_companion', { sessionId, serverEpoch: resumed.serverEpoch, sourceToken: resumed.sourceToken, action: 'close' });
  await expectReject(() => quest.reload({ waitUntil: 'commit', timeout: 15_000 }));
  pass('Management revokes the paired browser token and Stop closes the owned LAN listener');
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  report.pageAtFailure = await companionPage?.evaluate(() => ({ path: location.pathname,
    ready: document.body.dataset.ready, panelId: document.body.dataset.panelId,
    message: document.body.innerText.slice(0, 1200) })).catch(() => undefined);
  report.desktopAtFailure = await desktopFrame?.evaluate(() => ({ ready: document.body.dataset.ready,
    visible: document.visibilityState, panelId: document.body.dataset.panelId,
    notice: document.querySelector('.session-notice')?.textContent?.slice(0, 1000) })).catch(() => undefined);
  if (ownedSessionId) {
    const state = await call('get_inspection_state', { sessionId: ownedSessionId }).catch(() => undefined);
    report.panelsAtFailure = state?.structuredContent?.panels;
  }
} finally {
  await disposeStep('lanBrowserClosed', () => lanContext?.close() ?? Promise.resolve());
  await disposeStep('desktopBrowserClosed', () => desktopContext?.close() ?? Promise.resolve());
  await disposeStep('browserClosed', () => browser?.close() ?? Promise.resolve());
  if (ownedDeviceId && ownedSessionId) await disposeStep('testDeviceForgotten', async () => {
    const state = (await call('get_inspection_state', { sessionId: ownedSessionId })).structuredContent;
    await call('manage_companion', { sessionId: ownedSessionId, serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
      action: 'forget', deviceId: ownedDeviceId });
  });
  await disposeStep('mcpClosed', () => client.close());
  await disposeStep('privateStoreRemoved', () => rm(privateStore, { recursive: true, force: true }));
  await disposeStep('hostClosed', () => new Promise<void>(resolveClose => host ? host.close(() => resolveClose()) : resolveClose()));
  await disposeStep('reportWritten', () => writeFile(resolve(out, 'lan-browser-report.json'), JSON.stringify(report, null, 2) + '\n'));
  console.log(JSON.stringify(report, null, 2));
}

// Each disposal step is isolated: a throwing browser.close() must not skip the
// MCP child process, the loopback listener, or the report that explains the
// failure this cleanup exists for.
async function disposeStep(step: string, work: () => Promise<unknown>) {
  try { await work(); report.cleanup[step] = true; }
  catch (cleanupError) { report.status = 'failed'; process.exitCode = 1; report.cleanup[step] = false; (report.cleanupErrors ??= []).push(`${step}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
}

async function expectReject(work: () => Promise<unknown>) { let failed = false; try { await work(); } catch { failed = true; } assert.equal(failed, true, 'Expected the stopped LAN listener to reject the request.'); }
