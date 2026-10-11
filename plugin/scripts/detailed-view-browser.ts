/**
 * Browser acceptance for the cinematic-panel to full-Mol* round trip.
 *
 * Everything else about `open_detailed_view` and `import_detailed_view` is
 * covered by unit tests: route serving, MIME types, bearer gating, the handoff
 * artifact, the `.molj` projection. What no unit test can reach is whether the
 * generated page actually draws the structure, so this script runs the real
 * packaged server, mounts the real packaged panel, opens the detailed page in
 * Chromium, and proves pixels.
 *
 * The round trip it drives is the one a user does by hand:
 *
 *   1. the panel loads 1CRN and saves its scene;
 *   2. `open_detailed_view` returns a loopback address;
 *   3. the page builds the structure through the stock Mol* builder API and
 *      draws it, with the panel's camera and appearance already applied;
 *   4. the detailed viewer's own state changes (opacity, background, camera);
 *   5. Download State produces a real `.molj`;
 *   6. `import_detailed_view` projects it back and the panel renders it.
 *
 * Run: pnpm --dir plugin run test:detailed-view [-- --out /absolute/directory]
 * Exit code 1 on any failed scenario; the JSON report names which.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Browser, type Locator, type Page } from 'playwright';

const OPTION_USAGE = 'Optional usage: --out /absolute/artifact/directory (defaults under os.tmpdir())'
  + ' [--demo <demo name>] — with a demo the run adds the lesson leg: a colour key is emphasised,'
  + ' handed to the full viewer and brought back, and the named parts must survive the trip.';
const FLAGS = ['--out', '--demo'];
const options = new Map<string, string>();
const rawArguments = process.argv.slice(2);
for (let index = 0; index < rawArguments.length; index += 2) {
  const flag = rawArguments[index], value = rawArguments[index + 1];
  assert.ok(flag !== undefined && FLAGS.includes(flag) && !options.has(flag) && value !== undefined, OPTION_USAGE);
  options.set(flag, value);
}
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = resolve(options.get('--out') ?? resolve(tmpdir(), `stereofold-detailed-view-${Date.now()}`));
await mkdir(out, { recursive: true });

/**
 * The lesson leg, opt-in with `--demo crispr-cas9`.
 *
 * The five scenarios below run on 1CRN, which has no lesson and so no named
 * parts. The handoff's real requirement is the other thing: named parts and
 * emphasis stay readable, commandable and persistent. That needs a real colour
 * key, so it needs a real lesson — the same cache, lesson validation and
 * provenance check `quest-demo.ts` gives the demo command and the emulator
 * harness, rather than a fixture invented here.
 */
const demo = options.has('--demo') ? await (async () => {
  const { readDemoIndex, readDemoLesson, resolveCoordinates, demoCacheDirectory } = await import('./quest-demo.js');
  const index = await readDemoIndex();
  const entry = index.demos.find(candidate => candidate.name === options.get('--demo'));
  assert.ok(entry, `Unknown demo "${options.get('--demo')}".`);
  await readDemoLesson(entry);
  return { entry, lessonPath: resolve(root, 'demos', entry.lesson),
    coordinatesPath: await resolveCoordinates(entry, demoCacheDirectory(), message => console.log(message)),
    assemblyId: (entry.coordinates as { assemblyId?: string }).assemblyId };
})() : undefined;

type Scenario = { id: string; status: 'passed' | 'failed'; evidence: unknown };
const report: any = {
  status: 'failed',
  what: 'real packaged dist/server.mjs over stdio, real packaged inspector panel, real generated detailed page in headless Chromium',
  startedAt: new Date().toISOString(),
  scenarios: [] as Scenario[],
  screenshots: [] as unknown[],
  pageErrors: [] as string[],
  consoleErrors: [] as string[],
  externalRequests: [] as string[],
  cleanup: {} as Record<string, string>,
};
const passed = (id: string, evidence: unknown) => { report.scenarios.push({ id, status: 'passed', evidence }); console.log(`Passed: ${id}`); };

const client = new Client({ name: 'Stereofold detailed view acceptance', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'dist/server.mjs')], cwd: root, stderr: 'pipe' });
let stderr = '';
transport.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });

