#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { inflateSync } = require('node:zlib');

const repo = path.resolve(__dirname, '../..');
const pluginRequire = createRequire(path.join(repo, 'plugin/package.json'));
const { chromium } = pluginRequire('playwright');
const {
  installReferenceSpaceAdapter,
  installPresentationDepthAdapter,
  installSceneDepthAdapter,
} = require('../headset-preview/adapters.cjs');
const { installProbe, launchViewer } = require('../headset-preview/probe.cjs');
const { framing, eyes } = require('../headset-preview/assertions.cjs');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const RUNTIME_SHA256 = '4a3d7610fc263655e73311a61dc4d6d4f8004e5dc83f9f163f2e17934e31817b';
const RUNTIME_BYTES = 195151;
const DEFAULT_APPEARANCE = {
  representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
  opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0,
};
const DEFAULT_PLACEMENT = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
const MIME = new Map([
  ['.html', 'text/html'], ['.js', 'application/javascript'], ['.css', 'text/css'],
  ['.json', 'application/json'], ['.ttf', 'font/ttf'], ['.txt', 'text/plain'],
]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Decode Playwright's own 8-bit RGB/RGBA screenshots. This keeps the color
// assertions independent of CSS state and of a WebGL preserveDrawingBuffer flag.
function inspectPng(bytes) {
  assert.equal(bytes.readUInt32BE(0), 0x89504e47, 'Screenshot is not a PNG.');
  let offset = 8, width, height, bitDepth, colorType, interlace, compressed = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length); offset += length + 12;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8];
      colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') break;
  }
  assert.equal(bitDepth, 8); assert.equal(interlace, 0);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(channels, `Unsupported screenshot PNG color type ${colorType}.`);
  const packed = inflateSync(Buffer.concat(compressed));
  const stride = width * channels, pixels = Buffer.alloc(stride * height);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = packed[input++];
    for (let x = 0; x < stride; x++) {
      const raw = packed[input++], left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : NaN;
      assert.ok(Number.isFinite(predictor), `Unsupported PNG filter ${filter}.`);
      pixels[y * stride + x] = (raw + predictor) & 255;
    }
  }
  const rgba = at => [pixels[at], pixels[at + 1], pixels[at + 2], channels === 4 ? pixels[at + 3] : 255];
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
    .map(([x, y]) => rgba(y * stride + x * channels));
  const background = [0, 1, 2, 3].map(channel => Math.round(corners.reduce((sum, pixel) => sum + pixel[channel], 0) / corners.length));
  let foregroundPixels = 0, sum = [0, 0, 0, 0], bounds = [width, height, -1, -1];
  const unique = new Set();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = rgba(y * stride + x * channels);
    if (unique.size < 512) unique.add(pixel.join(','));
    if (Math.max(...pixel.map((value, channel) => Math.abs(value - background[channel]))) <= 10) continue;
    foregroundPixels++;
    for (let channel = 0; channel < 4; channel++) sum[channel] += pixel[channel];
    bounds = [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)];
  }
  return { width, height, background, foregroundPixels, foregroundMean: foregroundPixels
    ? sum.map(value => Math.round(value / foregroundPixels)) : null,
  foregroundBounds: foregroundPixels ? bounds : null, colorsObservedUpTo512: unique.size };
}

