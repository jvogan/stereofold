import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
// @ts-ignore Production camera geometry, used only to check the final pose.
import { lessonCameraMove } from '../../lab/browser-roundtrip/lesson-motion.mjs';

// From plugin/: tsx scripts/tour-motion-browser.ts /existing/inspection-build /fresh/output
// Actual production Mol* workspace + production player, local 1CRN, real UI and
// applyTourCommand actions. This isolates finite authored motion; it is not a
// packaged MCP, XR, headset, narration or continuous-spin acceptance.
const [buildArg, outArg] = process.argv.slice(2);
assert.ok(buildArg && outArg, 'Supply an inspection build and fresh output directory.');
const inspectionBuild = resolve(buildArg), out = resolve(outArg);
await mkdir(out, { recursive: false });
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const report: any = { status: 'failed', scope: 'Chromium desktop production Mol* inspection workspace and source player; local 1CRN, finite authored orbit; no MCP/XR/physical device/voice.', cases: [], errors: [], cleanup: {} };
const pass = (name: string) => { report.cases.push(name); console.log(`Passed: ${name}`); };
const server = spawn(process.execPath, [resolve('../lab/inspection/serve.cjs'), '--build', inspectionBuild], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
server.stdout.on('data', chunk => { stdout += chunk; });
server.stderr.on('data', chunk => { stderr += chunk; });
try {
  report.inspectionArtifacts = JSON.parse(await readFile(resolve(inspectionBuild, 'artifact-hashes.json'), 'utf8'));
  report.playerSourceSha256 = hash(await readFile(resolve('src/tour-player.ts')));
  const script = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { mountTourPlayer } from './src/tour-player.ts';
    import { applyTourCommand } from './src/inspection-tour-client.ts';
    const workspace=window.__stereofoldInspection;
    const tour={id:'motion-acceptance',title:'Finite orbit acceptance',summary:'A local motion check.',presentation:{captionCard:'shown',end:'hold'},steps:[
      {id:'orbit',title:'Orbit',body:'Observe the orbit, then pause and resume.',durationMs:60000,motion:{kind:'orbit',axis:'y',degrees:100,seconds:4}}
    ]};
    const player=mountTourPlayer({workspace,tours:[tour],after:document.querySelector('.inspector-heading')});
    window.__motionAcceptance={state:()=>player.getState(),command:patch=>applyTourCommand(player,patch)};
  ` }, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false });
  report.playerBundleSha256 = hash(script.outputFiles[0].text);
  const deadline = Date.now() + 30_000;
  while (!stdout.includes('\n')) {
    assert.ok(server.exitCode === null && Date.now() < deadline, stderr || 'Inspection server did not start.');
    await new Promise(done => setTimeout(done, 50));
  }
  const origin = JSON.parse(stdout.split('\n')[0]).preview;
  browser = await chromium.launch({ headless: true }); report.browserVersion = browser.version();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, reducedMotion: 'no-preference' });
  page.setDefaultTimeout(30_000);
  await page.addInitScript({ content: 'globalThis.__name=value=>value;' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  // Keep the production self-only script policy: the test bundle is served
  // as a same-origin resource, never through an inline-script exception.
  const playerUrl = `${origin}/motion-acceptance.js`;
  await page.route(playerUrl, route => route.fulfill({ contentType: 'application/javascript', body: script.outputFiles[0].text }));
  await page.goto(origin);
  await page.waitForFunction(() => (window as any).__stereofoldInspection?.snapshot().ready === true);
  if (await page.getByRole('button', { name: 'Pause rotation', exact: true }).count()) await page.getByRole('button', { name: 'Pause rotation', exact: true }).click();
  await page.addScriptTag({ url: playerUrl });
  const camera = () => page.evaluate(() => (window as any).__stereofoldInspection.snapshot().camera);
  const state = () => page.evaluate(() => (window as any).__motionAcceptance.state());
  const command = (patch: any) => page.evaluate(value => (window as any).__motionAcceptance.command(value), patch);
  const canvasHash = async () => hash(await page.locator('.stage canvas').screenshot());
  const openTools = async () => {
    const toggle = page.locator('[data-action="toggle-inspector"]');
    if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  };
  await openTools();
  for (const route of ['ui', 'command']) {
    const initial = await camera();
    if (route === 'ui') {
      await page.locator('[data-tour-menu]').selectOption('motion-acceptance');
      await page.locator('[data-tour-start]').click();
    } else await command({ action: 'start', tourId: 'motion-acceptance', autoplay: true, narration: false });
    await page.waitForFunction(() => (window as any).__motionAcceptance.state().motionRunning);
    await page.waitForTimeout(400);
    if (route === 'ui') await page.locator('[data-tour-play]').click();
    else await command({ action: 'pause' });
    assert.equal((await state()).motionRunning, false);
    const held = await camera(); assert.notDeepEqual(held.position, initial.position);
    await page.waitForTimeout(150);
    const heldPixels = await canvasHash();
    await page.waitForTimeout(500);
    assert.deepEqual(await camera(), held, `${route} pause must freeze the actual camera`);
    assert.equal(await canvasHash(), heldPixels, `${route} pause must hold the rendered molecule pixels`);
    await page.screenshot({ path: resolve(out, `${route}-paused.png`) });
    if (route === 'ui') await page.locator('[data-tour-play]').click();
    else await command({ action: 'play' });
    assert.equal((await state()).motionRunning, true);
    await page.waitForTimeout(300);
    assert.notDeepEqual((await camera()).position, held.position, `${route} Play must resume actual camera movement`);
    assert.notEqual(await canvasHash(), heldPixels, `${route} Play must redraw the moving molecule`);
    await page.waitForFunction(() => !(window as any).__motionAcceptance.state().motionRunning, undefined, { timeout: 8_000 });
    const completed = await camera(), expected = lessonCameraMove(initial, { kind: 'orbit', axis: 'y', degrees: 100 });
    for (const key of ['position', 'target', 'up']) for (let index = 0; index < 3; index++)
      assert.ok(Math.abs(completed[key][index] - expected[key][index]) < 1e-5, `${route} must finish exactly the authored orbit: ${key}[${index}]`);
    report[route] = { initial, held, completed, expected, heldPixels, completedPixels: await canvasHash() };
    await page.screenshot({ path: resolve(out, `${route}-completed.png`) });
    pass(`${route}: Pause holds real camera and pixels; Play completes only the remaining authored orbit`);
    await command({ action: 'pause' });
  }
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) { report.error = (error as Error).stack; throw error; }
finally {
  if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
  if (server.exitCode === null) { const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended; }
  report.cleanup.serverExited = server.exitCode === 0;
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