const hostBundle = await build({ entryPoints: [resolve(root, 'scripts/inspector-host.ts')], bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
const hostHtml = `<!doctype html><html><body style="margin:0;background:#071015"><iframe title="Stereofold" style="border:0;width:100vw;height:100vh"></iframe>`
  + `<script>${hostBundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
const http = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(hostHtml); });
await new Promise<void>(ready => http.listen(0, '127.0.0.1', ready));
const hostOrigin = `http://127.0.0.1:${(http.address() as any).port}`;

let browser: Browser | undefined;
let sessionId = '';
const call = async (name: string, args: Record<string, unknown>) => {
  const result: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result;
};
const privateView = async () => (await call('get_inspection', { sessionId }))._meta['stereo_structure/inspection'];
const waitSaved = async (predicate: (view: any) => boolean, what: string) => {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const view = await privateView();
    if (predicate(view)) return view;
    await new Promise(again => setTimeout(again, 120));
  }
  throw Error(`Timed out waiting for ${what}. Panel appearance: ${JSON.stringify((await privateView()).scene?.inspection?.appearance)}`);
};
const waitCommand = async (commandId: string, status: string) => {
  const until = Date.now() + 120_000;
  let last: any;
  while (Date.now() < until) {
    last = (await call('get_inspection_state', { sessionId, commandId })).structuredContent;
    if (last.command.status === status) return last;
    if (['conflict', 'rejected', 'expired'].includes(last.command.status)) break;
    await new Promise(again => setTimeout(again, 120));
  }
  throw Error(`Command ${commandId} reached ${last?.command?.status} instead of ${status}`);
};
const bindingNow = async () => {
  const state = (await call('get_inspection_state', { sessionId })).structuredContent;
  return { sessionId, serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
    baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision };
};
/** A panel that just rendered is briefly busy, so wait for it exactly as an agent would. */
const readyPanel = async () => {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const state = (await call('get_inspection_state', { sessionId })).structuredContent;
    const panel = state.panels.find((candidate: any) => candidate.current && candidate.availability === 'ready');
    if (panel) return { panelId: panel.panelId as string, ...await bindingNow() };
    await new Promise(again => setTimeout(again, 120));
  }
  throw Error('Timed out waiting for a current, ready panel');
};
/**
 * Foreground pixel count against the corner background, the same test the
 * inspector harness uses.
 *
 * `lit` is an optional emphasis colour. A lesson's named part
 * is drawn at full strength in its own colour while everything else drops to
 * context opacity, so counting pixels near that colour is the difference
 * between "the panel still draws" and "the part the lesson named is still the
 * one lit". The tolerance is wide because the part is shaded, not flat-filled.
 */
async function drawnPixels(page: Page, canvas: Locator, name: string, lit?: string) {
  const png = await canvas.screenshot();
  const file = `${name}.png`;
  await writeFile(resolve(out, file), png);
  const stats = await page.evaluate(async ({ base64, lit }) => {
    const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data, background = [...pixels.slice(0, 3)];
    const target = lit ? [1, 3, 5].map(offset => parseInt(lit.slice(offset, offset + 2), 16)) : undefined;
    let foreground = 0, litPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (background.some((channel, offset) => Math.abs(channel - pixels[index + offset]) > 10)) foreground++;
      if (target && target.every((channel, offset) => Math.abs(channel - pixels[index + offset]) < 72)) litPixels++;
    }
    return { background, foreground, width: image.width, height: image.height, ...(target ? { litPixels } : {}) };
  }, { base64: png.toString('base64'), lit });
  const sample = { file, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), ...stats };
  report.screenshots.push(sample);
  return sample;
}

