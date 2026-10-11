#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const repo = path.resolve(__dirname, '../..');
const pluginRequire = createRequire(path.join(repo, 'plugin/package.json'));
const { chromium } = pluginRequire('playwright');
const { installReferenceSpaceAdapter, installPresentationDepthAdapter } = require('./adapters.cjs');
const { installProbe, launchViewer } = require('./probe.cjs');
const { framing, eyes } = require('./assertions.cjs');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const runtimeHash = '4a3d7610fc263655e73311a61dc4d6d4f8004e5dc83f9f163f2e17934e31817b';
const fixtureHash = '23787562c427d7c1abe5420e86d5f1d0a6c7007dec1e8ce85645a6d69c32e8ba';


async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 4 && args[0] === '--runtime' && args[2] === '--out' && path.isAbsolute(args[1]) && path.isAbsolute(args[3]),
    'Use --runtime /absolute/iwer.min.js --out /absolute/new-directory');
  assert.ok((await fs.lstat(args[1])).isFile(), 'Runtime must be a regular file, not a symlink');
  const out = path.join(await fs.realpath(path.dirname(args[3])), path.basename(args[3]));
  assert.ok(out !== repo && !out.startsWith(`${repo}${path.sep}`), 'Keep output outside the repository');
  await fs.mkdir(out);
  const report = { schemaVersion: 1, kind: 'stock_molstar_iwer_headset_preview', status: 'failed', startedAt: new Date().toISOString(),
    rendering: { engine: 'stock Mol* 5.11.0', xrScheduling: 'preview adapter using stock Canvas3D.animate()',
      stockPluginXRLoop: 'not_retested_in_this_run', animationManagerDuringXR: 'not_exercised', iwerFrameValidation: 'unchanged',
      referenceSpaceAdapter: 'unwrap XRRigidTransform.matrix for IWER 2.3.0', presentationDepthAdapter: 'preserve XR framebuffer attachments while drawing pointers' },
    emulation: { runtime: 'IWER', version: '2.3.0', device: 'Meta Quest 2' }, physicalHeadset: 'not_run', passthroughCamera: 'not_run',
    wearerComfort: 'not_run', scientificControllerSelection: 'not_run', nativeVoice: 'not_run', actualCodexHost: 'not_run',
    cases: [], inputs: [], screenshots: [], pixelReadbacks: [], pageErrors: [], pageErrorStacks: [], consoleErrors: [], externalRequests: [], cleanup: {} };
  let browser, server, page, origin;
  const deadline = setTimeout(() => { report.deadlineExceeded = true; page?.close().catch(() => {}); }, 120_000); deadline.unref();
  const check = (name, details = {}) => report.cases.push({ name, status: 'passed', ...details });
  const snapshot = () => page.evaluate(() => window.__preview.snapshot());
  const shot = async name => { const bytes = await page.screenshot({ path: path.join(out, name) }); report.screenshots.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) }); };
  const pixels = async name => { const { png, ...sample } = await page.evaluate(() => window.__preview.pixels());
    assert.ok(png.startsWith('data:image/png;base64,')); const bytes = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64');
    await fs.writeFile(path.join(out, name), bytes, { flag: 'wx' }); report.screenshots.push({ path: name, kind: 'xr_canvas_only', bytes: bytes.length, sha256: sha256(bytes) });
    sample.framing = framing(sample.sceneFrame); report.pixelReadbacks.push({ path: name, ...sample });
    assert.equal(sample.glTrace.errorCount, 0, 'XR GL calls produced errors; see the retained method/stack traces');
    assert.equal(sample.bindings.framebufferIsPresentation, true); assert.equal(sample.glErrorsBefore.complete, true); assert.equal(sample.glErrorsAfter.complete, true);
    assert.deepEqual(sample.glErrorsBefore.errors, [], 'GL errors preceded XR readback'); assert.deepEqual(sample.glErrorsAfter.errors, [], 'GL errors occurred during XR readback');
    assert.deepEqual(sample.framing.map(value => value.eye).sort(), ['left', 'right']);
    assert.ok(sample.framing.every(value => value.fullyInside), 'The molecular render sphere is clipped by an eye frustum');
    assert.ok(sample.eyePixels.length === 2 && sample.eyePixels.every(value => value.foregroundPixels > 0 && value.colorsObservedUpTo256 > 1), 'An eye lacks visible molecular foreground'); return sample; };
  try {
    const assets = new Map();
    for (const [url, file, type] of [['/iwer.js', args[1], 'application/javascript'], ['/molstar.js', pluginRequire.resolve('molstar/build/viewer/molstar.js'), 'application/javascript'],
      ['/molstar.css', pluginRequire.resolve('molstar/build/viewer/molstar.css'), 'text/css'], ['/fixture.cif', path.join(repo, 'fixtures/1CRN.cif'), 'text/plain']]) {
      const bytes = await fs.readFile(file); assets.set(url, { type, bytes }); report.inputs.push({ path: url, bytes: bytes.length, sha256: sha256(bytes) });
    }
    assert.equal(report.inputs[0].sha256, runtimeHash); assert.equal(report.inputs[0].bytes, 195151);
    assert.equal(report.inputs[3].sha256, fixtureHash); assert.equal(report.inputs[3].bytes, 69506);
    assert.equal(pluginRequire('molstar/package.json').version, '5.11.0');
    report.verifierSha256 = sha256(await fs.readFile(__filename));
    report.assertionsSha256 = sha256(await fs.readFile(path.join(__dirname, 'assertions.cjs')));
    report.probeSha256 = sha256(await fs.readFile(path.join(__dirname, 'probe.cjs')));
    report.adaptersSha256 = sha256(await fs.readFile(path.join(__dirname, 'adapters.cjs')));
    assets.set('/adapters.js', { type: 'application/javascript', bytes: Buffer.from(`window.__previewAdapters = { installReferenceSpaceAdapter: ${installReferenceSpaceAdapter}, installPresentationDepthAdapter: ${installPresentationDepthAdapter} };`) });
    assets.set('/install.js', { type: 'application/javascript', bytes: Buffer.from(`(${installProbe})()`) });
    assets.set('/preview.js', { type: 'application/javascript', bytes: Buffer.from(`(${launchViewer})()`) });
    assets.set('/', { type: 'text/html', bytes: Buffer.from('<!doctype html><meta charset="utf-8"><title>Mol* headset emulation</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/molstar.css"><style>body{margin:0;background:#17242d}header{position:fixed;top:0;left:0;z-index:10000;padding:6px;background:#fff;color:#15242d;font:14px system-ui}button{margin-left:10px}#viewer{position:absolute;inset:38px 0 0}</style><header>IWER emulation · Quest 2 · public 1CRN<button data-mode="immersive-ar">Request AR</button><button data-mode="immersive-vr">Request VR</button></header><div id="viewer"></div><script src="/iwer.js"></script><script src="/adapters.js"></script><script src="/install.js"></script><script src="/molstar.js"></script><script src="/preview.js"></script>') });
    server = http.createServer((request, response) => {
      const asset = assets.get(request.url);
      if (request.method !== 'GET' || !asset) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8`, 'Cache-Control': 'no-store' }); response.end(asset.bytes);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    report.rendererMode = process.env.STEREOFOLD_BROWSER_RENDERER || 'browser-default';
    assert.ok(['browser-default', 'swiftshader'].includes(report.rendererMode));
    report.rendererArguments = report.rendererMode === 'swiftshader' ? ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'] : [];
    browser = await chromium.launch({ headless: true, args: report.rendererArguments }); report.browserVersion = browser.version();
    page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 }); page.setDefaultTimeout(20_000);
    page.on('pageerror', error => { report.pageErrors.push(error.message); report.pageErrorStacks.push(error.stack || error.message); });
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) { report.externalRequests.push(route.request().url()); await route.abort(); } else await route.continue();
    });
    await page.goto(origin);
    await page.waitForFunction(() => ['ready', 'error'].includes(window.__preview?.snapshot().status));
    await page.waitForFunction(() => window.__preview.snapshot().draws > 1 || window.__preview.snapshot().status === 'error');
    report.initial = await snapshot(); assert.equal(report.initial.status, 'ready', report.initial.errors.join('\n'));
    assert.equal(report.initial.loop, 'stock-plugin-desktop'); assert.equal(report.initial.stockPluginLoopAnimating, true);
    assert.equal(report.initial.stats.atoms, 327); assert.equal(report.initial.stats.residues, 46); assert.equal(report.initial.stats.modelNumber, 1);
    assert.equal(report.initial.contextCount, 1); assert.ok(report.initial.stats.renderObjects > 0 && report.initial.stats.representations > 0);
    check('Pinned 1CRN rendered in one stock Mol* WebGL context'); await shot('01-desktop.png');
    report.startupGlDiagnostic = await page.evaluate(() => window.__preview.drainStartupGlErrors());
    assert.equal(report.startupGlDiagnostic.complete, true, 'Startup GL error queue did not drain within 16 reads');
    assert.deepEqual(report.startupGlDiagnostic.errors, [], 'Startup rendering produced GL errors');
    for (const [index, mode] of ['immersive-ar', 'immersive-vr', 'immersive-ar'].entries()) {
      await page.locator(`[data-mode="${mode}"]`).click();
      await page.waitForFunction(mode => { const s = window.__preview.snapshot(); return s.status === 'error' || (s.active?.mode === mode && s.active.frames >= 6 && s.presenting); }, mode);
      const entered = await snapshot(); assert.equal(entered.status, 'ready', entered.errors.join('\n')); eyes(entered.active);
      assert.equal(entered.loop, 'stock-canvas3d-synchronous-xr'); assert.equal(entered.stockPluginLoopAnimating, false);
      assert.equal(entered.active.blendMode, mode === 'immersive-ar' ? 'alpha-blend' : 'opaque');
      assert.equal(entered.adapters.referenceSpace.checks.length, (index + 1) * 3);
      assert.ok(entered.adapters.referenceSpace.checks.every(value => value.maxAbsoluteError <= value.tolerance));
      assert.ok(entered.adapters.presentationDepth.attachSkipped > 0 && entered.adapters.presentationDepth.detachSkipped > 0);
      check(`${mode} session ${index + 1} drew both eyes`, { session: entered.active, loop: entered.loop, stockPluginLoopAnimating: entered.stockPluginLoopAnimating });
      if (index === 0) {
        await shot('02-ar-stereo.png'); const before = await pixels('02-ar-canvas.png');
        const moved = await page.evaluate(() => window.__preview.moveHead());
        await shot('03-ar-head-moved.png'); const after = await pixels('03-ar-head-moved-canvas.png');
        assert.ok(before.colorsObservedUpTo256 > 1 && after.colorsObservedUpTo256 > 1); assert.notEqual(before.sha256, after.sha256);
        assert.notDeepEqual(entered.active.lastFrame.pose, moved.active.lastFrame.pose);
        const from = entered.runtime.headPosition, to = moved.runtime.headPosition;
        check('Simulated head translation changed the XR pose and rendered pixels', {
          headPositionBefore: from, headPositionAfter: to, translationMetres: [to.x - from.x, to.y - from.y, to.z - from.z], before, after });
        const controlled = await page.evaluate(() => window.__preview.controllers());
        for (const hand of ['left', 'right']) {
          const input = controlled.active.inputs.find(input => input.handedness === hand);
          assert.ok(input?.profiles.includes('oculus-touch-v3')); assert.equal(input.targetRayMode, 'tracked-pointer');
          for (const type of ['selectstart', 'select', 'selectend', 'squeezestart', 'squeeze', 'squeezeend']) assert.equal(controlled.active.events.filter(event => event.hand === hand && event.type === type).length, 1);
          assert.ok(controlled.active.pointerStates[`${hand}:1`] > 0 && controlled.active.pointerStates[`${hand}:2`] > 0, 'Mol* did not receive trigger and squeeze states');
          assert.ok(input.buttons.every(button => !button.pressed));
        }
        check('Both IWER controllers produced select/squeeze events and stock Mol* pointer states', { session: controlled.active });
      }
      if (index === 1) { await shot('04-vr-stereo.png'); await pixels('04-vr-canvas.png'); }
      if (index === 2) await pixels('05-ar-reentry-canvas.png');
      const ending = await snapshot(); await page.evaluate(() => window.__preview.end());
      await page.waitForFunction(before => { const s = window.__preview.snapshot(); return !s.presenting && !s.active && s.draws > before; }, ending.draws);
      const ended = await snapshot(); assert.ok(ended.sessions.at(-1).ended); assert.equal(ended.contextCount, 1); assert.equal(ended.stats.atoms, 327);
      assert.equal(ended.loop, 'stock-plugin-desktop'); assert.equal(ended.stockPluginLoopAnimating, true);
      check(`${mode} session ${index + 1} ended and desktop rendering resumed`);
    }
    await shot('05-desktop-after-reentry.png'); report.final = await snapshot();
    assert.equal(report.final.glTrace.errorCount, 0, 'XR GL errors occurred after capture');
    assert.equal(report.final.contextLost, false); assert.deepEqual(report.final.errors, []);
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.externalRequests, []);
    report.status = 'passed';
  } catch (error) { report.error = error.stack;
    if (page && !page.isClosed()) { try { report.failedState = await snapshot(); } catch {} }
  }
  finally {
    if (page && !page.isClosed()) {
      try { report.cleanup.page = await page.evaluate(() => window.__preview?.dispose?.()); }
      catch (error) { report.cleanup.pageError = String(error); }
    }
    if (browser) { try { await browser.close(); report.cleanup.browserClosed = true; } catch (error) { report.cleanup.browserError = String(error); } }
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); report.cleanup.serverClosed = true; }
    if (origin) report.cleanup.listenerRefused = await new Promise(resolve => {
      const request = http.get(origin, response => { response.resume(); resolve(false); });
      request.on('error', error => resolve(error.code === 'ECONNREFUSED')); request.setTimeout(1000, () => { request.destroy(); resolve(false); });
    });
    clearTimeout(deadline);
    if (report.deadlineExceeded || report.pageErrors.length || report.consoleErrors.length || report.externalRequests.length
      || !report.cleanup.browserClosed || !report.cleanup.serverClosed || !report.cleanup.listenerRefused || !report.cleanup.page?.viewerDisposed
      || report.cleanup.page.activeSession || !report.cleanup.page.runtimeRemoved || !report.cleanup.page.adaptersRestored
      || report.cleanup.page.glTrace.errorCount || report.cleanup.pageError) report.status = 'failed';
    report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(out, 'browser-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, report: path.join(out, 'browser-report.json') }));
  if (report.status !== 'passed') process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
