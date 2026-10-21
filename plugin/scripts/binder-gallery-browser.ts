/** Real-browser acceptance for the packaged binder gallery; writes only to a fresh evidence directory. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Page, type Frame } from 'playwright';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { redactTokens, scrubSecrets } from './report-redaction.js';
// @ts-ignore Shared production visibility resolver.
import { visibleRowKeys } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

const out = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Supply a fresh absolute artifact directory.');
await mkdir(out, { recursive: false });
const preview = process.argv.includes('--preview');
const headed = process.argv.includes('--headed');
const stageAt = process.argv.indexOf('--stage');
const stage = stageAt < 0 ? 'steady-target' : process.argv[stageAt + 1];
assert.ok(stage === 'steady-target' || stage === 'original-pairs', 'Use --stage steady-target or --stage original-pairs.');
const lessonPath = resolve(`demos/binder-gallery/${stage === 'original-pairs' ? 'original-pairs' : 'lesson'}.json`);
const previewChapterAt = process.argv.indexOf('--preview-chapter');
const previewChapter = previewChapterAt < 0 ? 1 : Number(process.argv[previewChapterAt + 1]);
assert.ok(Number.isInteger(previewChapter) && previewChapter >= 1 && previewChapter <= 17
  && (previewChapterAt < 0 || preview), 'Use --preview --preview-chapter with a chapter from 1 to 17.');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const lesson = JSON.parse(await readFile(lessonPath, 'utf8'));
const manifest = JSON.parse(await readFile(resolve('demos/binder-gallery/manifest.json'), 'utf8'));
const report: any = { status: 'failed', scope: 'Actual Chromium desktop rendering and input; not a physical-headset benchmark.',
  startedAt: new Date().toISOString(), stage, lessonSha256: digest(JSON.stringify(lesson)), sourceSha256: manifest.composite.sha256,
  steps: [], screenshots: [], errors: [], appCalls: [], cleanup: {} };
const service = resolve(out, '.scene-service.json');
const socket = resolve(out, '.scene-service.sock');
const client = new Client({ name: 'Binder gallery browser acceptance', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.mjs')], cwd: process.cwd(),
  env: { STEREOFOLD_REPLY_AUDIO: '0', STEREOFOLD_PTT_TRANSCRIBE: '0', STEREOFOLD_SCENE_SERVICE: service, STEREOFOLD_SCENE_SOCKET: socket }, stderr: 'pipe' });
let stderr = '', browser: any, host: any, page: Page, frame: Frame, sessionId = '', panelId = '', pointerHeld = false;
transport.stderr?.on('data', c => { stderr = (stderr + String(c)).slice(-14000); });
async function call(name: string, args: any = {}) {
  const r: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!r.isError, `${name}: ${redactTokens(JSON.stringify(r.content))}`); return r;
}
const state = async () => (await call('get_inspection_state', { sessionId })).structuredContent;
const inspection = async () => (await call('get_inspection', { sessionId }))._meta['stereo_structure/inspection'];
async function until(read: () => Promise<any>, test: (v: any) => boolean, name: string, ms = 180000) {
  const deadline = Date.now() + ms; let last: any;
  do { last = await read(); if (test(last)) return last; await sleep(100); } while (Date.now() < deadline);
  throw Error(`Timed out: ${name}; ${redactTokens(JSON.stringify(last)).slice(0, 1800)}`);
}
const panel = (s: any) => s.panels?.find((p: any) => p.panelId === panelId);
const ready = (s: any) => s.hasScene && panel(s)?.current && panel(s)?.availability === 'ready' && !panel(s)?.tour?.navigating;
async function chapter(n: number, ms = 20000) { return until(state, s => ready(s) && panel(s)?.tour?.step === n, `saved chapter ${n + 1}`, ms); }
async function liveChapter(n: number) {
  return until(async () => frame.evaluate(() => {
    const root = document.querySelector('[data-tour-player]');
    const match = root?.querySelector('[data-tour-progress]')?.textContent?.match(/SCENE\s+(\d+)\s*\//);
    return { step: match ? Number(match[1]) - 1 : -1,
      navigating: (root?.querySelector('[data-tour-play]') as HTMLButtonElement)?.disabled,
      title: root?.querySelector('[data-tour-title]')?.textContent,
      autoplay: (root as HTMLElement)?.dataset.autoplay === 'true',
      input: (window as any).__binderAcceptance?.input };
  }), live => {
    if (live.step > n) throw Error(`The browser passed slide ${n + 1} before it was sampled (now ${live.step + 1}).`);
    return live.step === n && !live.navigating;
  }, `locally rendered chapter ${n + 1}`, 20000);
}
async function shot(name: string) {
  // Moving to the page corner with the button down would add a large orbit
  // during the held-input check. Screenshot the view exactly where it is.
  if (!pointerHeld) await page.mouse.move(4, 4);
  await sleep(100);
  await page.screenshot({ path: resolve(out, `${name}.png`), timeout: 15000 });
  const pixels = await frame.locator('.stage canvas').screenshot({ timeout: 15000 });
  await writeFile(resolve(out, `${name}-canvas.png`), pixels);
  report.screenshots.push({ name, sha256: digest(pixels), bytes: pixels.length });
}
function pose(scene: any) { return { camera: scene.camera, placement: scene.inspection.placement }; }
function assertPose(a: any, b: any) {
  assert.deepEqual(a.placement, b.placement, 'Room placement stays with the user.');
  for (const key of ['position', 'target', 'up']) for (let j = 0; j < 3; j++)
    assert.ok(Math.abs(a.camera[key][j] - b.camera[key][j]) < 1e-5, `Camera ${key} stays with the user.`);
}
try {
  await client.connect(transport);
  const opened = await call('inspect_lesson', { filePath: resolve('demos/binder-gallery/gallery.cif'), lessonPath });
  sessionId = opened.structuredContent.sessionId;
  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  const html = (resource.contents[0] as any).text;
  report.inspectorSha256 = digest(html);
  const bundle = await build({ entryPoints: [resolve('scripts/inspector-host.ts')], bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
  const hostHtml = `<!doctype html><html><body style="margin:0;background:white"><iframe title="Stereofold" style="border:0;width:100vw;height:100vh"></iframe><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  host = createServer((_q: any, r: any) => { r.setHeader('Content-Type', 'text/html'); r.end(hostHtml); });
  await new Promise<void>(r => host.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${host.address().port}`;
  report.listener = origin;
  browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1,
    ...(preview ? {} : { recordVideo: { dir: resolve(out, 'video'), size: { width: 1440, height: 960 } } }) });
  page = await context.newPage(); page.setDefaultTimeout(180000);
  await page.addInitScript({ content: 'globalThis.__name=v=>v;' });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.exposeFunction('__call', async (p: any) => {
    const r: any = await client.callTool({ name: p.name, arguments: p.arguments ?? {} });
    if (p.name.endsWith('.attach_inspection') && r.structuredContent?.panelId) panelId = r.structuredContent.panelId;
    if (/\.(?:poll_inspection|sync_inspection)$/.test(p.name)) report.appCalls.push({ tool: p.name.split('.').at(-1),
      at: Date.now(), availability: p.arguments?.availability, tour: p.arguments?.tourState,
      saved: r.structuredContent?.saved, conflict: r.structuredContent?.conflict });
    return r;
  });
  await page.goto(origin);
  await page.evaluate(({ html, opened }) => (window as any).__host.mount(html, opened, { theme: 'light' }), { html, opened });
  frame = page.frames().find(f => f !== page.mainFrame())!;
  await frame.locator('body[data-ready="true"]').waitFor();
  await chapter(0, 180000);
  const first = await inspection();
  const catalog = await decodeInspectionCatalog(first.catalog ?? first.catalogWire);
  report.browserVersion = browser.version();
  report.catalogRows = catalog.rows.length;
  report.renderer = await frame.evaluate(() => {
    const canvas = document.querySelector('.stage canvas') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2')!; const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable';
  });
  await shot('slide-01');
  if (preview && previewChapter > 1) {
    const box = await frame.locator('.stage canvas').boundingBox(); assert.ok(box);
    const x = box.x + box.width * .45, y = box.y + box.height * .5;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 36, y + 8, { steps: 8 }); await page.mouse.up();
    await until(state, ready, 'preview pose saved', 20000);
    const kept = pose((await inspection()).scene);
    for (let i = 1; i < previewChapter; i++) {
      await frame.locator('[data-tour-next]').click(); await chapter(i);
    }
    assertPose(kept, pose((await inspection()).scene));
    await shot(`slide-${String(previewChapter).padStart(2, '0')}-label-preview`);
    report.previewChapter = previewChapter;
    report.previewPosePreserved = true;
  }
  if (!preview) {
    const started = performance.now();
    const recordScene = (i: number, s: any, saved: any) => {
      assert.equal(saved.sourceSha256, manifest.composite.sha256);
      assert.equal(saved.inspection.lessonPlayback?.chapterId, lesson.chapters[i].id, 'The saved scene belongs to this chapter.');
      const visible = new Set(visibleRowKeys(catalog.rows, saved.inspection.visibility));
      const chains = [...new Set(catalog.rows.filter((r: any) => visible.has(r.key)).map((r: any) => r.identity.labelChain))].sort();
      assert.deepEqual(chains, [...lesson.chapters[i].immersive.visibility.chains].sort(), 'Exactly the authored pair is visible.');
      assert.equal(saved.inspection.appearance.background, '#ffffff');
      report.steps.push({ step: i + 1, atMs: performance.now() - started, visibleChains: chains, tour: panel(s).tour, evidence: 'saved-scene' });
      console.log(`Rendered slide ${i + 1} at ${Math.round(performance.now() - started)}ms`);
    };
    // Record the paused opening before input begins. A panel intentionally
    // reports busy during a held drag, and its saved scene lags until release.
    recordScene(0, await chapter(0), first.scene);
    await frame.evaluate(() => {
      const input = { held: false, moves: 0 };
      const observed: any[] = [];
      (window as any).__binderAcceptance = { input, observed };
      document.addEventListener('mousedown', event => {
        if ((event.target as Element)?.closest('.stage canvas')) input.held = true;
      }, true);
      document.addEventListener('mouseup', () => { input.held = false; }, true);
      document.addEventListener('mousemove', () => { if (input.held) input.moves++; }, true);
      const root = document.querySelector('[data-tour-player]')!;
      let previous = -1;
      const sample = () => {
        const match = root.querySelector('[data-tour-progress]')?.textContent?.match(/SCENE\s+(\d+)\s*\//);
        const step = match ? Number(match[1]) - 1 : -1;
        if (step < 0 || (root.querySelector('[data-tour-play]') as HTMLButtonElement)?.disabled || step === previous) return;
        previous = step;
        observed.push({ step, atMs: performance.now(), held: input.held, moves: input.moves,
          title: root.querySelector('[data-tour-title]')?.textContent });
      };
      new MutationObserver(sample).observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      sample();
    });
    await frame.locator('[data-tour-play]').click();
    const dragBox = await frame.locator('.stage canvas').boundingBox(); assert.ok(dragBox);
    const dragX = dragBox.x + dragBox.width * .45, dragY = dragBox.y + dragBox.height * .5;
    await page.mouse.move(dragX, dragY); await page.mouse.down();
    pointerHeld = true;
    await page.mouse.move(dragX + 12, dragY + 4, { steps: 4 });
    const second = await liveChapter(1);
    assert.equal(second.input.held, true, 'Slide 2 rendered while the mouse button remained down.');
    assert.equal(second.autoplay, true);
    report.steps.push({ step: 2, atMs: performance.now() - started, live: second, evidence: 'local-committed-caption-and-screenshot' });
    console.log(`Rendered slide 2 during held input at ${Math.round(performance.now() - started)}ms`);
    await shot('held-slide-02');
    await page.mouse.move(dragX + 36, dragY + 8, { steps: 4 });
    const third = await liveChapter(2);
    assert.equal(third.input.held, true, 'Slide 3 rendered before mouse release.');
    await page.mouse.up(); pointerHeld = false;
    report.autoplayContinuedDuringHeldPointer = true;
    // Saving can now catch up to the rendered third slide; only then compare
    // the host scene's mask. Local input does not promise a saved-scene receipt.
    for (let i = 2; i < lesson.chapters.length; i++) {
      const s = await chapter(i), saved = (await inspection()).scene;
      recordScene(i, s, saved);
      if (i === 2) await shot('held-transition-slide-03');
      if ([6, 7, 11, 14, 15, 16].includes(i)) await shot(`slide-${String(i + 1).padStart(2, '0')}`);
    }
    await until(state, s => ready(s) && panel(s).tour.step === 16 && !panel(s).tour.autoplay, 'final slide held', 20000);
    report.autoplayElapsedMs = performance.now() - started;
    // Actual mouse orbit, pan and zoom followed by a source-preserving slide swap.
    const box = await frame.locator('.stage canvas').boundingBox(); assert.ok(box);
    const x = box.x + box.width * .5, y = box.y + box.height * .5;
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 65, y + 25, { steps: 10 }); await page.mouse.up();
    await page.mouse.move(x, y); await page.mouse.down({ button: 'right' }); await page.mouse.move(x + 20, y - 10, { steps: 8 }); await page.mouse.up({ button: 'right' });
    await page.mouse.wheel(0, -70); await sleep(700); await until(state, ready, 'user pose saved');
    const moved = pose((await inspection()).scene); assert.notDeepEqual(moved, pose(first.scene));
    await frame.locator('[data-tour-back]').click(); await chapter(15);
    assertPose(moved, pose((await inspection()).scene));
    await shot('moved-slide-16');
    await frame.locator('[data-tour-next]').click(); await chapter(16);
    assertPose(moved, pose((await inspection()).scene));
    report.manualPosePreserved = true;
    report.liveObserved = await frame.evaluate(() => (window as any).__binderAcceptance?.observed);
    assert.ok(report.liveObserved.some((entry: any) => entry.step === 1 && entry.held)
      && report.liveObserved.some((entry: any) => entry.step === 2 && entry.held), 'The local observer saw both transitions before release.');
    assert.deepEqual(report.errors, []);
  }
  report.status = 'passed';
} catch (e) {
  report.failure = redactTokens((e as Error).stack ?? String(e)); process.exitCode = 1;
  try { if (page! && frame!) {
    report.liveObserved = await frame.evaluate(() => (window as any).__binderAcceptance?.observed);
    report.failureHostState = await state();
    if (pointerHeld) { await page.mouse.up(); pointerHeld = false; }
    await shot('failure'); report.visibleFailure = await frame.locator('body').innerText();
  } } catch {}
} finally {
  try { await browser?.close(); report.cleanup.browserClosed = true; } catch {}
  try { await client.close(); report.cleanup.clientClosed = true; } catch {}
  if (host) await new Promise<void>(r => host.close(() => r()));
  await rm(service, { force: true }); await rm(socket, { force: true });
  report.cleanup.listenerClosed = true; report.stderr = redactTokens(stderr); report.finishedAt = new Date().toISOString();
  await writeFile(resolve(out, 'report.json'), JSON.stringify(scrubSecrets(report, []), null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, slides: report.steps.length, failure: report.failure }));
}
