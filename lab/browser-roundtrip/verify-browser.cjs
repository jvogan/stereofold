#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const { extractFile } = require('../identity/extract.cjs');
const { selectionId } = require('../protocol/source-facts.cjs');
const pluginRequire = createRequire(path.resolve(__dirname, '../../plugin/package.json'));
const { chromium } = pluginRequire('playwright');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function assertCamera(actual, expected, tolerance = 1e-6) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [key, value] of Object.entries(expected)) {
    if (Array.isArray(value)) {
      assert.equal(actual[key].length, value.length);
      value.forEach((v, i) => assert.ok(Math.abs(actual[key][i] - v) <= tolerance, `${key}[${i}] changed`));
    } else if (typeof value === 'number') {
      assert.ok(Math.abs(actual[key] - value) <= tolerance, `${key} changed: ${actual[key]} != ${value}`);
    } else assert.equal(actual[key], value, `${key} changed`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 4 && args[0] === '--build' && args[2] === '--out'
    && path.isAbsolute(args[1]) && path.isAbsolute(args[3]), 'Use --build /absolute/build --out /absolute/new-directory');
  const buildDir = await fs.realpath(args[1]);
  const out = path.join(await fs.realpath(path.dirname(args[3])), path.basename(args[3]));
  const repo = await fs.realpath(path.resolve(__dirname, '../..'));
  assert.ok(out !== repo && !out.startsWith(`${repo}${path.sep}`));
  await fs.mkdir(out);
  const report = { schemaVersion: 1, kind: 'browser_roundtrip_verification', status: 'failed',
    startedAt: new Date().toISOString(), verifierSha256: sha256(await fs.readFile(__filename)),
    buildDirectory: buildDir, cases: [], screenshots: [], pageErrors: [], consoleErrors: [], externalRequests: [],
    actualCodexHost: 'not_run', nativeVoice: 'not_run', headsetQualification: 'not_run',
    transport: 'Node driver and isolated browser test adapter', cleanup: { browserClosed: false, serverClosed: false } };
  let browser, server, coordinator, page;
  const check = (name, details = {}) => report.cases.push({ name, status: 'passed', ...details });
  const shot = async name => {
    await page.screenshot({ path: path.join(out, name) });
    const bytes = await fs.readFile(path.join(out, name));
    report.screenshots.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  };
  try {
    const { BrowserCoordinator } = await import(pathToFileURL(path.join(__dirname, 'coordinator.mjs')));
    const { decideReturn } = await import(pathToFileURL(path.join(__dirname, '../protocol/return.mjs')));
    const build = JSON.parse(await fs.readFile(path.join(buildDir, 'build-report.json'), 'utf8'));
    assert.equal(build.status, 'passed');
    const artifacts = JSON.parse(await fs.readFile(path.join(buildDir, 'artifact-hashes.json'), 'utf8'));
    for (const item of artifacts) {
      assert.equal(path.basename(item.path), item.path);
      const bytes = await fs.readFile(path.join(buildDir, item.path));
      assert.equal(bytes.length, item.bytes);
      assert.equal(sha256(bytes), item.sha256);
    }
    report.bundleSha256 = build.bundleSha256;
    const pinnedSources = [];
    for (const item of build.fixtures) {
      const file = path.join(repo, item.path);
      const cif = await fs.readFile(file, 'utf8');
      const catalog = await extractFile(file, { assemblyId: '1', expectedHash: item.sha256 });
      assert.equal(sha256(JSON.stringify(catalog)), item.catalogSha256);
      pinnedSources.push({ id: item.id, cif, catalog });
    }
    const target = { bindingId: 'binding-a', taskId: 'task-a', panelId: 'panel-a', sessionId: 'session-a', deviceId: 'device-a' };
    coordinator = new BrowserCoordinator({ clock: () => performance.now(), pinnedSources, target });
    const served = new Map();
    for (const [name, type] of [['index.html', 'text/html'], ['roundtrip.js', 'application/javascript'], ['roundtrip.css', 'text/css']]) {
      served.set(`/${name}`, { type, bytes: await fs.readFile(path.join(buildDir, name)) });
    }
    server = http.createServer((req, res) => {
      const file = served.get(req.url === '/' ? '/index.html' : req.url);
      if (req.method !== 'GET' || !file) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': `${file.type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(file.bytes);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const rendererMode = process.env.STEREOFOLD_BROWSER_RENDERER || 'browser-default';
    assert.ok(['browser-default', 'swiftshader'].includes(rendererMode), 'Unsupported test browser renderer mode.');
    const rendererArgs = rendererMode === 'swiftshader'
      ? ['--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'] : [];
    report.rendererMode = rendererMode;
    report.rendererArguments = rendererArgs;
    browser = await chromium.launch({ headless: true, args: rendererArgs });
    report.browserVersion = browser.version();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) { report.externalRequests.push(route.request().url()); await route.abort(); }
      else await route.continue();
    });
    await page.goto(`${origin}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => ['ready', 'error'].includes(window.__stereofoldRoundtrip?.snapshot().status), null, { timeout: 30_000 });
    const snapshot = () => page.evaluate(() => window.__stereofoldRoundtrip.snapshot());
    const capture = id => page.evaluate(id => window.__stereofoldRoundtrip.capturePanel(id), id);
    const describe = id => page.evaluate(id => window.__stereofoldRoundtrip.describePanel(id), id);
    const apply = instruction => page.evaluate(instruction => window.__stereofoldRoundtrip.applyCommand(instruction), instruction);
    report.initial = await snapshot();
    assert.equal(report.initial.status, 'ready', report.initial.error);
    assert.equal(report.initial.maxLiveViewers, 3);
    assert.equal(report.initial.panels['panel-a'].atomCount, 327);
    assert.equal(report.initial.panels['panel-b'].atomCount, 7);
    assert.equal(report.initial.panels.receiver.atomCount, 7);
    for (const view of Object.values(report.initial.panels)) {
      assert.ok(view.drawCount > 0 && view.representationCount > 0 && view.renderObjectCount > 0);
    }
    check('Three independent actual Mol* viewers loaded their declared public structures');
    await shot('01-initial.png');

    await page.locator('#panel-a select').selectOption('ball-and-stick');
    await page.waitForFunction(() => window.__stereofoldRoundtrip.snapshot().panels['panel-a'].representation === 'ball-and-stick');
    const residue15 = page.locator('#panel-a .sequence button[data-label-chain="A"][data-label-sequence="15"]');
    await residue15.click();
    await page.waitForFunction(() => document.querySelector('#panel-a .sequence button[data-label-sequence="15"]')?.getAttribute('aria-pressed') === 'true');
    const beforeDrag = await capture('panel-a');
    const canvasBox = await page.locator('#panel-a canvas').boundingBox();
    await page.mouse.move(canvasBox.x + canvasBox.width * .45, canvasBox.y + canvasBox.height * .52);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width * .64, canvasBox.y + canvasBox.height * .60, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(camera => JSON.stringify(window.__stereofoldRoundtrip.snapshot().panels['panel-a'].camera) !== JSON.stringify(camera), beforeDrag.scene.camera);
    // Interact with B last. The capture call still names A explicitly.
    await page.locator('#panel-b .sequence button').first().click();
    await page.waitForFunction(() => {
      const state = window.__stereofoldRoundtrip.snapshot();
      return state.lastInteractedPanel === 'panel-b' && state.panels['panel-b'].ready
        && document.querySelector('#panel-b .sequence button')?.getAttribute('aria-pressed') === 'true';
    });
    report.captureA = await capture('panel-a');
    report.captureB = await capture('panel-b');
    assert.equal(report.captureA.fixtureId, 'public_1crn');
    assert.equal(report.captureA.scene.representation, 'ball-and-stick');
    assert.equal(report.captureA.scene.selectionKeys.length, 1);
    assert.notDeepEqual(report.captureA.scene.camera, beforeDrag.scene.camera);
    assert.notEqual(report.captureA.scene.sourceSha256, report.captureB.scene.sourceSha256);
    check('Capture A retained manual appearance, selection and camera after B was used last');
    await shot('02-selected-source.png');

    report.transfer = await coordinator.transfer(report.captureA);
    const reconstructed = await page.evaluate(instruction => window.__stereofoldRoundtrip.loadInstruction(instruction), report.transfer.instruction);
    report.captureBinding = coordinator.bindRenderedCapture(report.transfer.instruction, reconstructed);
    assert.equal(reconstructed.atomCount, 327);
    assert.equal(reconstructed.sourceSha256, report.captureA.scene.sourceSha256);
    assert.equal(reconstructed.modelNumber, report.captureA.scene.modelNumber);
    assert.equal(reconstructed.assemblyId, report.captureA.scene.assemblyId);
    assert.equal(reconstructed.representation, report.captureA.scene.representation);
    assert.deepEqual(reconstructed.selectionKeys, report.captureA.scene.selectionKeys);
    assertCamera(reconstructed.camera, report.captureA.scene.camera);
    check('Receiver reconstructed exact source/model/assembly and declared capture subset', { cameraTolerance: 1e-6 });
    await shot('03-reconstructed.png');

    const wrongGenerationInstruction = { sourceSha256: reconstructed.sourceSha256,
      sceneId: report.transfer.instruction.sceneId, operation: { kind: 'set_representation', value: 'cartoon' },
      expectedBrowser: { instanceId: reconstructed.instanceId, generation: reconstructed.generation + 1,
        loadCount: reconstructed.loadCount, revision: reconstructed.revision, drawCount: reconstructed.drawCount } };
    await assert.rejects(apply(wrongGenerationInstruction), /ownership changed/);
    assert.equal((await snapshot()).panels.receiver.revision, reconstructed.revision);
    check('Browser refused a stale generation before changing the representation');

    const command = coordinator.makeCommand({ kind: 'set_representation', value: 'cartoon' });
    let browserDispatches = 0;
    const trackedApply = async instruction => { browserDispatches += 1; return apply(instruction); };
    const [first, inflightDuplicate] = await Promise.all([
      coordinator.command(command, trackedApply), coordinator.command(command, trackedApply),
    ]);
    assert.equal(first.status, 'rendered');
    assert.equal(inflightDuplicate.status, 'rendered');
    const retried = await coordinator.command(command, trackedApply); // First acknowledgment is treated as lost.
    assert.equal(retried.status, 'rendered');
    assert.equal(browserDispatches, 1);
    report.representationCommand = { command, first, inflightDuplicate, retried, browserDispatches };
    const afterCommand = (await snapshot()).panels.receiver;
    assert.equal(afterCommand.instanceId, reconstructed.instanceId);
    assert.equal(afterCommand.loadCount, reconstructed.loadCount);
    assert.equal(afterCommand.representation, 'cartoon');
    assert.ok(afterCommand.drawCount > reconstructed.drawCount);
    assert.deepEqual(afterCommand.selectionKeys, reconstructed.selectionKeys);
    check('A command changed the already-loaded renderer; concurrent and lost-ack retries dispatched once');

    const wrong = coordinator.makeCommand({ kind: 'set_representation', value: 'ball-and-stick' });
    wrong.target.sessionId = 'session-panel-b';
    const rejected = await coordinator.command(wrong, trackedApply);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, 'wrong_target');
    assert.equal(browserDispatches, 1);
    assert.equal((await snapshot()).panels.receiver.revision, afterCommand.revision);
    report.wrongTarget = rejected;
    check('Wrong-session command was rejected before browser mutation');
    await shot('04-live-command.png');

    const ballAndStick = coordinator.makeCommand({ kind: 'set_representation', value: 'ball-and-stick' });
    const restored = await coordinator.command(ballAndStick, apply);
    assert.equal(restored.status, 'rendered');
    const beforeSelection = (await capture('receiver')).scene.camera;
    await page.locator('#receiver .sequence button[data-label-chain="A"][data-label-sequence="7"]').click();
    await page.waitForFunction(() => document.querySelector('#receiver .sequence button[data-label-sequence="7"]')?.getAttribute('aria-pressed') === 'true');
    const selected = await capture('receiver');
    const selectedRenderer = (await snapshot()).panels.receiver;
    assert.equal(selected.scene.selectionKeys.length, 1);
    assert.ok(selectedRenderer.selectedMarkerCount > 0 && selectedRenderer.selectionLociElementCount > 0);
    assertCamera(selected.scene.camera, beforeSelection);
    check('Sequence selection changed actual molecular markers and preserved the camera');
    const pickRows = await page.evaluate(() => window.__stereofoldRoundtrip.rows('receiver'));
    let point, chosenRow;
    for (const row of pickRows.filter(r => r.coordinateState === 'resolved' && r.key !== selected.scene.selectionKeys[0])) {
      try {
        point = await page.evaluate(key => window.__stereofoldRoundtrip.pickPoint('receiver', key), row.key);
        if (point) { chosenRow = row; break; }
      } catch { /* Try another exposed residue when all sites in this one are occluded. */ }
    }
    assert.ok(point && chosenRow, 'At least one visible unselected residue must be available for an actual mouse pick.');
    await page.mouse.click(point.x, point.y);
    await page.waitForFunction(key => {
      const receiver = window.__stereofoldRoundtrip.snapshot().panels.receiver;
      return receiver.ready && receiver.lastPick?.status === 'rendered' && receiver.selectionKeys.includes(key);
    }, chosenRow.key);
    let picked = await capture('receiver');
    assert.ok(picked.scene.selectionKeys.includes(chosenRow.key));
    const pressedKeys = await page.locator('#receiver .sequence button[aria-pressed="true"]').evaluateAll(buttons => buttons.map(b => b.dataset.key));
    assert.deepEqual(pressedKeys.sort(), [...picked.scene.selectionKeys].sort());
    report.picking = { point, identity: chosenRow.identity, selectionKeys: picked.scene.selectionKeys };
    check('A real canvas mouse pick selected the same canonical residue in the sequence controls');
    await shot('05-linked-pick.png');

    const beforeReceiverDrag = picked.scene.camera;
    const receiverBox = await page.locator('#receiver canvas').boundingBox();
    await page.mouse.move(receiverBox.x + receiverBox.width * .48, receiverBox.y + receiverBox.height * .50);
    await page.mouse.down();
    await page.mouse.move(receiverBox.x + receiverBox.width * .61, receiverBox.y + receiverBox.height * .38, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(camera => JSON.stringify(window.__stereofoldRoundtrip.snapshot().panels.receiver.camera) !== JSON.stringify(camera), beforeReceiverDrag);
    picked = await capture('receiver');
    assert.notDeepEqual(picked.scene.camera, report.captureA.scene.camera);
    assert.ok(picked.scene.selectionKeys.includes(chosenRow.key));
    check('Receiver inspection changed the actual camera before returning it to A');

    const bBeforeReturn = await capture('panel-b');
    const aDescriptor = await describe('panel-a');
    const rowsByKey = new Map(pickRows.map(r => [r.key, r]));
    const returnSnapshot = { version: 1, snapshotId: 'return-1', target,
      sourceSceneId: report.captureA.sceneId, sourceSha256: report.captureA.scene.sourceSha256,
      baseDesktopRevision: report.captureA.desktopRevision,
      selectionKeys: picked.scene.selectionKeys.map(key => selectionId(rowsByKey.get(key))),
      view: { centerAngstrom: picked.scene.camera.target, orientation: [0, 0, 0, 1], radiusAngstrom: picked.scene.camera.radius } };
    report.returnDecision = decideReturn(returnSnapshot, aDescriptor);
    assert.equal(report.returnDecision.status, 'apply_to_original');
    report.returnApplied = await page.evaluate(({ expected, scene }) => window.__stereofoldRoundtrip.applyReturn('panel-a', expected, scene),
      { expected: aDescriptor, scene: picked.scene });
    assert.equal(report.returnApplied.status, 'applied');
    const returnedA = await capture('panel-a');
    assert.deepEqual(returnedA.scene.selectionKeys, picked.scene.selectionKeys);
    assertCamera(returnedA.scene.camera, picked.scene.camera);
    assert.deepEqual((await capture('panel-b')).scene, bBeforeReturn.scene);
    check('Return updated A selection and complete draft camera; B stayed unchanged');
    await shot('06-returned-to-a.png');

    await page.evaluate(() => window.__stereofoldRoundtrip.setHidden('panel-a', true));
    const hiddenDescriptor = await describe('panel-a');
    const hiddenSnapshot = { ...returnSnapshot, snapshotId: 'return-hidden', baseDesktopRevision: hiddenDescriptor.revision };
    report.hiddenReturnDecision = decideReturn(hiddenSnapshot, hiddenDescriptor);
    assert.equal(report.hiddenReturnDecision.reason, 'original_panel_hidden');
    const hiddenResult = await page.evaluate(({ expected, scene }) => window.__stereofoldRoundtrip.applyReturn('panel-a', expected, scene),
      { expected: hiddenDescriptor, scene: picked.scene });
    assert.equal(hiddenResult.status, 'applied');
    await page.evaluate(() => window.__stereofoldRoundtrip.setHidden('panel-a', false));
    assert.deepEqual((await capture('panel-b')).scene, bBeforeReturn.scene);
    check('Hidden A retained its target; the visible B panel was never substituted');

    const beforeMalformed = await capture('panel-a');
    const malformedExpected = await describe('panel-a');
    const alternative = pickRows.find(row => !beforeMalformed.scene.selectionKeys.includes(row.key));
    const malformed = { ...picked.scene, selectionKeys: [alternative.key],
      camera: { ...picked.scene.camera, up: [0, 0, 0] } };
    await assert.rejects(page.evaluate(({ expected, scene }) => window.__stereofoldRoundtrip.applyReturn('panel-a', expected, scene),
      { expected: malformedExpected, scene: malformed }), /camera|Camera/);
    assert.deepEqual((await capture('panel-a')).scene, beforeMalformed.scene);
    check('Malformed return camera was rejected before its valid selection could change A');

    const heldBox = await page.locator('#panel-a canvas').boundingBox();
    await page.mouse.move(heldBox.x + heldBox.width * .3, heldBox.y + heldBox.height * .3);
    await page.mouse.down();
    await page.waitForFunction(() => window.__stereofoldRoundtrip.snapshot().panels['panel-a'].interactionActive);
    const heldCapture = await capture('panel-a');
    const heldExpected = await describe('panel-a');
    await assert.rejects(page.evaluate(({ expected, scene }) => window.__stereofoldRoundtrip.applyReturn('panel-a', expected, scene),
      { expected: heldExpected, scene: picked.scene }), /manipulation|drag|interaction/i);
    assert.deepEqual((await capture('panel-a')).scene, heldCapture.scene);
    await page.mouse.up();
    await page.waitForFunction(() => !window.__stereofoldRoundtrip.snapshot().panels['panel-a'].interactionActive);
    check('Return refused while a real mouse drag owned the original viewer');

    const beforeRace = await describe('panel-a');
    const raceSnapshot = { ...returnSnapshot, snapshotId: 'return-race', baseDesktopRevision: beforeRace.revision };
    assert.equal(decideReturn(raceSnapshot, beforeRace).status, 'apply_to_original');
    await page.locator('#panel-a .sequence button[data-label-chain="A"][data-label-sequence="20"]').click();
    await page.waitForFunction(() => document.querySelector('#panel-a .sequence button[data-label-sequence="20"]')?.getAttribute('aria-pressed') === 'true');
    const newerScene = await capture('panel-a');
    report.racedReturn = await page.evaluate(({ expected, scene }) => window.__stereofoldRoundtrip.applyReturn('panel-a', expected, scene),
      { expected: beforeRace, scene: picked.scene });
    assert.equal(report.racedReturn.status, 'save_snapshot');
    assert.deepEqual((await capture('panel-a')).scene, newerScene.scene);
    assert.equal(decideReturn(raceSnapshot, await describe('panel-a')).reason, 'desktop_revision_changed');
    check('A newer local selection between return decision and apply survived the return');

    const receiverBeforeFailure = await capture('receiver');
    await assert.rejects(page.evaluate(() => window.__stereofoldRoundtrip.loadPanel('receiver', 'public_1crn', { modelNumber: 99 })));
    assert.deepEqual((await capture('receiver')).scene, receiverBeforeFailure.scene);
    check('An unavailable model failed without replacing the loaded receiver');

    await page.evaluate(() => window.__stereofoldRoundtrip.loadPanel('panel-a', 'identity_edge', { modelNumber: 1 }));
    report.replacedReturn = decideReturn(returnSnapshot, await describe('panel-a'));
    assert.equal(report.replacedReturn.reason, 'desktop_source_replaced');
    const edgeBefore = await capture('panel-a');
    await page.locator('#panel-a .sequence button[data-label-chain="A"][data-label-sequence="3"][data-copy="1"]').click();
    await page.waitForFunction(() => document.querySelector('#panel-a .sequence button[data-label-chain="A"][data-label-sequence="3"][data-copy="1"]')?.getAttribute('aria-pressed') === 'true');
    const missing = await capture('panel-a');
    assert.equal(missing.scene.selectionKeys.length, 1);
    const missingRenderer = (await snapshot()).panels['panel-a'];
    assert.equal(missingRenderer.selectedMarkerCount, 0);
    assert.equal(missingRenderer.selectionLociElementCount, 0);
    assertCamera(missing.scene.camera, edgeBefore.scene.camera);
    assert.ok(await page.locator('#panel-a .selection-label').textContent().then(text => text.includes('coordinates missing')));
    check('Replaced sources reject old returns; unresolved sequence positions remain selectable without moving the camera');
    await shot('07-missing-coordinates.png');

    await page.evaluate(() => window.__stereofoldRoundtrip.disposePanel('panel-a'));
    report.unmountedReturn = decideReturn(returnSnapshot, await describe('panel-a'));
    assert.equal(report.unmountedReturn.reason, 'original_panel_unmounted');
    check('Unmounted original panel retained a recoverable return result');
    report.disposalRace = await page.evaluate(async () => {
      const api = window.__stereofoldRoundtrip;
      const accepted = api.setRepresentation('panel-b', 'ball-and-stick');
      const closing = api.disposePanel('panel-b');
      const late = api.select('panel-b', []).then(() => ({ accepted: true }), error => ({ accepted: false, reason: error.message }));
      const [rendered, , refused] = await Promise.all([accepted, closing, late]);
      return { acceptedMutationRendered: rendered.ready, refused, final: api.snapshot().panels['panel-b'] };
    });
    assert.equal(report.disposalRace.acceptedMutationRendered, true);
    assert.equal(report.disposalRace.refused.accepted, false);
    assert.match(report.disposalRace.refused.reason, /closing/);
    assert.equal(report.disposalRace.final.mounted, false);
    assert.equal(report.disposalRace.final.status, 'disposed');
    check('Disposal finished admitted work and refused a mutation arriving after close began');
    report.savedReturns = [raceSnapshot, returnSnapshot];
    report.final = await snapshot();
    await page.evaluate(() => window.__stereofoldRoundtrip.dispose());
    report.disposed = await snapshot();
    assert.equal(report.disposed.status, 'disposed');
    assert.ok(Object.values(report.disposed.panels).every(p => !p.mounted));
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []);
    check('All owned viewer instances disposed; no page errors or external requests');
    report.status = 'passed';
  } catch (error) {
    report.error = error.stack ?? String(error);
    if (page) {
      try { report.failureSnapshot = await page.evaluate(() => window.__stereofoldRoundtrip?.snapshot()); await shot('failure.png'); }
      catch { /* Preserve the original failure when the page itself is unavailable. */ }
    }
    process.exitCode = 1;
  } finally {
    if (coordinator) report.coordinator = coordinator.inspect();
    if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
    if (server) { await new Promise(resolve => server.close(resolve)); report.cleanup.serverClosed = true; }
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(out, 'browser-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, cases: report.cases.length,
    report: path.join(out, 'browser-report.json'), error: report.error })}\n`);
}
main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
