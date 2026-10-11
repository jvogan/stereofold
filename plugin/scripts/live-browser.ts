import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Page, type Frame } from 'playwright';
import { permitsLiveOrangeAction } from './live-browser-contract.js';

// Explicit paid opt-in. One session only; the Python transport independently
// limits duration. Never include API credentials in browser state or artifacts.
const [outArg, inputArg, consent, ...extra] = process.argv.slice(2);
assert.ok(outArg && inputArg && consent === '--allow-paid-live1' && extra.length === 0,
  'Usage: live-browser.ts <fresh-output-dir> <public-24k-mono-WAV> --allow-paid-live1 (one paid session <=35s)');
const out = resolve(outArg); await mkdir(out, { recursive: false });
const report: any = { status: 'failed', physicalHeadset: false, nativeHost: false,
  scope: 'Paid Live client delegation, fixed local action driver, official AppBridge and isolated Chromium/Mol*; no backend API model.',
  events: [], errors: [], cleanup: {} };
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const client = new Client({ name: 'Stereofold opt-in Live browser acceptance', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/server.mjs')],
  cwd: process.cwd(), env: { STEREOFOLD_REPLY_AUDIO: '0', STEREOFOLD_PTT_TRANSCRIBE: '0' }, stderr: 'pipe' });
transport.stderr?.on('data', () => {});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let host: ReturnType<typeof createServer> | undefined, page: Page | undefined, frame: Frame | undefined;
let paid: ReturnType<typeof spawn> | undefined, sessionId: string;
const call = async (name: string, args: any) => {
  const value: any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!value.isError, `${name} failed: ${String(value.content?.[0]?.text ?? '').slice(0, 300)}`); return value;
};
const state = async (commandId?: string) => (await call('get_inspection_state', { sessionId, ...(commandId ? { commandId } : {}) })).structuredContent;
async function waitState(predicate: (value: any) => boolean, commandId?: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await state(commandId); if (predicate(value)) return value; await sleep(75); }
  throw Error('Renderer receipt deadline exceeded');
}
const binding = (value: any) => ({ sessionId, serverEpoch: value.serverEpoch, sourceToken: value.sourceToken,
  baseStateRevision: value.stateRevision, baseInspectionRevision: value.inspectionRevision,
  panelId: value.panels.find((panel: any) => panel.surface === 'desktop' && panel.current && panel.availability === 'ready')?.panelId });
