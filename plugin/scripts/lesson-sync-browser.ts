import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Frame, type Page } from 'playwright';
import { redactTokens, requestRoute, scrubSecrets } from './report-redaction.js';
// @ts-ignore Production metadata admission predicate, used read-only by the harness.
import { canRestoreLessonPlaybackMetadata } from '../../lab/browser-roundtrip/lesson-playback-restore.mjs';

// Run from plugin/: pnpm exec tsx scripts/lesson-sync-browser.ts /fresh/artifact-dir
// Real packaged MCP/AppBridge/Mol* desktop peers. No XR, physical headset, or speech.
const outArg = process.argv[2];
assert.ok(outArg, 'Supply a fresh artifact directory outside the repository.');
const out = resolve(outArg);
await mkdir(out, { recursive: false });
const report: any = { status: 'failed', scope: 'Two Chromium desktop AppBridge panels, local 1CRN, isolated MCP scene service; no XR or physical-device evidence.',
  cases: [], errors: [], externalRequests: [], appCalls: [], cleanup: {} };
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const pass = (label: string) => { report.cases.push(label); console.log(`Passed: ${label}`); };
const client = new Client({ name: 'Stereofold two-peer lesson acceptance', version: '1' });
const secrets: string[] = [], sceneService = resolve(out, 'scene-service.json');
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.mjs')], cwd: process.cwd(),
  env: { STEREOFOLD_REPLY_AUDIO: '0', STEREOFOLD_PTT_TRANSCRIBE: '0', STEREOFOLD_SCENE_SERVICE: sceneService }, stderr: 'pipe' });
let stderr = '', browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, host: ReturnType<typeof createServer> | undefined;
let sessionId = '', origin = '', html = '', opened: any;
const peers: { name: string; page: Page; frame: Frame; offline: boolean; panelId: string }[] = [];
transport.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-32_768); });
const call = async (name: string, args: any) => {
  const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!result.isError, `${name}: ${redactTokens(String(result.content?.[0]?.text ?? 'failed'))}`); return result;
};
const inspection = async () => (await call('get_inspection', { sessionId }))._meta['stereo_structure/inspection'];
const state = async () => (await call('get_inspection_state', { sessionId })).structuredContent;
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 30_000): Promise<T> {
  const end = Date.now() + timeout;
  let last: T;
  do { last = await read(); if (predicate(last)) return last; await sleep(150); } while (Date.now() < end);
  throw Error(`Timed out: ${label}. Last: ${redactTokens(JSON.stringify(last!).slice(0, 3000))}`);
}
const expected = (data: any) => ({ sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
  baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision });
