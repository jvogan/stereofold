#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { InspectionHistory, replayHistory } from '../protocol/history.mjs';
import { camerasEqual, validateCamera } from '../protocol/camera.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, '../..');
const requirePlugin = createRequire(path.join(repo, 'plugin/package.json'));
const requireLocal = createRequire(import.meta.url);
const { chromium } = requirePlugin('playwright');
const { extractFile } = requireLocal('../identity/extract.cjs');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const MEDIUM_SHA256 = '2d3ca1bf21ddff35af2e2bc5d331720f7bfc46a16c4829ea3ec1b41062d5f5a6';
const SCENE_FIELDS = ['sourceSha256', 'modelNumber', 'assemblyId', 'representation', 'color', 'selectionKeys', 'camera'];

function assertCamera(actual, expected) {
  validateCamera(actual); validateCamera(expected);
  assert.ok(camerasEqual(actual, expected), `Camera changed: ${JSON.stringify({ actual, expected })}`);
}

function assertScene(actual, expected) {
  for (const key of SCENE_FIELDS.filter(key => !['camera', 'selectionKeys'].includes(key))) {
    assert.deepEqual(actual[key], expected[key], `${key} changed`);
  }
  assert.deepEqual([...actual.selectionKeys].sort(), [...expected.selectionKeys].sort(), 'Selection changed');
  assertCamera(actual.camera, expected.camera);
}

function rotatedCamera(input, radians = 0.24) {
  const camera = clone(input);
  const rotate = ([x, y, z]) => [x * Math.cos(radians) + z * Math.sin(radians), y,
    -x * Math.sin(radians) + z * Math.cos(radians)];
  const offset = camera.position.map((value, index) => value - camera.target[index]);
  camera.position = rotate(offset).map((value, index) => value + camera.target[index]);
  camera.up = rotate(camera.up);
  return validateCamera(camera);
}

function modelSnapshot(snapshot, revision) {
  return { revision, ...Object.fromEntries(SCENE_FIELDS.map(key => [key, clone(snapshot[key])])) };
}

function frameReceipt(snapshot, revision) {
  return { revision, instanceId: snapshot.instanceId, generation: snapshot.generation,
    loadCount: snapshot.loadCount, browserRevision: snapshot.revision, drawCount: snapshot.drawCount };
}

function expectedCounts(catalog, modelNumber = 1) {
  const rows = catalog.rows.filter(row => row.identity.modelNumber === modelNumber);
  return { rows, atoms: rows.reduce((sum, row) => sum + row.atomSites.length, 0),
    residues: rows.filter(row => row.atomSites.length > 0).length };
}

