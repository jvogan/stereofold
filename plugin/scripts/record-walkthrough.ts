/** Record real desktop inspector operations against the shipped stdio server.
 * Usage: pnpm --dir plugin exec tsx scripts/record-walkthrough.ts /absolute/new-output
 * Outputs a silent WebM and a local report. The report is not website content.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Frame, type Page } from 'playwright';
import { demoCacheDirectory, readDemoIndex, resolveCoordinates } from './quest-demo.js';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const argument = process.argv[2];
assert.ok(argument && isAbsolute(argument), 'Supply an absolute NEW output directory.');
const out = resolve(argument);
await mkdir(out, { recursive: false });
const report: any = { status: 'failed', scope: 'Scripted desktop inspector; shipped stdio MCP server; public coordinates; no headset session or host-chat recording',
  recordedAt: new Date().toISOString(), node: process.version, sources: ['PDB 1CRN', 'PDB 4HHB', 'PDB 9AX6 biological assembly 1'],
  operations: [], errors: [], cleanup: {} };
try {
  report.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pluginRoot, encoding: 'utf8' }).trim();
  report.workingTreeDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: pluginRoot, encoding: 'utf8' }).trim());
} catch { report.sourceCommit = null; }
report.serverSha256 = createHash('sha256').update(await readFile(resolve(pluginRoot, 'dist/server.mjs'))).digest('hex');
const entry = (await readDemoIndex()).demos.find(item => item.name === 'daraxonrasib');
assert.ok(entry, 'The bundled daraxonrasib lesson must exist.');
const coordinates = await resolveCoordinates(entry, demoCacheDirectory(), message => console.log(message));
report.lessonCoordinateSha256 = entry.coordinates.sha256;
const hostBundle = await build({ entryPoints: [resolve(pluginRoot, 'scripts/inspector-host.ts')], bundle: true,
  format: 'iife', write: false, platform: 'browser', target: 'es2022' });
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#071015;color:#e8fbfa;font:16px/1.4 system-ui}header{height:96px;box-sizing:border-box;padding:15px 28px;border-bottom:1px solid #38585d}
small{color:#a4c4c8;font-size:14px}h1{font-size:22px;margin:7px 0 0}iframe{display:block;border:0;width:1280px;height:704px}
</style></head><body><header><small>Stereofold · Scripted desktop recording · Real local MCP server</small><h1 id="step">Opening crambin · PDB 1CRN</h1></header>
<iframe title="Stereofold inspector"></iframe><script>${hostBundle.outputFiles[0].text.replace(/<\/script/giu, '<\\/script')}</script></body></html>`;
const listener = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); });
await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(listener.address() as any).port}`;
const client = new Client({ name: 'Stereofold desktop walkthrough', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(pluginRoot, 'dist/server.mjs')],
  cwd: pluginRoot, env: { STEREOFOLD_REPLY_AUDIO: '0', STEREOFOLD_PTT_TRANSCRIBE: '0' }, stderr: 'pipe' });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Page | undefined;
let frame: Frame | undefined;
let sessionId = '';
const call = async (name: string, args: Record<string, unknown>) => {
  const answer: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!answer.isError, `Tool ${name} failed: ${JSON.stringify(answer)}`);
  return answer;
};
const state = async () => (await call('get_inspection_state', { sessionId })).structuredContent;
async function waitReady() {
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    const value = await state();
    if (value.hasScene && value.panels.some((panel: any) => panel.current && panel.availability === 'ready')) return value;
    await new Promise(done => setTimeout(done, 150));
  }
  throw Error('The inspector did not draw and save its scene.');
}
async function command(name: string, args: Record<string, unknown>) {
  const commandId = randomUUID();
  const answer = await call(name, { sessionId, ...args, commandId, waitForRenderMs: 60_000 });
  let value = answer.structuredContent;
  const until = Date.now() + 180_000;
  if (name === 'replace_inspection_source') {
    while (!value.sourceRenderStatus?.rendered && !value.sourceRenderReceipt?.rendered) {
      const refusal=value.sourceRenderStatus?.status==='failed'?value.sourceRenderStatus:value.sourceRenderReceipt;
      if(refusal?.status==='failed') throw Error(String(refusal.failureReason??refusal.reason??'The renderer refused this source.'));
      assert.ok(Date.now() < until, 'Timed out waiting for source replacement to render.');
      await new Promise(done => setTimeout(done, 150));
      value = await state();
    }
    const current = await waitReady();
    const receipt = value.sourceRenderStatus?.rendered ? value.sourceRenderStatus : value.sourceRenderReceipt;
    report.operations.push({ tool: name, arguments: args, receipt: 'rendered', revision: current.inspectionRevision,
      sourceReceipt: { status: receipt.status, rendered: true } });
    return;
  }
  while (value.command?.status === 'queued' || value.command?.status === 'rendering') {
    assert.ok(Date.now() < until, 'Timed out waiting for a rendered receipt.');
    await new Promise(done => setTimeout(done, 150));
    value = (await call('get_inspection_state', { sessionId, commandId })).structuredContent;
  }
  assert.equal(value.command?.status, 'rendered', `The ${name} operation must render.`);
  const current = await waitReady();
  assert.equal(value.command.renderedRevision, current.inspectionRevision);
  report.operations.push({ tool: name, arguments: args, receipt: 'rendered', revision: value.command.renderedRevision });
}
async function caption(text: string) {
  await page!.locator('#step').evaluate((element, text) => { element.textContent = text; }, text);
}
async function hold(seconds: number) { await page!.waitForTimeout(seconds * 1000); }
async function mount(opened: any) {
  sessionId = opened.structuredContent.sessionId;
  await page!.evaluate(({ resource, result }) => (window as any).__host.mount(resource, result,
    { theme: 'dark', containerDimensions: { maxWidth: 1280, maxHeight: 704 } }),
  { resource: ((await client.readResource({ uri: 'ui://stereo-structure/inspector' })).contents[0] as any).text, result: opened });
  frame = page!.frames().find(candidate => candidate !== page!.mainFrame());
  assert.ok(frame);
  await frame.locator('body[data-ready="true"]').waitFor({ state: 'attached' });
  await waitReady();
}
try {
  await client.connect(transport);
  const opened = await call('inspect', { pdbId: '1CRN' });
  browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
    recordVideo: { dir: resolve(out, 'raw'), size: { width: 1280, height: 800 } } });
  page = await context.newPage();
  page.setDefaultTimeout(180_000);
  await page.addInitScript({ content: 'globalThis.__name = value => value;' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.exposeFunction('__call', (payload: any) => client.callTool({ name: payload.name, arguments: payload.arguments ?? {} }));
  await page.goto(origin);
  await mount(opened);
  await command('update_inspection', { change: { kind: 'appearance', patch: { color: 'uniform', uniformColor: '#65c7c1' } } });
  await hold(8);
  await caption('Crambin · Color chain A residues 10–15 orange');
  await command('update_inspection', { change: { kind: 'appearance', residues: { labelChain: 'A', authorResidueRange: [10, 15] }, patch: { color: 'uniform', uniformColor: '#ff8800' } } });
  await hold(8);
  await caption('Crambin · Inspect atomic detail with ball-and-stick');
  await command('update_inspection', { change: { kind: 'appearance', patch: { representation: 'ball-and-stick' } } });
  await hold(7);
  await caption('Same session · Replace crambin with hemoglobin · PDB 4HHB');
  const originalSession = sessionId;
  await command('replace_inspection_source', { pdbId: '4HHB' });
  assert.equal(sessionId, originalSession);
  assert.match(await frame!.locator('.scene-heading').innerText(), /4HHB/u);
  await hold(9);
  await caption('Hemoglobin · Highlight hemes and soften the protein context');
  await command('update_inspection', { change: { kind: 'compound', patch: { ops: [
    { kind: 'appearance', patch: { opacity: 0.35 } },
    { kind: 'appearance', residues: { componentId: 'HEM' }, patch: { representation: 'ball-and-stick', color: 'uniform', uniformColor: '#ff8800', opacity: 1 } },
  ] } } });
  await hold(9);
  await caption('Bundled daraxonrasib lesson · PDB 9AX6 · Assembly 1');
  await mount(await call('inspect_lesson', { filePath: coordinates, lessonPath: resolve(pluginRoot, 'demos', entry.lesson), assemblyId: '1' }));
  await command('control_tour', { action: 'next' });
  await hold(11);
  await caption('Daraxonrasib lesson · Next chapter: inspect the interface');
  await command('control_tour', { action: 'next' });
  await hold(11);
  await caption('Daraxonrasib lesson · Back restores the overview');
  await command('control_tour', { action: 'back' });
  await hold(8);
  await page.screenshot({ path: resolve(out, 'poster.png') });
  assert.deepEqual(report.errors, []);
  const image = await frame!.locator('.stage canvas').screenshot();
  assert.ok(image.length > 1000, 'The final molecular canvas must be nonempty.');
  report.finalCanvasSha256 = createHash('sha256').update(image).digest('hex');
  await frame!.locator('.header-menu > summary').click();
  const [preview] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    frame!.getByRole('button', { name: 'Capture preview · 10 s', exact: true }).click({ timeout: 15_000 }),
  ]);
  assert.equal(await preview.failure(), null, 'The canvas preview must download successfully.');
  await preview.saveAs(resolve(out, 'canvas-preview.webm'));
  const previewBytes = await readFile(resolve(out, 'canvas-preview.webm'));
  assert.ok(previewBytes.length > 1000, 'The ten-second canvas preview must be nonempty.');
  report.canvasPreview = { file: 'canvas-preview.webm', bytes: previewBytes.length,
    sha256: createHash('sha256').update(previewBytes).digest('hex'), scope: 'Silent desktop molecular canvas' };
  assert.deepEqual(report.errors, [], 'Recording must not introduce a page error.');
  const afterPreview = await frame!.locator('.stage canvas').screenshot();
  report.canvasPreview.sceneUnchanged = createHash('sha256').update(afterPreview).digest('hex') === report.finalCanvasSha256;
  assert.ok(report.canvasPreview.sceneUnchanged, 'Recording a stationary scene must not change its pixels.');
  const video = page.video();
  await context.close();
  assert.ok(video);
  await video.saveAs(resolve(out, 'walkthrough.webm'));
  report.status = 'passed';
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  for (const [name, cleanup] of [
    ['browserClosed', async () => { await browser?.close(); }],
    ['mcpClosed', async () => { await client.close(); await transport.close(); }],
    ['listenerClosed', async () => { await new Promise<void>(done => listener.close(() => done())); }],
  ] as const) {
    try { await cleanup(); report.cleanup[name] = true; }
    catch (error) { report.cleanup[name] = false; report.errors.push(String(error)); }
  }
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, operations: report.operations.length, cleanup: report.cleanup }));
}
