import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Frame, type Page } from 'playwright';
import { demoCacheDirectory, readDemoIndex, readDemoLesson, resolveCoordinates, resolveDemoStage, resolveVolumeStructure } from './quest-demo.js';
import { redactTokens, requestRoute, scrubSecrets } from './report-redaction.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { instrumentDemoRenderObjects } from './demo-render-probe.js';
import { readAddressedDemoFile } from '../src/addressed-demo-cache.js';
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
const stageId = process.argv[4]?.startsWith('--') ? undefined : process.argv[4];
const cachedOnly = process.argv.includes('--cached-only');
const growthOnly = process.argv.includes('--grow-only');
const renderObjectProbe = process.argv.includes('--render-object-probe');
const readability = process.argv.includes('--readability');
const verifyCaptionAccess = process.argv.includes('--verify-caption-access');
assert.ok(!verifyCaptionAccess || readability, '--verify-caption-access requires --readability.');
assert.ok(demoName && outArgument, 'Supply a demo name and a fresh artifact directory.');
const out = resolve(outArgument);
await mkdir(out, { recursive: false });

const runStartedAt = Date.now();
const report: any = { startedAt: new Date().toISOString(), commandReceipts: [], completionReceipts: [], demo: demoName, ...(stageId ? { stage: stageId } : {}), status: 'failed', cases: [], errors: [], externalRequests: [], failedRequests: [], cleanup: {},
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
let activeSessionId: string | undefined;
const safeReceipt = (data: any) => ({ accepted: data?.accepted, inspectionRevision: data?.inspectionRevision,
  status: data?.command?.status, reason: data?.command?.reason, detail: redactTokens(data?.command?.detail),
  renderedRevision: data?.command?.renderedRevision });

const call = async (name: string, args: Record<string, unknown>) => {
  const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!result.isError, `stereo_structure.${name}: ${redactTokens(String(result.content?.[0]?.text ?? 'failed'))}`);
  return result;
};
const privateInspection = async (sessionId: string) => (await call('get_inspection', { sessionId }))._meta['stereo_structure/inspection'];
async function waitSaved(sessionId: string, predicate: (data: any) => boolean, description: string) {
  const deadline = Date.now() + (description.startsWith('Back') ? 20_000 : 180_000);
  while (Date.now() < deadline) {
    const data = await privateInspection(sessionId);
    if (description === 'Back to restore the previous scene') report.backComparison.actual = data.scene;
    if (predicate(data)) return data;
    await new Promise<void>(done => setTimeout(done, 150));
  }
  throw Error(`Timed out waiting for ${description}.`);
}
function comparableBackScene(scene: any, refitsFigure: boolean, animated = false) {
  const value = structuredClone(scene);
  // A source-entry marker describes the first visit, not subsequent Back.
  if (value.inspection?.lessonPlayback) delete value.inspection.lessonPlayback.entry;
  if (refitsFigure) delete value.camera;
  // A visit restarts its authored clip; definition and playback policy stay exact.
  if (animated && value.inspection?.animation?.playback) {
    delete value.inspection.animation.playback.timeSeconds;
    delete value.inspection.animation.playback.state;
  }
  return value;
}
function sameBackScene(actual: any, expected: any) {
  const left = structuredClone(actual), right = structuredClone(expected);
  if (left?.camera || right?.camera) {
    if (!left?.camera || !right?.camera) return false;
    for (const key of ['position', 'target', 'up']) {
      const a = left.camera[key], b = right.camera[key];
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 3 || b.length !== 3) return false;
      for (let index = 0; index < 3; index++) {
        if (!Number.isFinite(a[index]) || !Number.isFinite(b[index])) return false;
        // Camera matrix round trips can differ by a few floating-point steps.
        // Four machine epsilons at the component's magnitude (unit floor near
        // zero) admit that noise only; all other camera and scene fields stay exact.
        const tolerance = 4 * Number.EPSILON * Math.max(1, Math.abs(a[index]), Math.abs(b[index]));
        if (Math.abs(a[index] - b[index]) > tolerance) return false;
        a[index] = b[index];
      }
    }
  }
  return isDeepStrictEqual(left, right);
}
function assertFigureCamera(actual: any, expected: any) {
  for (const key of ['position', 'target', 'up'])
    assert.ok(Array.isArray(actual[key]) && actual[key].length === 3 && actual[key].every(Number.isFinite), `Finite camera ${key}`);
  assert.ok(Number.isFinite(actual.fov) && actual.fov > 0 && Number.isFinite(actual.radius) && actual.radius > 0);
  assert.ok(Number.isFinite(actual.radiusMax) && actual.radiusMax >= actual.radius - 1e-6);
  assert.equal(actual.mode, expected.mode); assert.equal(actual.fov, expected.fov); assert.deepEqual(actual.up, expected.up);
  const direction = (camera: any) => { const v = camera.target.map((x: number, i: number) => x - camera.position[i]); const n = Math.hypot(...v); assert.ok(n > 0); return v.map((x: number) => x / n); };
  const a = direction(actual), b = direction(expected);
  assert.ok(a.every((x: number, i: number) => Math.abs(x - b[i]) < 1e-7), 'Figure refit must preserve viewing direction');
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
if (cachedOnly) {
  const cached = async (source: { file: string; sha256: string }) => {
    assert.ok(await readAddressedDemoFile(file => resolve(demoCacheDirectory(), file), source.file, source.sha256),
      `--cached-only: missing verified ${source.file}`);
  };
  await cached(entry.coordinates);
  if (entry.coordinates.volume) await cached(entry.coordinates.volume.structure);
}
const coordinatePath = await resolveCoordinates(entry, demoCacheDirectory(), message => console.log(message));
const volume = entry.coordinates.volume;
assert.ok(!renderObjectProbe || !volume, '--render-object-probe supports the isolated atomic inspector only.');
if (renderObjectProbe) {
  report.instrumentation = 'Test-only read-only render-object accessor injected into served inspector HTML; distributed files are unchanged. This run is not byte-identical production HTML.';
  report.scope += ' Render-object counts describe this instrumented flat Chromium run, not Quest frame rate or immersive GPU cost.';
}
const structurePath = volume ? await resolveVolumeStructure(entry, demoCacheDirectory(), message => console.log(message)) : coordinatePath;
const lessonPath = resolve('demos', entry.lesson);
report.harnessSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
report.cachedOnly = cachedOnly;
report.timingScope = 'First chapter includes browser mount and hydration; later chapters run from input to current-ready saved cursor, excluding screenshots. Observational timings, not a device benchmark.';
report.bundle = { serverSha256: createHash('sha256').update(await readFile(resolve('dist/server.mjs'))).digest('hex') };
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
  activeSessionId = sessionId;
  const tourId = opened.structuredContent.customTourId as string;
  report.openMs = Date.now() - openedAt;
  report.atomSites = opened.structuredContent.atomSites;
  report.openedAssemblyId = opened.structuredContent.assemblyId;
  assert.equal(tourId, `lesson-${manifest.id}`, 'The demo lesson must register its own tour.');
  assert.equal(report.atomSites, volume?.structure.atomSites ?? entry.coordinates.atomSites,
    'The opened catalog must carry the declared reference-coordinate atom-site count.');
  if (entry.coordinates.assemblyId) assert.equal(report.openedAssemblyId, entry.coordinates.assemblyId, 'The opened catalog must be the requested assembly.');
  passed(`inspect_lesson opens ${entry.pdbId ?? entry.sourceId ?? entry.name} with the ${demoName}${stage ? ` ${stage.id}` : ''} lesson at assembly ${report.openedAssemblyId} and registers ${tourId}`);

  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  const resourceHtml = (resource.contents[0] as any).text as string;
  report.bundle.inspectorSha256 = createHash('sha256').update(resourceHtml).digest('hex');
  const mountStartedAt = Date.now();
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
  await page.exposeFunction('__call', async (payload: any) => {
    const result: any = await client.callTool({ name: payload.name, arguments: payload.arguments ?? {} });
    if (payload.name.endsWith('complete_inspection')) report.completionReceipts.push({
      phase: payload.arguments?.phase ?? 'complete', atMs: Date.now() - runStartedAt, ...safeReceipt(result.structuredContent) });
    return result;
  });
  await page.goto(origin);
  await page.evaluate(({ resource, result }) => (window as any).__host.mount(resource, result, { theme: 'dark' }), { resource: html, result: opened });
  let frame = page.frames().find(candidate => candidate !== page.mainFrame());
  assert.ok(frame, 'The controlled host must create an inspector frame.');
  const desktopFrame = frame;
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
    const mapBadge = await frame.locator('.scene-heading .source-code').textContent();
    const mapCaption = await frame.locator('.canvas-caption > span').first().textContent();
    assert.equal(mapBadge, 'Density map', 'A drawn density map must not inherit the reference coordinate format badge.');
    assert.ok(mapCaption?.endsWith(' · ISOSURFACE'), 'The map caption must identify the isosurface rather than report zero chains.');
    report.density.display = { badge: mapBadge, caption: mapCaption };
    surface = 'companion';
    passed(`${volume.emdbId} bytes are fetched, digest-verified, drawn as an isosurface and saved under the map identity`);
  }
  report.mountReadyMs = Date.now() - mountStartedAt;
  const catalog = await decodeInspectionCatalog(baseline.catalog ?? baseline.catalogWire);
  report.atomCatalogRows = catalog.rows.length;
  report.surface = surface;
  await page.screenshot({ path: resolve(out, `${demoName}-initial.png`) });
  const menu = frame.locator('[data-tour-menu]');
  await menu.waitFor({ state: volume ? 'attached' : 'visible' });
  const values = await menu.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  assert.ok(values.includes(tourId), `The tour menu must offer ${tourId}; it offered ${values.join(', ')}.`);
  const renderCommand = async (tool: string, args: Record<string, unknown>) => {
    const action = String(args.action ?? tool);
    const startedAt = Date.now();
    let state: any, panel: any;
    const readyDeadline = Date.now() + 180_000;
    while (Date.now() < readyDeadline) {
      state = (await call('get_inspection_state', { sessionId })).structuredContent;
      panel = state.panels.find((candidate: any) => candidate.current && candidate.surface === surface && candidate.availability === 'ready');
      if (panel && !state.pendingCommand.length) break;
      await new Promise<void>(done => setTimeout(done, 150));
    }
    assert.ok(panel && !state.pendingCommand.length, 'The actual renderer must settle to a current ready panel binding.');
    const queued = await call(tool, { sessionId, panelId: panel.panelId, ...args, waitForRenderMs: 1000 });
    const commandId = queued.structuredContent.command.commandId;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const settled = (await call('get_inspection_state', { sessionId, commandId })).structuredContent;
      // A draw receipt can precede the renderer's final busy -> ready heartbeat.
      if (settled.command?.status === 'rendered' && !settled.pendingCommand.some((command: any) => command.commandId === commandId)
        && settled.panels.some((candidate: any) => candidate.current && candidate.surface === surface && candidate.availability === 'ready')) {
        report.commandReceipts.push({ tool, action, elapsedMs: Date.now() - startedAt, ...safeReceipt(settled) });
        return;
      }
      assert.ok(!['conflict', 'rejected', 'unconfirmed', 'cancelled', 'expired', 'superseded'].includes(settled.command?.status),
        `Tour ${action} failed: ${settled.command?.detail ?? settled.command?.reason ?? settled.command?.status}`);
      await new Promise<void>(done => setTimeout(done, 150));
    }
    throw Error(`Timed out waiting for tour ${action} rendered receipt and released command fence.`);
  };
  const controlTour = (action: string) => renderCommand('control_tour', { action });
  const checkReferenceDesktop = async () => {
    await desktopFrame.waitForFunction(id => ![...document.querySelectorAll<HTMLSelectElement>('[data-tour-menu] option')]
      .some(option => option.value === id) && document.querySelector('.canvas-caption > span')?.textContent === 'REFERENCE COORDINATES', tourId, { timeout: 20_000 });
    const state = (await call('get_inspection_state', { sessionId })).structuredContent;
    const reference = state.panels.find((panel: any) => panel.surface === 'desktop');
    assert.equal(reference?.referenceOnly, true, 'The reference desktop must not own the density scene');
    const saved = await privateInspection(sessionId);
    assert.equal(saved.scene.sourceSha256, entry.coordinates.sha256, 'The companion map must remain authoritative');
    return { caption: await desktopFrame.locator('.canvas-caption > span').first().textContent(), offersDensityLesson: false,
      referenceOnly: reference.referenceOnly, mapSourceSha256: saved.scene.sourceSha256, history: state.history };
  };
  if (volume) report.referenceDesktopBefore = await checkReferenceDesktop();
  // inspect_lesson installs and draws chapter one during source hydration.
  // Reselecting here would clear its baseline and race that local save with
  // an external Next command, rather than test the opened lesson.
  const firstChapterStartedAt = mountStartedAt;
  // A flat density companion deliberately defers automatic start for XR.
  // Explicit Next tests its supported flat transport while desktop stays open.
  if (volume) await controlTour('next');
  const installed = await waitRenderedStep(sessionId, 1, tourId, surface);
  assert.equal(installed.panel.tour.active, true, 'The opening chapter must be active');
  assert.equal(installed.saved.scene.sourceSha256, entry.coordinates.sha256);
  report.openingChapter = { installed: true, active: installed.panel.tour.active,
    step: installed.panel.tour.step, ready: installed.panel.availability, current: installed.panel.current,
    sourceMatched: true, savedRevision: installed.state.inspectionRevision };
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
  let captionScrolledBeforeNext = false;
  for (let step = 1; !growthOnly && step <= manifest.chapters.length; step++) {
    const transitionStartedAt = step === 1 ? firstChapterStartedAt : Date.now();
    if (step > 1) {
      if (volume) await controlTour('next');
      else { await frame.locator('[data-tour-next]').click(); await expectStep(frame, step, `${demoName} scene ${step}`); }
    }
    const chapter = manifest.chapters[step - 1];
    if (chapter.immersive?.visibility) expectedVisibility = resolveVisibility(expectedVisibility, chapter.immersive.visibility,
      chains, { classes: componentClassesPresent(rows) });
    const { saved, panel, state } = await waitRenderedStep(sessionId, step, tourId, surface,
      chapter.immersive?.visibility ? expectedVisibility : undefined);
    if (captionScrolledBeforeNext) {
      assert.equal(await frame.locator('.tour-player-scene').evaluate(element => element.scrollTop), 0,
        'A new chapter must open its caption at the beginning after the previous caption was scrolled.');
      captionScrolledBeforeNext = false;
      (report.captionChapterReset ??= []).push(step);
    }
    const transitionMs = Date.now() - transitionStartedAt;
    const title: string | null = volume ? await frame.locator('[data-tour-title]').textContent() : await frame.locator('[data-tour-title]').innerText();
    const body: string | null = volume ? await frame.locator('[data-tour-body]').textContent() : await frame.locator('[data-tour-body]').innerText();
    assert.equal(title?.trim(), chapter.title, `Scene ${step} must carry its authored title.`);
    assert.equal(body?.trim(), chapter.caption, `Scene ${step} must carry its authored caption.`);
    scenes.push(saved.scene);
    const pixelHash = await canvasHash(frame);
    pixels.add(pixelHash);
    const record: any = { step, transitionMs, readyPanel: panel.availability === 'ready',
      savedRevision: state.inspectionRevision, sourceMatched: saved.scene.sourceSha256 === entry.coordinates.sha256, chapter: chapter.id, acknowledgedStep: panel.tour.step,
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
    assert.equal(saved.scene.sourceSha256, entry.coordinates.sha256, 'Every chapter must remain on the verified coordinate or density source.');
    report.steps.push(record);
    await page.screenshot({ path: resolve(out, `${demoName}-scene-${step}.png`) });
    if (readability && !volume) {
      record.readability = [];
      for (const size of [{ width: 1200, height: 800 }, { width: 900, height: 700 }, { width: 600, height: 700 }]) {
        await page.setViewportSize(size);
        // Mol* debounces element resize before updating its drawing buffer.
        // Two animation frames can still expose the previous panel dimensions.
        await frame.waitForFunction(() => {
          const canvas = document.querySelector<HTMLCanvasElement>('.stage canvas')!;
          const stage = document.querySelector<HTMLElement>('.stage')!;
          return Math.abs(canvas.clientWidth - stage.clientWidth) <= 1
            && Math.abs(canvas.clientHeight - stage.clientHeight) <= 1;
        }, undefined, { timeout: 5000 });
        await frame.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        const caption = frame.locator('.tour-player-scene');
        const dimensions = await caption.evaluate(element => {
          const caption = element as HTMLElement;
          const canvas = document.querySelector('.stage canvas')!.getBoundingClientRect();
          const next = document.querySelector('[data-tour-next]')!.getBoundingClientRect();
          const hint = document.querySelector<HTMLElement>('[data-tour-scroll-hint]');
          return { canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height },
            caption: { clientHeight: caption.clientHeight, scrollHeight: caption.scrollHeight, tabIndex: caption.tabIndex,
              role: caption.getAttribute('role'), label: caption.getAttribute('aria-label') },
            nextControlVisible: next.bottom <= innerHeight && next.right <= innerWidth && next.top >= 0,
            scrollHintVisible: Boolean(hint && !hint.hidden) };
        });
        if (verifyCaptionAccess) {
          assert.equal(dimensions.caption.tabIndex, 0); assert.equal(dimensions.caption.role, 'region');
          assert.equal(dimensions.caption.label, 'Lesson caption and sources');
          assert.ok(dimensions.nextControlVisible, 'Caption must leave chapter controls accessible.');
          if (dimensions.caption.scrollHeight > dimensions.caption.clientHeight + 2) {
            assert.ok(dimensions.scrollHintVisible, 'Overflowing captions need a visible scroll cue.');
            await caption.focus(); await caption.press('PageDown');
            await frame.waitForFunction(() => document.querySelector('.tour-player-scene')!.scrollTop > 0, undefined, { timeout: 2000 });
            await caption.press('End');
            await frame.waitForFunction(() => {
              const region = document.querySelector('.tour-player-scene')!;
              return region.scrollTop + region.clientHeight >= region.scrollHeight - 2;
            }, undefined, { timeout: 2000 });
            assert.equal(await frame.locator('[data-tour-scroll-hint]').isVisible(), false, 'The cue clears once the end is reached.');
            (dimensions as any).keyboardScrollPassed = true;
            await caption.evaluate(element => { element.scrollTop = 0; (element as HTMLElement).blur(); });
          }
        }
        await page.screenshot({ path: resolve(out, `${demoName}-scene-${step}-${size.width}x${size.height}.png`) });
        record.readability.push({ viewport: size, ...dimensions });
      }
      await page.setViewportSize({ width: 1200, height: 800 });
      await frame.waitForFunction(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('.stage canvas')!;
        const stage = document.querySelector<HTMLElement>('.stage')!;
        return Math.abs(canvas.clientWidth - stage.clientWidth) <= 1
          && Math.abs(canvas.clientHeight - stage.clientHeight) <= 1;
      }, undefined, { timeout: 5000 });
      await frame.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      if (verifyCaptionAccess && step < manifest.chapters.length) {
        captionScrolledBeforeNext = await frame.locator('.tour-player-scene').evaluate(element => {
          element.scrollTop = element.scrollHeight;
          return element.scrollTop > 0;
        });
      }
    }
  }
  if (!growthOnly) {
  assert.equal(scenes.length, manifest.chapters.length, 'Every authored chapter must play as a tour scene.');
  const expectsVisualChanges = manifest.chapters.slice(1).some(chapter => chapter.changes.some(change => change.kind !== 'hold')
    || chapter.immersive?.visibility || chapter.immersive?.placement || chapter.immersive?.view || chapter.immersive?.selection);
  if (expectsVisualChanges) assert.ok(pixels.size > 1, 'Authored visual transitions must visibly change the rendered molecule.');
  report.distinctCanvases = pixels.size;
  passed(`${demoName} acknowledges and saves all ${manifest.chapters.length} rendered chapters with their authored captions`);

  const backStartedAt = Date.now();
  if (scenes.length > 1) {
  if (volume) await controlTour('back');
  else { await frame.locator('[data-tour-back]').click(); await expectStep(frame, manifest.chapters.length - 1, `${demoName} back`); }
  await waitRenderedStep(sessionId, manifest.chapters.length - 1, tourId, surface);
  const backChapterDefinition = manifest.chapters[scenes.length - 2];
  const backChapter = backChapterDefinition.immersive;
  const animatedBack = Boolean(backChapterDefinition.animation);
  const refitsFigure = Boolean(!volume && backChapter?.figure
    && !(backChapter.emphasis?.framing && backChapter.emphasis.focus?.length));
  const expectedBack = scenes[scenes.length - 2];
  report.backComparison = { expected: expectedBack, refitsFigure };
  const backed = await waitSaved(sessionId, data => sameBackScene(comparableBackScene(data.scene, refitsFigure, animatedBack),
    comparableBackScene(expectedBack, refitsFigure, animatedBack)), 'Back to restore the previous scene');
  assert.ok(sameBackScene(comparableBackScene(backed.scene, refitsFigure, animatedBack), comparableBackScene(expectedBack, refitsFigure, animatedBack)),
    'Back must restore the previous source, scientific state and placement.');
  if (refitsFigure) {
    assertFigureCamera(backed.scene.camera, expectedBack.camera);
    report.backFigureCamera = { expected: expectedBack.camera, actual: backed.scene.camera, invariantsPassed: true };
  }
  if (animatedBack) {
    const definition = backChapterDefinition.animation!;
    const playback = backed.scene.inspection.animation.playback;
    const validate = (sample: any) => {
      assert.ok(sample && sample.id === playback.id && sample.chapterId === backChapterDefinition.id, 'Back must own the authored clip');
      assert.equal(sample.durationSeconds, definition.durationSeconds);
      assert.equal(sample.speed, definition.playback?.speed ?? 1);
      assert.equal(sample.loop, definition.playback?.loop ?? false);
      assert.ok(Number.isFinite(sample.timeSeconds) && sample.timeSeconds >= 0 && sample.timeSeconds <= sample.durationSeconds);
      const ended = !sample.loop && sample.state === 'paused' && sample.timeSeconds === sample.durationSeconds;
      if (definition.playback?.autoplay !== false) assert.ok(sample.state === 'playing' || ended, 'Authored playing clip must play or finish');
      else assert.equal(sample.state, 'paused', 'Authored paused clip must remain paused');
      return ended;
    };
    validate(playback);
    const samples: any[] = [];
    const deadline = Date.now() + 8_000;
    let advancing = false;
    while (Date.now() < deadline) {
      const state = (await call('get_inspection_state', { sessionId })).structuredContent;
      const panel = state.panels.find((candidate: any) => candidate.current && candidate.surface === surface && candidate.availability === 'ready');
      const sample = panel?.animation;
      if (sample?.chapterId === backChapterDefinition.id) {
        const ended = validate(sample); samples.push({ ...sample, observedAtMs: Date.now() - runStartedAt });
        if (ended || (samples.length > 1 && sample.timeSeconds !== samples[0].timeSeconds)) { advancing = true; break; }
        if (definition.playback?.autoplay === false && samples.length > 1) { assert.equal(sample.timeSeconds, samples[0].timeSeconds); advancing = true; break; }
      }
      await new Promise<void>(done => setTimeout(done, 250));
    }
    report.backAnimationClock = { authoredAutoplay: definition.playback?.autoplay !== false, savedAtRestart: playback, samples, validProgression: advancing };
    assert.ok(advancing, 'Back animation clock must advance, complete, or hold when authored paused');
  }
  if (demoName === 'daraxonrasib' && refitsFigure) {
    await frame.locator('[data-tour-next]').click(); await expectStep(frame, 2, 'repeat Next');
    await waitRenderedStep(sessionId, 2, tourId, surface);
    await frame.locator('[data-tour-back]').click(); await expectStep(frame, 1, 'repeat Back');
    const repeated = await waitRenderedStep(sessionId, 1, tourId, surface);
    assert.deepEqual(comparableBackScene(repeated.saved.scene, true), comparableBackScene(backed.scene, true));
    assertFigureCamera(repeated.saved.scene.camera, backed.scene.camera);
    for (const key of ['position', 'target', 'up', 'radius', 'radiusMax']) {
      const previous = [backed.scene.camera[key]].flat(), next = [repeated.saved.scene.camera[key]].flat();
      assert.ok(next.every((value: number, i: number) => Math.abs(value - previous[i]) < 1e-5), `Repeat Back camera ${key} must remain stable`);
    }
    report.repeatBack = { stable: true, cameraBefore: backed.scene.camera, cameraAfter: repeated.saved.scene.camera };
  }
  if (arrivalBuild && JSON.stringify(scenes.at(-1)) === JSON.stringify(scenes.at(-2))) {
    // The closing inspection chapter legitimately holds the complete wall.
    // Step back once more to exercise restoration of an earlier reveal mask.
    await frame.locator('[data-tour-back]').click();
    const target = manifest.chapters.length - 2;
    await expectStep(frame, target, `${demoName} back to an earlier reveal`);
    await waitRenderedStep(sessionId, target, tourId, surface);
    const restored = await waitSaved(sessionId, data => sameBackScene(data.scene, scenes[target - 1]),
      'Back to restore the earlier reveal mask and placement');
    assert.ok(sameBackScene(restored.scene, scenes[target - 1]));
    report.backRestoredEarlierReveal = { step: target, visibility: restored.scene.inspection.visibility,
      placement: restored.scene.inspection.placement };
  }
  report.backMs = Date.now() - backStartedAt;
  } else report.backSkipped = 'Single-chapter lesson has no previous authored chapter.';
  const restartStartedAt = Date.now();
  // Restart lives behind the player's collapsed Lesson options summary.
  if (volume) { await controlTour('restore-start'); await controlTour('next'); }
  else {
    await frame.locator('details.tour-more > summary').click();
    await frame.locator('[data-tour-restart]').click();
    await expectStep(frame, 1, `${demoName} restart`);
  }
  await waitRenderedStep(sessionId, 1, tourId, surface);
  report.restartMs = Date.now() - restartStartedAt;
  passed(`${demoName} supports ${scenes.length > 1 ? 'Back to the previous scientific scene and ' : ''}Restart to scene one`);
  }


  if (volume) {
    report.referenceDesktopAfter = await checkReferenceDesktop();
    const beforeHistory = await privateInspection(sessionId);
    const originalOpacity = beforeHistory.scene.inspection.appearance.opacity;
    const testOpacity = originalOpacity === 0.82 ? 0.67 : 0.82;
    report.mapHistory = [];
    for (const [tool, args, opacity] of [
      ['update_inspection', { change: { kind: 'appearance', patch: { opacity: testOpacity } } }, testOpacity],
      ['undo_last_change', {}, originalOpacity], ['redo_last_change', {}, testOpacity], ['undo_last_change', {}, originalOpacity],
    ] as const) {
      await renderCommand(tool, args);
      const saved = await waitSaved(sessionId, data => data.scene?.sourceSha256 === entry.coordinates.sha256
        && data.scene.inspection.appearance.opacity === opacity, `${tool} to retain map-owned history`);
      const state = (await call('get_inspection_state', { sessionId })).structuredContent;
      assert.ok(state.panels.some((panel: any) => panel.surface === 'companion' && panel.current && panel.availability === 'ready'));
      report.mapHistory.push({ tool, sourceSha256: saved.scene.sourceSha256, opacity, history: state.history });
    }
    await checkReferenceDesktop();
    passed('The reference desktop stays open while companion map identity and Undo/Redo history remain authoritative');
    const atomic = index.demos.find(demo => demo.name === 'tubulin-dimer')!;
    await call('replace_inspection_source', { sessionId, demo: atomic.name, waitForRenderMs: 40_000 });
    await waitSaved(sessionId, data => data.scene?.sourceSha256 === atomic.coordinates.sha256, 'atomic source recovery');
    await desktopFrame.waitForFunction(() => [...document.querySelectorAll<HTMLOptionElement>('[data-tour-menu] option')]
      .some(option => option.value === 'lesson-tubulin-dimer') && document.querySelector('.canvas-caption > span')?.textContent !== 'REFERENCE COORDINATES', undefined, { timeout: 60_000 });
    let atomicState: any;
    const atomicDesktopDeadline = Date.now() + 20_000;
    do {
      atomicState = (await call('get_inspection_state', { sessionId })).structuredContent;
      if (atomicState.panels.some((panel: any) => panel.surface === 'desktop' && panel.current
        && panel.availability === 'ready' && !panel.referenceOnly)) break;
      await new Promise<void>(done => setTimeout(done, 150));
    } while (Date.now() < atomicDesktopDeadline);
    assert.ok(atomicState.panels.some((panel: any) => panel.surface === 'desktop' && panel.current
      && panel.availability === 'ready' && !panel.referenceOnly), 'The restored atomic desktop must reattach as current and ready.');
    report.atomicRecovery = { sourceSha256: atomic.coordinates.sha256, desktopCustomTourRestored: true, referenceOnly: false };
    passed('An atomic source replacement restores the desktop custom lesson choices');
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
  if (activeSessionId) {
    try {
      const state = (await call('get_inspection_state', { sessionId: activeSessionId })).structuredContent;
      report.stateAtFailure = { hasScene: state.hasScene, stateRevision: state.stateRevision, inspectionRevision: state.inspectionRevision,
        pendingCommand: state.pendingCommand.map((command: any) => ({ kind: command.kind, status: command.status, reason: command.reason, detail: redactTokens(command.detail) })),
        panels: state.panels.map((panel: any) => ({ surface: panel.surface, current: panel.current, availability: panel.availability, tour: panel.tour })) };
    } catch (stateError) { report.stateAtFailureError = redactTokens(String(stateError)); }
  }
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
  report.totalMs = Date.now() - runStartedAt;
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
