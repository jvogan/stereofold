import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Frame, type Page } from 'playwright';
import { demoCacheDirectory, readDemoIndex, readDemoLesson, resolveCoordinates, resolveDemoStage, resolveVolumeStructure } from './quest-demo.js';
import { redactTokens, requestRoute, scrubSecrets } from './report-redaction.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { instrumentDemoRenderObjects } from './demo-render-probe.js';
// @ts-ignore Shared visibility resolver used by the production lesson player.
import { availableChains, componentClassesPresent, emptyVisibility, resolveVisibility, visibleRowKeys } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

/**
 * Isolated Chromium acceptance for one checked-in demo lesson.
 *
 * Usage: pnpm exec tsx scripts/demo-browser.ts <demo name> /absolute/fresh-artifact-dir [stage id]
 *
 * Atomic lessons use the controlled AppBridge host from `tour-browser.ts`.
 * Volume lessons use the actual flat loopback companion and its density
 * transport. Both open through `inspect_lesson` and walk the lesson's own tour.
 * This opens no user browser; the host listener is loopback-only.
 */
const demoName = process.argv[2];
const outArgument = process.argv[3];
const stageId = process.argv[4];
const growthOnly = process.argv.includes('--grow-only');
const renderObjectProbe = process.argv.includes('--render-object-probe');
assert.ok(demoName && outArgument, 'Supply a demo name and a fresh artifact directory.');
const out = resolve(outArgument);
await mkdir(out, { recursive: false });

const report: any = { demo: demoName, ...(stageId ? { stage: stageId } : {}), status: 'failed', cases: [], errors: [], externalRequests: [], failedRequests: [], cleanup: {},
  scope: `Isolated headless Chromium: desktop or flat loopback companion. No WebXR emulator or physical headset.${growthOnly ? ' Growth-only diagnostic; chapter sequence is not replayed.' : ''}` };
const passed = (name: string) => { report.cases.push(name); console.log(`Passed: ${name}`); };
const client = new Client({ name: 'Stereofold demo acceptance', version: '1' });
const privateSceneService = resolve(out, '.scene-service.json');
const secrets: string[] = [];
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.mjs')], cwd: process.cwd(),
  env: { STEREOFOLD_REPLY_AUDIO: '0', STEREOFOLD_PTT_TRANSCRIBE: '0', STEREOFOLD_SCENE_SERVICE: privateSceneService }, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr += String(chunk); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let host: ReturnType<typeof createServer> | undefined;
let acceptancePage: Page | undefined;
let acceptanceFrame: Frame | undefined;
let closingDesktop = false;

const call = async (name: string, args: Record<string, unknown>) => {
  const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!result.isError, `stereo_structure.${name}: ${redactTokens(String(result.content?.[0]?.text ?? 'failed'))}`);
  return result;
};
const privateInspection = async (sessionId: string) => (await call('get_inspection', { sessionId }))._meta['stereo_structure/inspection'];
async function waitSaved(sessionId: string, predicate: (data: any) => boolean, description: string) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const data = await privateInspection(sessionId);
    if (predicate(data)) return data;
    await new Promise<void>(done => setTimeout(done, 150));
  }
  throw Error(`Timed out waiting for ${description}.`);
}
async function canvasHash(frame: Frame) {
  const png = await frame.locator('.stage canvas').screenshot();
  assert.ok(png.length > 1_000, 'The molecular canvas must render non-empty pixels.');
  return createHash('sha256').update(png).digest('hex');
}
async function waitRenderedStep(sessionId: string, step: number, tourId: string, surface: string, expectedVisibility?: any) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const state = (await call('get_inspection_state', { sessionId })).structuredContent;
    const panel = state.panels?.find((candidate: any) => candidate.current && candidate.surface === surface
      && candidate.availability === 'ready' && candidate.tour?.selectedId === tourId
      && candidate.tour?.step === step - 1 && candidate.tour?.navigating === false);
    if (panel && state.hasScene) {
      const saved = await privateInspection(sessionId);
      if (saved.scene && (!expectedVisibility || JSON.stringify(saved.scene.inspection?.visibility ?? emptyVisibility()) === JSON.stringify(expectedVisibility)))
        return { saved, state, panel };
    }
    await new Promise<void>(done => setTimeout(done, 150));
  }
  throw Error(`Timed out waiting for rendered and saved chapter ${step}.`);
}

