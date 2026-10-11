/**
 * Card-size screenshots of the packaged inspector.
 *
 * Mounts `dist/inspector.html` through the emulated MCP Apps host
 * (`scripts/inspector-host.ts`) at five card sizes and themes, loads the offline
 * 1CRN fixture, screenshots each card and measures the vertical layout so the
 * stage's position and visible height can be compared before and after a change.
 *
 *   cd plugin && npx tsx scripts/card-screenshots.ts <out-dir>   # must not exist
 *
 * The run exits 0 even when a case fails to reach `body[data-ready="true"]`; a
 * nonzero exit means the harness itself broke. Nothing is fetched from the
 * network: every non-origin request is aborted and recorded.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Page, type Frame } from 'playwright';

const out = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Supply a fresh artifact directory');
await mkdir(out, { recursive: false });

const READY_CAP_MS = 60_000;
const SETTLE_MS = 1_000;
const distHtml = resolve('dist/inspector.html');
const distServer = resolve('dist/server.mjs');
const fixture = resolve('../fixtures/1CRN.cif');

type Case = {
  name:string; note:string; theme:'light'|'dark'; width:number; height:number;
};
const CASES:Case[] = [
  { name: '01-700x490-light', note: 'Codex inline chat card today', theme: 'light', width: 700, height: 490 },
  { name: '02-700x720-light', note: 'inline card at the requested 720 px', theme: 'light', width: 700, height: 720 },
  { name: '03-440x720-dark', note: 'Codex side-panel card', theme: 'dark', width: 440, height: 720 },
  { name: '04-1100x720-dark', note: 'harness default', theme: 'dark', width: 1100, height: 720 },
  { name: '05-1450x720-light', note: 'wide Codex window', theme: 'light', width: 1450, height: 720 },
];

const SELECTORS = [
  '.app-header', '.scene-heading', '.readiness-strip', '.session-outcome',
  '.stage', '.stage canvas', '.inspector', '.sequence-panel', '.app-footer',
  '.mobile-tabs', '.header-menu',
];

/**
 * Source string, not a function: tsx compiles with keep-names and injects a
 * `__name` helper that does not exist inside the frame, so any named inner
 * function evaluated there throws `ReferenceError: __name is not defined`.
 */
const measureSource = `(()=>{
  const selectors=${JSON.stringify(SELECTORS)};
  const round=(value)=>Math.round(value*100)/100;
  const elements={};
  for(const selector of selectors) {
    const element=document.querySelector(selector);
    if(!element) {elements[selector]={top:0,bottom:0,left:0,width:0,height:0,visible:false,present:false};continue;}
    const rect=element.getBoundingClientRect();
    const style=getComputedStyle(element);
    elements[selector]={
      top:round(rect.top+window.scrollY),
      bottom:round(rect.bottom+window.scrollY),
      left:round(rect.left+window.scrollX),
      width:round(rect.width),
      height:round(rect.height),
      visible:rect.width>0 && rect.height>0 && style.visibility!=='hidden' && style.display!=='none',
      present:true,
    };
  }
  const text=(selector)=>{const element=document.querySelector(selector);return element?(element.innerText||element.textContent||'').trim():null;};
  return {
    scrollHeight:document.documentElement.scrollHeight,
    scrollWidth:document.documentElement.scrollWidth,
    innerHeight:window.innerHeight,
    innerWidth:window.innerWidth,
    bodyDataset:{...document.body.dataset},
    htmlTheme:document.documentElement.dataset.theme??null,
    sessionOutcomeText:text('.session-outcome'),
    readinessStripText:text('.readiness-strip'),
    elements,
  };
})()`;

const report:any = {
  status: 'failed',
  host: 'emulated MCP Apps AppBridge (scripts/inspector-host.ts) with a real dist/server.mjs over stdio; the actual Codex host is not exercised',
  dist: distHtml,
  fixture,
  readyCapMs: READY_CAP_MS,
  cases: [],
  cleanup: {},
};

const client = new Client({ name: 'Stereofold card screenshots', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [distServer], cwd: process.cwd(), stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', c => { stderr += String(c); });

const hostBundle = await build({ entryPoints: [resolve('scripts/inspector-host.ts')], bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
const hostHtml = `<!doctype html><html><body style="margin:0;background:#071015"><iframe title="Stereofold" style="border:0;width:100vw;height:100vh"></iframe><script>${hostBundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
const http = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(hostHtml); });
await new Promise<void>(r => http.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(http.address() as any).port}`;

let browser:Awaited<ReturnType<typeof chromium.launch>> | undefined;
const call = async (name:string, args:any) => {
  const result:any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result));
  return result;
};

async function canvasCensus(page:Page, frame:Frame) {
  const canvas = frame.locator('.stage canvas');
  if (await canvas.count() === 0) return null;
  const png = await canvas.screenshot();
  return page.evaluate(async base64 => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    const canvasEl = document.createElement('canvas');
    canvasEl.width = img.width; canvasEl.height = img.height;
    const ctx = canvasEl.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, img.width, img.height).data;
    const background = [...pixels.slice(0, 3)];
    let foreground = 0;
    for (let i = 0; i < pixels.length; i += 4) if (background.some((c, k) => Math.abs(c - pixels[i + k]) > 10)) foreground++;
    return { background, foreground, width: img.width, height: img.height };
  }, png.toString('base64'));
}