async function command(id: string, change: any) {
  const current = await waitState(value => value.panels.some((panel: any) => panel.surface === 'desktop' && panel.current && panel.availability === 'ready'));
  await call('update_inspection', { ...binding(current), commandId: id, change });
  return waitState(value => value.command?.commandId === id && value.command?.status === 'rendered', id);
}
try {
  const bundle = await build({ entryPoints: [resolve('scripts/inspector-host.ts')], bundle: true, format: 'iife', write: false, platform: 'browser', target: 'es2022' });
  const html = `<!doctype html><button id="enable">Enable test audio</button><iframe style="border:0;width:100vw;height:90vh"></iframe><script>${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`;
  host = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
  await new Promise<void>(done => host!.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(host.address() as any).port}`;
  await client.connect(transport);
  const opened = await call('inspect_file', { filePath: resolve('../fixtures/1CRN.cif') });
  sessionId = opened.structuredContent.sessionId;
  const resource = await client.readResource({ uri: 'ui://stereo-structure/inspector' });
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--mute-audio'] });
  page = await browser.newPage({ viewport: { width: 1100, height: 780 } }); page.setDefaultTimeout(45000);
  await page.addInitScript({ content: 'globalThis.__name = value => value;' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.exposeFunction('__call', (payload: any) => client.callTool({ name: payload.name, arguments: payload.arguments ?? {} }));
  await page.goto(origin);
  await page.evaluate(({ resource, opened }) => (window as any).__host.mount(resource, opened, { theme: 'dark' }), { resource: (resource.contents[0] as any).text, opened });
  frame = page.frames().find(item => item !== page!.mainFrame()); assert.ok(frame);
  await frame.locator('body[data-ready="true"]').waitFor();
  await waitState(value => value.hasScene === true);
  const residues = (await call('get_inspection_state', { sessionId, residues: { authorChain: 'A', authorResidueRange: [10, 15], limit: 16 } })).structuredContent.residues.rows;
  assert.equal(residues.length, 6); const keys = residues.map((row: any) => row.key);
  await command('live-fixture-select', { kind: 'selection', patch: { selectionKeys: keys } });
  await writeFile(resolve(out, 'before.png'), await frame.locator('.stage canvas').screenshot());
  await page.evaluate(() => {
    const w = window as any;
    const context = new AudioContext({ sampleRate: 24000 });
    const analyser = context.createAnalyser(); analyser.connect(context.destination);
    w.__playback = { context, next: 0, chunks: 0, ended: 0, peak: 0, renderedPeak: 0, firstStartMs: null, lastEndMs: null };
    const observed = new Float32Array(analyser.fftSize);
    const observe = () => { analyser.getFloatTimeDomainData(observed); for (const value of observed) w.__playback.renderedPeak = Math.max(w.__playback.renderedPeak, Math.abs(value)); requestAnimationFrame(observe); }; observe();
    document.querySelector('#enable')!.addEventListener('click', () => void context.resume());
    w.__pcm = (base64: string) => {
      const state = w.__playback, raw = atob(base64), buffer = context.createBuffer(1, raw.length / 2, 24000);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) {
        const n = raw.charCodeAt(2 * i) | (raw.charCodeAt(2 * i + 1) << 8);
        samples[i] = (n > 32767 ? n - 65536 : n) / 32768; state.peak = Math.max(state.peak, Math.abs(samples[i]));
      }
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(analyser);
      const at = Math.max(context.currentTime + .03, state.next); state.next = at + buffer.duration;
      state.firstStartMs ??= performance.now() + (at - context.currentTime) * 1000;
      source.onended = () => { state.ended++; state.lastEndMs = performance.now(); source.disconnect(); };
      state.chunks++; source.start(at);
    };
  });
  await page.locator('#enable').click();
  await page.waitForFunction(() => (window as any).__playback.context.state === 'running');
  console.log('Local render and browser audio ready; starting one bounded paid Live session.');
  let transcript = '', delegation: { id: string; target: string } | undefined, acting = false;
  let playback = Promise.resolve(), action = Promise.resolve();
  const maybeAct = () => {
    if (acting || !delegation || delegation.target !== 'client' || !permitsLiveOrangeAction(transcript)) return;
    acting = true;
    const accepted = delegation;
    action = (async () => {
      const started = performance.now();
      const receipt = await command('live-orange-render', { kind: 'appearance', scope: 'selection', patch: { color: 'uniform', uniformColor: '#ff8800' } });
      const saved = (await call('get_inspection', { sessionId }))._meta['stereo_structure/inspection'].scene;
      assert.deepEqual(saved.selectionKeys, keys);
      assert.ok(saved.inspection.styles?.some((style: any) => style.uniformColor?.toLowerCase() === '#ff8800' && keys.every((key: string) => style.selectionKeys.includes(key))), 'Saved selection style must be orange on the exact selected keys');
      report.renderedAction = { commandId: receipt.command.commandId, status: receipt.command.status,
        localActionMs: Math.round(performance.now() - started), selectedResidues: keys.length, color: '#ff8800', receipt: receipt.command };
      await writeFile(resolve(out, 'after.png'), await frame!.locator('.stage canvas').screenshot());
      paid!.stdin!.write(JSON.stringify({ type: 'result', id: accepted.id,
        content: 'Confirmed rendered result: the six selected residues in the local molecular viewer are now orange. The actual browser renderer returned rendered for this specific color command. Say briefly: The selected residues are now orange.' }) + '\n');
    })().catch(error => { report.errors.push(error.message); });
  };
  paid = spawn('python3', ['scripts/live-browser-transport.py', '--allow-paid-live1', '--input', resolve(inputArg), '--output', out], { stdio: ['pipe', 'pipe', 'pipe'] });
  paid.stderr!.on('data', () => {}); // Never relay credential-adjacent process diagnostics.
  const lines = createInterface({ input: paid.stdout! });
  lines.on('line', line => {
    let event: any;
    try { event = JSON.parse(line); } catch { report.errors.push('Transport emitted invalid JSON'); paid?.kill('SIGTERM'); return; }
    if (event.type === 'audio') playback = playback.then(() => page!.evaluate(data => (window as any).__pcm(data), event.pcm)).catch(error => { report.errors.push(`Playback: ${error.message}`); });
    else if (event.type === 'transcript') {
      report.events.push(event); if (event.side === 'input') { transcript = event.text; maybeAct(); }
    } else if (event.type === 'delegation') { delegation = event; report.events.push({ type: 'delegation', target: event.target, atMs: event.atMs }); maybeAct(); }
    else if (event.type === 'finished') report.api = event.report;
    else report.events.push(event);
  });
  const hardStop = setTimeout(() => paid?.kill('SIGKILL'), 45000);
  try { await new Promise<void>((done, reject) => { paid!.once('error', reject); paid!.once('close', code => code === 0 ? done() : reject(Error(`Live transport exited ${code}`))); }); }
  finally { clearTimeout(hardStop); }
  await action; await playback;
  await page.waitForFunction(() => { const p = (window as any).__playback; return p.chunks > 0 && p.ended === p.chunks; }, undefined, { timeout: 20000 });
  report.playback = await page.evaluate(() => { const { context, ...stats } = (window as any).__playback; return { ...stats, contextState: context.state, sampleRate: context.sampleRate }; });
  assert.equal(report.api?.status, 'passed'); assert.equal(report.api?.finalized, true);
  assert.equal(report.renderedAction?.status, 'rendered'); assert.ok(report.playback.peak > .01); assert.ok(report.playback.renderedPeak > .01, 'WebAudio analyser must observe non-silent rendered output');
  assert.ok(report.playback.ended > 0); assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'Acceptance failed'; process.exitCode = 1;
} finally {
  paid?.kill('SIGTERM');
  for (const [name, close] of [
    ['browserClosed', () => browser?.close() ?? Promise.resolve()], ['mcpClosed', () => client.close()],
    ['listenerClosed', () => new Promise<void>(done => host ? host.close(() => done()) : done())],
  ] as const) { try { await close(); report.cleanup[name] = true; } catch { report.cleanup[name] = false; report.status = 'failed'; process.exitCode = 1; } }
  await writeFile(resolve(out, 'live-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, failure: report.failure, report: resolve(out, 'live-browser-report.json'), cost: report.api?.estimatedVoiceUsd }));
}
