import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// From plugin/: tsx scripts/playback-manipulation-browser.ts /existing/inspection-build /fresh/output
// Production desktop workspace and player, local 1CRN, actual mouse input.
// The lab page forwards pointer intent using the inspector callback contract.
const [buildArg, outArg] = process.argv.slice(2);
assert.ok(buildArg && outArg, 'Supply an inspection build and fresh output directory.');
const inspectionBuild = resolve(buildArg), out = resolve(outArg);
await mkdir(out, { recursive: false });
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const report: any = { status: 'failed', scope: 'Chromium desktop production Mol* inspection workspace and source player; local 1CRN, molecular playback with held drag, wheel zoom, autoplay and cached Back; no physical device.', cases: [], errors: [], cleanup: {} };
const pass = (name: string) => { report.cases.push(name); console.log(`Passed: ${name}`); };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  report.inspectionArtifacts = JSON.parse(await readFile(resolve(inspectionBuild, 'artifact-hashes.json'), 'utf8'));
  report.playerSourceSha256 = hash(await readFile(resolve('src/tour-player.ts')));
  const script = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { mountTourPlayer } from './src/tour-player.ts';
    import { applyTourCommand } from './src/inspection-tour-client.ts';
    const workspace=window.__stereofoldInspection;
    const animation={version:1,durationSeconds:20,playback:{autoplay:true,loop:true},tracks:[{id:'body',chains:['A'],keyframes:[
      {t:0,translation:[0,0,0],rotation:[0,0,0,1]}, {t:20,translation:[10,0,0],rotation:[0,0,1,0]}]}]};
    const tour={id:'playback-input',title:'Playback input',summary:'',presentation:{captionCard:'shown',end:'hold'},steps:[0,1,2].map(i=>({
      id:'chapter-'+i,title:'Chapter '+i,durationMs:4000,animation,view:'fit',placement:{scale:1+i*.2}}))};
    const player=mountTourPlayer({workspace,tours:[tour],after:document.querySelector('.inspector-heading')});
    for(const name of ['mousedown','wheel']) document.querySelector('.stage canvas').addEventListener(name,
      ()=>player.notifyMutation(workspace.snapshot(),{interaction:true}));
    window.__motionAcceptance={state:()=>player.getState(),command:patch=>applyTourCommand(player,patch)};
  ` }, bundle: true, format: 'iife', platform: 'browser', target: 'es2022', write: false });
  report.playerBundleSha256 = hash(script.outputFiles[0].text);
  // Intercept every local request: no listening socket or external network is needed.
  const origin = 'http://localhost:31809';
  const assets = new Map<string, Buffer>();
  for (const artifact of report.inspectionArtifacts) {
    assert.ok(!artifact.path.includes('/'));
    const bytes = await readFile(resolve(inspectionBuild, artifact.path));
    assert.equal(hash(bytes), artifact.sha256);
    assets.set('/'+artifact.path, bytes);
  }
  assets.set('/', assets.get('/index.html')!);
  browser = await chromium.launch({ headless: true }); report.browserVersion = browser.version();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, reducedMotion: 'no-preference' });
  page.setDefaultTimeout(30_000);
  await page.addInitScript({ content: 'globalThis.__name=value=>value;' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url()), bytes = assets.get(url.pathname);
    if (url.origin !== origin || !bytes) return route.abort();
    const contentType = url.pathname.endsWith('.js') ? 'application/javascript' : url.pathname.endsWith('.css') ? 'text/css'
      : url.pathname.endsWith('.ttf') ? 'font/ttf' : 'text/html';
    return route.fulfill({ body: bytes, contentType });
  });
  // Keep the production self-only script policy: the test bundle is served
  // as a same-origin resource, never through an inline-script exception.
  const playerUrl = `${origin}/motion-acceptance.js`;
  await page.route(playerUrl, route => route.fulfill({ contentType: 'application/javascript', body: script.outputFiles[0].text }));
  await page.goto(origin);
  await page.waitForFunction(() => (window as any).__stereofoldInspection?.snapshot().ready === true);
  if (await page.getByRole('button', { name: 'Pause rotation', exact: true }).count()) await page.getByRole('button', { name: 'Pause rotation', exact: true }).click();
  await page.addScriptTag({ url: playerUrl });
  const command = (patch: any) => page.evaluate(value => (window as any).__motionAcceptance.command(value), patch);
  await command({ action: 'start', tourId: 'playback-input', autoplay: true, narration: false });
  const read = () => page.evaluate(() => ({ view: (window as any).__stereofoldInspection.snapshot(), tour: (window as any).__motionAcceptance.state() }));
  const initial = await read();
  const box = await page.locator('.stage canvas').boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .65, box.y + box.height * .6, { steps: 12 });
  await page.waitForTimeout(500);
  const moved = await read();
  assert.notDeepEqual(moved.view.camera.position, initial.view.camera.position);
  assert.ok(moved.view.animation.timeSeconds > initial.view.animation.timeSeconds);
  await page.waitForFunction(() => (window as any).__motionAcceptance.state().step === 1);
  const advanced = await read();
  assert.equal(advanced.tour.autoplay, true);
  assert.equal(advanced.view.interactionActive, true, 'chapter advanced before mouse release');
  assert.equal(advanced.view.animation.state, 'playing');
  await page.mouse.up();
  await page.mouse.wheel(0, -200); await page.waitForTimeout(500);
  const zoomed = await read();
  assert.notDeepEqual(zoomed.view.camera.position, advanced.view.camera.position);
  const assertPose = (value: any) => {
    for (const key of ['position','target','up']) value.view.camera[key].forEach((v: number,i: number) =>
      assert.ok(Math.abs(v-zoomed.view.camera[key][i]) < 1e-6, key+' camera drift'));
    assert.deepEqual(value.view.inspection.placement, zoomed.view.inspection.placement);
    assert.equal(value.view.animation.state, 'playing'); assert.equal(value.tour.autoplay, true);
  };
  await command({ action: 'next' }); assertPose(await read());
  await command({ action: 'back' }); assertPose(await read());
  const beforeTime = (await read()).view.animation.timeSeconds;
  await page.waitForTimeout(250);
  assert.ok((await read()).view.animation.timeSeconds > beforeTime);
  await page.screenshot({ path: resolve(out, 'desktop-playback.png') });
  report.samples = { initial, moved, advanced, zoomed, final: await read() };
  pass('Mouse orbit and wheel zoom keep molecular time and autoplay live; held drag crosses a chapter; Next/Back preserve placement and camera within 1e-6.');
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) { report.error = (error as Error).stack; throw error; }
finally {
  if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