const cameraDistance = camera => Math.hypot(...camera.position.map((value, index) => value - camera.target[index]));
const cameraDirection = camera => {
  const distance = cameraDistance(camera);
  return camera.position.map((value, index) => (value - camera.target[index]) / distance);
};
const near = (actual, expected, tolerance = 1e-6) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance,
    `Expected ${value} to be within ${tolerance} of ${expected[index]}.`));
};
const captureCore = capture => ({
  sourceSha256: capture.sourceSha256, modelNumber: capture.modelNumber, assemblyId: capture.assemblyId,
  selectionKeys: structuredClone(capture.selectionKeys), camera: structuredClone(capture.camera),
  appearance: structuredClone(capture.inspection.appearance), placement: structuredClone(capture.inspection.placement),
});

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 6 && args[0] === '--build' && args[2] === '--xr-runtime' && args[4] === '--out'
    && [args[1], args[3], args[5]].every(path.isAbsolute),
  'Use --build /absolute/build --xr-runtime /absolute/iwer.min.js --out /absolute/new-directory');
  assert.ok((await fs.lstat(args[1])).isDirectory(), 'Build must be a real directory.');
  assert.ok((await fs.lstat(args[3])).isFile(), 'XR runtime must be a regular file, not a symlink.');
  const buildDir = await fs.realpath(args[1]);
  const runtimePath = await fs.realpath(args[3]);
  const outDir = path.join(await fs.realpath(path.dirname(args[5])), path.basename(args[5]));
  assert.ok(outDir !== repo && !outDir.startsWith(`${repo}${path.sep}`), 'Keep verification artifacts outside the repository.');
  await fs.mkdir(outDir);

  const report = {
    schemaVersion: 1,
    kind: 'rich_local_inspection_browser_check',
    status: 'failed',
    startedAt: new Date().toISOString(),
    buildDirectory: buildDir,
    verifierSha256: sha256(await fs.readFile(__filename)),
    browserVersion: null,
    actualCodexHost: 'not_run',
    rendererMode: process.env.STEREOFOLD_BROWSER_RENDERER || 'browser-default',
    cases: [], inputs: [], screenshots: [], desktopPixels: [], xrPixels: [],
    requests: [], responses: [], externalRequests: [], pageErrors: [], pageErrorStacks: [], consoleErrors: [], expectedContextLogs: [],
    emulatedXr: { runtime: 'IWER 2.3.0', device: 'Meta Quest 2', physicalHeadset: 'not_run',
      passthroughCamera: 'not_run', wearerComfort: 'not_run', physicalControllerSelection: 'not_run',
      nativeVoice: 'not_run', inputs: [], sessions: [] },
    cleanup: {},
  };
  assert.ok(['browser-default', 'swiftshader'].includes(report.rendererMode), 'Unsupported renderer mode.');
  const rendererArguments = report.rendererMode === 'swiftshader'
    ? ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'] : [];
  report.rendererArguments = rendererArguments;
  const passed = (name, details = {}) => report.cases.push({ name, status: 'passed', ...details });
  let browser, server, origin, page, fallbackPage, browserPhase = 'desktop';
  let screenshotBytes = 0;
  const deadline = setTimeout(() => {
    report.deadlineExceeded = true;
    page?.close().catch(() => {});
    fallbackPage?.close().catch(() => {});
  }, 120_000);
  deadline.unref();

  const appState = target => target.evaluate(() => window.__stereofoldInspection.snapshot());
  const shot = async (target, name, { locator, kind = 'page' } = {}) => {
    const bytes = locator ? await locator.screenshot() : await target.screenshot({ fullPage: true });
    assert.ok(bytes.length > 1000 && bytes.length < 15 * 1024 * 1024, `${name} has an implausible size.`);
    screenshotBytes += bytes.length;
    assert.ok(report.screenshots.length < 26 && screenshotBytes < 80 * 1024 * 1024, 'Screenshot artifact bound exceeded.');
    await fs.writeFile(path.join(outDir, name), bytes, { flag: 'wx' });
    const entry = { path: name, kind, bytes: bytes.length, sha256: sha256(bytes) };
    if (kind === 'desktop_canvas') {
      entry.sample = inspectPng(bytes);
      assert.ok(entry.sample.foregroundPixels > 100 && entry.sample.colorsObservedUpTo512 > 8,
        `${name} does not contain a rendered molecular scene.`);
      report.desktopPixels.push(entry);
    }
    report.screenshots.push(entry);
    return entry;
  };
  const xrPixels = async (name, { fullyInside = true } = {}) => {
    await page.evaluate(() => window.__preview.frames(4));
    const { png, ...sample } = await page.evaluate(() => window.__preview.pixels());
    assert.ok(png.startsWith('data:image/png;base64,'));
    const bytes = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64');
    assert.ok(bytes.length > 1000 && bytes.length < 15 * 1024 * 1024);
    screenshotBytes += bytes.length;
    assert.ok(report.screenshots.length < 26 && screenshotBytes < 80 * 1024 * 1024, 'XR artifact bound exceeded.');
    await fs.writeFile(path.join(outDir, name), bytes, { flag: 'wx' });
    sample.framing = framing(sample.sceneFrame);
    const entry = { path: name, kind: 'emulated_xr_canvas', bytes: bytes.length, sha256: sha256(bytes), ...sample };
    report.screenshots.push({ path: name, kind: entry.kind, bytes: entry.bytes, sha256: entry.sha256 });
    report.xrPixels.push(entry);
    assert.equal(sample.glTrace.errorCount, 0, 'XR rendering produced a WebGL error.');
    assert.equal(sample.bindings.framebufferIsPresentation, true);
    for (const diagnostic of [sample.glErrorsBefore, sample.glErrorsAfter]) {
      assert.equal(diagnostic.complete, true); assert.deepEqual(diagnostic.errors, []);
    }
    assert.deepEqual(sample.framing.map(value => value.eye).sort(), ['left', 'right']);
    if (fullyInside) assert.ok(sample.framing.every(value => value.fullyInside), 'The molecule is clipped in an XR eye.');
    assert.equal(sample.eyePixels.length, 2);
    assert.ok(sample.eyePixels.every(value => value.foregroundPixels > 100 && value.colorsObservedUpTo256 > 1),
      'An XR eye lacks visible molecular foreground.');
    return entry;
  };
  const changedEyes = (before, after, label) => {
    assert.deepEqual(before.eyeHashes.map(value => value.eye).sort(), ['left', 'right']);
    assert.deepEqual(after.eyeHashes.map(value => value.eye).sort(), ['left', 'right']);
    for (const value of before.eyeHashes) {
      assert.notEqual(value.sha256, after.eyeHashes.find(other => other.eye === value.eye)?.sha256,
        `${label} did not change ${value.eye}-eye pixels.`);
    }
  };
  const enterXr = async mode => {
    await page.locator(`[data-mode="${mode}"]`).click();
    await page.waitForFunction(expected => {
      const state = window.__preview?.snapshot();
      return state?.status === 'error' || (state?.presenting && state.active?.mode === expected && state.active.frames >= 6);
    }, mode, { timeout: 30_000 });
    const state = await page.evaluate(() => window.__preview.snapshot());
    assert.equal(state.status, 'ready', state.errors.join('\n'));
    eyes(state.active);
    assert.equal(state.contextCount, 1); assert.equal(state.stats.atoms, 327); assert.equal(state.stats.residues, 46);
    assert.equal(state.loop, 'stock-canvas3d-synchronous-xr'); assert.equal(state.stockPluginLoopAnimating, false);
    assert.equal(state.active.blendMode, mode === 'immersive-ar' ? 'alpha-blend' : 'opaque');
    assert.ok(state.adapters.referenceSpace.checks.length >= 3);
    assert.ok(state.adapters.referenceSpace.checks.every(value => value.maxAbsoluteError <= value.tolerance));
    report.emulatedXr.sessions.push({ mode, entered: state });
    return state;
  };
  const endXr = async () => {
    const before = await page.evaluate(() => window.__preview.snapshot());
    await page.evaluate(() => window.__preview.end());
    await page.waitForFunction(draws => {
      const state = window.__preview.snapshot(); return !state.presenting && !state.active && state.draws > draws;
    }, before.draws, { timeout: 30_000 });
    const ended = await page.evaluate(() => window.__preview.snapshot());
    assert.equal(ended.loop, 'stock-plugin-desktop'); assert.equal(ended.stockPluginLoopAnimating, true);
    assert.equal(ended.sessions.at(-1).ended, true); assert.equal(ended.glTrace.errorCount, 0);
    report.emulatedXr.sessions.at(-1).ended = ended;
    return ended;
  };

  try {
    const runtime = await fs.readFile(runtimePath);
    assert.equal(runtime.length, RUNTIME_BYTES); assert.equal(sha256(runtime), RUNTIME_SHA256);
    report.emulatedXr.runtimeBytes = runtime.length; report.emulatedXr.runtimeSha256 = sha256(runtime);
    for (const file of ['../headset-preview/probe.cjs', '../headset-preview/adapters.cjs', '../headset-preview/assertions.cjs']) {
      const bytes = await fs.readFile(path.join(__dirname, file));
      report.emulatedXr.inputs.push({ path: file, bytes: bytes.length, sha256: sha256(bytes) });
    }
    assert.equal(pluginRequire('molstar/package.json').version, '5.11.0');

    const buildReportBytes = await fs.readFile(path.join(buildDir, 'build-report.json'));
    const buildReport = JSON.parse(buildReportBytes);
    assert.equal(buildReport.status, 'passed'); assert.equal(buildReport.kind, 'inspection_build');
    report.buildReportSha256 = sha256(buildReportBytes);
    const manifestPath = path.join(buildDir, 'artifact-hashes.json');
    const manifestStat = await fs.lstat(manifestPath);
    assert.ok(manifestStat.isFile() && !manifestStat.isSymbolicLink(), 'Artifact manifest must be a regular file.');
    const manifestBytes = await fs.readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    assert.ok(Array.isArray(manifest) && manifest.length >= 8 && manifest.length <= 32, 'Unexpected build artifact count.');
    assert.deepEqual((await fs.readdir(buildDir)).sort(), [...manifest.map(entry => entry.path), 'artifact-hashes.json'].sort(),
      'Build directory contains an undeclared artifact.');
    const required = new Set(['index.html', 'inspection.js', 'inspection.css', 'build-report.json', 'inputs.json', 'metafile.json']);
    const assets = new Map();
    let buildBytes = manifestBytes.length;
    for (const entry of manifest) {
      assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'path', 'sha256']);
      assert.equal(path.basename(entry.path), entry.path, 'Build artifacts must remain in one immutable directory.');
      assert.ok(!assets.has(`/${entry.path}`), 'Build artifact appears more than once.');
      const file = path.join(buildDir, entry.path), stat = await fs.lstat(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${entry.path} must be a regular file.`);
      const bytes = await fs.readFile(file);
      assert.equal(bytes.length, entry.bytes); assert.equal(sha256(bytes), entry.sha256);
      assert.ok(bytes.length < 25 * 1024 * 1024, `${entry.path} exceeds the per-file bound.`);
      buildBytes += bytes.length; required.delete(entry.path);
      assets.set(`/${entry.path}`, { bytes, type: MIME.get(path.extname(entry.path)) || 'application/octet-stream' });
      report.inputs.push({ path: entry.path, bytes: bytes.length, sha256: entry.sha256 });
    }
    assert.deepEqual([...required], []); assert.ok(buildBytes < 45 * 1024 * 1024, 'Build artifact byte bound exceeded.');
    assets.set('/artifact-hashes.json', { bytes: manifestBytes, type: 'application/json' });
    const html = assets.get('/index.html').bytes.toString('utf8');
    const cspMeta = html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i)?.[0]
      ?? html.match(/<meta[^>]+content=["'][^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i)?.[0];
    const csp = cspMeta?.match(/content="([^"]+)"/i)?.[1] ?? cspMeta?.match(/content='([^']+)'/i)?.[1];
    assert.ok(csp, 'Inspection page needs an explicit CSP.');
    const policies = new Map(csp.split(';').map(value => value.trim().split(/\s+/)).filter(value => value[0])
      .map(([directive, ...values]) => [directive, new Set(values)]));
    assert.deepEqual([...policies.get('default-src')], ["'none'"]);
    assert.ok(policies.get('script-src')?.has("'self'")); assert.ok(policies.get('font-src')?.has("'self'"));
    assert.deepEqual([...policies.get('connect-src')], ["'none'"]);
    assert.ok(policies.get('style-src')?.has("'self'") && policies.get('style-src')?.has("'unsafe-inline'"));
    assert.ok(["'self'", 'data:', 'blob:'].every(value => policies.get('img-src')?.has(value)));
    passed('Immutable bounded build, local fonts and restrictive CSP passed the artifact audit', { artifactCount: manifest.length, buildBytes });

    server = http.createServer((request, response) => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      const asset = assets.get(pathname === '/' ? '/index.html' : pathname);
      if (request.method !== 'GET' || !asset) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8`, 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' });
      response.end(asset.bytes);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, args: rendererArguments });
    report.browserVersion = browser.version();

    const context = await browser.newContext({ viewport: { width: 1240, height: 820 }, deviceScaleFactor: 1 });
    await context.addInitScript({ content: `${runtime.toString('utf8')}\n;
      window.__previewAdapters = {
        installReferenceSpaceAdapter: ${installReferenceSpaceAdapter},
        installPresentationDepthAdapter: ${installPresentationDepthAdapter},
        installSceneDepthAdapter: ${installSceneDepthAdapter}
      };
      (${installProbe})();
      window.__attachInspectionXr = ${launchViewer};` });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { report.externalRequests.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(20_000);
    page.on('pageerror', error => { report.pageErrors.push(error.message); report.pageErrorStacks.push(error.stack || error.message); });
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const value = message.text();
      if (browserPhase === 'context-recovery' && /CONTEXT_LOST_WEBGL|WebGL context (?:was )?lost|webglcontextlost/iu.test(value)) {
        report.expectedContextLogs.push({ phase: browserPhase, message: value });
      } else report.consoleErrors.push(value);
    });
    page.on('request', request => report.requests.push({ method: request.method(), url: request.url() }));
    page.on('response', response => report.responses.push({ status: response.status(), url: response.url() }));
    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.ready === 'true'
      && ['ready', 'error'].includes(window.__stereofoldInspection?.snapshot().status), null, { timeout: 30_000 });
    const initial = report.initial = await appState(page);
    assert.equal(initial.status, 'ready', initial.error || 'Inspection viewer did not become ready.');
    assert.equal(initial.atomCount, 327); assert.equal(initial.residueCount, 46); assert.equal(initial.modelNumber, 1);
    assert.equal(initial.contextLost, false); assert.equal(initial.xrPresenting, false);
    assert.deepEqual(initial.inspection.appearance, DEFAULT_APPEARANCE);
    assert.deepEqual(initial.inspection.placement, DEFAULT_PLACEMENT);
    assert.deepEqual(initial.inspection.history, { undoCount: 0, redoCount: 0, lastAction: null });
    assert.deepEqual(initial.inspection.savedViews, []);
    const rows = await page.evaluate(() => window.__stereofoldInspection.rows());
    assert.equal(rows.length, 46); assert.equal(new Set(rows.map(row => row.key)).size, 46);
    assert.ok(rows.every(row => typeof row.key === 'string'));
    const resolvedKeys = rows.filter(row => row.coordinateState === 'resolved' && row.atomSites?.length).map(row => row.key);
    assert.ok(resolvedKeys.length > 2, 'The canonical catalog lacks resolved residues for inspection.');
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox(); assert.ok(box && box.width >= 400 && box.height >= 300);
    await shot(page, '01-wide-default.png');
    const initialCanvas = await shot(page, '02-canvas-default.png', { locator: canvas, kind: 'desktop_canvas' });
    passed('The wide local preview loaded public 1CRN with its exact default inspection state');

    // Rehearse the complete Mac-only walkthrough from a deliberately rich view.
    // Each apply must commit a rendered state; moving to the next explanation
    // must not mutate the scene. Restore is checked against the exact rich
    // capture rather than against the easier default state.
    const initialCapture = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    await page.evaluate(async key => {
      const inspection = window.__stereofoldInspection.viewer.inspection;
      await inspection.configure({ representation: 'spacefill', color: 'sequence-id', opacity: 0.72,
        background: '#192734', labels: true, clipping: 12, fog: 18 });
      await inspection.place({ translation: [-0.2, 0.15, 0.05], rotation: [5, -20, 10], scale: 0.9 });
      await window.__stereofoldInspection.viewer.select([key]);
      await inspection.orbit('x', 12);
      await inspection.saveView('Before walkthrough');
    }, resolvedKeys[3]);
    const guideStartCapture = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    const guideStartState = await appState(page);
    const guideSavedViews = structuredClone(guideStartState.inspection.savedViews);
    assert.equal(await page.locator('.walkthrough').getAttribute('data-step'), 'idle');
    assert.match(await page.locator('.walkthrough-intro').textContent(), /No headset needed\./);
    await page.locator('[data-guide="start"]').click();
    await page.waitForFunction(() => {
      const panel = document.querySelector('.walkthrough');
      return panel?.dataset.step === '0' && panel.dataset.applied === 'false'
        && !document.querySelector('.walkthrough-active')?.hidden;
    });
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-guide-title]')), true);
    assert.deepEqual(captureCore(await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture())), captureCore(guideStartCapture));
    const afterGuideStart = await appState(page);
    assert.deepEqual(afterGuideStart.inspection.history, guideStartState.inspection.history, 'Starting the walkthrough changed history.');
    assert.deepEqual(afterGuideStart.inspection.savedViews, guideSavedViews, 'Starting the walkthrough changed saved views.');

    const applyGuideStep = async step => {
      const before = await appState(page);
      assert.equal(await page.locator('.walkthrough').getAttribute('data-step'), String(step));
      assert.equal(await page.locator('.walkthrough').getAttribute('data-applied'), 'false');
      await page.locator('[data-guide="apply"]').click();
      await page.waitForFunction(({ step, revision }) => {
        const state = window.__stereofoldInspection.snapshot();
        const panel = document.querySelector('.walkthrough');
        return state.ready && state.revision > revision && panel?.dataset.step === String(step)
          && panel.dataset.applied === 'true';
      }, { step, revision: before.revision });
      const after = await appState(page);
      assert.ok(after.drawCount > before.drawCount, `Walkthrough step ${step + 1} did not await a rendered frame.`);
      return after;
    };
    const advanceGuide = async nextStep => {
      const before = await page.evaluate(() => ({
        revision: window.__stereofoldInspection.snapshot().revision,
        capture: window.__stereofoldInspection.viewer.inspection.capture(),
      }));
      await page.locator('[data-guide="apply"]').click();
      await page.waitForFunction(step => {
        const panel = document.querySelector('.walkthrough');
        return panel?.dataset.step === String(step) && panel.dataset.applied === 'false';
      }, nextStep);
      const after = await page.evaluate(() => ({
        revision: window.__stereofoldInspection.snapshot().revision,
        capture: window.__stereofoldInspection.viewer.inspection.capture(),
      }));
      assert.equal(after.revision, before.revision, `Advancing to walkthrough step ${nextStep + 1} changed the revision.`);
      assert.deepEqual(captureCore(after.capture), captureCore(before.capture),
        `Advancing to walkthrough step ${nextStep + 1} changed the scene.`);
    };

    const guide0 = await applyGuideStep(0);
    assert.deepEqual(guide0.inspection.appearance, { ...DEFAULT_APPEARANCE, color: 'residue-name' });
    assert.deepEqual(guide0.inspection.placement, DEFAULT_PLACEMENT);
    assert.deepEqual(guide0.selectionKeys, []);
    assert.deepEqual(guide0.camera, initialCapture.camera);

    const rangeKeys = rows.filter(row => row.identity.authorChain === 'A'
      && row.identity.authorResidue >= 8 && row.identity.authorResidue <= 16).map(row => row.key);
    assert.equal(rangeKeys.length, 9, 'The walkthrough fixture no longer contains Chain A residues 8–16.');
    await advanceGuide(1);
    const guide1Camera = structuredClone((await appState(page)).camera);
    const guide1 = await applyGuideStep(1);
    assert.deepEqual(guide1.selectionKeys, rangeKeys.slice(0, 1));
    assert.equal(guide1.inspection.appearance.labels, true);
    assert.deepEqual(guide1.camera, guide1Camera, 'Walkthrough selection moved the camera.');
    await shot(page, '02a-guided-residue-label.png');

    await advanceGuide(2);
    const beforeGuideFocus = await appState(page);
    const guide2 = await applyGuideStep(2);
    assert.deepEqual(guide2.selectionKeys, rangeKeys);
    assert.equal(guide2.inspection.appearance.labels, false, 'The region walkthrough crowded the molecule with labels.');
    assert.notDeepEqual(guide2.camera, beforeGuideFocus.camera, 'Walkthrough focus did not move the viewpoint.');
    assert.deepEqual(guide2.inspection.placement, beforeGuideFocus.inspection.placement);

    await advanceGuide(3);
    const beforeGuideSurface = await appState(page);
    const guide3 = await applyGuideStep(3);
    for (const key of Object.keys(guide3.camera).filter(key => !['radius', 'radiusMax', 'fog'].includes(key))) {
      assert.deepEqual(guide3.camera[key], beforeGuideSurface.camera[key], `Walkthrough cutaway changed viewpoint ${key}.`);
    }
    assert.equal(guide3.inspectionRender.clipping, 20);
    assert.equal(guide3.inspectionRender.fog, 0);
    assert.deepEqual(guide3.inspection.placement, beforeGuideSurface.inspection.placement);
    assert.deepEqual(guide3.inspection.appearance, {
      ...beforeGuideSurface.inspection.appearance, representation: 'molecular-surface', color: 'uniform',
      uniformColor: '#58dcc9', opacity: 0.35, clipping: 20, fog: 0,
    });

    await advanceGuide(4);
    const beforeGuidePlacement = await appState(page);
    const guide4 = await applyGuideStep(4);
    assert.deepEqual(guide4.camera, beforeGuidePlacement.camera, 'Walkthrough placement changed the camera.');
    assert.deepEqual(guide4.inspection.placement,
      { translation: [0.35, 0, 0.1], rotation: [0, 30, 0], scale: 1.15 });

    await advanceGuide(5);
    const beforeGuideOrbit = await appState(page);
    const guide5 = await applyGuideStep(5);
    assert.deepEqual(guide5.inspection.placement, beforeGuideOrbit.inspection.placement);
    assert.notDeepEqual(guide5.camera, beforeGuideOrbit.camera, 'Walkthrough orbit did not move the viewpoint.');
    assert.equal(await page.locator('[data-guide="apply"]').isHidden(), true, 'The completed walkthrough still offers another step.');
    await shot(page, '02b-wide-guided-inspection.png');

    await page.locator('[data-guide="restore"]').click();
    await page.waitForFunction(revision => document.querySelector('.walkthrough')?.dataset.step === 'idle'
      && window.__stereofoldInspection.snapshot().ready
      && window.__stereofoldInspection.snapshot().revision > revision, guide5.revision);
    const guideRestoredCapture = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    const guideRestoredState = await appState(page);
    assert.deepEqual(captureCore(guideRestoredCapture), captureCore(guideStartCapture));
    assert.deepEqual(guideRestoredState.inspection.savedViews, guideSavedViews, 'Walkthrough restore overwrote saved views.');
    assert.notDeepEqual(guideRestoredState.inspection.history, guideStartState.inspection.history,
      'Walkthrough restore imported the starting history instead of recording the tour.');
    assert.equal(guideRestoredState.inspection.history.lastAction, 'restore');
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-guide="start"]')), true);

    // Keeping a walkthrough result closes the guide without another mutation.
    await page.locator('[data-guide="start"]').click();
    await page.waitForFunction(() => document.querySelector('.walkthrough')?.dataset.step === '0');
    await applyGuideStep(0);
    const beforeKeep = await page.evaluate(() => ({ revision: window.__stereofoldInspection.snapshot().revision,
      capture: window.__stereofoldInspection.viewer.inspection.capture() }));
    await page.locator('[data-guide="keep"]').click();
    await page.waitForFunction(() => document.querySelector('.walkthrough')?.dataset.step === 'idle');
    const afterKeep = await page.evaluate(() => ({ revision: window.__stereofoldInspection.snapshot().revision,
      capture: window.__stereofoldInspection.viewer.inspection.capture() }));
    assert.equal(afterKeep.revision, beforeKeep.revision);
    assert.deepEqual(captureCore(afterKeep.capture), captureCore(beforeKeep.capture));
    assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-guide="start"]')), true);

    // The recovery action clears visibility effects and fits the view while
    // retaining molecule placement and the other appearance choices.
    await page.evaluate(async () => {
      const inspection = window.__stereofoldInspection.viewer.inspection;
      await inspection.configure({ representation: 'molecular-surface', color: 'uniform', opacity: 0.22, clipping: 44, fog: 51 });
      await inspection.place({ translation: [0.4, -0.1, 0.2], rotation: [0, 25, 0], scale: 1.2 });
      await inspection.dolly(0.6);
    });
    const beforeReveal = await appState(page);
    await page.locator('[data-tab="view"]').click();
    await page.locator('[data-action="reveal"]').click();
    await page.waitForFunction(revision => {
      const state = window.__stereofoldInspection.snapshot();
      return state.ready && state.revision >= revision + 2 && state.inspection.appearance.opacity === 1
        && state.inspection.appearance.clipping === 0 && state.inspection.appearance.fog === 0;
    }, beforeReveal.revision);
    const revealed = await appState(page);
    assert.deepEqual(revealed.inspection.placement, beforeReveal.inspection.placement);
    assert.equal(revealed.inspection.appearance.representation, beforeReveal.inspection.appearance.representation);
    assert.equal(revealed.inspection.appearance.color, beforeReveal.inspection.appearance.color);
    near(cameraDirection(revealed.camera), cameraDirection(beforeReveal.camera));
    assert.ok(Math.abs(cameraDistance(revealed.camera) - cameraDistance(beforeReveal.camera)) > 1e-4,
      'Show the whole molecule did not fit the camera.');

    await page.evaluate(value => window.__stereofoldInspection.viewer.inspection.restore(value), initialCapture);
    assert.deepEqual(captureCore(await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture())), captureCore(initialCapture));
    await page.locator('[data-tab="look"]').click();
    passed('The six-step Mac walkthrough rendered each change, kept Next inert, and restored an exact rich starting view');
    passed('Keeping the guided result was inert and Show the whole molecule recovered visibility while retaining placement');

    // Exercise visible controls, then validate their changes through the independent public API.
    await page.locator('[data-control="representation"]').selectOption('ball-and-stick');
    await page.waitForFunction(() => window.__stereofoldInspection.snapshot().ready && window.__stereofoldInspection.snapshot().inspection.appearance.representation === 'ball-and-stick');
    const themedCanvas = await shot(page, '03-canvas-ball-and-stick-theme.png', { locator: canvas, kind: 'desktop_canvas' });
    assert.notEqual(themedCanvas.sha256, initialCanvas.sha256);
    await page.locator('[data-control="color"]').selectOption('uniform');
    await page.waitForFunction(() => window.__stereofoldInspection.snapshot().ready && window.__stereofoldInspection.snapshot().inspection.appearance.color === 'uniform');
    await page.locator('[data-control="uniform-color"]').fill('#e45b72');
    await page.locator('[data-control="uniform-color"]').dispatchEvent('change');
    await page.waitForFunction(() => window.__stereofoldInspection.snapshot().ready && window.__stereofoldInspection.snapshot().inspection.appearance.uniformColor === '#e45b72');
    const uniform = await appState(page);
    assert.equal(uniform.inspection.appearance.representation, 'ball-and-stick');
    assert.equal(uniform.inspection.appearance.color, 'uniform');
    const uniformCanvas = await shot(page, '03b-canvas-uniform.png', { locator: canvas, kind: 'desktop_canvas' });
    assert.notEqual(themedCanvas.sha256, uniformCanvas.sha256);
    const meanDistance = themedCanvas.sample.foregroundMean.slice(0, 3)
      .reduce((sum, value, index) => sum + Math.abs(value - uniformCanvas.sample.foregroundMean[index]), 0);
    assert.ok(meanDistance > 20, 'Uniform palette did not materially change sampled molecular pixels.');

    const beforeSurface = await appState(page);
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.configure({ representation: 'molecular-surface' }));
    const surface = await appState(page);
    assert.equal(surface.inspection.appearance.representation, 'molecular-surface');
    assert.equal(surface.inspection.appearance.color, beforeSurface.inspection.appearance.color);
    assert.equal(surface.inspection.appearance.uniformColor, beforeSurface.inspection.appearance.uniformColor);
    const surfaceCanvas = await shot(page, '04-canvas-surface.png', { locator: canvas, kind: 'desktop_canvas' });
    assert.notEqual(surfaceCanvas.sha256, uniformCanvas.sha256);
    passed('UI palette changes reached molecular pixels and representation changes preserved the chosen color');

    await page.evaluate(key => window.__stereofoldInspection.viewer.select([key]), resolvedKeys[5]);
    const selected = await appState(page); assert.deepEqual(selected.selectionKeys, [resolvedKeys[5]]);
    assert.ok(selected.selectedMarkerCount > 0);
    const beforeUnplacedFocus = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    await page.evaluate(key => window.__stereofoldInspection.viewer.focus([key]), resolvedKeys[5]);
    const unplacedFocus = await appState(page);
    assert.deepEqual(unplacedFocus.selectionKeys, [resolvedKeys[5]]);
    assert.notDeepEqual(unplacedFocus.camera.target, beforeUnplacedFocus.camera.target);
    const unplacedFocusTarget = structuredClone(unplacedFocus.camera.target);
    await page.evaluate(value => window.__stereofoldInspection.viewer.inspection.restore(value), beforeUnplacedFocus);
    const beforeLabels = await shot(page, '05-canvas-selected.png', { locator: canvas, kind: 'desktop_canvas' });
    await page.locator('[data-control="labels"]').check();
    await page.waitForFunction(() => window.__stereofoldInspection.snapshot().ready && window.__stereofoldInspection.snapshot().inspection.appearance.labels === true);
    const labelled = await appState(page);
    assert.deepEqual(labelled.selectionKeys, [resolvedKeys[5]]);
    assert.equal(labelled.inspectionRender.labels, true); assert.equal(labelled.representationCount, 2);
    const labelledCanvas = await shot(page, '06-canvas-labelled.png', { locator: canvas, kind: 'desktop_canvas' });
    assert.notEqual(labelledCanvas.sha256, beforeLabels.sha256, 'Selected-residue labels did not change molecular pixels.');
    const historyBeforeHover = structuredClone(labelled.inspection.history);
    await page.evaluate(key => window.__stereofoldInspection.viewer.inspection.hover([key]), resolvedKeys[9]);
    const hovered = await appState(page); assert.ok(hovered.highlightedMarkerCount > 0);
    assert.deepEqual(hovered.inspection.history, historyBeforeHover, 'Hover unexpectedly entered semantic history.');
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.hover([]));
    assert.equal((await appState(page)).highlightedMarkerCount, 0);
    await page.evaluate(() => window.__stereofoldInspection.viewer.select([]));
    const noSelectionLabels = await appState(page);
    assert.equal(noSelectionLabels.inspection.appearance.labels, true);
    assert.equal(noSelectionLabels.inspectionRender.labels, false); assert.equal(noSelectionLabels.representationCount, 1);
    await page.evaluate(key => window.__stereofoldInspection.viewer.select([key]), resolvedKeys[5]);
    await page.locator('[data-control="opacity"]').fill('0.46');
    await page.locator('[data-control="opacity"]').dispatchEvent('change');
    await page.waitForFunction(() => window.__stereofoldInspection.snapshot().ready && Math.abs(window.__stereofoldInspection.snapshot().inspection.appearance.opacity - 0.46) < 1e-6);
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.configure({ background: '#201027' }));
    const translucentCanvas = await shot(page, '07-canvas-labelled-translucent.png', { locator: canvas, kind: 'desktop_canvas' });
    assert.notEqual(translucentCanvas.sha256, labelledCanvas.sha256);
    await shot(page, '08-wide-rich-inspection.png');
    passed('Selection-scoped labels, opacity and background produced distinct rendered pixels');

    const beforePlacement = await appState(page), cameraBeforePlacement = structuredClone(beforePlacement.camera);
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.place({
      translation: [0.35, -0.12, 0.2], rotation: [12, 28, -8], scale: 1.3,
    }));
    const placed = await appState(page);
    assert.deepEqual(placed.inspection.placement, { translation: [0.35, -0.12, 0.2], rotation: [12, 28, -8], scale: 1.3 });
    assert.deepEqual(placed.camera, cameraBeforePlacement, 'Object placement changed the inspection camera.');
    const placedCanvas = await shot(page, '09-canvas-object-placed.png', { locator: canvas, kind: 'desktop_canvas' });
    assert.notEqual(placedCanvas.sha256, translucentCanvas.sha256);
    const directionBeforePlacedFocus = cameraDirection(placed.camera);
    await page.evaluate(key => window.__stereofoldInspection.viewer.focus([key]), resolvedKeys[5]);
    const placedFocus = await appState(page);
    assert.notDeepEqual(placedFocus.camera.target, unplacedFocusTarget,
      'Focus ignored the active molecular placement transform.');
    near(cameraDirection(placedFocus.camera), directionBeforePlacedFocus);
    near(placedFocus.camera.up, placed.camera.up);
    assert.deepEqual(placedFocus.inspection.placement, placed.inspection.placement);
    const focusedPlacedCanvas = await shot(page, '10-canvas-placed-focus.png', { locator: canvas, kind: 'desktop_canvas' });
    assert.notEqual(focusedPlacedCanvas.sha256, placedCanvas.sha256);
    assert.ok(focusedPlacedCanvas.sample.foregroundPixels > 100);
    const placementBeforeOrbit = structuredClone(placed.inspection.placement), cameraBeforeOrbit = structuredClone(placedFocus.camera);
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.orbit('y', 24));
    const orbited = await appState(page);
    assert.deepEqual(orbited.inspection.placement, placementBeforeOrbit);
    assert.notDeepEqual(orbited.camera, cameraBeforeOrbit, 'Viewpoint orbit did not change the camera.');
    const distanceBeforeDolly = cameraDistance(orbited.camera);
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.dolly(0.72));
    const dollied = await appState(page);
    assert.ok(Math.abs(cameraDistance(dollied.camera) - distanceBeforeDolly) > 1e-4);
    assert.deepEqual(dollied.inspection.placement, placementBeforeOrbit);
    passed('Object placement and viewpoint orbit/dolly remained independent');

    const directionBeforeFit = cameraDirection(dollied.camera), upBeforeFit = dollied.camera.up;
    await page.locator('[data-action="fit"]').click();
    await page.waitForFunction(revision => window.__stereofoldInspection.snapshot().revision > revision, dollied.revision);
    const fitted = await appState(page);
    near(cameraDirection(fitted.camera), directionBeforeFit); near(fitted.camera.up, upBeforeFit);
    await page.locator('[data-action="reset-orientation"]').click();
    await page.waitForFunction(revision => window.__stereofoldInspection.snapshot().revision > revision, fitted.revision);
    const resetOrientation = await appState(page);
    assert.notDeepEqual(cameraDirection(resetOrientation.camera), directionBeforeFit);
    assert.deepEqual(resetOrientation.inspection.placement, placementBeforeOrbit);
    passed('Fit preserved the current viewing direction while reset orientation performed a separate camera action');

    const exactBeforeEdit = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    const preDepthCanvas = await shot(page, '11-canvas-before-depth.png', { locator: canvas, kind: 'desktop_canvas' });
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.configure({ fog: 37, clipping: 18 }));
    const depthChanged = await appState(page);
    assert.deepEqual(depthChanged.inspectionRender, { clipping: 18, fog: 37, labels: true });
    assert.equal(depthChanged.camera.fog, 37);
    const depthCanvas = await shot(page, '12-canvas-depth.png', { locator: canvas, kind: 'desktop_canvas' });
    assert.notEqual(depthCanvas.sha256, preDepthCanvas.sha256, 'Clipping/fog did not alter rendered pixels.');
    const exactAfterEdit = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    await page.locator('[data-action="undo"]').click();
    await page.waitForFunction(expected => window.__stereofoldInspection.snapshot().ready && window.__stereofoldInspection.snapshot().inspection.history.lastAction === expected, 'undo');
    assert.deepEqual(captureCore(await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture())), captureCore(exactBeforeEdit));
    await page.locator('[data-action="redo"]').click();
    await page.waitForFunction(expected => window.__stereofoldInspection.snapshot().ready && window.__stereofoldInspection.snapshot().inspection.history.lastAction === expected, 'redo');
    assert.deepEqual(captureCore(await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture())), captureCore(exactAfterEdit));
    const savedResult = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.saveView('Surface detail'));
    const savedId = savedResult.id ?? savedResult.savedView?.id ?? savedResult.inspection?.savedViews?.at(-1)?.id ?? savedResult.savedViews?.at(-1)?.id;
    assert.ok(typeof savedId === 'string' && savedId);
    const savedCapture = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.place({ translation: [-5, 4, 1], scale: 0.6 }));
    await page.evaluate(id => window.__stereofoldInspection.viewer.inspection.restoreView(id), savedId);
    const restoredView = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    assert.deepEqual(restoredView.camera, savedCapture.camera);
    assert.deepEqual(restoredView.inspection.appearance, savedCapture.inspection.appearance);
    assert.deepEqual(restoredView.inspection.placement, savedCapture.inspection.placement);
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.configure({ representation: 'spacefill' }));
    await page.evaluate(value => window.__stereofoldInspection.viewer.inspection.restore(value), savedCapture);
    const restoredCapture = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    assert.deepEqual(captureCore(restoredCapture), captureCore(savedCapture));
    passed('Undo, redo, saved views and rich capture/restore recovered exact appearance, placement, camera and selection');

    const beforeRejected = await appState(page);
    const rejected = await page.evaluate(async () => {
      const calls = [
        () => window.__stereofoldInspection.viewer.inspection.configure({ representation: 'ribbon' }),
        () => window.__stereofoldInspection.viewer.inspection.configure(null),
        () => window.__stereofoldInspection.viewer.inspection.orbit('diagonal', 12),
        () => window.__stereofoldInspection.viewer.select(['missing-canonical-key']),
        () => window.__stereofoldInspection.viewer.inspection.restore({ appearance: {} }),
        () => window.__stereofoldInspection.loadFixture('missing-fixture'),
      ];
      const results = [];
      for (const call of calls) try { await call(); results.push({ status: 'resolved' }); }
      catch (error) { results.push({ status: 'rejected', code: error.code ?? null, message: error.message }); }
      return results;
    });
    assert.ok(rejected.every(value => value.status === 'rejected'), 'An invalid inspection command unexpectedly resolved.');
    const afterRejected = await appState(page);
    for (const key of ['sourceSha256', 'modelNumber', 'assemblyId', 'selectionKeys', 'camera', 'inspection', 'revision', 'drawCount']) {
      assert.deepEqual(afterRejected[key], beforeRejected[key], `Rejected commands changed ${key}.`);
    }
    report.rejectedCommands = rejected;
    passed('Awaited invalid and unresolved commands rejected without a semantic or rendered-state change');

    const beforeFailedLoad = await appState(page);
    const captureBeforeFailedLoad = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    assert.equal(beforeFailedLoad.inspectionRender.labels, true); assert.equal(beforeFailedLoad.representationCount, 2);
    await page.evaluate(() => window.__stereofoldInspection.viewer.testHooks.failNextLoadAt('after_candidate_draw'));
    const failedLoad = await page.evaluate(async () => {
      try { await window.__stereofoldInspection.loadFixture('identity_edge'); return { status: 'resolved' }; }
      catch (error) { return { status: 'rejected', code: error.code ?? null, message: error.message }; }
    });
    assert.equal(failedLoad.status, 'rejected'); assert.equal(failedLoad.code, 'injected_load_failure');
    const afterFailedLoad = await appState(page);
    const captureAfterFailedLoad = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    assert.deepEqual(captureCore(captureAfterFailedLoad), captureCore(captureBeforeFailedLoad));
    assert.equal(afterFailedLoad.revision, beforeFailedLoad.revision);
    assert.equal(afterFailedLoad.loadCount, beforeFailedLoad.loadCount);
    assert.equal(afterFailedLoad.candidateCount, 0); assert.equal(afterFailedLoad.candidatePresent, false);
    assert.equal(afterFailedLoad.representationCount, 2); assert.equal(afterFailedLoad.inspectionRender.labels, true);
    assert.deepEqual(afterFailedLoad.inspectionRender, beforeFailedLoad.inspectionRender);
    assert.equal(afterFailedLoad.stateCellCount, beforeFailedLoad.stateCellCount);
    assert.equal(afterFailedLoad.lastLoadFailure.recovered, true);
    report.richFailedLoad = { result: failedLoad, before: beforeFailedLoad, after: afterFailedLoad };
    passed('A failed scene replacement rolled back rich appearance, placement, selection, camera and label resources');

    browserPhase = 'context-recovery';
    const lose = await page.evaluate(() => window.__stereofoldInspection.viewer.testHooks.loseContext());
    assert.equal(lose.supported, true, 'WEBGL_lose_context is required for the rich recovery check.');
    await page.waitForFunction(count => {
      const state = window.__stereofoldInspection.snapshot();
      return state.contextLossCount > count || state.status === 'error';
    }, afterFailedLoad.contextLossCount);
    const lost = await appState(page); assert.equal(lost.status, 'context_lost');
    const restore = await page.evaluate(() => window.__stereofoldInspection.viewer.testHooks.restoreContext());
    assert.equal(restore.supported, true);
    await page.evaluate(() => window.__stereofoldInspection.viewer.testHooks.waitForContextRecovery());
    const recovered = await appState(page);
    const recoveredCapture = await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    assert.equal(recovered.status, 'ready'); assert.equal(recovered.contextLost, false);
    assert.equal(recovered.contextRestorationCount, afterFailedLoad.contextRestorationCount + 1);
    assert.deepEqual(captureCore(recoveredCapture), captureCore(captureBeforeFailedLoad));
    assert.equal(recovered.representationCount, 2); assert.equal(recovered.inspectionRender.labels, true);
    assert.deepEqual(recovered.inspectionRender, beforeFailedLoad.inspectionRender);
    assert.equal(recovered.candidateCount, 0); assert.equal(recovered.candidatePresent, false);
    assert.equal(recovered.stateCellCount, beforeFailedLoad.stateCellCount);
    report.richContextRecovery = { lost, recovered };
    browserPhase = 'desktop';
    passed('WebGL context restoration rebuilt one molecule and one selected-label representation with the exact rich view');

    // A second page proves the bundled font failure path and responsive layout.
    const fallbackContext = await browser.newContext({ viewport: { width: 440, height: 900 }, deviceScaleFactor: 1 });
    const fallback = report.fontFallback = { abortedFonts: [], pageErrors: [], consoleErrors: [] };
    await fallbackContext.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { report.externalRequests.push(route.request().url()); await route.abort(); return; }
      if (url.pathname.endsWith('.ttf')) { fallback.abortedFonts.push(url.pathname); await route.abort('failed'); return; }
      await route.continue();
    });
    fallbackPage = await fallbackContext.newPage(); fallbackPage.setDefaultTimeout(20_000);
    fallbackPage.on('pageerror', error => fallback.pageErrors.push(error.message));
    fallbackPage.on('console', message => { if (message.type() === 'error') fallback.consoleErrors.push(message.text()); });
    await fallbackPage.goto(origin, { waitUntil: 'load' });
    await fallbackPage.waitForFunction(() => document.body.dataset.ready === 'true'
      && window.__stereofoldInspection?.snapshot().status === 'ready', null, { timeout: 30_000 });
    await fallbackPage.evaluate(() => { document.documentElement.style.fontSize = '125%'; });
    const layout = fallback.layout = await fallbackPage.evaluate(() => {
      const controls = [...document.querySelectorAll('button,select,input')].filter(element => {
        const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }).map(element => { const rect = element.getBoundingClientRect(); return {
        tag: element.tagName, control: element.dataset.control ?? element.dataset.action ?? element.dataset.mode ?? null,
        bounds: [rect.left, rect.top, rect.right, rect.bottom], fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      }; });
      return { innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
        controls, statusFontSize: Number.parseFloat(getComputedStyle(document.querySelector('[data-role="status"]') ?? document.body).fontSize) };
    });
    assert.ok(fallback.abortedFonts.length >= 1, 'The bundled-font fallback was not exercised.');
    assert.ok(layout.scrollWidth <= layout.innerWidth && layout.bodyScrollWidth <= layout.innerWidth, 'Narrow layout overflows horizontally.');
    assert.ok(layout.controls.length >= 10 && layout.controls.every(control => control.bounds[0] >= -1
      && control.bounds[2] <= layout.innerWidth + 1 && control.fontSize >= 12), 'A narrow control is clipped or unreadable.');
    assert.ok(layout.statusFontSize >= 12); assert.deepEqual(fallback.pageErrors, []);
    assert.ok(fallback.consoleErrors.length <= fallback.abortedFonts.length
      && fallback.consoleErrors.every(message => /Failed to load resource|ERR_FAILED/i.test(message)),
    'The font-fallback page logged a non-font console error.');
    await shot(fallbackPage, '13-narrow-font-fallback.png');
    const beforeTab = await appState(fallbackPage);
    await fallbackPage.locator('.mobile-tabs [data-workspace="sequence"]').click();
    const fallbackRows = await fallbackPage.evaluate(() => window.__stereofoldInspection.rows());
    const fallbackRangeKeys = fallbackRows.filter(row => row.identity.authorChain === 'A'
      && row.identity.authorResidue >= 8 && row.identity.authorResidue <= 16).map(row => row.key);
    assert.equal(fallbackRangeKeys.length, 9);
    const fallbackSearch = fallbackPage.locator('[data-control="search"]');
    await fallbackSearch.fill('8-16');
    const fallbackSelectMatches = fallbackPage.locator('[data-action="select-range"]');
    assert.equal(await fallbackSelectMatches.textContent(), 'Select 8–16 · 9');
    assert.equal(await fallbackSelectMatches.isEnabled(), true);
    await fallbackSearch.press('Enter');
    await fallbackPage.waitForFunction(keys => {
      const state = window.__stereofoldInspection.snapshot();
      return state.ready && JSON.stringify(state.selectionKeys) === JSON.stringify(keys);
    }, fallbackRangeKeys);
    const rangeSelected = await appState(fallbackPage);
    assert.deepEqual(rangeSelected.camera, beforeTab.camera, 'Enter range selection moved the narrow-layout camera.');
    assert.ok(rangeSelected.selectedMarkerCount > 0);
    const sequenceSummary = fallbackPage.locator('.mobile-selection-summary');
    assert.equal(await sequenceSummary.isVisible(), true);
    const summaryText = await sequenceSummary.textContent();
    assert.match(summaryText, /A · .+ \+ 7 more/);
    assert.equal(await fallbackPage.locator('[data-selection="focus"]').isEnabled(), true);
    assert.equal(await fallbackPage.locator('[data-selection="clear"]').isEnabled(), true);
    await fallbackPage.locator('.mobile-tabs [data-workspace="structure"]').click();
    const afterTab = await appState(fallbackPage);
    assert.deepEqual(afterTab.camera, beforeTab.camera);
    assert.ok(afterTab.selectedMarkerCount > 0);
    assert.equal(await sequenceSummary.isVisible(), true);
    assert.equal(await sequenceSummary.textContent(), summaryText);
    await shot(fallbackPage, '13b-narrow-linked-selection.png');

    const beforeMobileFocus = await appState(fallbackPage);
    await fallbackPage.locator('[data-selection="focus"]').click();
    await fallbackPage.waitForFunction(revision => window.__stereofoldInspection.snapshot().ready
      && window.__stereofoldInspection.snapshot().revision > revision, beforeMobileFocus.revision);
    const afterMobileFocus = await appState(fallbackPage);
    assert.notDeepEqual(afterMobileFocus.camera, beforeMobileFocus.camera, 'Persistent narrow Focus did not move the viewpoint.');
    await fallbackPage.locator('[data-selection="clear"]').click();
    await fallbackPage.waitForFunction(() => window.__stereofoldInspection.snapshot().ready
      && window.__stereofoldInspection.snapshot().selectionKeys.length === 0);
    assert.equal(await sequenceSummary.textContent(), 'No residues selected');

    await fallbackPage.locator('.mobile-tabs [data-workspace="sequence"]').click();
    await fallbackSearch.fill('NOT-A-RESIDUE');
    assert.equal(await fallbackSelectMatches.textContent(), 'No matches');
    assert.equal(await fallbackSelectMatches.isDisabled(), true);
    await fallbackSearch.fill('');
    assert.equal(await fallbackSelectMatches.textContent(), `Select all ${fallbackRows.length}`);
    passed('Narrow tabs kept an exact selection summary and persistent actions while Enter selected the labelled residue range');
    passed('Narrow sequence search named its result count and disabled selection when no residues matched');
    await fallbackPage.evaluate(() => window.__stereofoldInspection.loadFixture('identity_edge'));
    const edgeRows = await fallbackPage.evaluate(() => window.__stereofoldInspection.rows());
    const unresolved = edgeRows.find(row => row.coordinateState !== 'resolved' || !row.atomSites?.length);
    assert.ok(unresolved, 'Identity-edge fixture did not expose its unresolved canonical row.');
    await fallbackPage.evaluate(key => window.__stereofoldInspection.viewer.select([key]), unresolved.key);
    const beforeUnresolvedFocus = await fallbackPage.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    const unresolvedFocus = await fallbackPage.evaluate(async key => {
      try { await window.__stereofoldInspection.viewer.focus([key]); return { status: 'resolved' }; }
      catch (error) { return { status: 'rejected', code: error.code ?? null, message: error.message }; }
    }, unresolved.key);
    assert.equal(unresolvedFocus.status, 'rejected'); assert.equal(unresolvedFocus.code, 'missing_coordinates');
    const afterUnresolvedFocus = await fallbackPage.evaluate(() => window.__stereofoldInspection.viewer.inspection.capture());
    assert.deepEqual(captureCore(afterUnresolvedFocus), captureCore(beforeUnresolvedFocus));
    fallback.unresolvedFocus = { row: { key: unresolved.key, coordinateState: unresolved.coordinateState }, result: unresolvedFocus };
    const fallbackDisposed = await fallbackPage.evaluate(() => window.__stereofoldInspection.dispose());
    assert.equal(fallbackDisposed.contextDisposed ?? fallbackDisposed.viewer?.contextDisposed, true);
    await fallbackContext.close(); report.cleanup.fallbackContextClosed = true; fallbackPage = undefined;
    passed('The 440 px large-text layout stayed readable without overflow when local fonts were unavailable');
    passed('An unresolved canonical residue remained selectable while focus rejected without changing its rich scene');

    await page.setViewportSize({ width: 960, height: 640 });
    await page.evaluate(async () => {
      await window.__stereofoldInspection.viewer.inspection.configure({ clipping: 0, fog: 0, labels: false });
      for (const [mode, label] of [['immersive-ar', 'Request emulated AR'], ['immersive-vr', 'Request emulated VR']]) {
        if (document.querySelector(`[data-mode="${mode}"]`)) continue;
        const button = document.createElement('button'); button.type = 'button'; button.dataset.mode = mode; button.textContent = label;
        (document.querySelector('header') ?? document.body).append(button);
      }
      await window.__stereofoldInspection.viewer.testHooks.attachXrPreview(window.__attachInspectionXr);
    });
    const startupGl = report.emulatedXr.startupGl = await page.evaluate(() => window.__preview.drainStartupGlErrors());
    assert.equal(startupGl.complete, true); assert.deepEqual(startupGl.errors, []);
    const semanticBeforeHead = await appState(page);
    const enteredAr = await enterXr('immersive-ar');
    const arInitial = await xrPixels('14-xr-ar-initial.png');
    const moved = await page.evaluate(() => window.__preview.moveHead());
    const arMoved = await xrPixels('15-xr-ar-head-moved.png');
    assert.notDeepEqual(enteredAr.active.lastFrame.pose, moved.active.lastFrame.pose);
    changedEyes(arInitial, arMoved, 'Head translation');
    const semanticAfterHead = await appState(page);
    for (const key of ['camera', 'selectionKeys', 'inspection', 'revision']) {
      assert.deepEqual(semanticAfterHead[key], semanticBeforeHead[key], `Head tracking changed semantic ${key}.`);
    }
    passed('Emulated AR rendered an unclipped molecule in both eyes and head tracking preserved semantic inspection state');

    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.configure({
      color: 'uniform', uniformColor: '#67df8f', opacity: 0.82, background: '#09141c', labels: false,
    }));
    const arRich = await xrPixels('16-xr-ar-rich-command.png');
    changedEyes(arMoved, arRich, 'Rich inspection command');
    assert.equal((await appState(page)).xrPresenting, true);
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.configure({ clipping: 55 }));
    const arClipped = await xrPixels('17-xr-ar-deliberate-clipping.png', { fullyInside: false });
    changedEyes(arRich, arClipped, 'Deliberate clipping');
    assert.ok(arClipped.framing.some(value => !value.fullyInside), 'Deliberate clipping did not intersect an eye frustum.');
    assert.equal((await appState(page)).inspectionRender.clipping, 55);
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.configure({ clipping: 0 }));
    const arUnclipped = await xrPixels('18-xr-ar-clipping-cleared.png');
    changedEyes(arClipped, arUnclipped, 'Clearing deliberate clipping');
    const arSelected = await page.evaluate(async key => {
      await window.__stereofoldInspection.viewer.select([key]);
      return window.__preview.frames(4);
    }, resolvedKeys[8]);
    assert.equal(arSelected, undefined);
    const beforeXrLabels = await xrPixels('19-xr-ar-selected-no-label.png');
    await page.evaluate(() => window.__stereofoldInspection.viewer.inspection.configure({ labels: true }));
    const withXrLabels = await xrPixels('20-xr-ar-selected-label.png');
    changedEyes(beforeXrLabels, withXrLabels, 'Selected-residue labels');
    assert.deepEqual((await appState(page)).selectionKeys, [resolvedKeys[8]]);
    passed('Rich appearance commands and selected-residue labels changed actual pixels in both AR eyes');

    await page.evaluate(async () => {
      const { device, initialHeadPosition: p } = window.__xrProbe;
      const controller = device.controllers.right;
      controller.connected = true; controller.position.set(p.x + 0.2, p.y - 0.15, p.z - 0.3);
      controller.quaternion.set(0, 0, 0, 1); controller.updateButtonValue('trigger', 1);
      await window.__preview.frames(4);
    });
    const heldBefore = await appState(page);
    const heldResult = await page.evaluate(async () => {
      try { await window.__stereofoldInspection.viewer.inspection.configure({ opacity: 0.31 }); return { status: 'applied' }; }
      catch (error) { return { status: 'rejected', code: error.code }; }
    });
    assert.deepEqual(heldResult, { status: 'rejected', code: 'interaction_active' });
    const heldAfter = await appState(page);
    assert.deepEqual(heldAfter.inspection.appearance, heldBefore.inspection.appearance);
    assert.equal(heldAfter.revision, heldBefore.revision);
    await page.evaluate(async () => {
      window.__xrProbe.device.controllers.right.updateButtonValue('trigger', 0);
      await window.__preview.frames(4); window.__xrProbe.device.controllers.right.connected = false;
      await window.__preview.frames(4);
    });
    assert.equal((await appState(page)).interactionActive, false);
    passed('A held XR input rejected a competing appearance edit without changing state');

    await endXr();
    await enterXr('immersive-vr');
    const vrPixels = await xrPixels('21-xr-vr-opaque.png');
    assert.ok(vrPixels.eyePixels.every(eye => eye.backgroundSample[3] === 255), 'Opaque VR background has transparent eye pixels.');
    await endXr();
    await enterXr('immersive-ar');
    await xrPixels('22-xr-ar-reentry.png');
    passed('The same viewer exited AR, entered opaque VR, exited, and re-entered AR without WebGL errors');

    const disposed = report.cleanup.page = await page.evaluate(() => window.__stereofoldInspection.dispose());
    const disposedViewer = disposed.viewer ?? disposed;
    assert.equal(disposedViewer.contextDisposed, true); assert.equal(disposedViewer.cleanupPending, false);
    const xrCleanup = disposedViewer.xrPreviewCleanup;
    assert.equal(xrCleanup.attachmentDetached, true); assert.equal(xrCleanup.ownsViewer, false);
    assert.equal(xrCleanup.activeSession, false); assert.equal(xrCleanup.runtimeRemoved, true);
    assert.equal(xrCleanup.adaptersRestored, true); assert.equal(xrCleanup.glTrace.errorCount, 0);
    assert.equal(disposedViewer.representationCount, 0); assert.equal(disposedViewer.renderObjectCount, 0);
    passed('Disposal ended the active XR session, restored adapters/runtime, and released the Mol* context');

    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []);
    assert.ok(report.responses.every(response => response.status === 200));
    report.final = disposed;
    report.status = 'passed';
  } catch (error) {
    report.error = error.stack || String(error);
    if (page && !page.isClosed()) {
      try { report.failedState = await appState(page); } catch {}
      try { await shot(page, 'failure.png', { kind: 'failure_page' }); } catch (shotError) { report.failureScreenshotError = String(shotError); }
    }
  } finally {
    if (fallbackPage && !fallbackPage.isClosed()) {
      try { await fallbackPage.evaluate(() => window.__stereofoldInspection?.dispose?.()); } catch {}
    }
    if (page && !page.isClosed() && !report.cleanup.page) {
      try { report.cleanup.page = await page.evaluate(() => window.__stereofoldInspection?.dispose?.()); }
      catch (error) { report.cleanup.pageError = String(error); }
    }
    if (browser) {
      try { await browser.close(); report.cleanup.browserClosed = true; }
      catch (error) { report.cleanup.browserError = String(error); }
    }
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); report.cleanup.serverClosed = true;
    }
    if (origin) report.cleanup.listenerRefused = await new Promise(resolve => {
      const request = http.get(origin, response => { response.resume(); resolve(false); });
      request.on('error', error => resolve(error.code === 'ECONNREFUSED'));
      request.setTimeout(1000, () => { request.destroy(); resolve(false); });
    });
    clearTimeout(deadline);
    if (report.deadlineExceeded || !report.cleanup.browserClosed || !report.cleanup.serverClosed || !report.cleanup.listenerRefused
      || report.cleanup.pageError) report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(outDir, 'browser-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, cases: report.cases.length,
    report: path.join(outDir, 'browser-report.json'), error: report.error })}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