try {
  await client.connect(transport);
  const cif = await readFile(fixture, 'utf8');
  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  const html = (resource.contents[0] as any).text as string;
  report.inspectorBytes = Buffer.byteLength(html, 'utf8');
  browser = await chromium.launch({ headless: true });
  report.browserVersion = browser.version();

  for (const testCase of CASES) {
    const startedAt = Date.now();
    const errors:string[] = [];
    const externalRequests:string[] = [];
    const containerDimensions = { maxWidth: testCase.width, maxHeight: testCase.height };
    const entry:any = {
      case: testCase.name, note: testCase.note, theme: testCase.theme,
      viewport: { width: testCase.width, height: testCase.height },
      containerDimensions, errors, externalRequests, timings: {},
    };
    report.cases.push(entry);
    let page:Page | undefined;
    try {
      const openedAt = Date.now();
      const opened = await call('inspect', { structureText: cif });
      entry.timings.openMs = Date.now() - openedAt;
      entry.sessionId = opened.structuredContent.sessionId;

      page = await browser.newPage({ viewport: { width: testCase.width, height: testCase.height }, deviceScaleFactor: 1 });
      page.setDefaultTimeout(READY_CAP_MS);
      page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(origin)) return route.continue();
        externalRequests.push(url);
        return route.abort();
      });
      await page.exposeFunction('__call', async (p:any) => client.callTool({ name: p.name, arguments: p.arguments ?? {} }));
      await page.goto(origin);
      const mountedAt = Date.now();
      await page.evaluate(
        ({ html, opened, context }) => (window as any).__host.mount(html, opened, context),
        { html, opened, context: { theme: testCase.theme, containerDimensions } },
      );
      const frame = page.frames().find(f => f !== page!.mainFrame())!;
      try {
        await frame.locator('body[data-ready="true"]').waitFor({ state: 'attached', timeout: READY_CAP_MS });
        entry.ready = true;
      } catch (error) {
        entry.ready = false;
        errors.push(`ready timeout after ${READY_CAP_MS} ms: ${(error as Error).message.split('\n')[0]}`);
      }
      entry.timings.readyMs = Date.now() - mountedAt;
      await page.waitForTimeout(SETTLE_MS);

      const file = `${testCase.name}.png`;
      await page.screenshot({ path: resolve(out, file), fullPage: false });
      entry.screenshot = file;

      const measurements = await frame.evaluate<any>(measureSource);
      entry.measurements = measurements;
      const stage = measurements.elements['.stage'];
      entry.stageTop = stage.top;
      entry.stageVisibleHeight = Math.max(0, Math.min(stage.bottom, measurements.innerHeight) - Math.max(stage.top, 0));
      entry.documentOverflows = measurements.scrollHeight > measurements.innerHeight;
      entry.scrollOverflowPx = Math.max(0, measurements.scrollHeight - measurements.innerHeight);

      // Scrolls the stage into view, so it runs after the rect measurements.
      entry.canvas = await canvasCensus(page, frame);
    } catch (error) {
      errors.push((error as Error).stack ?? String(error));
      entry.ready ??= false;
    } finally {
      entry.timings.totalMs = Date.now() - startedAt;
      await page?.close().catch(() => {});
    }
  }

  report.status = report.cases.every((c:any) => c.ready && c.errors.length === 0) ? 'passed' : 'failed';
} catch (error) {
  report.failure = (error as Error).stack;
  report.stderr = stderr;
  throw error;
} finally {
  await browser?.close().catch(() => {});
  report.cleanup.browserClosed = true;
  await client.close().catch(() => {});
  report.cleanup.mcpClosed = true;
  await new Promise<void>(r => http.close(() => r()));
  report.cleanup.listenerClosed = true;
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const rows = report.cases.map((c:any) => {
    const notes = [
      c.canvas ? `canvas ${c.canvas.width}x${c.canvas.height} fg=${c.canvas.foreground}` : 'no canvas',
      c.documentOverflows ? `+${c.scrollOverflowPx}px scroll` : '',
      c.ready === false ? 'NOT READY' : '',
      c.errors.length ? `${c.errors.length} error(s)` : '',
    ].filter(Boolean).join('; ');
    return [c.case, String(c.stageTop ?? '—'), String(c.stageVisibleHeight ?? '—'), c.documentOverflows ? 'yes' : 'no', notes];
  });
  const header = ['case', 'stageTop', 'stageVisible', 'overflow', 'notes'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r:string[]) => r[i].length)));
  const line = (cells:string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join(' | ').trimEnd();
  console.log(`\n${line(header)}`);
  for (const row of rows) console.log(line(row));
  console.log(`\nstatus: ${report.status}   out: ${out}`);
}