const index = await readDemoIndex();
const found = index.demos.find(demo => demo.name === demoName);
assert.ok(found, `Unknown demo "${demoName}".`);
const { entry, stage } = resolveDemoStage(found, stageId);
if (stage) report.stageTitle = stage.title;
const manifest = await readDemoLesson(entry);
const coordinatePath = await resolveCoordinates(entry, demoCacheDirectory(), message => console.log(message));
const volume = entry.coordinates.volume;
assert.ok(!renderObjectProbe || !volume, '--render-object-probe supports the isolated atomic inspector only.');
if (renderObjectProbe) {
  report.instrumentation = 'Test-only read-only render-object accessor injected into served inspector HTML; distributed files are unchanged. This run is not byte-identical production HTML.';
  report.scope += ' Render-object counts describe this instrumented flat Chromium run, not Quest frame rate or immersive GPU cost.';
}
const structurePath = volume ? await resolveVolumeStructure(entry, demoCacheDirectory(), message => console.log(message)) : coordinatePath;
const lessonPath = resolve('demos', entry.lesson);
report.pdbId = entry.pdbId;
report.chapters = manifest.chapters.length;
report.declaredAtomSites = entry.coordinates.atomSites;
report.sourceBytes = entry.coordinates.bytes;
if (entry.coordinates.assemblyId) report.assemblyId = entry.coordinates.assemblyId;
const openedAt = Date.now();

