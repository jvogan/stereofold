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
 * Usage: pnpm exec tsx scripts/experience-browser.ts /absolute/fresh-artifact-dir
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
const client = new Client({ name: 'Stereofold molecular-experience acceptance', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.mjs')], cwd: process.cwd(), stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += String(chunk); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let host: ReturnType<typeof createServer> | undefined;
let acceptancePage: Page | undefined;
let acceptanceFrame: Frame | undefined;
let acceptanceSession: string | undefined;

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
  acceptanceSession = sessionId;
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

  // At 800 x 640 the inspector is a Tools sheet over the stage. Open it before
  // reaching for anything inside it; a running tour keeps it open by itself.
  const openTools=async()=>{
    const toggle=frame.locator('[data-action="toggle-inspector"]');
    if(await toggle.isVisible() && await toggle.getAttribute('aria-expanded')!=='true') await toggle.click();
  };
  await openTools();
  await frame.locator('[data-experience-library]').click();
  const menu=frame.locator('[data-experience-menu]');
  assert.equal(await menu.locator('option').count(),10);
  const journeys=await menu.locator('option').evaluateAll(options=>options.map(option=>({id:(option as HTMLOptionElement).value,title:option.textContent})));
  report.journeys=journeys;
  await menu.selectOption('tubulin-eb3-lattice');
  await frame.locator('[data-experience-start]').click();
  const waitStep=async(index:number)=>waitSaved(sessionId,data=>data.experience?.stepIndex===index&&data.experience?.applied===true&&!!data.scene,`confirmed experience scene ${index+1}`);
  let state=await waitStep(0);
  report.dimer={pdbId:state.pdbId,sourceToken:state.sourceToken,assemblyId:state.scene.assemblyId,hash:await canvasHash(page,frame)};
  await page.screenshot({path:resolve(out,'experience-dimer.png')});
  await frame.locator('[data-experience-next]').click();await waitStep(1);
  await frame.locator('[data-experience-back]').click();await waitStep(0);
  passed('A current 1CRN session starts a real tubulin journey; Next and Back confirm rendered scenes');
  for(const [index,label] of [[5,'protofilament'],[10,'lattice'],[15,'eb3']] as const){
    const current:any=(await call('get_inspection_state',{sessionId})).structuredContent;
    const panel=current.panels.find((p:any)=>p.current&&p.availability==='ready');
    assert.ok(panel,'a ready panel must exist');
    await call('navigate_experience',{sessionId,serverEpoch:current.serverEpoch,sourceToken:current.sourceToken,
      baseStateRevision:current.stateRevision,baseInspectionRevision:current.inspectionRevision,panelId:panel.panelId,
      experienceId:'tubulin-eb3-lattice',baseExperienceRevision:current.experience.revision,stepIndex:index});
    state=await waitStep(index);
    report[label]={pdbId:state.pdbId,sourceToken:state.sourceToken,assemblyId:state.scene.assemblyId,hash:await canvasHash(page,frame)};
    await page.screenshot({path:resolve(out,`experience-${label}.png`)});
    passed(`Live rendering confirms ${label} scene ${index+1}`);
  }
  assert.notEqual(report.dimer.hash,report.protofilament.hash);
  assert.notEqual(report.protofilament.hash,report.lattice.hash);
  assert.notEqual(report.lattice.hash,report.eb3.hash);
  await frame.locator('[data-experience-play]').click();
  await frame.waitForFunction(()=>document.querySelector('[data-experience-play]')?.textContent==='Pause');
  await waitStep(16);
  await frame.locator('[data-experience-play]').click();
  await frame.waitForFunction(()=>document.querySelector('[data-experience-play]')?.textContent==='Play');
  await openTools();
  await frame.locator('[data-experience-library]').click();
  assert.equal(await menu.isVisible(),true);
  passed('Play, Pause and Tour menu remain available after source/assembly transitions');
  await menu.selectOption('cas9-ternary-complex');
  await frame.locator('[data-experience-start]').click();
  await waitSaved(sessionId,data=>data.experience?.definition?.id==='cas9-ternary-complex'&&data.experience?.applied===true,'switching into Cas9 within this session');
  passed('The same session switches from the microtubule journey into Cas9 using Tour menu');
  const beforeReplace:any=(await call('get_inspection_state',{sessionId})).structuredContent;
  const replacementPanel=beforeReplace.panels.find((p:any)=>p.current&&p.availability==='ready');
  assert.ok(replacementPanel);
  await call('replace_inspection_source',{sessionId,serverEpoch:beforeReplace.serverEpoch,sourceToken:beforeReplace.sourceToken,
    baseStateRevision:beforeReplace.stateRevision,baseInspectionRevision:beforeReplace.inspectionRevision,panelId:replacementPanel.panelId,pdbId:'1CRN'});
  await waitSaved(sessionId,data=>data.pdbId==='1CRN'&&!data.experience&&!!data.scene,'arbitrary source replacement after a journey');
  passed('A general agent source replacement refreshes the same panel after leaving a journey');

  assert.deepEqual(report.errors, [], `The packaged inspector raised browser errors: ${JSON.stringify(report.errors)}`);
  assert.deepEqual(report.externalRequests, [], 'The isolated acceptance host must make no external requests.');
  report.status = 'passed';
} catch (error) {
  report.failure = (error as Error).stack;
  report.stderr = stderr;
  if (acceptanceSession) {
    try { report.stateAtFailure = (await call('get_inspection_state', { sessionId: acceptanceSession })).structuredContent; }
    catch (stateError) { report.stateAtFailureError = String(stateError); }
  }
  if (acceptanceFrame) {
    try {
      report.tourUiAtFailure = await acceptanceFrame.evaluate(() => {
        const root = document.querySelector('[data-experience-player]') as HTMLElement | null;
        const button = document.querySelector('[data-experience-start]') as HTMLButtonElement | null;
        return { notice: document.querySelector('[data-conflict]')?.textContent, status: document.querySelector('[data-experience-status]')?.textContent, progress: document.querySelector('[data-experience-progress]')?.textContent,
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
  await disposeStep('reportWritten', () => writeFile(resolve(out, 'experience-browser-report.json'), `${JSON.stringify(report, null, 2)}\n`));
  console.log(JSON.stringify(report, null, 2));
}

// Each disposal step is isolated: a throwing browser.close() must not skip the
// MCP child process, the loopback listener, or the report that explains the
// failure this cleanup exists for.
async function disposeStep(step: string, work: () => Promise<unknown>) {
  try { await work(); report.cleanup[step] = true; }
  catch (cleanupError) { report.cleanup[step] = false; (report.cleanupErrors ??= []).push(`${step}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
}