function assertReady(snapshot, { scene, prior, catalog, cells } = {}) {
  assert.equal(snapshot.status, 'ready', snapshot.error);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.contextLost, false);
  assert.equal(snapshot.contextDisposed, false);
  assert.equal(snapshot.candidatePresent, false);
  assert.equal(snapshot.candidateCount, 0);
  assert.equal(snapshot.frameCoverVisible, false);
  assert.equal(snapshot.frameCoverBytes, 0);
  assert.equal(snapshot.pendingFrameWaits, 0);
  assert.equal(snapshot.testPausedAt, null);
  assert.equal(snapshot.replacementPhase, 'idle');
  assert.equal(snapshot.representationCount, 1);
  assert.ok(snapshot.renderObjectCount > 0 && snapshot.drawCount > 0);
  assert.equal(snapshot.xrPresenting, false);
  assert.equal(snapshot.trackballAnimation, 'off');
  assert.equal(snapshot.desktopStereo, 'off');
  if (cells !== undefined) assert.equal(snapshot.stateCellCount, cells, 'Retained Mol* state cell count changed');
  if (scene) assertScene(snapshot, scene);
  if (prior) {
    assert.equal(snapshot.instanceId, prior.instanceId, 'A replacement created a new viewer instance');
    assert.ok(snapshot.drawCount > prior.drawCount, 'The operation needs a subsequent actual draw');
  }
  if (catalog) {
    const counts = expectedCounts(catalog, snapshot.modelNumber);
    assert.equal(snapshot.sourceSha256, catalog.source.sha256);
    assert.equal(snapshot.atomCount, counts.atoms);
    assert.equal(snapshot.residueCount, counts.residues);
    assert.equal(snapshot.sequenceRowCount, counts.rows.length);
    const selected = new Set(snapshot.selectionKeys);
    assert.ok([...selected].every(key => counts.rows.some(row => row.key === key)));
    const atoms = counts.rows.filter(row => selected.has(row.key)).reduce((sum, row) => sum + row.atomSites.length, 0);
    assert.equal(snapshot.selectionLociElementCount, atoms, 'Actual Mol* loci do not match the selected atom sites');
    if (atoms) assert.ok(snapshot.selectedMarkerCount > 0, 'Resolved selection needs actual marked geometry');
    else assert.equal(snapshot.selectedMarkerCount, 0);
  }
}

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 4 && args[0] === '--build' && args[2] === '--out'
    && path.isAbsolute(args[1]) && path.isAbsolute(args[3]), 'Use --build /absolute/build --out /absolute/new-ssd-directory');
  const buildDirectory = await fs.realpath(args[1]);
  const out = path.join(await fs.realpath(path.dirname(args[3])), path.basename(args[3]));
  const actualRepo = await fs.realpath(repo);
  assert.ok(out !== actualRepo && !out.startsWith(`${actualRepo}${path.sep}`), 'Keep generated artifacts outside the repository');
  await fs.mkdir(out);
  const report = { schemaVersion: 1, kind: 'browser_recovery_history_performance', status: 'failed',
    startedAt: new Date().toISOString(), buildDirectory,
    verifierSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))), cases: [], screenshots: [],
    sourceHashes: [], pageErrors: [], consoleErrors: [], expectedContextLogs: [], externalRequests: [],
    actualCodexHost: 'not_run', nativeVoice: 'not_run', headsetQualification: 'not_run',
    transport: 'Owned Node driver and browser test adapter',
    cleanup: { viewersDisposed: false, browserClosed: false, serverClosed: false, errors: [] } };
  let browser, server, page, history;
  let phase = 'setup';
  const started = performance.now();
  const runCase = async (name, action) => {
    phase = name;
    const start = performance.now();
    try {
      const detail = await action() ?? {};
      report.cases.push({ name, status: 'passed', durationMs: performance.now() - start, ...detail });
      if (detail.status !== 'unsupported') process.stdout.write(`PASS ${name}\n`);
      else process.stdout.write(`UNSUPPORTED ${name}\n`);
    } catch (error) {
      report.cases.push({ name, status: 'failed', durationMs: performance.now() - start, error: error.message });
      throw error;
    }
  };
  const shot = async name => {
    await page.screenshot({ path: path.join(out, name) });
    const bytes = await fs.readFile(path.join(out, name));
    report.screenshots.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  };

  try {
    const build = JSON.parse(await fs.readFile(path.join(buildDirectory, 'build-report.json'), 'utf8'));
    assert.equal(build.status, 'passed');
    const artifacts = JSON.parse(await fs.readFile(path.join(buildDirectory, 'artifact-hashes.json'), 'utf8'));
    for (const item of artifacts) {
      assert.equal(path.basename(item.path), item.path);
      const bytes = await fs.readFile(path.join(buildDirectory, item.path));
      assert.equal(bytes.length, item.bytes);
      assert.equal(sha256(bytes), item.sha256);
    }
    report.bundleSha256 = build.bundleSha256;
    report.buildReportSha256 = sha256(await fs.readFile(path.join(buildDirectory, 'build-report.json')));
    report.buildSourceRevision = build.sourceRevision;
    report.dependencies = build.dependencies;
    for (const item of build.sourceFiles) {
      const file = path.resolve(repo, item.path);
      assert.ok(file.startsWith(`${repo}${path.sep}`), 'Build source path escaped the repository');
      assert.equal(sha256(await fs.readFile(file)), item.sha256, `Build source changed: ${item.path}`);
    }
    for (const name of ['verify-recovery.mjs', '../protocol/history.mjs', '../protocol/camera.mjs',
      '../protocol/contracts.mjs', '../identity/extract.cjs', '../identity/identity.cjs']) {
      const file = path.resolve(directory, name);
      const bytes = await fs.readFile(file);
      report.sourceHashes.push({ path: path.relative(repo, file), bytes: bytes.length, sha256: sha256(bytes) });
    }
    const fixtures = new Map();
    for (const item of build.fixtures) {
      const file = path.resolve(repo, item.path);
      assert.ok(file.startsWith(`${repo}${path.sep}`));
      const cif = await fs.readFile(file, 'utf8');
      const parseStart = performance.now();
      const catalog = await extractFile(file, { assemblyId: '1', expectedHash: item.sha256 });
      assert.equal(sha256(JSON.stringify(catalog)), item.catalogSha256);
      fixtures.set(item.id, { id: item.id, cif, catalog, sha256: item.sha256, nodeCatalogParseMs: performance.now() - parseStart });
    }
    const mediumFile = path.resolve(directory, '../../fixtures/4HHB.cif');
    const mediumSource = JSON.parse(await fs.readFile(path.resolve(directory, '../../fixtures/4HHB.source.json'), 'utf8'));
    assert.equal(mediumSource.sha256, MEDIUM_SHA256);
    const mediumBytes = await fs.readFile(mediumFile);
    assert.equal(mediumBytes.length, mediumSource.bytes);
    assert.equal(sha256(mediumBytes), MEDIUM_SHA256);
    const parseStart = performance.now();
    const mediumCatalog = await extractFile(mediumFile, { assemblyId: '1', expectedHash: MEDIUM_SHA256 });
    const medium = { id: 'public_4hhb', cif: mediumBytes.toString('utf8'), catalog: mediumCatalog, sha256: MEDIUM_SHA256,
      nodeCatalogParseMs: performance.now() - parseStart };
    fixtures.set(medium.id, medium);
    report.mediumFixture = { id: medium.id, bytes: mediumBytes.length, sha256: MEDIUM_SHA256,
      source: mediumSource.source, catalogSha256: sha256(JSON.stringify(mediumCatalog)) };
    const small = fixtures.get('public_1crn');
    const ligand = fixtures.get('synthetic_ligand');
    assert.ok(small && ligand);

    const originalHtml = await fs.readFile(path.join(buildDirectory, 'index.html'), 'utf8');
    assert.equal(originalHtml.split('<body>').length, 2, 'Expected the built document to have one plain body tag');
    const receiverHtml = originalHtml.replace('<body>', '<body data-roundtrip-role="receiver">');
    report.document = { baseSha256: sha256(originalHtml), receiverSha256: sha256(receiverHtml),
      change: 'Added data-roundtrip-role="receiver" to mount one owned viewer' };
    const served = new Map([
      ['/index.html', { type: 'text/html', bytes: Buffer.from(receiverHtml) }],
      ['/roundtrip.js', { type: 'application/javascript', bytes: await fs.readFile(path.join(buildDirectory, 'roundtrip.js')) }],
      ['/roundtrip.css', { type: 'text/css', bytes: await fs.readFile(path.join(buildDirectory, 'roundtrip.css')) }],
    ]);
    assert.equal(sha256(served.get('/roundtrip.js').bytes), report.bundleSha256);
    server = http.createServer((request, response) => {
      if (request.url === '/favicon.ico' && request.method === 'GET') { response.writeHead(204); response.end(); return; }
      const file = served.get(request.url === '/' ? '/index.html' : request.url);
      if (request.method !== 'GET' || !file) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': `${file.type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      response.end(file.bytes);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    report.browserVersion = browser.version();
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      const known = new WeakSet();
      const contexts = [];
      const events = [];
      HTMLCanvasElement.prototype.getContext = function (...args) {
        const result = getContext.apply(this, args);
        if (result && ['webgl', 'webgl2', 'experimental-webgl'].includes(args[0]) && !known.has(result)) {
          known.add(result);
          const entry = { id: contexts.length + 1, type: args[0], owner: this.closest('.panel')?.id ?? null,
            canvas: this, gl: result };
          contexts.push(entry);
          for (const name of ['webglcontextlost', 'webglcontextrestored']) {
            this.addEventListener(name, () => events.push({ contextId: entry.id, type: name, atMs: performance.now() }));
          }
        }
        return result;
      };
      Object.defineProperty(window, '__recoveryContextStats', { value: () => ({
        created: contexts.length, contexts: contexts.map(item => ({ id: item.id, type: item.type, owner: item.owner,
          connected: item.canvas.isConnected, lost: item.gl.isContextLost(),
          renderer: item.gl.isContextLost() ? null : item.gl.getParameter(item.gl.RENDERER),
          version: item.gl.isContextLost() ? null : item.gl.getParameter(item.gl.VERSION) })),
        events: structuredClone(events),
      }), writable: false });
    });
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const value = message.text();
      if (phase.startsWith('Context ') && /CONTEXT_LOST_WEBGL|WebGL context (?:was )?lost|webglcontextlost/iu.test(value)) {
        report.expectedContextLogs.push({ phase, message: value });
      } else report.consoleErrors.push(value);
    });
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== origin) {
        report.externalRequests.push(route.request().url()); await route.abort();
      } else await route.continue();
    });
    await page.goto(`${origin}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => ['ready', 'error'].includes(window.__stereofoldRoundtrip?.snapshot().status));
    const state = () => page.evaluate(() => window.__stereofoldRoundtrip.snapshot());
    const current = async () => (await state()).panels.receiver;
    const capture = () => page.evaluate(() => window.__stereofoldRoundtrip.capturePanel('receiver'));
    const contexts = () => page.evaluate(() => window.__recoveryContextStats());
    const hook = (method, ...args) => page.evaluate(({ method, args }) =>
      window.__stereofoldRoundtrip.lifecycleTest('receiver', method, ...args), { method, args });
    const load = (fixtureId, options = {}) => page.evaluate(({ fixtureId, options }) =>
      window.__stereofoldRoundtrip.loadPanel('receiver', fixtureId, options), { fixtureId, options });
    const attemptLoad = (fixtureId = 'synthetic_ligand', options = {}) => page.evaluate(async ({ fixtureId, options }) => {
      try { return { status: 'fulfilled', snapshot: await window.__stereofoldRoundtrip.loadPanel('receiver', fixtureId, options) }; }
      catch (error) { return { status: 'rejected', code: error.code ?? null, message: error.message }; }
    }, { fixtureId, options });
    const waitPaused = point => page.waitForFunction(point =>
      window.__stereofoldRoundtrip.snapshot().panels.receiver.testPausedAt === point, point);

    report.initial = await state();
    assert.equal(report.initial.status, 'ready', report.initial.error);
    assert.deepEqual(Object.keys(report.initial.panels), ['receiver']);
    assert.equal(report.initial.maxLiveViewers, 1);
    assertReady(report.initial.panels.receiver, { catalog: ligand.catalog });
    report.initialContexts = await contexts();
    assert.equal(report.initialContexts.contexts.filter(item => item.owner === 'receiver').length, 1);
    const contextCount = report.initialContexts.created;
    const noContextGrowth = async () => {
      const value = await contexts();
      assert.equal(value.created, contextCount, 'A scene operation created another WebGL context');
      assert.equal(value.contexts.filter(item => item.owner === 'receiver').length, 1);
      return value;
    };
    await runCase('One receiver rendered the pinned public baseline', async () => {
      await load('public_1crn', { representation: 'ball-and-stick' });
      const key = small.catalog.rows.find(row => row.identity.modelNumber === 1 && row.identity.labelSequenceId === 15).key;
      const before = await current();
      const inspection = { selectionKeys: [key], camera: rotatedCamera(before.camera) };
      const after = await page.evaluate(inspection => window.__stereofoldRoundtrip.applyInspection('receiver', inspection), inspection);
      assertReady(after, { catalog: small.catalog, prior: before });
      assert.deepEqual(after.selectionKeys, inspection.selectionKeys);
      assertCamera(after.camera, inspection.camera);
      await noContextGrowth();
      await shot('01-baseline.png');
      return { snapshot: after };
    });

    for (const point of ['after_parse', 'after_representation', 'after_candidate_draw']) {
      await runCase(`Replacement failure at ${point} preserved the entire prior capture`, async () => {
        const before = await current();
        const saved = await capture();
        await hook('failNextLoadAt', point);
        const failed = await attemptLoad();
        assert.equal(failed.status, 'rejected');
        assert.equal(failed.code, 'injected_load_failure');
        const after = await current();
        const recovered = await capture();
        assertScene(recovered.scene, saved.scene);
        assertReady(after, { scene: saved.scene, prior: before, catalog: small.catalog, cells: before.stateCellCount });
        assert.equal(after.generation, before.generation + 1);
        assert.equal(after.loadCount, before.loadCount);
        assert.equal(after.revision, before.revision);
        assert.deepEqual(after.mutationCounts, before.mutationCounts);
        assert.equal(after.lastLoadFailure.phase, point);
        assert.equal(after.lastLoadFailure.recovered, true);
        assert.equal(after.lastLoadFailure.candidateRemoved, true);
        assert.equal(after.lastLoadFailure.recoveryPending, false);
        assert.ok(after.lastLoadFailure.rollbackDrawCount > before.drawCount);
        await noContextGrowth();
        return { failure: failed, priorCapture: saved, recoveredCapture: recovered, snapshot: after };
      });
    }

    async function actualPick() {
      const before = await current();
      const rows = await page.evaluate(() => window.__stereofoldRoundtrip.rows('receiver'));
      let point, chosen;
      for (const row of rows.filter(row => row.atomSites.length && !before.selectionKeys.includes(row.key))) {
        try {
          point = await page.evaluate(key => window.__stereofoldRoundtrip.pickPoint('receiver', key), row.key);
          if (point) { chosen = row; break; }
        } catch (error) {
          if (!/visible atom|not_visible|occluded|pick buffer/iu.test(error.message)) throw error;
        }
      }
      assert.ok(point && chosen, 'No unselected residue had a visible point in the actual Mol* pick buffer');
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(key => {
        const snapshot = window.__stereofoldRoundtrip.snapshot().panels.receiver;
        return snapshot.ready && snapshot.lastPick?.status === 'rendered' && snapshot.selectionKeys.includes(key);
      }, chosen.key);
      const after = await current();
      assertReady(after, { catalog: small.catalog, prior: before, cells: before.stateCellCount });
      assertCamera(after.camera, before.camera);
      assert.equal(after.mutationCounts.pick, before.mutationCounts.pick + 1);
      const pressed = await page.locator('#receiver .sequence button[aria-pressed="true"]')
        .evaluateAll(buttons => buttons.map(button => button.dataset.key));
      assert.deepEqual(pressed.sort(), [...after.selectionKeys].sort());
      return { point, identity: chosen.identity, snapshot: after };
    }
    await runCase('An actual mouse pick still linked 3D and sequence after rollback', actualPick);

    await runCase('Cancelling a paused replacement restored the view and refused competing viewer mutations', async () => {
      const before = await current();
      const saved = await capture();
      await hook('pauseNextLoadAt', 'after_representation');
      const pending = attemptLoad();
      await waitPaused('after_representation');
      const paused = await current();
      assert.equal(paused.ready, false);
      assert.equal(paused.candidateCount, 1);
      const competing = await page.evaluate(() => window.__stereofoldRoundtrip.probeBusy('receiver'));
      assert.equal(competing.length, 2);
      assert.ok(competing.every(result => result.status === 'rejected' && result.code === 'viewer_busy'));
      const cancelled = await page.evaluate(() => window.__stereofoldRoundtrip.cancelLoad('receiver'));
      assert.equal(cancelled.cancelled, true);
      const failed = await pending;
      assert.equal(failed.status, 'rejected');
      assert.equal(failed.code, 'load_cancelled');
      const after = await current();
      assertReady(after, { scene: saved.scene, prior: before, catalog: small.catalog, cells: before.stateCellCount });
      assert.equal(after.revision, before.revision);
      assert.equal(after.loadCount, before.loadCount);
      assert.equal(after.lastLoadFailure.recovered, true);
      assert.equal((await page.evaluate(() => window.__stereofoldRoundtrip.cancelLoad('receiver'))).cancelled, false);
      await noContextGrowth();
      return { paused, competing, cancellation: failed, snapshot: after };
    });

    let contextSupported = null;
    async function restoreContext(before) {
      const restore = await hook('restoreContext');
      assert.equal(restore.supported, true);
      await page.waitForFunction(count => {
        const value = window.__stereofoldRoundtrip.snapshot().panels.receiver;
        return value.contextRestorationCount > count || value.status === 'error';
      }, before.contextRestorationCount);
      const recovered = await hook('waitForContextRecovery');
      assert.equal(recovered.contextRestorationCount, before.contextRestorationCount + 1);
      assert.equal(recovered.contextLossCount, before.contextLossCount + 1);
      assertReady(recovered, { scene: before, prior: before, catalog: small.catalog, cells: before.stateCellCount });
      assert.equal(recovered.loadCount, before.loadCount);
      assert.equal(recovered.revision, before.revision);
      await noContextGrowth();
      return recovered;
    }
    await runCase('Context loss at rest restored the retained scene with an actual recovery draw', async () => {
      const before = await current();
      const loss = await hook('loseContext');
      contextSupported = loss.supported;
      if (!loss.supported) return { status: 'unsupported', reason: 'WEBGL_lose_context is unavailable' };
      await page.waitForFunction(() => window.__stereofoldRoundtrip.snapshot().panels.receiver.contextLost);
      const lost = await current();
      assert.equal(lost.ready, false);
      assert.equal(lost.status, 'context_lost');
      const recovered = await restoreContext(before);
      return { lost, recovered, contextEvents: (await contexts()).events };
    });
    await runCase('Context loss during a candidate draw rejected replacement and recovered the original scene', async () => {
      if (!contextSupported) return { status: 'unsupported', reason: 'WEBGL_lose_context is unavailable' };
      const before = await current();
      await hook('pauseNextLoadAt', 'after_candidate_draw');
      const pending = attemptLoad();
      await waitPaused('after_candidate_draw');
      const paused = await current();
      assert.equal(paused.candidateCount, 1);
      assert.equal(paused.frameCoverVisible, true);
      assert.ok(paused.frameCoverBytes > 0 && paused.drawCount > before.drawCount);
      assert.equal((await hook('loseContext')).supported, true);
      await page.waitForFunction(() => window.__stereofoldRoundtrip.snapshot().panels.receiver.contextLost);
      const failed = await pending;
      assert.equal(failed.status, 'rejected');
      assert.equal(failed.code, 'context_lost');
      const recovered = await restoreContext(before);
      assert.equal(recovered.lastLoadFailure.recovered, true);
      assert.equal(recovered.lastLoadFailure.recoveryPending, false);
      assert.equal(recovered.lastLoadFailure.candidateRemoved, true);
      return { paused, failure: failed, recovered, contextEvents: (await contexts()).events };
    });
    await runCase('Picking remained usable after the supported context recovery cases', async () => {
      const result = await actualPick();
      await shot('02-after-recovery.png');
      return { ...result, contextRecoverySupported: contextSupported };
    });

    await runCase('Repeated successful replacements retained one representation and one receiver context', async () => {
      const samples = [];
      const settledCells = new Map();
      for (const id of ['synthetic_ligand', 'public_1crn', 'synthetic_ligand', 'public_1crn']) {
        const before = await current();
        const after = await load(id, { representation: 'ball-and-stick' });
        assertReady(after, { catalog: fixtures.get(id).catalog, prior: before, cells: settledCells.get(id) });
        settledCells.set(id, after.stateCellCount);
        assert.equal(after.loadCount, before.loadCount + 1);
        assert.equal(after.revision, before.revision + 1);
        assert.equal(after.mutationCounts.load, before.mutationCounts.load + 1);
        await noContextGrowth();
        samples.push({ fixture: id, snapshot: after });
      }
      return { samples, contextCount };
    });

    const historyInitial = await current();
    const historyCapture = await capture();
    const historyTarget = { bindingId: 'binding-recovery', taskId: 'task-recovery', panelId: 'receiver',
      sessionId: 'session-recovery', deviceId: 'browser-receiver' };
    const initialFrame = frameReceipt(historyInitial, 0);
    delete initialFrame.revision;
    history = new InspectionHistory({ clock: () => performance.now(),
      scope: { target: historyTarget, serverEpoch: 'server-recovery', receiverEpoch: 'receiver-recovery',
        leaseId: 'lease-recovery', sceneId: historyCapture.sceneId }, initial: modelSnapshot(historyInitial, 0),
      initialRenderer: initialFrame, actors: ['browser-driver'],
      selectionKeys: small.catalog.rows.filter(row => row.identity.modelNumber === 1).map(row => row.key) });
    let serial = 0;
    let dispatches = 0;
    const jobs = new Map();
    const historyProofs = [];
    const makeRequest = operation => history.makeRequest(operation,
      { operationId: `lease-recovery/${++serial}`, actorId: 'browser-driver' });
    const undoRequest = original => history.prepareUndo(original.operationId,
      { operationId: `lease-recovery/${++serial}`, actorId: 'browser-driver' });

    async function submitHistory(request, { confirm = true, reconcileOperation = null } = {}) {
      const outcome = history.admit(request);
      if (jobs.has(request.operationId)) { await jobs.get(request.operationId); return history.operation(request.operationId); }
      if (outcome.status !== 'admitted') return outcome;
      const work = (async () => {
        const before = await current();
        assertReady(before, { catalog: small.catalog });
        assertScene(before, history.inspect().snapshot);
        const planned = history.preview(request.operationId);
        const baseline = reconcileOperation ? { rendererBaseline: { operationId: reconcileOperation,
          snapshot: modelSnapshot(before, history.inspect().snapshot.revision),
          receipt: frameReceipt(before, history.inspect().snapshot.revision) } } : undefined;
        history.commit(request.operationId, planned.snapshot, baseline);
        if (!planned.requiresRender) {
          const unchanged = await current();
          assertScene(unchanged, before);
          assert.equal(unchanged.revision, before.revision);
          return;
        }
        const representationChanged = before.representation !== planned.snapshot.representation;
        const inspectionChanged = !camerasEqual(before.camera, planned.snapshot.camera)
          || JSON.stringify([...before.selectionKeys].sort()) !== JSON.stringify([...planned.snapshot.selectionKeys].sort());
        assert.ok(!(representationChanged && inspectionChanged), 'The draft renderer applies one bounded change per operation');
        dispatches++;
        let after;
        try {
          after = representationChanged
            ? await page.evaluate(value => window.__stereofoldRoundtrip.setRepresentation('receiver', value), planned.snapshot.representation)
            : await page.evaluate(inspection => window.__stereofoldRoundtrip.applyInspection('receiver', inspection),
              { camera: planned.snapshot.camera, selectionKeys: planned.snapshot.selectionKeys });
          assertReady(after, { scene: planned.snapshot, prior: before, catalog: small.catalog, cells: before.stateCellCount });
          assert.equal(after.generation, before.generation);
          assert.equal(after.loadCount, before.loadCount);
          assert.equal(after.revision, before.revision + 1);
          const actualCapture = await capture();
          assertScene(actualCapture.scene, planned.snapshot);
          const receipt = frameReceipt(after, planned.snapshot.revision);
          if (confirm) history.confirmRendered(request.operationId, receipt);
          historyProofs.push({ operationId: request.operationId, request, confirmed: confirm,
            before: modelSnapshot(before, planned.snapshot.revision - 1), after: modelSnapshot(after, planned.snapshot.revision),
            receipt, selectedMarkerCount: after.selectedMarkerCount, selectionLociElementCount: after.selectionLociElementCount,
            ...(baseline ? { rendererBaseline: baseline.rendererBaseline } : {}) });
        } catch (error) {
          if (history.operation(request.operationId).status === 'committed') history.rendererFailed(request.operationId, 'browser_verification_failed');
          throw error;
        }
      })();
      jobs.set(request.operationId, work);
      await work;
      return history.operation(request.operationId);
    }

    await runCase('History changed the actual representation and undid it once across a retry', async () => {
      const change = makeRequest({ kind: 'set_representation', value: 'cartoon' });
      assert.equal((await submitHistory(change)).status, 'rendered');
      const undo = undoRequest(change);
      const first = await submitHistory(undo);
      const after = await current();
      const beforeRetry = dispatches;
      const retry = await submitHistory(clone(undo));
      assert.equal(first.status, 'rendered'); assert.deepEqual(retry, first);
      assert.equal(dispatches, beforeRetry);
      assert.equal((await current()).revision, after.revision);
      assert.equal(after.representation, historyInitial.representation);
      assertCamera(after.camera, historyInitial.camera);
      return { change, undo, outcome: first, browserDispatches: dispatches, snapshot: after };
    });

    await runCase('A named saved view restored its complete actual camera and linked selection', async () => {
      const selection = small.catalog.rows.find(row => row.identity.modelNumber === 1 && row.identity.labelSequenceId === 15).key;
      await submitHistory(makeRequest({ kind: 'set_selection', selectionKeys: [selection] }));
      const save = makeRequest({ kind: 'save_view', viewId: 'inspection-home', name: 'Selected residue view' });
      const beforeSave = dispatches;
      assert.equal((await submitHistory(save)).requiresRender, false);
      assert.equal(dispatches, beforeSave);
      const saved = history.savedView('inspection-home');
      const moved = rotatedCamera(saved.camera, -0.37);
      // Change projection/clipping fields as well as orientation so a partial camera restore cannot pass.
      moved.mode = saved.camera.mode === 'perspective' ? 'orthographic' : 'perspective';
      moved.fog = saved.camera.fog === 35 ? 45 : 35;
      await submitHistory(makeRequest({ kind: 'set_camera', camera: moved }));
      const another = small.catalog.rows.find(row => row.identity.modelNumber === 1 && row.atomSites.length && row.key !== selection).key;
      await submitHistory(makeRequest({ kind: 'set_selection', selectionKeys: [another] }));
      const beforeRestore = await current();
      const restore = makeRequest({ kind: 'restore_view', viewId: 'inspection-home' });
      await submitHistory(restore);
      const restored = await current();
      assertCamera(restored.camera, saved.camera);
      assert.deepEqual([...restored.selectionKeys].sort(), [...saved.selectionKeys].sort());
      const undo = undoRequest(restore);
      await submitHistory(undo);
      const reverted = await current();
      assertScene(reverted, beforeRestore);
      await shot('03-saved-view-and-undo.png');
      return { saved, restored, undoRestoration: reverted };
    });

    await runCase('Cancellation before apply preserved the actual viewer and replay dispatched nothing', async () => {
      const before = await current();
      const cancel = makeRequest({ kind: 'set_camera', camera: rotatedCamera(before.camera, 0.18) });
      history.admit(cancel);
      history.cancel(cancel.operationId, 'browser-driver');
      const count = dispatches;
      assert.equal((await submitHistory(cancel)).status, 'cancelled');
      const after = await current();
      assertScene(after, before); assert.equal(after.revision, before.revision);
      const replayed = replayHistory(JSON.parse(JSON.stringify(history.exportLog())));
      assert.deepEqual(replayed, history.inspect());
      assert.equal(dispatches, count);
      return { cancellation: history.operation(cancel.operationId), replayEqual: true, dispatchesBefore: count, dispatchesAfter: dispatches };
    });

    await runCase('A lost render acknowledgment required a checked renderer baseline before the next actual change', async () => {
      const before = await current();
      const first = makeRequest({ kind: 'set_representation', value: before.representation === 'cartoon' ? 'ball-and-stick' : 'cartoon' });
      const oldConfirmed = clone(history.inspect().lastRendered);
      await submitHistory(first, { confirm: false });
      assert.equal(history.operation(first.operationId).status, 'committed');
      assert.deepEqual(history.inspect().lastRendered, oldConfirmed);
      const actualFirst = await current();
      assert.equal(actualFirst.revision, oldConfirmed.browserRevision + 1);
      const second = makeRequest({ kind: 'set_representation', value: before.representation });
      await submitHistory(second, { reconcileOperation: first.operationId });
      const actualSecond = await current();
      assert.equal(actualSecond.revision, oldConfirmed.browserRevision + 2);
      assert.equal(history.operation(first.operationId).status, 'superseded');
      assert.equal(history.operation(first.operationId).renderedRevision, null);
      assert.equal(history.operation(second.operationId).status, 'rendered');
      const count = dispatches;
      assert.equal((await submitHistory(first)).status, 'superseded');
      assert.equal(dispatches, count);
      assert.equal(history.inspect().lastRendered.browserRevision, actualSecond.revision);
      assert.deepEqual(replayHistory(history.exportLog()), history.inspect());
      return { first: history.operation(first.operationId), second: history.operation(second.operationId),
        actualFirst, actualSecond, oldConfirmed, replayEqual: true };
    });
    report.history = { replayEqual: true, dispatches, proofs: historyProofs, final: history.inspect() };
    const historyBytes = Buffer.from(`${JSON.stringify(history.exportLog(), null, 2)}\n`);
    await fs.writeFile(path.join(out, 'history-events.json'), historyBytes, { flag: 'wx' });
    report.history.log = { path: 'history-events.json', bytes: historyBytes.length, sha256: sha256(historyBytes) };

    report.performance = [];
    for (const id of ['public_1crn', 'public_4hhb']) {
      await runCase(`Measured ${id} through confirmed load, representation, selection, and camera draws`, async () => {
        const fixture = fixtures.get(id);
        const before = await current();
        const loadResult = await page.evaluate(async fixture => {
          const api = window.__stereofoldRoundtrip;
          const startMs = performance.now();
          const snapshot = fixture.id === 'public_4hhb'
            ? await api.loadMeasuredFixture('receiver', fixture, { modelNumber: 1, assemblyId: '1', representation: 'cartoon' })
            : await api.loadPanel('receiver', fixture.id, { modelNumber: 1, assemblyId: '1', representation: 'cartoon' });
          const returnedMs = performance.now();
          const element = document.querySelector('#receiver .stage > canvas');
          const bounds = element.getBoundingClientRect();
          return { snapshot, startMs, returnedMs, elapsedMs: returnedMs - startMs,
            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
              canvasCssWidth: bounds.width, canvasCssHeight: bounds.height,
              canvasPixelWidth: element.width, canvasPixelHeight: element.height } };
        }, { id: fixture.id, cif: fixture.cif, catalog: fixture.catalog, sha256: fixture.sha256 });
        assertReady(loadResult.snapshot, { catalog: fixture.catalog, prior: before });
        assert.equal(loadResult.snapshot.representation, 'cartoon');
        assert.equal(loadResult.snapshot.loadCount, before.loadCount + 1);
        const row = fixture.catalog.rows.find(row => row.identity.modelNumber === 1 && row.entityType === 'polymer' && row.atomSites.length);
        assert.ok(row);
        const mutationResults = [];
        let previous = loadResult.snapshot;
        for (const operation of [
          { method: 'setRepresentation', value: 'ball-and-stick' },
          { method: 'select', value: [row.key] },
          { method: 'setCamera', value: rotatedCamera(previous.camera, 0.19) },
        ]) {
          const measurement = await page.evaluate(async operation => {
            const startMs = performance.now();
            const snapshot = await window.__stereofoldRoundtrip[operation.method]('receiver', operation.value);
            const returnedMs = performance.now();
            return { snapshot, startMs, returnedMs, elapsedMs: returnedMs - startMs };
          }, operation);
          const expected = { ...previous,
            ...(operation.method === 'setRepresentation' ? { representation: operation.value }
              : operation.method === 'select' ? { selectionKeys: operation.value } : { camera: operation.value }) };
          assertReady(measurement.snapshot, { scene: expected, catalog: fixture.catalog, prior: previous,
            cells: loadResult.snapshot.stateCellCount });
          assert.equal(measurement.snapshot.revision, previous.revision + 1);
          assert.equal(measurement.snapshot.loadCount, loadResult.snapshot.loadCount);
          assert.equal(measurement.snapshot.generation, loadResult.snapshot.generation);
          mutationResults.push({ operation: operation.method, ...measurement });
          previous = measurement.snapshot;
        }
        await noContextGrowth();
        const metric = { fixture: id, sourceBytes: Buffer.byteLength(fixture.cif), sourceSha256: fixture.sha256,
          modelNumber: 1, assemblyId: '1', atomCount: loadResult.snapshot.atomCount,
          residueCount: loadResult.snapshot.residueCount, sequenceRowCount: loadResult.snapshot.sequenceRowCount,
          nodeCatalogParseMs: fixture.nodeCatalogParseMs, measurement: 'In-page API call through its confirmed draw and return',
          browserParseOnlyMs: null, load: loadResult, operations: mutationResults };
        report.performance.push(metric);
        await shot(id === 'public_1crn' ? '04-1crn-measured.png' : '05-4hhb-measured.png');
        return { fixture: id, sourceBytes: metric.sourceBytes, atomCount: metric.atomCount,
          residueCount: metric.residueCount, viewport: loadResult.viewport, loadToReturnMs: loadResult.elapsedMs,
          operations: mutationResults.map(value => ({ operation: value.operation, elapsedMs: value.elapsedMs })) };
      });
    }

    await runCase('Disposal during a paused replacement awaited candidate and context cleanup', async () => {
      await hook('pauseNextLoadAt', 'after_representation');
      const pending = attemptLoad('public_1crn');
      await waitPaused('after_representation');
      const paused = await current();
      assert.equal(paused.candidateCount, 1);
      await page.evaluate(() => window.__stereofoldRoundtrip.disposeDuringLoad('receiver'));
      const stopped = await pending;
      assert.equal(stopped.status, 'rejected');
      assert.equal(stopped.code, 'viewer_disposed');
      const disposed = await current();
      assert.equal(disposed.status, 'disposed');
      assert.equal(disposed.mounted, false);
      assert.equal(disposed.cleanupPending, false);
      assert.equal(disposed.contextDisposed, true);
      assert.equal(disposed.stateCellCount, 0);
      assert.equal(disposed.candidateCount, 0);
      assert.equal(disposed.pendingFrameWaits, 0);
      assert.equal(disposed.frameCoverBytes, 0);
      assert.equal(disposed.representationCount, 0);
      assert.equal(disposed.renderObjectCount, 0);
      assert.equal(disposed.testPausedAt, null);
      await page.evaluate(() => window.__stereofoldRoundtrip.dispose());
      report.final = await state();
      report.finalContexts = await noContextGrowth();
      report.cleanup.viewersDisposed = true;
      return { paused, interruptedLoad: stopped, disposed };
    });
    for (const source of report.sourceHashes) {
      assert.equal(sha256(await fs.readFile(path.join(repo, source.path))), source.sha256, `Source changed during the run: ${source.path}`);
    }
    assert.deepEqual(report.pageErrors, []);
    assert.deepEqual(report.consoleErrors, []);
    assert.deepEqual(report.externalRequests, []);
    report.status = 'passed';
  } catch (error) {
    report.error = error.stack ?? String(error);
    if (page && !page.isClosed()) {
      try {
        report.failureSnapshot = await page.evaluate(() => window.__stereofoldRoundtrip?.snapshot());
        report.failureContexts = await page.evaluate(() => window.__recoveryContextStats?.());
        await shot('failure.png');
      } catch (captureError) { report.failureCaptureError = captureError.message; }
    }
    process.exitCode = 1;
  } finally {
    phase = 'cleanup';
    if (history && !report.history) {
      report.partialHistory = history.inspect();
      try {
        await fs.writeFile(path.join(out, 'partial-history-events.json'), `${JSON.stringify(history.exportLog(), null, 2)}\n`, { flag: 'wx' });
      } catch (error) { report.cleanup.errors.push(`History record: ${error.message}`); }
    }
    if (page && !page.isClosed() && !report.cleanup.viewersDisposed) {
      try {
        const disposed = await page.evaluate(async () => {
          const api = window.__stereofoldRoundtrip;
          if (!api) return null;
          await api.disposeDuringLoad('receiver');
          await api.dispose();
          return api.snapshot();
        });
        report.cleanup.disposedSnapshot = disposed;
        report.cleanup.viewersDisposed = Boolean(disposed && Object.values(disposed.panels).every(value =>
          value.contextDisposed && !value.cleanupPending && value.candidateCount === 0 && value.pendingFrameWaits === 0));
      } catch (error) { report.cleanup.errors.push(`Viewer cleanup: ${error.message}`); }
    }
    if (browser) {
      try { await browser.close(); report.cleanup.browserClosed = true; }
      catch (error) { report.cleanup.errors.push(`Browser cleanup: ${error.message}`); }
    }
    if (server) {
      try {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        report.cleanup.serverClosed = true;
      } catch (error) { report.cleanup.errors.push(`Server cleanup: ${error.message}`); }
    }
    if (report.cleanup.errors.length || report.status === 'passed' && !Object.entries(report.cleanup)
      .filter(([key]) => ['viewersDisposed', 'browserClosed', 'serverClosed'].includes(key)).every(([, value]) => value)) {
      report.status = 'failed'; process.exitCode = 1;
    }
    report.finishedAt = new Date().toISOString();
    report.durationMs = performance.now() - started;
    report.passedCases = report.cases.filter(value => value.status === 'passed').length;
    report.unsupportedCases = report.cases.filter(value => value.status === 'unsupported').length;
    await fs.writeFile(path.join(out, 'recovery-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    const artifacts = [];
    for (const name of (await fs.readdir(out)).sort()) {
      const bytes = await fs.readFile(path.join(out, name));
      artifacts.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    await fs.writeFile(path.join(out, 'artifact-hashes.json'), `${JSON.stringify(artifacts, null, 2)}\n`, { flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, cases: report.cases.length, passed: report.passedCases,
    unsupported: report.unsupportedCases, report: path.join(out, 'recovery-report.json'), error: report.error })}\n`);
}

main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