try {
  await client.connect(transport);
  const structureText = await readFile(resolve(root, '../fixtures/1CRN.cif'), 'utf8');
  const opened = await call('inspect', { structureText });
  sessionId = opened.structuredContent.sessionId;
  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  const panelHtml = (resource.contents[0] as any).text as string;

  browser = await chromium.launch({ headless: true });
  report.browserVersion = browser.version();
  // A short viewport pins the inspector footer over the appearance controls, so
  // give the panel room rather than forcing clicks through an overlay.
  const panelPage = await browser.newPage({ viewport: { width: 1180, height: 1200 }, deviceScaleFactor: 1 });
  panelPage.setDefaultTimeout(120_000);
  panelPage.on('pageerror', error => report.pageErrors.push(`panel: ${error.message}`));
  panelPage.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(`panel: ${message.text()}`); });
  await panelPage.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(hostOrigin)) return route.continue();
    report.externalRequests.push(url);
    return route.abort();
  });
  await panelPage.exposeFunction('__call', async (payload: any) => client.callTool({ name: payload.name, arguments: payload.arguments ?? {} }));
  await panelPage.goto(hostOrigin);
  await panelPage.evaluate(({ html, result }) => (window as any).__host.mount(html, result, { theme: 'dark' }), { html: panelHtml, result: opened });
  const panelFrame = panelPage.frames().find(frame => frame !== panelPage.mainFrame())!;
  await panelFrame.locator('body[data-ready="true"]').waitFor();
  const baseline = await waitSaved(view => view.scene !== null, 'the panel to save its first scene');

  // A default scene would not prove the handoff carries anything, so give the
  // panel a look the detailed page has to reproduce before opening it.
  await panelFrame.getByRole('button', { name: 'Pause rotation', exact: true }).click();
  await panelFrame.locator('[data-control="representation"]').selectOption('ball-and-stick');
  await waitSaved(view => view.scene.inspection.appearance.representation === 'ball-and-stick', 'the ball-and-stick representation to save');
  await panelFrame.locator('[data-background="#192734"]').click();
  const panelScene = (await waitSaved(view => view.scene.inspection.appearance.background === '#192734', 'the panel background to save')).scene;
  passed('panel-scene-saved', { representation: panelScene.inspection.appearance.representation, background: panelScene.inspection.appearance.background,
    firstRevision: baseline.inspectionRevision });

  const detailedResult = await call('open_detailed_view', await bindingNow());
  const detailed = detailedResult.structuredContent.detailedView;
  assert.match(detailed.url, /^http:\/\/127\.0\.0\.1:\d+\/detailed#[a-f0-9]{64}$/);
  const detailedOrigin = new URL(detailed.url).origin;

  const viewerPage = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  viewerPage.setDefaultTimeout(180_000);
  viewerPage.on('pageerror', error => report.pageErrors.push(`detailed: ${error.message}`));
  viewerPage.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(`detailed: ${message.text()}`); });
  await viewerPage.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(detailedOrigin)) return route.continue();
    report.externalRequests.push(url);
    return route.abort();
  });
  await viewerPage.goto(detailed.url);
  // Wait for either outcome so a page that failed to build reports its own
  // message instead of a bare timeout.
  await viewerPage.locator('body[data-detailed]').waitFor();
  assert.equal(await viewerPage.locator('body').getAttribute('data-detailed'), 'ready',
    `the detailed page did not build: ${await viewerPage.locator('#status').textContent()}`);
  const drawn = await viewerPage.evaluate(() => {
    const plugin = (window as any).stereofoldDetailedView.plugin;
    const structures = plugin.managers.structure.hierarchy.current.structures;
    const first = structures[0];
    return {
      structures: structures.length,
      atoms: first?.cell.obj?.data?.elementCount ?? 0,
      models: plugin.managers.structure.hierarchy.current.models.length,
      representations: first?.components?.flatMap((component: any) => component.representations).length ?? 0,
      camera: plugin.canvas3d.camera.getSnapshot(),
      background: plugin.canvas3d.props.renderer.backgroundColor,
      // What the page fitted to, so the framing can be checked
      // against the structure instead of against the panel's own camera.
      bounds: (() => {
        const sphere = plugin.canvas3d.boundingSphereVisible ?? plugin.canvas3d.boundingSphere;
        return {center: Array.from(sphere.center as number[]), radius: sphere.radius as number};
      })(),
      representation: document.body.dataset.representation,
      sceneRepresentation: document.body.dataset.sceneRepresentation,
      cameraFit: document.body.dataset.cameraFit,
    };
  });
  assert.equal(drawn.structures, 1, 'the detailed page must hold exactly one structure');
  assert.ok(drawn.atoms > 0, `the detailed structure must have atoms, got ${drawn.atoms}`);
  assert.ok(drawn.representations > 0, 'the detailed structure must carry a representation');
  const detailedPixels = await drawnPixels(viewerPage, viewerPage.locator('#app canvas'), '01-detailed-view-drawn');
  assert.ok(detailedPixels.foreground > 500, `the detailed canvas must not be blank, got ${detailedPixels.foreground} foreground pixels`);
  // The background travels with the handoff; the framing no
  // longer does. A camera snapshot taken where the panel or a headset seat put
  // it left the structure a speck in this window, so the page fits what it has
  // loaded. Check the fit itself: the camera looks at the structure's own
  // centre, from a distance of a few radii, which is what filling a viewport
  // means for a perspective camera.
  assert.equal(drawn.cameraFit, 'structure', 'the detailed page must fit the structure on load');
  const span = Math.hypot(...[0, 1, 2].map(axis => drawn.camera.position[axis] - drawn.bounds.center[axis]));
  for (const axis of [0, 1, 2]) {
    assert.ok(Math.abs(drawn.camera.target[axis] - drawn.bounds.center[axis]) < drawn.bounds.radius,
      `the detailed camera must look at the structure, target ${drawn.camera.target[axis]} vs centre ${drawn.bounds.center[axis]}`);
  }
  assert.ok(span > drawn.bounds.radius && span < drawn.bounds.radius * 6,
    `the structure must fill the viewport: camera is ${span.toFixed(1)} from a ${drawn.bounds.radius.toFixed(1)} radius`);
  // A filled representation is never rebuilt here, whatever the scene carries.
  assert.ok(!['molecular-surface', 'spacefill'].includes(String(drawn.representation)),
    `the detailed page must not open on ${drawn.representation}`);
  assert.equal(drawn.background, parseInt(panelScene.inspection.appearance.background.slice(1), 16));
  passed('detailed-page-draws-the-structure', { ...drawn, camera: undefined, pixels: detailedPixels });

  // Do detailed work the panel does not offer, then bring it back through the
  // viewer's own Download State exactly as a user would.
  const changed = await viewerPage.evaluate(async () => {
    const plugin = (window as any).stereofoldDetailedView.plugin;
    let reference: string | undefined;
    for (const [ref, cell] of plugin.state.data.cells) {
      const id = cell.transform?.transformer?.id;
      if (typeof id === 'string' && id.endsWith('structure-representation-3d')) { reference = ref; break; }
    }
    if (!reference) throw Error('no structure representation to update');
    await plugin.build().to(reference).update((old: any) => ({ ...old, type: { ...old.type, params: { ...old.type.params, alpha: 0.42 } } })).commit();
    plugin.canvas3d.setProps({ renderer: { backgroundColor: 0x2b1a33 } });
    const camera = plugin.canvas3d.camera.getSnapshot();
    plugin.canvas3d.camera.setState({ ...camera, position: [camera.position[0] + 12, camera.position[1] - 7, camera.position[2] + 9] }, 0);
    plugin.canvas3d.requestDraw();
    await new Promise(frame => requestAnimationFrame(() => frame(null)));
    return { camera: plugin.canvas3d.camera.getSnapshot() };
  });
  const editedPixels = await drawnPixels(viewerPage, viewerPage.locator('#app canvas'), '02-detailed-view-edited');
  assert.notEqual(editedPixels.sha256, detailedPixels.sha256, 'the detailed edits must change pixels');
  const molj = await viewerPage.evaluate(async () => {
    const plugin = (window as any).stereofoldDetailedView.plugin;
    const blob = await plugin.managers.snapshot.serialize({ type: 'molj' });
    return await blob.text();
  });
  const moljPath = resolve(out, 'download-state.molj');
  await writeFile(moljPath, molj);
  const parsed = JSON.parse(molj);
  assert.ok(Array.isArray(parsed.entries) && parsed.entries.length > 0, 'Download State must produce plugin state entries');
  passed('download-state-produces-a-real-molj', { bytes: Buffer.byteLength(molj, 'utf8'), entries: parsed.entries.length, path: moljPath });

  const importResult = await call('import_detailed_view', { ...await readyPanel(), commandId: 'detailed-import-1', filePath: moljPath });
  const imported = importResult.structuredContent.detailedImport;
  assert.equal(imported.changed, true, `the import must queue a change, got ${JSON.stringify(imported)}`);
  assert.ok(imported.applied.includes('opacity'), `the import must apply opacity, got ${imported.applied}`);
  assert.ok(imported.applied.includes('background'), `the import must apply background, got ${imported.applied}`);
  await waitCommand('detailed-import-1', 'rendered');
  const afterImport = await waitSaved(view => view.scene.inspection.appearance.opacity === 0.42, 'the panel to render the imported opacity');
  assert.equal(afterImport.scene.inspection.appearance.background, '#2b1a33');
  assert.equal(afterImport.scene.inspection.appearance.representation, 'ball-and-stick');
  assert.equal(await panelFrame.locator('[data-control="background"]').inputValue(), '#2b1a33');
  const panelPixels = await drawnPixels(panelPage, panelFrame.locator('.stage canvas'), '03-panel-after-import');
  assert.ok(panelPixels.foreground > 100, 'the panel must still draw after the import');
  passed('import-round-trips-into-the-panel', { applied: imported.applied, dropped: imported.dropped, pixels: panelPixels });

  // The framing leg: the detailed camera comes back as its own command.
  const cameraImport = await call('import_detailed_view', { ...await readyPanel(), commandId: 'detailed-import-2', filePath: moljPath });
  const cameraApplied = cameraImport.structuredContent.detailedImport;
  if (cameraApplied.changed) {
    await waitCommand('detailed-import-2', 'rendered');
    const framed = await waitSaved(view => JSON.stringify(view.scene.camera.position) === JSON.stringify(changed.camera.position.map(Number)),
      'the panel to restore the detailed framing');
    passed('camera-round-trips-into-the-panel', { applied: cameraApplied.applied, position: framed.scene.camera.position });
  } else {
    report.scenarios.push({ id: 'camera-round-trips-into-the-panel', status: 'failed', evidence: cameraApplied });
    console.error('Failed: camera-round-trips-into-the-panel', JSON.stringify(cameraApplied));
  }

  // The one press a user actually has. Everything above went
  // through a file and an agent holding its path; this is the button on the
  // detailed page — "Apply supported changes and return" — which posts the
  // viewer's own state to the host over the page key it already holds and
  // loops until the panel has rendered every leg. Two things only a real
  // Chromium against a real Mol* build can catch live here:
  // getStateSnapshot() returning the entry shape the projection expects, and
  // selection.getLoci(loaded) returning element loci for the loaded structure.
  const beforeReturn = await waitSaved(view => view.scene !== null, 'the panel scene before the return press');
  const returnedEdits = await viewerPage.evaluate(async () => {
    const plugin = (window as any).stereofoldDetailedView.plugin;
    let reference: string | undefined;
    for (const [ref, cell] of plugin.state.data.cells) {
      const id = cell.transform?.transformer?.id;
      if (typeof id === 'string' && id.endsWith('structure-representation-3d')) { reference = ref; break; }
    }
    if (!reference) throw Error('no structure representation to update');
    await plugin.build().to(reference).update((old: any) => ({ ...old, type: { ...old.type, params: { ...old.type.params, alpha: 0.63 } } })).commit();
    plugin.canvas3d.setProps({ renderer: { backgroundColor: 0x143b2a } });
    plugin.canvas3d.requestDraw();
    await new Promise(frame => requestAnimationFrame(() => frame(null)));
    return { alpha: 0.63, background: '#143b2a' };
  });
  await viewerPage.locator('#return:not([hidden])').waitFor();
  await viewerPage.locator('#return').click();
  await viewerPage.locator('body[data-returned="applied"]').waitFor({ timeout: 180_000 });
  const returnState = await viewerPage.evaluate(() => ({
    returned: document.body.dataset.returned,
    applied: (document.body.dataset.returnedApplied ?? '').split(',').filter(Boolean),
    note: document.getElementById('return-note')?.textContent ?? '',
    status: document.getElementById('status')?.textContent ?? '',
  }));
  assert.equal(returnState.returned, 'applied', `the one press must apply, not fall back: ${returnState.status}`);
  assert.ok(returnState.applied.includes('appearance'),
    `the one press must send the appearance back, got ${JSON.stringify(returnState.applied)}`);
  const afterReturn = await waitSaved(view => view.scene.inspection.appearance.opacity === 0.63
    && view.scene.inspection.appearance.background === '#143b2a', 'the panel to render the returned appearance');
  assert.equal(await panelFrame.locator('[data-control="background"]').inputValue(), '#143b2a');
  assert.notEqual(afterReturn.inspectionRevision, beforeReturn.inspectionRevision, 'the return must move the saved inspection on');
  const returnedPixels = await drawnPixels(panelPage, panelFrame.locator('.stage canvas'), '04-panel-after-one-press-return');
  assert.ok(returnedPixels.foreground > 100, 'the panel must still draw after the one-press return');
  passed('one-press-return-applies-to-the-panel', { ...returnState, ...returnedEdits,
    opacity: afterReturn.scene.inspection.appearance.opacity,
    background: afterReturn.scene.inspection.appearance.background, pixels: returnedPixels });

  // The desktop's own way back, and the size of the way back.
  //
  // A wearer in this page has no companion panel, so nothing the agent says or
  // queues reaches them, which makes the trip to Mol* one way with no way
  // back. recall_headset leaves one sentence and this
  // page's poll takes it, shows it and arms the same one-tap re-entry hint the
  // Back control arms. On loopback there is no /viewer to navigate to, so the
  // page stops at the sentence and says so rather than leaving the address bar
  // somewhere it cannot come back from.
  const recallText = 'Come back, the lesson is waiting.';
  const recalled = await call('recall_headset', { sessionId, text: recallText });
  assert.equal(recalled.structuredContent.detailedRecall.queued, true);
  await viewerPage.locator('body[data-recall]').waitFor({ timeout: 30_000 });
  const recallState = await viewerPage.evaluate(() => ({
    recall: document.body.dataset.recall,
    status: document.getElementById('status')?.textContent ?? '',
    hint: sessionStorage.getItem('stereofold-reenter-xr'),
  }));
  assert.equal(recallState.recall, 'here', 'a loopback page has no /viewer to return to and must say so');
  assert.equal(recallState.status, recallText, 'the wearer must read the sentence the agent sent');
  assert.equal(JSON.parse(recallState.hint ?? '{}').via, 'recall',
    `the recall must arm the one-tap return the way the Back control does, got ${recallState.hint}`);
  // One delivery. A second would yank a wearer who opened the viewer again
  // minutes later straight back out of it.
  assert.deepEqual((await call('poll_detailed_view', { sessionId })).structuredContent.detailedRecall, { recall: false });

  // The size of the way back. On loopback the link is hidden because there is
  // nowhere to go; unhiding it measures the CSS the headset actually gets,
  // which is the whole difference between a control a controller ray can hit
  // from across a room and the 110x34 px corner link that shipped.
  const backBox = await viewerPage.evaluate(() => {
    const bar = document.getElementById('bar')!, back = document.getElementById('back')!;
    bar.hidden = false; back.hidden = false; document.body.dataset.back = 'on';
    const barBox = bar.getBoundingClientRect(), backRect = back.getBoundingClientRect();
    const status = document.getElementById('status')!.getBoundingClientRect();
    return { top: Math.round(backRect.top), height: Math.round(backRect.height), width: Math.round(backRect.width),
      barTop: Math.round(barBox.top), statusTop: Math.round(status.top) };
  });
  assert.ok(backBox.height >= 64, `the way back must be at least 64 px tall, got ${backBox.height}`);
  assert.ok(backBox.width >= 200, `the way back must be a wide target, got ${backBox.width}`);
  assert.equal(backBox.barTop, 0, 'the row must sit at the top of the page');
  assert.ok(backBox.statusTop >= backBox.top + backBox.height,
    `the status line must sit below the row, not over it (${backBox.statusTop} vs ${backBox.top + backBox.height})`);
  passed('the-mac-can-call-the-wearer-back-out-of-molstar', { ...recallState, ...backBox });

  // The lesson leg. 1CRN has no named parts, so everything above proves the
  // trip and none of it proves the requirement itself —
  // that the lesson's own parts and the emphasis on them stay readable across
  // it. This opens the demo lesson in a second panel, lights one named part
  // through the agent's own emphasize tool, takes the whole thing to the full
  // Mol* viewer and brings it back with the one press, then checks the key is
  // still on the molecule at the far end.
  if (demo) {
    const lessonOpened = await call('inspect_lesson', { filePath: demo.coordinatesPath, lessonPath: demo.lessonPath,
      ...(demo.assemblyId ? { assemblyId: demo.assemblyId } : {}) });
    sessionId = lessonOpened.structuredContent.sessionId;
    const lessonPage = await browser.newPage({ viewport: { width: 1180, height: 1200 }, deviceScaleFactor: 1 });
    lessonPage.setDefaultTimeout(180_000);
    lessonPage.on('pageerror', error => report.pageErrors.push(`lesson panel: ${error.message}`));
    lessonPage.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(`lesson panel: ${message.text()}`); });
    await lessonPage.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(hostOrigin)) return route.continue();
      report.externalRequests.push(url);
      return route.abort();
    });
    await lessonPage.exposeFunction('__call', async (payload: any) => client.callTool({ name: payload.name, arguments: payload.arguments ?? {} }));
    await lessonPage.goto(hostOrigin);
    await lessonPage.evaluate(({ html, result }) => (window as any).__host.mount(html, result, { theme: 'dark' }), { html: panelHtml, result: lessonOpened });
    const lessonFrame = lessonPage.frames().find(frame => frame !== lessonPage.mainFrame())!;
    await lessonFrame.locator('body[data-ready="true"]').waitFor();
    await waitSaved(view => view.scene !== null, 'the lesson panel to save its first scene');
    await lessonFrame.getByRole('button', { name: 'Pause rotation', exact: true }).click();

    // Readable: the lesson publishes its parts by name, before anything is lit.
    const beforeState = (await call('get_inspection_state', { sessionId })).structuredContent;
    const lessonParts = beforeState.lesson?.parts ?? [];
    assert.ok(lessonParts.length > 0, `${demo.entry.name} published no named parts for the agent to read.`);
    // The guide RNA is the part most often named, so prefer it.
    const namedPart = lessonParts.find((part: any) => /rna/iu.test(part.label ?? part.id)) ?? lessonParts[0];

    // Commandable: the agent's own tool, named as the lesson names the part.
    await call('emphasize', { ...await readyPanel(), commandId: 'lesson-emphasize-1', parts: [namedPart.label ?? namedPart.id] });
    await waitCommand('lesson-emphasize-1', 'rendered');
    const lit = (await call('get_inspection_state', { sessionId })).structuredContent;
    assert.deepEqual(lit.view.emphasis?.focus, [namedPart.id],
      `the agent's emphasize did not leave ${namedPart.id} focused: ${JSON.stringify(lit.view.emphasis)}`);
    const litColour = (lit.view.emphasis.parts as any[]).find(part => part.id === namedPart.id)?.color;
    assert.match(String(litColour), /^#[0-9a-f]{6}$/iu, 'the focused part must carry its own colour');
    const beforeTrip = await drawnPixels(lessonPage, lessonFrame.locator('.stage canvas'), '05-lesson-emphasis-before-handoff', litColour);
    assert.ok((beforeTrip as any).litPixels > 100,
      `the emphasised part must be drawn in its own colour, got ${(beforeTrip as any).litPixels} pixels near ${litColour}`);
    passed('lesson-parts-are-readable-and-commandable', { parts: lessonParts.length, focus: lit.view.emphasis.focus,
      colour: litColour, contextOpacity: lit.view.emphasis.contextOpacity, pixels: beforeTrip });

    // The trip out: the handoff carries the key and says, in the result and on
    // the page, that the full viewer will not repaint it.
    const lessonHandoff = (await call('open_detailed_view', await bindingNow())).structuredContent.detailedView;
    assert.ok(lessonHandoff.notCarried.includes('emphasis-colours'),
      `the handoff must say the colours do not repaint: ${JSON.stringify(lessonHandoff.notCarried)}`);
    assert.deepEqual(lessonHandoff.emphasis, { focus: [namedPart.id], repainted: false });
    const lessonOrigin = new URL(lessonHandoff.url).origin;
    const lessonViewer = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    lessonViewer.setDefaultTimeout(300_000);
    lessonViewer.on('pageerror', error => report.pageErrors.push(`lesson detailed: ${error.message}`));
    lessonViewer.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(`lesson detailed: ${message.text()}`); });
    await lessonViewer.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(lessonOrigin)) return route.continue();
      report.externalRequests.push(url);
      return route.abort();
    });
    await lessonViewer.goto(lessonHandoff.url);
    await lessonViewer.locator('body[data-detailed]').waitFor();
    assert.equal(await lessonViewer.locator('body').getAttribute('data-detailed'), 'ready',
      `the lesson detailed page did not build: ${await lessonViewer.locator('#status').textContent()}`);
    const namedOverThere = await lessonViewer.evaluate(() => ({ parts: document.body.dataset.emphasisParts ?? '',
      focus: document.body.dataset.emphasisFocus ?? '', note: document.getElementById('note')?.textContent ?? '' }));
    assert.ok(namedOverThere.focus.includes(namedPart.label ?? namedPart.id),
      `the full viewer must name what the headset was showing, got "${namedOverThere.focus}"`);
    assert.ok(namedOverThere.note.length > 0, 'the full viewer must say the key is not repainted here');
    await drawnPixels(lessonViewer, lessonViewer.locator('#app canvas'), '06-lesson-detailed-view');

    // The trip back: one press, with a change of its own to carry.
    await lessonViewer.evaluate(async () => {
      const plugin = (window as any).stereofoldDetailedView.plugin;
      plugin.canvas3d.setProps({ renderer: { backgroundColor: 0x281033 } });
      plugin.canvas3d.requestDraw();
      await new Promise(frame => requestAnimationFrame(() => frame(null)));
    });
    await lessonViewer.locator('#return:not([hidden])').waitFor();
    await lessonViewer.locator('#return').click();
    await lessonViewer.locator('body[data-returned="applied"]').waitFor({ timeout: 300_000 });

    // Persistent: the background came back and the colour key is still lit.
    const afterTripState = await waitSaved(view => view.scene.inspection.appearance.background === '#281033',
      'the lesson panel to render the returned background');
    const afterTrip = (await call('get_inspection_state', { sessionId })).structuredContent;
    assert.deepEqual(afterTrip.view.emphasis?.focus, [namedPart.id],
      `the Mol* trip dropped the emphasis: ${JSON.stringify(afterTrip.view.emphasis)}`);
    assert.equal(afterTrip.lesson?.parts?.length, lessonParts.length, 'the lesson parts must survive the trip');
    assert.equal(afterTripState.scene.inspection.emphasis?.focus?.[0], namedPart.id,
      'the saved scene must still carry the emphasis after the return');
    const afterPixels = await drawnPixels(lessonPage, lessonFrame.locator('.stage canvas'), '07-lesson-emphasis-after-return', litColour);
    assert.ok((afterPixels as any).litPixels > 100,
      `the named part must still be lit after the round trip, got ${(afterPixels as any).litPixels} pixels near ${litColour}`);
    passed('lesson-emphasis-survives-the-molstar-round-trip', { namedOverThere,
      focus: afterTrip.view.emphasis.focus, parts: afterTrip.lesson.parts.length,
      background: afterTripState.scene.inspection.appearance.background,
      before: (beforeTrip as any).litPixels, after: (afterPixels as any).litPixels, pixels: afterPixels });
  } else {
    report.lessonLeg = 'NOT RUN — pass --demo <name> to add it.';
  }

  assert.deepEqual(report.externalRequests, [], 'neither page may reach the network');
  assert.deepEqual(report.pageErrors, [], 'neither page may raise an error');
  report.status = report.scenarios.every((scenario: Scenario) => scenario.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  report.failure = (error as Error).stack;
  report.stderr = stderr;
  console.error(error);
} finally {
  const dispose = async (name: string, action: () => Promise<unknown>) => {
    try { await action(); report.cleanup[name] = 'ok'; }
    catch (error) { report.cleanup[name] = (error as Error).message; }
  };
  await dispose('browserClosed', async () => { await browser?.close(); });
  // Closing the MCP child ends the loopback companion listener the detailed
  // view rides on; it is unref'd and owned by that process, so no port is left.
  await dispose('mcpClosed', () => client.close());
  await dispose('listenerClosed', () => new Promise<void>(done => http.close(() => done())));
  report.finishedAt = new Date().toISOString();
  await dispose('reportWritten', () => writeFile(resolve(out, 'detailed-view-report.json'), JSON.stringify(report, null, 2) + '\n'));
  console.log(`\nReport: ${resolve(out, 'detailed-view-report.json')}`);
  console.log(JSON.stringify({ status: report.status, scenarios: report.scenarios.map((scenario: Scenario) => [scenario.id, scenario.status]) }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}
