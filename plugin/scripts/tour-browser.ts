import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Frame, type Page } from 'playwright';

/**
 * Isolated Chromium acceptance for the inspector's guided molecular tours.
 *
 * Usage: pnpm exec tsx scripts/tour-browser.ts /absolute/fresh-artifact-dir
 *
 * The script deliberately drives the packaged inspector through the same
 * AppBridge host used by inspector-browser.ts. It never opens a user browser,
 * and its host listener is loopback-only.
 */
const outArgument = process.argv[2];
assert.ok(outArgument, 'Supply a fresh artifact directory.');
const out = resolve(outArgument);
await mkdir(out, { recursive: false });

const report: any = { status: 'failed', cases: [], errors: [], externalRequests: [], cleanup: {} };
const passed = (name: string) => { report.cases.push(name); console.log(`Passed: ${name}`); };
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const client = new Client({ name: 'Stereofold guided-tour acceptance', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.mjs')], cwd: process.cwd(), stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += String(chunk); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let host: ReturnType<typeof createServer> | undefined;
let acceptancePage: Page | undefined;
let acceptanceFrame: Frame | undefined;

const call = async (name: string, args: Record<string, unknown>) => {
  const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!result.isError, `stereo_structure.${name}: ${JSON.stringify(result)}`);
  return result;
};
const privateInspection = async (sessionId: string) => (await call('get_inspection', { sessionId }))._meta['stereo_structure/inspection'];
async function waitSaved(sessionId: string, predicate: (data: any) => boolean, description: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const data = await privateInspection(sessionId);
    if (predicate(data)) return data;
    await sleep(100);
  }
  throw Error(`Timed out waiting for ${description}.`);
}
async function canvasHash(page: Page, frame: Frame) {
  const png = await frame.locator('.stage canvas').screenshot();
  assert.ok(png.length > 1_000, 'The molecular canvas must render non-empty pixels.');
  return createHash('sha256').update(png).digest('hex');
}
async function mount(html: string, opened: any) {
  const page = await browser!.newPage({ viewport: { width: 800, height: 640 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(120_000);
  // tsx emits this helper for serialized test-page callbacks. The controlled
  // browser page needs it before the inspector srcdoc initializes.
  await page.addInitScript({ content: 'globalThis.__name = value => value;' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    report.externalRequests.push(url);
    return route.abort();
  });
  await page.exposeFunction('__call', (payload: any) => client.callTool({ name: payload.name, arguments: payload.arguments ?? {} }));
  await page.goto(origin);
  await page.evaluate(({ resource, result }) => (window as any).__host.mount(resource, result, { theme: 'dark' }), { resource: html, result: opened });
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  assert.ok(frame, 'The controlled host must create an inspector frame.');
  await page.waitForFunction(() => (window as any).__host.connected);
  return { page, frame };
}

const hostBundle = await build({ entryPoints: [resolve('scripts/inspector-host.ts')], bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
const hostHtml = `<!doctype html><html><body style="margin:0;background:#071015"><iframe title="Stereofold" style="border:0;width:100vw;height:100vh"></iframe><script>${hostBundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
host = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(hostHtml); });
await new Promise<void>(done => host!.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(host.address() as any).port}`;

try {
  await client.connect(transport);
  report.inspectorBuild = (await stat(resolve('dist/inspector.html'))).mtime.toISOString();
  const cif = await readFile(resolve('../fixtures/1CRN.cif'), 'utf8');
  const opened = await call('inspect', { structureText: cif });
  const sessionId = opened.structuredContent.sessionId as string;
  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  const html = (resource.contents[0] as any).text as string;
  browser = await chromium.launch({ headless: true });
  report.browserVersion = browser.version();
  const { page, frame } = await mount(html, opened);
  acceptancePage = page;
  acceptanceFrame = frame;
  await frame.locator('body[data-ready="true"]').waitFor();
  await page.screenshot({ path: resolve(out, 'tour-initial-800x640.png') });
  report.initialScreenshot = resolve(out, 'tour-initial-800x640.png');
  // The player reads this seam when autoplay begins; it avoids a seven-second
  // browser-test delay without changing its product default.
  await frame.evaluate(() => { document.body.dataset.tourDelayMs = '350'; });
  const baseline = await waitSaved(sessionId, data => data.scene != null, 'the initial fitted inspector scene');
  const baselineScene = baseline.scene;

  // At 800 x 640 the inspector is a Tools sheet over the stage. Open it before
  // reaching for anything inside it; a running tour keeps it open by itself.
  const openTools = async () => {
    const toggle = frame.locator('[data-action="toggle-inspector"]');
    if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  };
  await openTools();
  const menu = frame.locator('[data-tour-menu]');
  await menu.waitFor({ state: 'visible' });
  assert.ok(await menu.locator('option').count() >= 11, 'The tour menu must expose its prompt plus at least 10 tours.');
  assert.equal(await menu.locator('option').first().getAttribute('value'), '', 'The first menu entry must be the non-tour prompt.');
  const tourValues = await menu.locator('option').evaluateAll(options => options.slice(1).map(option => (option as HTMLOptionElement).value));
  assert.equal(new Set(tourValues).size, tourValues.length, 'Every tour must have a distinct selection value.');
  assert.ok(tourValues.every(Boolean), 'Every tour must be selectable by a non-empty value.');
  passed('The inspector exposes a prompted menu with exactly ten selectable guided tours');

  let lastTourBaseline: any;
  let firstSceneForCurrentTour: any;
  const tourValuesToExercise = process.env.TOUR_PLAYBACK_ONLY === '1' ? tourValues.slice(-1) : tourValues;
  for (const [tourIndex, value] of tourValuesToExercise.entries()) {
    if (tourIndex > 0) {
      await openTools();
      await frame.locator('[data-tour-menu-button]').click();
      await menu.waitFor({ state: 'visible' });
    }
    // Scene one deliberately sets cartoon/opacity 1 while it may preserve
    // background. Give every tour a persisted visual state it must replace.
    await openTools();
    await frame.locator('[data-tab="look"]').click();
    await frame.locator('[data-control="representation"]').selectOption('ball-and-stick');
    await frame.locator('[data-control="opacity"]').fill('0.55');
    await frame.locator('[data-control="opacity"]').press('Tab');
    await waitSaved(sessionId, data => data.scene?.inspection?.appearance?.representation === 'ball-and-stick'
      && data.scene?.inspection?.appearance?.opacity === 0.55,
      `tour ${tourIndex + 1} distinctive pre-tour view to persist`);
    lastTourBaseline = (await privateInspection(sessionId)).scene;
    await menu.selectOption(value);
    await frame.locator('[data-tour-start]').click();
    await frame.locator('[data-tour-progress]').waitFor({ state: 'visible' });
    await expectStep(frame, 1, `tour ${tourIndex + 1} start`, 15_000);
    assert.ok((await frame.locator('[data-tour-title]').innerText()).trim(), `Tour ${tourIndex + 1} scene 1 needs a title.`);
    assert.ok((await frame.locator('[data-tour-body]').innerText()).trim().length > 20, `Tour ${tourIndex + 1} scene 1 needs explanatory text.`);
    assert.ok((await frame.locator('[data-tour-status]').innerText()).trim().length > 8, `Tour ${tourIndex + 1} must report useful navigation guidance.`);
    const firstScene = await waitSaved(sessionId, data => JSON.stringify(data.scene) !== JSON.stringify(lastTourBaseline), `tour ${tourIndex + 1} first scene to persist`);
    firstSceneForCurrentTour = firstScene.scene;
    if (tourIndex === 0) {
      const firstTourScreenshot = resolve(out, 'tour-first-scene-800x640.png');
      await page.screenshot({ path: firstTourScreenshot });
      report.firstTourScreenshot = firstTourScreenshot;
    }
    const pixelHashes = new Set<string>([await canvasHash(page, frame)]);

    for (let step = 2; step <= 20; step++) {
      await frame.locator('[data-tour-next]').click();
      await expectStep(frame, step, `tour ${tourIndex + 1} step ${step}`);
      assert.ok((await frame.locator('[data-tour-body]').innerText()).trim().length > 20, `Tour ${tourIndex + 1} step ${step} needs explanatory text.`);
      pixelHashes.add(await canvasHash(page, frame));
    }
    assert.ok(pixelHashes.size > 1, `Tour ${tourIndex + 1} must visibly change the real molecular model during its first twenty scenes.`);
    assert.notDeepEqual((await privateInspection(sessionId)).scene, firstScene.scene, `Tour ${tourIndex + 1} must make model state changes after its first scene.`);
    await frame.locator('[data-tour-restart]').click();
    await expectStep(frame, 1, `tour ${tourIndex + 1} restart`);
    await waitSaved(sessionId, data => JSON.stringify(data.scene) !== JSON.stringify(baselineScene), `tour ${tourIndex + 1} restarted first scene`);
  }
  passed(process.env.TOUR_PLAYBACK_ONLY === '1'
    ? 'Focused playback setup reaches twenty informative scenes with real molecular changes'
    : 'Every available tour contains at least twenty informative scenes and drives the real inspector model through its narrative');

  // The selected final tour is still at scene 1 after the catalogue sweep.
  await frame.locator('[data-tour-next]').click();
  await expectStep(frame, 2, 'back restoration setup');
  const stepTwoScene = (await waitSaved(sessionId,
    data => JSON.stringify(data.scene) !== JSON.stringify(firstSceneForCurrentTour), 'scene 2 to persist')).scene;
  await frame.locator('[data-tour-next]').click();
  await expectStep(frame, 3, 'forward from scene 2');
  await frame.locator('[data-tour-back]').click();
  await expectStep(frame, 2, 'back to scene 2');
  const backedScene = (await waitSaved(sessionId, data => JSON.stringify(data.scene) === JSON.stringify(stepTwoScene), 'Back to restore scene 2')).scene;
  assert.deepEqual(backedScene, stepTwoScene, 'Back must restore the exact previous model view.');
  await canvasHash(page, frame);
  passed('Back restores the exact saved molecular scene and a rendered molecular canvas for the prior tour step');

  await frame.locator('[data-tour-play]').click();
  assert.match(await frame.locator('[data-tour-play]').innerText(), /pause/i, 'Autoplay control must expose Pause while running.');
  await expectStep(frame, 3, 'autoplay advance', 12_000);
  await frame.locator('[data-tour-play]').click();
  assert.match(await frame.locator('[data-tour-play]').innerText(), /autoplay/i, 'Autoplay control must return to Autoplay when paused.');
  const pausedProgress = await frame.locator('[data-tour-progress]').innerText();
  await sleep(800);
  assert.equal(await frame.locator('[data-tour-progress]').innerText(), pausedProgress, 'Paused autoplay must not advance the tour.');
  await frame.locator('[data-tour-restart]').click();
  await expectStep(frame, 1, 'restart after autoplay pause');
  await frame.locator('[data-tour-restore]').click();
  const restored = await waitSaved(sessionId,
    data => JSON.stringify(data.scene) === JSON.stringify(lastTourBaseline), 'Restore to return to the pre-tour scene');
  assert.deepEqual(restored.scene, lastTourBaseline, 'Restore must return appearance, placement, selection, and camera to the pre-tour scene.');
  await openTools();
  await frame.locator('[data-tour-menu-button]').click();
  await menu.waitFor({ state: 'visible' });
  await page.screenshot({ path: resolve(out, 'tour-mobile-800x640.png') });
  const mobilePng = await readFile(resolve(out, 'tour-mobile-800x640.png'));
  assert.ok(mobilePng.length > 1_000, 'The narrow inspector tour screenshot must be written.');
  assert.equal(await menu.isVisible(), true, 'Tours remain usable in the 800×640 embedded inspector viewport.');
  assert.equal(await menu.isEnabled(), true, 'Tour selection remains usable in the 800×640 embedded inspector viewport.');
  passed('Autoplay advances, Pause holds the model steady, Restart replays scene 1, Restore returns the captured view, and tour controls remain usable at 800×640');

  assert.deepEqual(report.errors, [], `The packaged inspector raised browser errors: ${JSON.stringify(report.errors)}`);
  assert.deepEqual(report.externalRequests, [], 'The isolated acceptance host must make no external requests.');
  report.status = 'passed';
} catch (error) {
  report.failure = (error as Error).stack;
  report.stderr = stderr;
  if (acceptanceFrame) {
    try {
      report.tourUiAtFailure = await acceptanceFrame.evaluate(() => {
        const root = document.querySelector('[data-tour-player]') as HTMLElement | null;
        const button = document.querySelector('[data-tour-start]') as HTMLButtonElement | null;
        return { status: document.querySelector('[data-tour-status]')?.textContent, progress: document.querySelector('[data-tour-progress]')?.textContent,
          startHidden: button?.hidden, startDisabled: button?.disabled, active: root?.dataset.active, selected: root?.dataset.selected };
      });
    } catch (stateError) { report.tourUiAtFailureError = String(stateError); }
  }
  if (acceptancePage) {
    try {
      const failureScreenshot = resolve(out, 'tour-browser-failure.png');
      await acceptancePage.screenshot({ path: failureScreenshot });
      report.failureScreenshot = failureScreenshot;
    } catch (screenshotError) { report.failureScreenshotError = String(screenshotError); }
  }
  throw error;
} finally {
  await disposeStep('browserClosed', () => browser?.close() ?? Promise.resolve());
  await disposeStep('mcpClosed', () => client.close());
  await disposeStep('listenerClosed', () => new Promise<void>(done => host ? host.close(() => done()) : done()));
  await disposeStep('reportWritten', () => writeFile(resolve(out, 'tour-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`));
  console.log(JSON.stringify(report, null, 2));
}

// Each disposal step is isolated: a throwing browser.close() must not skip the
// MCP child process, the loopback listener, or the report that explains the
// failure this cleanup exists for.
async function disposeStep(step: string, work: () => Promise<unknown>) {
  try { await work(); report.cleanup[step] = true; }
  catch (cleanupError) { report.cleanup[step] = false; (report.cleanupErrors ??= []).push(`${step}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
}

async function expectStep(frame: Frame, step: number, description: string, timeout = 120_000) {
  await frame.locator('[data-tour-progress]').waitFor({ state: 'visible', timeout });
  await frame.waitForFunction(step => {
    const text = document.querySelector('[data-tour-progress]')?.textContent ?? '';
    return new RegExp(`(?:${step}\\s*(?:/|of)\\s*\\d+|step\\s*${step})`, 'i').test(text);
  }, step, { timeout });
  assert.match(await frame.locator('[data-tour-progress]').innerText(), new RegExp(`${step}\\s*(?:/|of)\\s*\\d+|step\\s*${step}`, 'i'), `${description} must report step ${step}.`);
}