async function saveScene(data: any, scene: any) {
  const result = await call('sync_inspection', { ...expected(data), scene });
  assert.equal(result.structuredContent.saved, true, redactTokens(JSON.stringify(result.structuredContent)));
  return await inspection();
}
async function bothAt(step: number, narration = false, active = true) {
  const value = await until(state, s => peers.every(p => s.panels.some((entry: any) => entry.panelId === p.panelId
    && entry.current && entry.availability === 'ready' && entry.tour?.step === step && entry.tour?.active === active
    && entry.tour?.autoplay === false && (step < 0 || entry.tour?.narration === narration))), `both live cursors at ${step}`);
  report.panels = value.panels.map((p: any) => ({ panelId: p.panelId, current: p.current, availability: p.availability, inspectionRevision: p.inspectionRevision, tour: p.tour }));
  return value;
}
async function command(peer: typeof peers[number], action: string, extra: any = {}) {
  await until(state, s => s.panels.some((p: any) => p.panelId === peer.panelId && p.current && p.availability === 'ready'), `${peer.name} command admission`);
  const result = await call('control_tour', { sessionId, panelId: peer.panelId, action, ...extra, waitForRenderMs: 10_000 });
  const receipt = result.structuredContent.command;
  if (receipt?.status !== 'rendered') await until(async () => (await call('get_inspection_state', { sessionId, commandId: receipt.commandId })).structuredContent,
    s => s.command?.status === 'rendered', `${action} receipt`);
}
async function appearanceCount(peer: typeof peers[number]) {
  return await peer.frame.evaluate(() => ((globalThis as any).__stereofoldDiagnostics?.entries?.() ?? []).filter((entry: any) => entry.kind === 'appearance-cost').length);
}
function differencePaths(a: any, b: any, path = ''): string[] {
  if (a === b) return [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return [path];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => differencePaths(a[key], b[key], path ? `${path}.${key}` : key));
}
async function mount(name: string) {
  const page = await browser!.newPage({ viewport: { width: 1100, height: 780 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30_000);
  await page.addInitScript({ content: 'globalThis.__name = value => value;' });
  const recorder = await build({ stdin: { contents: `import { resetHeadsetDiagnostics, installHeadsetDiagnostics } from './lab/browser-roundtrip/headset-diagnostics.mjs'; resetHeadsetDiagnostics({limit:2000}); installHeadsetDiagnostics();`, resolveDir: resolve('..') },
    bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
  await page.addInitScript({ content: recorder.outputFiles[0].text });
  page.on('pageerror', error => report.errors.push({ peer: name, message: redactTokens(error.message) }));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/')) return route.continue();
    report.externalRequests.push(requestRoute(url)); return route.abort();
  });
  const peer = { name, page, frame: undefined as unknown as Frame, offline: false, panelId: '' };
  await page.exposeFunction('__call', async (payload: any) => {
    if (peer.offline) throw Error('Synthetic peer transport disconnect.');
    assert.ok(!payload.name.endsWith('.voice_acknowledgement'), 'Acceptance must not request narration.');
    const response: any = await client.callTool({ name: payload.name, arguments: payload.arguments ?? {} });
    if (payload.name.endsWith('.attach_inspection') && response.structuredContent?.panelId) peer.panelId = response.structuredContent.panelId;
    if (payload.name.endsWith('.sync_inspection') || payload.name.endsWith('.poll_inspection')) report.appCalls.push({ peer: name,
      name: payload.name, sentRevision: payload.arguments?.baseInspectionRevision, revision: response.structuredContent?.inspectionRevision,
      cursor: payload.arguments?.tourState, saved: response.structuredContent?.saved, conflict: response.structuredContent?.conflict,
      isError: response.isError === true });
    return response;
  });
  const load = async () => {
    await page.goto(origin);
    await page.evaluate(({ html, opened }) => (window as any).__host.mount(html, opened, { theme: 'dark' }), { html, opened });
    peer.frame = page.frames().find(candidate => candidate !== page.mainFrame())!;
    assert.ok(peer.frame); await peer.frame.locator('body[data-ready="true"]').waitFor();
    assert.equal(await peer.frame.evaluate(() => typeof (globalThis as any).__stereofoldDiagnostics?.entries), 'function',
      'The actual diagnostics hook must expose its entries reader');
    await until(async () => peer.panelId, Boolean, `${name} registration`);
  };
  await load(); peers.push(peer);
  return { peer, reload: async () => { peer.panelId = ''; await load(); } };
}

try {
  await client.connect(transport);
  report.serverSha256 = hash(await readFile(resolve('dist/server.mjs')));
  opened = await call('inspect', { structureText: await readFile(resolve('../fixtures/1CRN.cif'), 'utf8') });
  sessionId = opened.structuredContent.sessionId;
  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  html = (resource.contents[0] as any).text;
  report.inspectorSha256 = hash(html);
  // Read the public workspace capture without changing it or bypassing any
  // scene admission. The marker must identify exactly one compiled accessor.
  const captureAccessor = /capture:([$\w]+),restore:\(/g;
  assert.equal([...html.matchAll(captureAccessor)].length, 1, 'Expected one compiled workspace capture accessor');
  html = html.replace(captureAccessor, 'capture:(globalThis.__stereofoldPeerCapture=$1,$1),restore:(');
  report.instrumentation = 'Test-only read-only workspace capture accessor in served HTML; distributed files unchanged.';
  const bundle = await build({ entryPoints: [resolve('scripts/inspector-host.ts')], bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
  const hostHtml = `<!doctype html><html><body style="margin:0"><iframe style="border:0;width:100vw;height:100vh"></iframe><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  host = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(hostHtml); });
  await new Promise<void>(done => host!.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(host.address() as any).port}`;
  browser = await chromium.launch({ headless: true }); report.browserVersion = browser.version();
  const a = await mount('a');
  await until(inspection, data => !!data.scene, 'first rendered scene');
  // Existing rendered panel means no automatic browser launch. Loopback starts
  // the shared revision protocol without pairing or touching any headset.
  const shareArgs = { sessionId, connection: 'loopback', launch: 'none', headset: 'auto', waitForSceneMs: 0 };
  const shared = await until(() => call('open_companion', shareArgs), result => !!result.structuredContent?.companion,
    'loopback share setup', 45_000);
  const link = shared.structuredContent?.companion?.url;
  if (link) { const parsed = new URL(link); secrets.push(parsed.hash.slice(1)); parsed.searchParams.forEach(value => secrets.push(value)); }
  assert.equal((await inspection()).shared, true);
  const b = await mount('b');
  await bothAt(-1, false, false);
  await command(a.peer, 'start', { tourId: 'fold-detective', autoplay: false, narration: false });
  await bothAt(0);
  pass('A real lesson start reaches both live player cursors with autoplay and narration off');

  const beforeMetadata = await inspection();
  const costBefore = await Promise.all(peers.map(appearanceCount));
  assert.ok(costBefore.every(count => count > 0), 'Both renderers must record real appearance work before checking the shortcut');
  const stopped = structuredClone(beforeMetadata.scene);
  stopped.inspection.lessonPlayback.stopped = true;
  stopped.inspection.lessonPlayback.narration = true;
  report.metadataAdmission = { serverScene: beforeMetadata.scene, incoming: stopped, peers: await Promise.all(peers.map(async peer => {
    const capture = await peer.frame.evaluate(() => (globalThis as any).__stereofoldPeerCapture());
    return { peer: peer.name, capture, differencesAgainstServer: differencePaths(capture, beforeMetadata.scene),
      canRestoreMetadata: canRestoreLessonPlaybackMetadata(capture, stopped), appearanceCount: await appearanceCount(peer) };
  })) };
  const stoppedSaved = await saveScene(beforeMetadata, stopped);
  await bothAt(0, true, false);
  assert.deepEqual(await Promise.all(peers.map(appearanceCount)), costBefore, 'Status-only peer updates must not rebuild appearance');
  assert.deepEqual((await inspection()).scene.inspection.lessonPlayback, stopped.inspection.lessonPlayback);
  pass('Stop/narration metadata reaches both live players without appearance work or speech');

  const stale = await call('sync_inspection', { ...expected(beforeMetadata), scene: beforeMetadata.scene });
  assert.equal(stale.structuredContent.conflict, true);
  assert.equal((await inspection()).inspectionRevision, stoppedSaved.inspectionRevision);
  pass('A stale pre-stop save cannot overwrite the new shared cursor');

  const resumed = structuredClone(stopped);
  resumed.inspection.lessonPlayback.stopped = false;
  resumed.inspection.lessonPlayback.narration = false;
  await saveScene(await inspection(), resumed); await bothAt(0);
  const priorCost = await appearanceCount(b.peer);
  const retryableNext = { sessionId, commandId: 'peer-retry-next', action: 'next', waitForRenderMs: 10_000 };
  const firstNext = await call('control_tour', retryableNext);
  await bothAt(1);
  const firstReceipt = await until(async () => (await call('get_inspection_state', { sessionId, commandId: retryableNext.commandId })).structuredContent,
    s => s.command?.status === 'rendered', 'first retryable Next receipt');
  assert.equal(firstNext.structuredContent.command.commandId, retryableNext.commandId);
  assert.ok(await appearanceCount(b.peer) > priorCost, 'A real chapter visual change must render');
  pass('A visual chapter update renders on the peer and reconciles its cursor');
  await command(b.peer, 'next'); await bothAt(2);
  pass('Next from the following panel advances the shared chapter, not its old cursor');

  const beforeReplay = await inspection(), replayCost = await Promise.all(peers.map(appearanceCount));
  const replay = await call('control_tour', retryableNext);
  assert.equal(replay.structuredContent.commandReplay.currentSource, true);
  assert.equal(replay.structuredContent.command.commandId, retryableNext.commandId);
  assert.equal(replay.structuredContent.command.status, 'rendered');
  assert.equal(replay.structuredContent.command.renderedRevision, firstReceipt.command.renderedRevision);
  await bothAt(2);
  await sleep(1_000);
  assert.equal((await inspection()).inspectionRevision, beforeReplay.inspectionRevision);
  assert.deepEqual((await inspection()).scene, beforeReplay.scene);
  assert.deepEqual(await Promise.all(peers.map(appearanceCount)), replayCost);
  report.commandReplay = { commandId: retryableNext.commandId, originalRenderedRevision: firstReceipt.command.renderedRevision,
    currentRevision: beforeReplay.inspectionRevision, currentChapter: beforeReplay.scene.inspection.lessonPlayback.chapterId };
  pass('An exact implicit Next retry returns its original receipt without advancing either peer or repainting');

  b.peer.offline = true;
  const retry = b.peer.frame.getByRole('button', { name: 'Retry', exact: true });
  await retry.waitFor({ state: 'visible' });
  await command(a.peer, 'next');
  const disconnected = await inspection();
  assert.equal(disconnected.scene.inspection.lessonPlayback.chapterId, 'fold-detective-04');
  b.peer.offline = false;
  await retry.click();
  await bothAt(3);
  pass('A disconnected desktop peer catches up after reconnect and its visible Retry action');
  await b.reload(); await bothAt(3);
  assert.equal((await inspection()).scene.inspection.lessonPlayback.chapterId, disconnected.scene.inspection.lessonPlayback.chapterId);
  pass('Reload restores the held chapter without narration or autoplay');
  await command(a.peer, 'done'); await bothAt(-1, false, false);
  assert.equal((await inspection()).scene.inspection.lessonPlayback, undefined);
  const finalRevision = (await inspection()).inspectionRevision;
  await sleep(2_500);
  assert.equal((await inspection()).inspectionRevision, finalRevision, 'Idle peers must not resurrect the finished cursor');
  pass('Done clears both player cursors and stays cleared across later polls');
  const bothRepresentations = async (representation: string) => {
    await until(inspection, data => data.scene.inspection.appearance.representation === representation,
      `shared scene saved ${representation}`);
    await until(state, s => peers.every(peer => s.panels.some((p: any) => p.panelId === peer.panelId
      && p.current && p.availability === 'ready')), 'both scene editors caught up');
    for (const peer of peers) await until(async () => peer.frame.evaluate(() => {
      try { return (globalThis as any).__stereofoldPeerCapture().inspection.appearance.representation; }
      catch (error) {
        if ((error as Error).message === 'A molecular change is still rendering.') return undefined;
        throw error;
      }
    }),
      value => value === representation, `${peer.name} shows ${representation}`);
    assert.equal((await inspection()).scene.inspection.appearance.representation, representation);
  };
  const originalStyle = (await inspection()).scene.inspection.appearance.representation;
  const editStyle = originalStyle === 'ball-and-stick' ? 'spacefill' : 'ball-and-stick';
  const edit = await call('update_inspection', { sessionId, panelId: a.peer.panelId,
    change: { kind: 'appearance', patch: { representation: editStyle } }, waitForRenderMs: 10_000 });
  const editReceipt = edit.structuredContent.command;
  if (editReceipt.status !== 'rendered') await until(async () =>
    (await call('get_inspection_state', { sessionId, commandId: editReceipt.commandId })).structuredContent,
    value => value.command?.status === 'rendered', 'agent appearance edit receipt');
  await bothRepresentations(editStyle);
  pass('An agent appearance edit reaches both peer renderers and shared history');
  const historyFrom = async (peer: typeof peers[number], action: 'undo' | 'redo', style: string) => {
    const revision = (await inspection()).inspectionRevision;
    await peer.frame.locator(`[data-action="${action}"]`).click();
    await until(inspection, data => data.inspectionRevision > revision
      && data.scene.inspection.appearance.representation === style, `${peer.name} ${action} saved`);
    await bothRepresentations(style);
  };
  await historyFrom(b.peer, 'undo', originalStyle);
  await historyFrom(a.peer, 'redo', editStyle);
  pass('Undo from the following peer and Redo from the first peer restore the shared scene');
  await historyFrom(b.peer, 'undo', originalStyle);
  const exploreControls = a.peer.frame.getByRole('button', { name: 'Explore controls', exact: true });
  if (await exploreControls.isVisible()) await exploreControls.click();
  const toolsButton = a.peer.frame.locator('[data-action="toggle-inspector"]');
  if (await toolsButton.isVisible() && await toolsButton.getAttribute('aria-expanded') !== 'true') await toolsButton.click();
  const freshStyle = ['cartoon', 'ball-and-stick', 'spacefill'].find(style => style !== originalStyle && style !== editStyle)!;
  await a.peer.frame.locator('[data-control="representation"]').selectOption(freshStyle);
  await bothRepresentations(freshStyle);
  await until(state, s => s.history.redoCount === 0, 'fresh manual edit clears shared redo');
  for (const peer of peers) await until(() => peer.frame.locator('[data-action="redo"]').isDisabled(), Boolean,
    `${peer.name} disables discarded redo`);
  pass('A manual style change clears Redo in both visible peer menus');
  await b.reload(); await bothRepresentations(freshStyle);
  await historyFrom(b.peer, 'undo', originalStyle);
  pass('A reloaded peer retains shared Undo and restores the prior style on both renderers');
  for (const peer of peers) {
    await peer.page.screenshot({ path: resolve(out, `${peer.name}-final.png`) });
    await writeFile(resolve(out, `${peer.name}-diagnostics.json`), JSON.stringify(scrubSecrets(await peer.frame.evaluate(() => (globalThis as any).__stereofoldDiagnostics?.entries?.() ?? []), secrets), null, 2));
  }
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.failure = redactTokens(String((error as Error)?.stack ?? error)); process.exitCode = 1;
  for (const peer of peers) {
    report[`${peer.name}Notice`] = (await peer.frame.locator('.session-notice').allTextContents().catch(() => [])).map(redactTokens);
    report[`${peer.name}FailureCapture`] = await peer.frame.evaluate(() => (globalThis as any).__stereofoldPeerCapture?.()).catch(() => undefined);
    await writeFile(resolve(out, `${peer.name}-failure-diagnostics.json`), JSON.stringify(scrubSecrets(await peer.frame.evaluate(() => (globalThis as any).__stereofoldDiagnostics?.entries?.() ?? []).catch(() => []), secrets), null, 2));
    await peer.page.screenshot({ path: resolve(out, `${peer.name}-failure.png`) }).catch(() => {});
  }
} finally {
  const cleanup = async (key: string, action: () => Promise<unknown>) => {
    try { await action(); report.cleanup[key] = true; }
    catch (error) { report.cleanup[key] = redactTokens(String(error)); process.exitCode = 1; }
  };
  await cleanup('browserClosed', async () => browser?.close());
  await cleanup('clientClosed', () => client.close()); await cleanup('serverClosed', () => transport.close());
  await cleanup('hostClosed', () => new Promise<void>(done => host ? host.close(() => done()) : done()));
  await cleanup('privateRegistryRemoved', () => rm(sceneService, { force: true }));
  await writeFile(resolve(out, 'server-stderr.txt'), redactTokens(stderr));
  await writeFile(resolve(out, 'report.json'), JSON.stringify(scrubSecrets(report, secrets), null, 2));
  console.log(`Report: ${resolve(out, 'report.json')}`);
}
