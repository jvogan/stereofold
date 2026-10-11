import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CIF } from 'molstar/lib/commonjs/mol-io/reader/cif.js';
import { chromium, type Frame, type Page } from 'playwright';

/**
 * Real Chromium/Mol* acceptance through the packaged MCP server and official
 * AppBridge. The exports are synthetic native-contract fixtures, NOT evidence
 * of a mounted Structure Viewer export or physical headset acceptance.
 * Run from plugin/: pnpm test:scene-handoff /absolute/fresh-artifact-directory
 * No production bundles are built; only the isolated AppBridge host is bundled.
 */
const argument = process.argv[2];
assert.ok(argument, 'Supply a fresh artifact directory outside the repository.');
const out = resolve(argument);
await mkdir(out, { recursive: false });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const report: any = { status: 'failed', fixtureKind: 'synthetic-native-export-contract',
  scope: 'Compiled MCP server, official AppBridge, real Chromium/Mol* desktop renderer; no live upstream viewer, XR or physical headset claim.',
  cases: [], errors: [], externalRequests: [], appCalls: [], cleanup: {}, artifacts: [] };
const pass = (name: string) => { report.cases.push(name); console.log(`Passed: ${name}`); };
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const client = new Client({ name: 'Stereofold native scene renderer acceptance', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.mjs')], cwd: process.cwd(), env: { STEREOFOLD_REPLY_AUDIO: '0', STEREOFOLD_PTT_TRANSCRIBE: '0', ...(process.env.STEREOFOLD_SCENE_SERVICE ? { STEREOFOLD_SCENE_SERVICE: process.env.STEREOFOLD_SCENE_SERVICE } : {}) }, stderr: 'pipe' });
let stderr = '', browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let host: ReturnType<typeof createServer> | undefined, page: Page | undefined, frame: Frame | undefined, activeSession: string | undefined;
transport.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-32_768); });
const call = async (name: string, args: Record<string, unknown>) => {
  const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`); return result;
};
const inspection = async (sessionId: string) => (await call('get_inspection', { sessionId }))._meta['stereo_structure/inspection'];
async function waitSaved(sessionId: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const data = await inspection(sessionId);
    if (data.scene && data.inspectionRevision > 0) return data;
    await sleep(100);
  }
  throw Error('The actual renderer did not resolve, render and save the scene within 45 seconds.');
}
async function artifact(name: string, bytes: string | Buffer) {
  const path = resolve(out, name); await writeFile(path, bytes);
  report.artifacts.push({ name, path, byteLength: Buffer.byteLength(bytes), sha256: hash(bytes) }); return path;
}
async function screenshot(name: string) {
  const png = await frame!.locator('.stage canvas').screenshot();
  assert.ok(png.byteLength > 1000, 'Canvas screenshot must contain rendered pixels.');
  const pixels = await page!.evaluate(async data => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data, colors = new Map<string, number>();
    for (let i = 0; i < pixels.length; i += 4) {
      const key = `${pixels[i] >> 3},${pixels[i + 1] >> 3},${pixels[i + 2] >> 3}`;
      colors.set(key, (colors.get(key) ?? 0) + 1);
    }
    return { width: canvas.width, height: canvas.height, quantizedColors: colors.size,
      pixelsOutsideDominantColor: pixels.length / 4 - Math.max(...colors.values()) };
  }, png.toString('base64'));
  assert.ok(pixels.quantizedColors > 30 && pixels.pixelsOutsideDominantColor > 1000, `Molecule canvas is blank: ${JSON.stringify(pixels)}`);
  await artifact(`${name}-canvas.png`, png); await artifact(`${name}-host.png`, await page!.screenshot());
  return { sha256: hash(png), ...pixels };
}
async function mount(html: string, result: any, origin: string, readyState = 'true') {
  await page?.close();
  page = await browser!.newPage({ viewport: { width: 1100, height: 780 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(45_000);
  await page.addInitScript({ content: 'globalThis.__name = value => value;' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    report.externalRequests.push(url); return route.abort();
  });
  await page.exposeFunction('__call', async (payload: any) => {
    const result: any = await client.callTool({ name: payload.name, arguments: payload.arguments ?? {} });
    // Record the real renderer's calls, never inject a fabricated import target.
    if (['resolve_scene_import', 'sync_inspection'].some(name => payload.name.endsWith(`.${name}`)))
      report.appCalls.push({ name: payload.name, sessionId: payload.arguments?.sessionId, isError: !!result.isError,
        imported: result.structuredContent?.imported, revision: result.structuredContent?.inspectionRevision });
    return result;
  });
  await page.goto(origin);
  await page.evaluate(({ html, result }) => (window as any).__host.mount(html, result, { theme: 'dark' }), { html, result });
  frame = page.frames().find(candidate => candidate !== page!.mainFrame()); assert.ok(frame);
  await page.waitForFunction(() => (window as any).__host.connected);
  await frame.locator(`body[data-ready="${readyState}"],body[data-ready="error"]`).waitFor();
  assert.equal(await frame.locator('body').getAttribute('data-ready'), readyState, await frame.locator('.session-notice').allTextContents().then(parts => parts.join(' ')));
}

try {
  // Emit exactly an atom_site coordinate loop, without source bonds or assembly
  // categories, so the synthetic fixture matches the coordinate-only contract.
  const source = await readFile(resolve('../fixtures/1CRN.cif'), 'utf8');
  const parsed = await CIF.parse(source).run(); if (parsed.isError) throw Error(parsed.message);
  const atoms = parsed.result.blocks[0].categories.atom_site;
  const columns = ['group_PDB', 'id', 'type_symbol', 'pdbx_formal_charge', 'label_atom_id', 'label_alt_id', 'label_comp_id', 'label_asym_id',
    'label_entity_id', 'label_seq_id', 'pdbx_PDB_ins_code', 'Cartn_x', 'Cartn_y', 'Cartn_z', 'occupancy', 'B_iso_or_equiv',
    'auth_seq_id', 'auth_comp_id', 'auth_asym_id', 'auth_atom_id', 'pdbx_PDB_model_num'];
  const rows = Array.from({ length: atoms.rowCount }, (_, i) => columns.map(column => {
    const field = atoms.getField(column); if (!field || field.valueKind(i) !== 0) return '?';
    const value = field.str(i); assert.ok(value && !/[\s'"#;]/.test(value), 'This bounded 1CRN fixture requires simple CIF tokens.'); return value;
  }).join(' '));
  const coordinateText = ['data_synthetic_native_handoff', '#', 'loop_', ...columns.map(column => `_atom_site.${column}`), ...rows, '#', ''].join('\n');
  const coordinatePath = await artifact('synthetic-coordinates.cif', coordinateText);
  const selectedIds = [atoms.getField('id')!.str(0), atoms.getField('id')!.str(7)];
  const scene: any = { version: 2, revision: 7,
    objects: [{ id: 'primary', primary: true, visible: true, derived: false, frameCount: 1,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], construction: { kind: 'model', modelIndex: 0 },
      constructionOptions: { models: [{ index: 0, modelNumber: 1 }], assemblies: [] } }],
    selection: { atomIds: [], atomIdsTruncated: false, atomCount: 0, expression: null, summary: null },
    focus: { atomIds: [], expression: null, summary: null },
    camera: { orientation: 'current', mode: 'perspective', fovDegrees: 42, position: [25, 30, 80], target: [9, 9, 6], up: [0, 1, 0] },
    layers: [{ id: 'main', visible: true, target: { kind: 'all' }, labels: false, opacity: 1, representation: 'cartoon', color: { kind: 'uniform', value: '#D85C9D' } }],
    background: '#162638', lighting: 'studio', annotations: [], measurements: [], volumes: [], analyses: [], assemblySymmetry: [], sceneGuides: [],
    qualityAssessment: [], storyboard: [], savedScenes: [], dirtyDerivedObjectIds: [], trajectory: null, namedSelections: {} };
  const sidecar = (text: string, format: string, mediaType: string, outputPath: string) => ({ schemaVersion: 1, createdAt: '2026-09-19T00:00:00Z',
    artifact: { outputPath, sha256: hash(text), byteLength: Buffer.byteLength(text), mediaType }, provenance: {
      format, sceneRevision: scene.revision, selectionAtomCount: format === 'scene-json' ? 0 : atoms.rowCount,
      workspacePublication: { source: { sha256: hash(source), workspacePath: 'synthetic-fixture-source/1CRN.cif' } },
      ...(format === 'scene-json' ? {} : { coordinateProvenance: { format: 'mmcif', atomCount: atoms.rowCount, modelCount: 1,
        identityPreserving: true, generatedAtomIdentifierCount: 0, generatedModelCount: 0, namespacedAtomIdentifierCount: 0, remappedModelCount: 0,
        preservedAtomIdentifierCount: atoms.rowCount, atomIdentifierPolicy: 'preserve-source-atom-site-ids-with-collision-safe-fallbacks',
        residueIdentifierPolicy: 'source-label-and-author-identifiers', bondConnectivityPolicy: 'coordinates-only-no-explicit-bond-records' } }),
    } });
  await artifact('synthetic-coordinates.cif.provenance.json', JSON.stringify(sidecar(coordinateText, 'selection-mmcif', 'chemical/x-mmcif', 'synthetic-coordinates.cif'), null, 2));
  const sceneFile = async (name: string, value: any) => {
    const text = JSON.stringify(value, null, 2); const path = await artifact(name, text);
    await artifact(`${name}.provenance.json`, JSON.stringify(sidecar(text, 'scene-json', 'application/json', name), null, 2)); return path;
  };
  const scenePath = await sceneFile('synthetic-scene.json', scene);
  const inputs = { scenePath, coordinatePath, nativeExports: { expectedRevision: 7, exportSelection: { kind: 'all', objectId: 'primary' } } };
  await client.connect(transport);
  report.build = { inspectorMtime: (await stat(resolve('dist/inspector.html'))).mtime.toISOString(), serverSha256: hash(await readFile(resolve('dist/server.mjs'))) };
  const checked = await call('inspect_scene', inputs);
  assert.equal(checked.structuredContent.kind, 'scene-preflight'); assert.equal(checked.structuredContent.imported, false);
  assert.equal(checked.structuredContent.preflight.supported, true); assert.equal(checked.structuredContent.sessionId, undefined);
  assert.equal(checked._meta, undefined); await artifact('check-result.json', JSON.stringify(checked, null, 2));
  pass('Native check reports supported/provisional without a session, render token or hydration');

  const hostBundle = await build({ entryPoints: [resolve('scripts/inspector-host.ts')], bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
  const hostHtml = `<!doctype html><html><body style="margin:0;background:#071015"><iframe title="Stereofold" style="border:0;width:100vw;height:100vh"></iframe><script>${hostBundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  host = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(hostHtml); });
  await new Promise<void>(done => host!.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(host.address() as any).port}`;
  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' }); const html = (resource.contents[0] as any).text as string;
  browser = await chromium.launch({ headless: true }); report.browserVersion = browser.version();
  await mount(html, checked, origin, 'preflight');
  await frame!.locator('[data-scene-preflight]').waitFor({ state: 'visible' });
  assert.match(await frame!.locator('[data-scene-preflight]').innerText(), /Scene compatibility checked/);
  assert.match(await frame!.locator('#status').innerText(), /No structure was opened/);
  assert.equal(await frame!.locator('.workspace').isVisible(), false);
  assert.equal(await frame!.locator('.readiness-strip').isVisible(), false);
  assert.equal(await frame!.locator('.header-actions').isVisible(), false);
  assert.equal(await frame!.locator('[data-scene-preflight]').getAttribute('data-supported'), 'true');
  assert.ok(!report.appCalls.some((entry: any) => entry.name.endsWith('.resolve_scene_import')));
  await artifact('supported-check-host.png', await page!.screenshot());
  pass('Mounting a check result displays compatibility status rather than a permanent Loading panel');

  const matching = await call('inspect_scene', { ...inputs, mode: 'matching-scene' }); activeSession = matching.structuredContent.sessionId;
  const nativeSession = activeSession!;
  // Reuse the check card so the test covers restoring its hidden controls.
  await page!.evaluate(result => (window as any).__host.send(result), matching);
  await frame!.locator('body[data-ready="true"]').waitFor();
  const rendered = await waitSaved(nativeSession);
  assert.equal(await frame!.locator('.workspace').isVisible(), true);
  assert.equal(await frame!.locator('[data-scene-preflight]').isVisible(), false);
  assert.equal(rendered.sceneImport, undefined);
  assert.deepEqual(rendered.scene.selectionKeys, []);
  assert.deepEqual(rendered.scene.inspection.appearance.representation, 'cartoon');
  assert.deepEqual(rendered.scene.inspection.appearance.color, 'uniform');
  assert.deepEqual(rendered.scene.inspection.appearance.uniformColor, '#D85C9D');
  assert.deepEqual(rendered.scene.inspection.appearance.background, '#162638');
  assert.deepEqual(rendered.scene.camera.position, scene.camera.position); assert.deepEqual(rendered.scene.camera.target, scene.camera.target);
  assert.deepEqual(rendered.scene.camera.up, scene.camera.up); assert.ok(Math.abs(rendered.scene.camera.fov - 42 * Math.PI / 180) < 1e-8);
  assert.equal(await frame!.locator('[data-control="representation"]').inputValue(), 'cartoon');
  assert.match(await frame!.locator('.selection-count').innerText(), /0 residues|No residues|Nothing selected/);
  assert.equal(await frame!.locator('.sequence button[aria-pressed="true"]').count(), 0);
  assert.ok(report.appCalls.some((entry: any) => entry.name.endsWith('.resolve_scene_import') && entry.sessionId === activeSession && entry.imported === true));
  report.matching = { retainedImportMetadata: !!rendered.sceneImport, scene: rendered.scene, pixels: await screenshot('matching-scene'), readiness: (await call('get_inspection_state', { sessionId: activeSession })).structuredContent.readiness };
  pass('The actual renderer resolves native import and renders/saves requested style, camera and explicitly empty native selection');

  await frame!.locator('[data-control="opacity"]').fill('0.6');
  await frame!.locator('[data-control="opacity"]').dispatchEvent('change');
  const editedDeadline = Date.now() + 15_000;
  let edited = await inspection(nativeSession);
  while (edited.scene.inspection.appearance.opacity !== .6 && Date.now() < editedDeadline) {
    await sleep(100); edited = await inspection(nativeSession);
  }
  assert.equal(edited.scene.inspection.appearance.opacity, .6);
  assert.equal(edited.sceneImport, undefined);
  await mount(html, matching, origin);
  assert.equal(await frame!.locator('[data-control="opacity"]').inputValue(), '0.6');
  assert.equal((await inspection(nativeSession)).sceneImport, undefined);
  report.postImportEdit = { opacity: .6, importMetadataCleared: true, restoredByNewRenderer: true };
  pass('Import metadata clears after render; a later appearance edit survives a new renderer without reapplying the imported style');

  const assemblyNative = structuredClone(scene);
  assemblyNative.objects[0].construction = { kind: 'assembly', assemblyId: '1', modelIndex: 0 };
  assemblyNative.objects[0].constructionOptions = { models: [{ index: 0, modelNumber: 1 }], assemblies: [{ id: '1' }],
    operatorCount: 1, operatorsTruncated: false, operators: [{ assemblyId: '1', modelNumber: 1 }] };
  assemblyNative.layers[0].target = { kind: 'all', objectId: 'primary' };
  assemblyNative.camera.clippingRadius = 50;
  assemblyNative.camera.nearClip = 1;
  const assemblyPath = await sceneFile('synthetic-native-assembly-scene.json', assemblyNative);
  const assemblyOpened = await call('inspect_scene', { ...inputs, scenePath: assemblyPath, mode: 'matching-scene' });
  activeSession = assemblyOpened.structuredContent.sessionId;
  assert.ok(activeSession);
  await mount(html, assemblyOpened, origin);
  const assemblyRendered = await waitSaved(activeSession!);
  assert.equal(assemblyRendered.scene.assemblyId, 'asymmetric_unit');
  assert.equal(assemblyRendered.scene.inspection.appearance.representation, 'cartoon');
  assert.deepEqual(assemblyRendered.scene.camera.position, assemblyNative.camera.position);
  report.assembly = { scene: assemblyRendered.scene, pixels: await screenshot('native-assembly') };
  pass('A native single-copy assembly loads its already assembled coordinates and restores the requested scene');

  const selectedNative = structuredClone(scene);
  selectedNative.selection = { atomIds: ['primary|1_555|0', 'primary|1_555|7'], atomIdsTruncated: false, atomCount: 2,
    expression: { kind: 'atom_ids', atomIds: ['primary|1_555|0', 'primary|1_555|7'] }, summary: 'Synthetic canonical upstream selection' };
  const selectedNativePath = await sceneFile('synthetic-canonical-selection.json', selectedNative);
  const selectedRefusal = await call('inspect_scene', { ...inputs, scenePath: selectedNativePath, mode: 'matching-scene' });
  assert.equal(selectedRefusal.structuredContent.sessionId, undefined);
  assert.equal(selectedRefusal.structuredContent.preflight.supported, false);
  assert.match(selectedRefusal.content[0].text, /empty native selection/);
  await artifact('canonical-selection-refused.json', JSON.stringify(selectedRefusal, null, 2));
  pass('Canonical native object/instance/element selection IDs are refused before opening, never confused with atom_site IDs');

  const transformedNative = structuredClone(scene); transformedNative.objects[0].matrix[12] = 2;
  const transformedPath = await sceneFile('synthetic-transformed-scene.json', transformedNative);
  const transformRefusal = await call('inspect_scene', { ...inputs, scenePath: transformedPath, mode: 'matching-scene' });
  assert.equal(transformRefusal.structuredContent.sessionId, undefined);
  assert.match(transformRefusal.content[0].text, /avoid applying placement twice/);
  await artifact('native-transform-refused.json', JSON.stringify(transformRefusal, null, 2));
  pass('Native nonidentity matrices are refused rather than applied twice to already transformed exports');

  // Separately exercise the legacy raw-source-ID adapter through the renderer.
  // This proves its existing selection mapping, NOT native selection fidelity.
  const legacyScene = structuredClone(scene);
  legacyScene.selection = { atomIds: selectedIds, atomIdsTruncated: false, atomCount: selectedIds.length,
    expression: { kind: 'atom_ids', atomIds: selectedIds }, summary: 'Synthetic legacy raw-source-ID selection' };
  const legacySceneText = JSON.stringify(legacyScene), legacyScenePath = await artifact('synthetic-legacy-selection-scene.json', legacySceneText);
  const provenancePath = await artifact('synthetic-legacy-declaration.json', JSON.stringify({ version: 1, kind: 'structure-viewer-local-snapshot',
    sceneSha256: hash(legacySceneText), expectedRevision: 7, sourceObjectId: 'primary', coordinate: { format: 'selection-mmcif', sha256: hash(coordinateText),
      coordinateProvenance: { identityPreserving: true, generatedAtomIdentifierCount: 0, generatedModelCount: 0, namespacedAtomIdentifierCount: 0, remappedModelCount: 0 } } }));
  const legacyOpened = await call('inspect_scene', { scenePath: legacyScenePath, coordinatePath, provenancePath });
  const legacySession = legacyOpened.structuredContent.sessionId; activeSession = legacySession;
  await mount(html, legacyOpened, origin); const legacyRendered = await waitSaved(legacySession);
  assert.equal(legacyRendered.scene.selectionKeys.length, 2);
  assert.match(await frame!.locator('.selection-count').innerText(), /2 residues/);
  assert.equal(await frame!.locator('.sequence button[aria-pressed="true"]').count(), 2);
  report.legacySelection = { scope: 'Synthetic legacy raw-source-ID adapter only; not a native selection roundtrip', scene: legacyRendered.scene, pixels: await screenshot('legacy-selection') };
  pass('Separately, the legacy raw-source-ID adapter resolves and visibly selects two residues in the real renderer');

  const unsupported = structuredClone(scene); unsupported.layers.push({ ...unsupported.layers[0], id: 'extra', representation: 'spheres' });
  const unsupportedPath = await sceneFile('synthetic-unsupported-scene.json', unsupported);
  for (const mode of ['check', 'matching-scene']) {
    const refusal = await call('inspect_scene', { ...inputs, scenePath: unsupportedPath, mode });
    assert.equal(refusal.structuredContent.imported, false); assert.equal(refusal.structuredContent.preflight.supported, false);
    assert.equal(refusal.structuredContent.sessionId, undefined); assert.equal(refusal._meta, undefined);
    await artifact(`unsupported-${mode}.json`, JSON.stringify(refusal, null, 2));
  }
  assert.deepEqual((await inspection(nativeSession)).scene, edited.scene);
  const refusedMount = await call('inspect_scene', { ...inputs, scenePath: unsupportedPath, mode: 'check' });
  await mount(html, refusedMount, origin, 'preflight');
  assert.match(await frame!.locator('[data-scene-preflight]').innerText(), /Matching scene unavailable/);
  assert.match(await frame!.locator('[data-scene-preflight]').textContent() ?? '', /extra|multi-layer/);
  await artifact('unsupported-check-host.png', await page!.screenshot());

  pass('Unsupported extra layers remain check/refuse; the existing rendered scene is unchanged');
  const structureOnly = await call('inspect_scene', { ...inputs, scenePath: unsupportedPath, mode: 'structure-only' });
  activeSession = structureOnly.structuredContent.sessionId;
  assert.equal((await inspection(activeSession!)).sceneImport, undefined);
  await mount(html, structureOnly, origin); const plain = await waitSaved(activeSession!);
  assert.deepEqual(plain.scene.selectionKeys, []); assert.notDeepEqual(plain.scene.camera.position, scene.camera.position);
  assert.notEqual(plain.scene.inspection.appearance.uniformColor, '#D85C9D');
  assert.ok(!report.appCalls.some((entry: any) => entry.name.endsWith('.resolve_scene_import') && entry.sessionId === activeSession));
  report.structureOnly = { scene: plain.scene, pixels: await screenshot('structure-only') };
  assert.notEqual(report.matching.pixels.sha256, report.structureOnly.pixels.sha256);
  pass('Explicit structure-only renders coordinates with default view and no imported selection/style');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  report.status = 'passed';
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error); report.serverStderr = stderr;
  if (activeSession) try { report.stateAtFailure = (await call('get_inspection_state', { sessionId: activeSession })).structuredContent; } catch {}
  if (frame) try { report.uiAtFailure = await frame.evaluate(() => ({ ready: document.body.dataset.ready,
    notice: document.querySelector('.session-notice')?.textContent, status: document.querySelector('#status')?.textContent })); } catch {}
  if (page) try { await artifact('failure.png', await page.screenshot()); } catch {}
  console.error(report.failure); process.exitCode = 1;
} finally {
  for (const [name, close] of [
    ['browserClosed', () => browser?.close() ?? Promise.resolve()], ['mcpClosed', () => client.close()],
    ['listenerClosed', () => new Promise<void>(done => host ? host.close(() => done()) : done())],
  ] as const) {
    try { await close(); report.cleanup[name] = true; } catch (error) { report.cleanup[name] = false; report.errors.push(`${name}: ${String(error)}`); process.exitCode = 1; }
  }
  await writeFile(resolve(out, 'scene-handoff-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Evidence: ${resolve(out, 'scene-handoff-report.json')}`);
}