const hostBundle = await build({ entryPoints: [resolve('scripts/inspector-host.ts')], bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
const hostHtml = `<!doctype html><html><body style="margin:0;background:#071015"><iframe title="Stereofold" style="border:0;width:100vw;height:100vh"></iframe><script>${hostBundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
host = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(hostHtml); });
await new Promise<void>(done => host!.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(host.address() as any).port}`;

try {
  await client.connect(transport);
  const opened = await call('inspect_lesson', { filePath: structurePath, lessonPath,
    ...(volume ? { densityPath: coordinatePath } : {}),
    ...(entry.coordinates.assemblyId ? { assemblyId: entry.coordinates.assemblyId } : {}) });
  const sessionId = opened.structuredContent.sessionId as string;
  const tourId = opened.structuredContent.customTourId as string;
  report.openMs = Date.now() - openedAt;
  report.atomSites = opened.structuredContent.atomSites;
  report.openedAssemblyId = opened.structuredContent.assemblyId;
  assert.equal(tourId, `lesson-${manifest.id}`, 'The demo lesson must register its own tour.');
  assert.equal(report.atomSites, volume?.structure.atomSites ?? entry.coordinates.atomSites,
    'The opened catalog must carry the declared reference-coordinate atom-site count.');
  if (entry.coordinates.assemblyId) assert.equal(report.openedAssemblyId, entry.coordinates.assemblyId, 'The opened catalog must be the requested assembly.');
  passed(`inspect_lesson opens ${entry.pdbId} with the ${demoName}${stage ? ` ${stage.id}` : ''} lesson at assembly ${report.openedAssemblyId} and registers ${tourId}`);

  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  const resourceHtml = (resource.contents[0] as any).text as string;
  const html = renderObjectProbe ? instrumentDemoRenderObjects(resourceHtml) : resourceHtml;
  browser = await chromium.launch({ headless: true });
  report.browserVersion = browser.version();
  let page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(180_000);
  await page.addInitScript({ content: 'globalThis.__name = value => value;' });
  page.on('pageerror', error => report.errors.push(redactTokens(error.message)));
  page.on('requestfailed', request => {
    const failure = { route: requestRoute(request.url()), reason: request.failure()?.errorText };
    if (closingDesktop && new URL(request.url()).pathname === '/tool' && failure.reason === 'net::ERR_ABORTED')
      (report.intentionalClosedDesktopRequests ??= []).push(failure);
    else report.failedRequests.push(failure);
  });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    report.externalRequests.push(requestRoute(url));
    return route.abort();
  });
  await page.exposeFunction('__call', (payload: any) => client.callTool({ name: payload.name, arguments: payload.arguments ?? {} }));
  await page.goto(origin);
  await page.evaluate(({ resource, result }) => (window as any).__host.mount(resource, result, { theme: 'dark' }), { resource: html, result: opened });
  let frame = page.frames().find(candidate => candidate !== page.mainFrame());
  assert.ok(frame, 'The controlled host must create an inspector frame.');
  await page.waitForFunction(() => (window as any).__host.connected);
  acceptancePage = page;
  acceptanceFrame = frame;
  await frame.locator('body[data-ready="true"]').waitFor();
  let baseline = await waitSaved(sessionId, data => data.scene != null, 'the initial fitted scene');
  let surface = 'desktop';
  if (volume) {
    // AppBridge desktop hydration draws only the reference coordinates. The
    // real flat companion fetches /density and draws the map, with no XR runtime.
    const connected = await call('open_companion', { sessionId, connection: 'loopback', launch: 'none' });
    const url = connected.structuredContent.companion.url as string;
    const companionOrigin = new URL(url).origin;
    secrets.push(new URL(url).hash.slice(1));
    page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(180_000);
    await page.addInitScript({ content: 'globalThis.__name = value => value;' });
    page.on('pageerror', error => report.errors.push(redactTokens(error.message)));
    page.on('requestfailed', request => report.failedRequests.push({ route: requestRoute(request.url()), reason: request.failure()?.errorText }));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(companionOrigin)) return route.continue();
      report.externalRequests.push(requestRoute(route.request().url())); return route.abort();
    });
    const mapResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/density'));
    await page.goto(url);
    acceptancePage = page; frame = page.mainFrame(); acceptanceFrame = frame;
    const downloaded = await mapResponse;
    assert.equal(downloaded.status(), 200, 'The actual companion must fetch the density bytes successfully.');
    const mapBytes = await downloaded.body();
    assert.equal(mapBytes.byteLength, entry.coordinates.bytes);
    assert.equal(createHash('sha256').update(mapBytes).digest('hex'), entry.coordinates.sha256);
    await frame.locator('body[data-ready="true"]').waitFor();
    baseline = await waitSaved(sessionId, data => data.scene?.sourceSha256 === entry.coordinates.sha256,
      'the companion to draw and save the actual density source');
    assert.equal(baseline.scene.inspection.appearance.representation, 'isosurface');
    report.density = { sourceSha256: entry.coordinates.sha256, bytes: mapBytes.byteLength,
      contour: volume.contour, catalogReferenceAtomSites: report.atomSites, savedRepresentation: 'isosurface' };
    surface = 'companion';
    passed(`${volume.emdbId} bytes are fetched, digest-verified, drawn as an isosurface and saved under the map identity`);
  }
  const catalog = await decodeInspectionCatalog(baseline.catalog ?? baseline.catalogWire);
  report.atomCatalogRows = catalog.rows.length;
  report.surface = surface;
  await page.screenshot({ path: resolve(out, `${demoName}-initial.png`) });
  const menu = frame.locator('[data-tour-menu]');
  await menu.waitFor({ state: volume ? 'attached' : 'visible' });
  const values = await menu.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  assert.ok(values.includes(tourId), `The tour menu must offer ${tourId}; it offered ${values.join(', ')}.`);
  const controlTour = async (action: string) => {
    let state: any, panel: any;
    const readyDeadline = Date.now() + 180_000;
    while (Date.now() < readyDeadline) {
      state = (await call('get_inspection_state', { sessionId })).structuredContent;
      panel = state.panels.find((candidate: any) => candidate.current && candidate.surface === surface && candidate.availability === 'ready');
      if (panel && !state.pendingCommand.length) break;
      await new Promise<void>(done => setTimeout(done, 150));
    }
    assert.ok(panel && !state.pendingCommand.length, 'The actual renderer must settle to a current ready panel binding.');
    const queued = await call('control_tour', { sessionId, panelId: panel.panelId, action, waitForRenderMs: 1000 });
    const commandId = queued.structuredContent.command.commandId;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const settled = (await call('get_inspection_state', { sessionId, commandId })).structuredContent;
      if (settled.command?.status === 'rendered' && !settled.pendingCommand.some((command: any) => command.commandId === commandId)) return;
      assert.ok(!['conflict', 'rejected', 'unconfirmed', 'cancelled', 'expired', 'superseded'].includes(settled.command?.status),
        `Tour ${action} failed: ${settled.command?.detail ?? settled.command?.reason ?? settled.command?.status}`);
      await new Promise<void>(done => setTimeout(done, 150));
    }
    throw Error(`Timed out waiting for tour ${action} rendered receipt and released command fence.`);
  };
  await menu.selectOption(tourId, { force: Boolean(volume) });
  // The public Next action starts an inactive selected lesson paused. This
  // preserves the real player/render path without racing an autoplay timer
  // while the acceptance process captures pixels under system load.
  await controlTour('next');
  await waitRenderedStep(sessionId, 1, tourId, surface);
  if (!volume) await expectStep(frame, 1, `${demoName} start`, 60_000);
  const scenes: any[] = [];
  const pixels = new Set<string>();
  report.steps = [];
  let expectedVisibility = baseline.scene.inspection.visibility ?? emptyVisibility();
  const rows = catalog.rows;
  const chains = availableChains(rows);
  const arrivalBuild = demoName === 'microtubule-arrival' && stage?.id === 'build';
  assert.ok(!growthOnly || arrivalBuild, '--grow-only supports only the microtubule-arrival build stage.');
  let buildPlacement: any;
  let previousVisibleChains: string[] = [];
  for (let step = 1; !growthOnly && step <= manifest.chapters.length; step++) {
    if (step > 1) {
      if (volume) await controlTour('next');
      else { await frame.locator('[data-tour-next]').click(); await expectStep(frame, step, `${demoName} scene ${step}`); }
    }
    const chapter = manifest.chapters[step - 1];
    if (chapter.immersive?.visibility) expectedVisibility = resolveVisibility(expectedVisibility, chapter.immersive.visibility,
      chains, { classes: componentClassesPresent(rows) });
    const { saved, panel } = await waitRenderedStep(sessionId, step, tourId, surface,
      chapter.immersive?.visibility ? expectedVisibility : undefined);
    const title: string | null = volume ? await frame.locator('[data-tour-title]').textContent() : await frame.locator('[data-tour-title]').innerText();
    const body: string | null = volume ? await frame.locator('[data-tour-body]').textContent() : await frame.locator('[data-tour-body]').innerText();
    assert.equal(title?.trim(), chapter.title, `Scene ${step} must carry its authored title.`);
    assert.equal(body?.trim(), chapter.caption, `Scene ${step} must carry its authored caption.`);
    scenes.push(saved.scene);
    const pixelHash = await canvasHash(frame);
    pixels.add(pixelHash);
    const record: any = { step, chapter: chapter.id, acknowledgedStep: panel.tour.step,
      navigating: panel.tour.navigating, savedRepresentation: saved.scene.inspection.appearance.representation, pixelHash,
      placement: saved.scene.inspection.placement,
      unchangedScene: step > 1 && JSON.stringify(saved.scene) === JSON.stringify(scenes[step - 2]) };
    if (renderObjectProbe) record.renderObjects = await frame.evaluate(() => {
      const probe = (globalThis as any).__stereofoldDemoRenderObjects;
      if (typeof probe !== 'function') throw Error('The test-only render-object probe was not installed.');
      return probe();
    });
    if (chapter.immersive?.visibility) {
      record.visibility = saved.scene.inspection.visibility;
      const visibleKeys = new Set(visibleRowKeys(rows, record.visibility));
      record.visiblePolymerChains = [...new Set(rows.filter((row: any) => row.entityType === 'polymer' && visibleKeys.has(row.key))
        .map((row: any) => row.identity.labelChain))].sort();
      if (arrivalBuild) {
        const authored = [...chapter.immersive.visibility.chains!].sort();
        assert.deepEqual(record.visiblePolymerChains, authored, `Chapter ${step} must draw exactly its cumulative polymer chains.`);
        assert.ok(previousVisibleChains.every(chain => record.visiblePolymerChains.includes(chain)), 'The build must retain every previously revealed copy.');
        previousVisibleChains = record.visiblePolymerChains;
        if (step === 1) buildPlacement = saved.scene.inspection.placement;
        assert.deepEqual(saved.scene.inspection.placement, buildPlacement, 'The reveal must retain its opening placement and scale.');
      }
    }
    if (volume) assert.equal(saved.scene.sourceSha256, entry.coordinates.sha256, 'Every density chapter must remain on the actual map source.');
    report.steps.push(record);
    await page.screenshot({ path: resolve(out, `${demoName}-scene-${step}.png`) });
  }
  if (!growthOnly) {
  assert.equal(scenes.length, manifest.chapters.length, 'Every authored chapter must play as a tour scene.');
  const expectsVisualChanges = manifest.chapters.slice(1).some(chapter => chapter.changes.some(change => change.kind !== 'hold')
    || chapter.immersive?.visibility || chapter.immersive?.placement || chapter.immersive?.view || chapter.immersive?.selection);
  if (expectsVisualChanges) assert.ok(pixels.size > 1, 'Authored visual transitions must visibly change the rendered molecule.');
  report.distinctCanvases = pixels.size;
  passed(`${demoName} acknowledges and saves all ${manifest.chapters.length} rendered chapters with their authored captions`);

  if (volume) await controlTour('back');
  else { await frame.locator('[data-tour-back]').click(); await expectStep(frame, manifest.chapters.length - 1, `${demoName} back`); }
  await waitRenderedStep(sessionId, manifest.chapters.length - 1, tourId, surface);
  const backed = await waitSaved(sessionId, data => JSON.stringify(data.scene) === JSON.stringify(scenes[scenes.length - 2]), 'Back to restore the previous scene');
  assert.deepEqual(backed.scene, scenes[scenes.length - 2], 'Back must restore the exact previous molecular scene.');
  if (arrivalBuild && JSON.stringify(scenes.at(-1)) === JSON.stringify(scenes.at(-2))) {
    // The closing inspection chapter legitimately holds the complete wall.
    // Step back once more to exercise restoration of an earlier reveal mask.
    await frame.locator('[data-tour-back]').click();
    const target = manifest.chapters.length - 2;
    await expectStep(frame, target, `${demoName} back to an earlier reveal`);
    await waitRenderedStep(sessionId, target, tourId, surface);
    const restored = await waitSaved(sessionId, data => JSON.stringify(data.scene) === JSON.stringify(scenes[target - 1]),
      'Back to restore the earlier reveal mask and placement');
    assert.deepEqual(restored.scene, scenes[target - 1]);
    report.backRestoredEarlierReveal = { step: target, visibility: restored.scene.inspection.visibility,
      placement: restored.scene.inspection.placement };
  }
  // Restart lives behind the player's collapsed Lesson options summary.
  if (volume) { await controlTour('restore-start'); await controlTour('next'); }
  else {
    await frame.locator('details.tour-more > summary').click();
    await frame.locator('[data-tour-restart]').click();
    await expectStep(frame, 1, `${demoName} restart`);
  }
  await waitRenderedStep(sessionId, 1, tourId, surface);
  passed(`${demoName} supports Back to the exact previous scene and Restart to scene one`);
  }

  if (arrivalBuild && (process.argv.includes('--grow') || growthOnly)) {
    // Open the final wall through the real paused tour transport, then let a
    // flat companion own the source transition. Room anchoring requires XR;
    // this check establishes source transport, map draw and session continuity.
    await controlTour('restore-start');
    await controlTour('back');
    await waitRenderedStep(sessionId, manifest.chapters.length, tourId, surface);
    closingDesktop = true;
    await page.close();
    const connected = await call('open_companion', { sessionId, connection: 'loopback', launch: 'none' });
    const url = connected.structuredContent.companion.url as string;
    const companionOrigin = new URL(url).origin;
    secrets.push(new URL(url).hash.slice(1));
    page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(180_000);
    await page.addInitScript({ content: 'globalThis.__name = value => value;' });
    page.on('pageerror', error => report.errors.push(redactTokens(error.message)));
    page.on('requestfailed', request => report.failedRequests.push({ route: requestRoute(request.url()), reason: request.failure()?.errorText }));
    await page.route('**/*', route => {
      if (route.request().url().startsWith(companionOrigin)) return route.continue();
      report.externalRequests.push(requestRoute(route.request().url())); return route.abort();
    });
    await page.goto(url);
    acceptancePage = page; frame = page.mainFrame(); acceptanceFrame = frame;
    await frame.locator('body[data-ready="true"]').waitFor();
    const readyDeadline = Date.now() + 180_000;
    let ready: any, panel: any;
    while (Date.now() < readyDeadline) {
      ready = (await call('get_inspection_state', { sessionId })).structuredContent;
      panel = ready.panels.find((candidate: any) => candidate.current && candidate.surface === 'companion' && candidate.availability === 'ready');
      if (panel && !ready.pendingCommand.length) break;
      await new Promise<void>(done => setTimeout(done, 150));
    }
    assert.ok(panel, 'The flat companion must render the outgoing wall before growing.');
    const before = await privateInspection(sessionId);
    const beforeKeys = new Set(visibleRowKeys(rows, before.scene.inspection.visibility));
    const beforeChains = [...new Set(rows.filter((row: any) => row.entityType === 'polymer' && beforeKeys.has(row.key))
      .map((row: any) => row.identity.labelChain))].sort();
    assert.deepEqual(beforeChains, [...manifest.chapters.at(-1)!.immersive!.visibility!.chains!].sort(),
      'Growth must start from the final wall mask.');
    report.growthBefore = { visiblePolymerChains: beforeChains, placement: before.scene.inspection.placement };
    await page.screenshot({ path: resolve(out, `${demoName}-grow-before.png`) });
    const response = page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/density'));
    const grown = (await call('grow_structure', { sessionId, serverEpoch: ready.serverEpoch, sourceToken: ready.sourceToken,
      baseStateRevision: ready.stateRevision, baseInspectionRevision: ready.inspectionRevision,
      panelId: panel.panelId, stage: 'next', device: 'quest2' })).structuredContent;
    assert.equal(grown.grow.refused, false);
    assert.equal(grown.grow.from, 'build'); assert.equal(grown.grow.to, 'density');
    const downloaded = await response;
    assert.equal(downloaded.status(), 200);
    const mapBytes = await downloaded.body();
    assert.equal(mapBytes.byteLength, grown.grow.density.bytes);
    assert.equal(createHash('sha256').update(mapBytes).digest('hex'), grown.grow.density.sha256);
    const deadline = Date.now() + 180_000;
    let landed: any;
    while (Date.now() < deadline) {
      landed = (await call('get_inspection_state', { sessionId })).structuredContent;
      if (landed.sourceRenderReceipt?.rendered === true && landed.sourceRenderReceipt?.status === 'rendered'
          && landed.sourceRenderReceipt.sourceToken === landed.sourceToken && landed.hasScene && landed.sourceToken !== ready.sourceToken
          && landed.panels.some((candidate: any) => candidate.panelId === landed.sourceRenderReceipt.panelId
            && candidate.current && candidate.surface === 'companion' && candidate.availability === 'ready')
          && landed.density?.sha256 === grown.grow.density.sha256) break;
      await new Promise<void>(done => setTimeout(done, 150));
    }
    report.growthState = { hasScene: landed.hasScene, sourceChanged: landed.sourceToken !== ready.sourceToken,
      stateRevision: landed.stateRevision, inspectionRevision: landed.inspectionRevision,
      currentReadyCompanion: landed.panels.some((candidate: any) => candidate.current && candidate.surface === 'companion' && candidate.availability === 'ready'),
      sourceRenderReceipt: landed.sourceRenderReceipt ? { rendered: landed.sourceRenderReceipt.rendered,
        status: landed.sourceRenderReceipt.status, renderedRevision: landed.sourceRenderReceipt.renderedRevision } : null,
      density: landed.density };
    assert.ok(report.growthState.hasScene && report.growthState.sourceChanged && report.growthState.currentReadyCompanion,
      'Growth must acknowledge a saved scene on a current ready companion under the new source binding.');
    assert.equal(landed.sourceRenderReceipt?.rendered, true, 'Growth must return a real rendered source receipt.');
    assert.equal(landed.sourceRenderReceipt?.status, 'rendered');
    assert.equal(landed.sourceRenderReceipt.sourceToken, landed.sourceToken);
    assert.ok(landed.panels.some((candidate: any) => candidate.panelId === landed.sourceRenderReceipt.panelId
      && candidate.current && candidate.surface === 'companion' && candidate.availability === 'ready'));
    assert.ok(Number.isInteger(landed.sourceRenderReceipt.renderedRevision)
      && landed.sourceRenderReceipt.renderedRevision <= landed.inspectionRevision,
      'The receipt must identify a saved revision of the current source.');
    const after = await waitSaved(sessionId, data => data.scene?.sourceSha256 === grown.grow.density.sha256,
      'the actual grown map scene');
    assert.equal(after.customTour.id, grown.grow.lessonId);
    assert.equal(after.scene.inspection.appearance.representation, 'isosurface');
    await page.screenshot({ path: resolve(out, `${demoName}-grow-density.png`) });
    report.growth = { from: grown.grow.from, to: grown.grow.to, deviceTier: grown.grow.deviceTier,
      sessionRetained: after.sessionId === sessionId, sourceSha256: after.scene.sourceSha256,
      bytes: mapBytes.byteLength, lessonId: after.customTour.id, readyAndSaved: true,
      sourceRenderReceiptPresent: landed.sourceRenderReceipt?.rendered === true,
      placementBefore: before.scene.inspection.placement, placementAfter: after.scene.inspection.placement,
      scope: 'Actual flat companion source transition. XR room center, diameter and orientation anchoring require an immersive session.' };
    assert.equal(report.growth.sessionRetained, true);
    passed('Quest2-class grow_structure replaces the wall with digest-verified rendered EMD-6347 density in the same flat companion session');
  }

  assert.deepEqual(report.errors, [], `The packaged inspector raised browser errors: ${JSON.stringify(report.errors)}`);
  assert.deepEqual(report.externalRequests, [], 'The isolated acceptance host must make no external requests.');
  assert.deepEqual(report.failedRequests, [], 'The flat companion must have no failed network requests.');
  report.status = 'passed';
} catch (error) {
  report.failure = scrubSecrets((error as Error).stack, secrets);
  report.stderr = redactTokens(stderr.slice(-4000));
  if (acceptancePage) {
    try { await acceptancePage.screenshot({ path: resolve(out, `${demoName}-failure.png`) }); }
    catch (screenshotError) { report.failureScreenshotError = String(screenshotError); }
  }
  if (acceptanceFrame) {
    try {
      report.tourUiAtFailure = await acceptanceFrame.evaluate(() => ({
        status: document.querySelector('[data-tour-status]')?.textContent,
        progress: document.querySelector('[data-tour-progress]')?.textContent,
      }));
    } catch (stateError) { report.tourUiAtFailureError = String(stateError); }
  }
  throw error;
} finally {
  report.networkBeforeCleanup = { errors: [...report.errors], externalRequests: [...report.externalRequests], failedRequests: [...report.failedRequests] };
  await disposeStep('browserClosed', () => browser?.close() ?? Promise.resolve());
  await disposeStep('mcpClosed', () => client.close());
  await disposeStep('listenerClosed', () => new Promise<void>(done => host ? host.close(() => done()) : done()));
  await disposeStep('privateSceneServiceRemoved', () => rm(privateSceneService, { force: true }));
  await disposeStep('reportWritten', () => writeFile(resolve(out, `${demoName}-report.json`), `${JSON.stringify(scrubSecrets(report, secrets), null, 2)}\n`));
  console.log(JSON.stringify(scrubSecrets(report, secrets), null, 2));
}

async function disposeStep(step: string, work: () => Promise<unknown>) {
  try { await work(); report.cleanup[step] = true; }
  catch (cleanupError) { report.cleanup[step] = false; (report.cleanupErrors ??= []).push(`${step}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
}

async function expectStep(frame: Frame, step: number, description: string, timeout = 180_000) {
  await frame.locator('[data-tour-progress]').waitFor({ state: 'visible', timeout });
  await frame.waitForFunction(step => {
    const text = document.querySelector('[data-tour-progress]')?.textContent ?? '';
    return new RegExp(`(?:${step}\\s*(?:/|of)\\s*\\d+|step\\s*${step})`, 'i').test(text);
  }, step, { timeout });
  assert.match(await frame.locator('[data-tour-progress]').innerText(), new RegExp(`${step}\\s*(?:/|of)\\s*\\d+|step\\s*${step}`, 'i'), `${description} must report step ${step}.`);
}
