import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright';
import { fixtureWav } from './voice-browser-server.js';

const target = process.argv[2];
assert.ok(target, 'Supply a fresh artifact directory.');
const out = resolve(target);
await mkdir(out, { recursive: false });
const fakeMicrophone = resolve(out, 'synthetic-microphone.wav');
await writeFile(fakeMicrophone, Buffer.from(fixtureWav(2), 'base64'));
const report:any = {
  status: 'failed',
  mode: 'Host simulation: explicit in-process transcription/narration seams; no Codex or OAuth request.',
  cases: [], messages: [], toolCalls: [], companionToolCalls: [], voiceRequests: [], voiceResponses: [], pageErrors: [], console: [], diagnostics: {},
};
function recordCase(message: string) { report.cases.push(message); console.log(`PASS: ${message}`); }
const delay = (ms:number) => new Promise<void>(done => setTimeout(done, ms));
const client = new Client({ name: 'Voice browser acceptance', version: '1' });
const transcript = process.env.VOICE_TEST_TRANSCRIPT
  ?? (process.env.VOICE_TEST_FAST === '1' ? 'show tubulin' : 'Can you explain this microtubule lattice?');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/voice-browser-server.ts'), transcript],
  cwd: process.cwd(), env: { VOICE_TEST_TRANSCRIPT: transcript }, stderr: 'pipe',
});
transport.stderr?.on('data', () => {});
const call = async (name:string, args:Record<string, unknown>) => {
  const result:any = await client.callTool({ name: `stereo_structure.${name}`, arguments: args });
  assert.ok(!result.isError, `${name}: ${String(result.content?.[0]?.text ?? '').slice(0, 500)}`);
  return result;
};
const binding = (state:any, sessionId:string) => ({ sessionId, serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
  baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision });
async function state(sessionId:string) { return (await call('get_inspection_state', { sessionId })).structuredContent as any; }
async function waitState(sessionId:string, predicate:(value:any) => boolean, timeout = 120_000) {
  const until = Date.now() + timeout;
  let latest:any;
  while (Date.now() < until) { latest = await state(sessionId); if (predicate(latest)) return latest; await delay(150); }
  throw Error(`Timed out waiting for inspection state: ${JSON.stringify(latest?.panels?.map((panel:any) => ({id:panel.panelId,surface:panel.surface,current:panel.current,availability:panel.availability})))}`);
}

const fixture = String.raw`
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
let bridge;
window.__host = {
  events: [], connected: false,
  async mount({ html, url, result, context = { theme: 'dark' } }) {
    if (bridge) await bridge.close();
    const frame = document.querySelector('iframe');
    this.connected = false;
    bridge = new AppBridge(null, {name:'Voice acceptance host',version:'1'}, {message:{text:{}},serverTools:{},serverResources:{}},
      {hostContext:{displayMode:'inline',containerDimensions:{maxWidth:1100,maxHeight:720},...context}});
    bridge.oncalltool = payload => window.__call(payload);
    bridge.onupdatemodelcontext = async () => ({});
    bridge.onsizechange = () => {};
    bridge.onmessage = async payload => { this.events.push(payload); return {}; };
    bridge.oninitialized = async () => { this.connected = true; await bridge.sendToolResult(result); };
    await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
    if (url) frame.src = url; else frame.srcdoc = html;
  },
};`;
const fixtureBundle = await build({ stdin:{contents:fixture,resolveDir:process.cwd(),loader:'ts'}, bundle:true, write:false, format:'iife', platform:'browser', target:'es2022' });
let desktopHtml = '';
const host = createServer((request, response) => {
  if (request.url === '/desktop') { response.setHeader('content-type','text/html;charset=utf-8'); response.end(desktopHtml); return; }
  response.setHeader('content-type','text/html;charset=utf-8');
  response.end(`<!doctype html><html><body style="margin:0;background:#071015"><iframe style="border:0;width:100vw;height:100vh"></iframe><script>${fixtureBundle.outputFiles[0].text.split('</script').join('<\\/script')}</script></body></html>`);
});
await new Promise<void>((done, fail) => { host.once('error', fail); host.listen(0, '127.0.0.1', done); });
const hostOrigin = `http://127.0.0.1:${(host.address() as any).port}`;
let browser:any, context:any, page:any, companionPage:any, sessionId:string|undefined;
async function capture(stage:string) {
  if (!page) return;
  const frames = page.frames().filter((value:any) => value !== page.mainFrame());
  report.diagnostics[stage] = {
    url: page.url(),
    hostConnected: await page.evaluate(() => (window as any).__host.connected).catch(() => undefined),
    hostEventCount: await page.evaluate(() => (window as any).__host.events.length).catch(() => undefined),
    frames: await Promise.all(frames.map(async (frame:any) => ({
      url: frame.url(),
      body: await frame.evaluate(() => ({ ready:document.body?.dataset.ready, panelId:document.body?.dataset.panelId,
        text:document.body?.innerText.slice(0,2000), html:document.body?.outerHTML.slice(0,3000) })).catch((error:any) => ({error:String(error)})),
    }))),
  };
  if (companionPage) report.diagnostics[stage].companion = await companionPage.evaluate(() => ({url:location.href.replace(/#.*/, '#[capability]'), ready:document.body.dataset.ready, panelId:document.body.dataset.panelId, text:document.body.innerText.slice(0,2000)})).catch((error:any) => ({error:String(error)}));
  if (companionPage) report.voiceLifecycle = await companionPage.evaluate(() => (window as any).__voiceLifecycle ?? []).catch(() => []);
  if (companionPage) report.voiceAudio = await companionPage.evaluate(() => (window as any).__voiceAudio ?? []).catch(() => []);
  if (companionPage) report.voiceButtonStyle = await companionPage.evaluate(() => {
    const button = document.querySelector('[data-voice-orb]'); if (!button) return null;
    const style = getComputedStyle(button);
    return {color:style.color,backgroundColor:style.backgroundColor};
  }).catch(() => null);
  await page.screenshot({path:resolve(out, `${stage}.png`), fullPage:true}).catch(() => {});
  await companionPage?.screenshot({path:resolve(out, `${stage}-companion.png`), fullPage:true}).catch(() => {});
}
try {
  await client.connect(transport);
  const cif = await readFile(resolve('../fixtures/1CRN.cif'), 'utf8');
  const opened:any = await call('inspect', { structureText:cif });
  sessionId = opened.structuredContent.sessionId;
  desktopHtml = ((await client.readResource({uri:'ui://stereo-structure/inspector'})).contents[0] as { text:string }).text;
  browser = await chromium.launch({headless:true, args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${fakeMicrophone}`]});
  context = await browser.newContext({ permissions:['microphone'], viewport:{width:1120,height:760} });
  page = await context.newPage(); page.setDefaultTimeout(120_000);
  page.on('pageerror', (error:any) => report.pageErrors.push(error.message));
  page.on('console', (message:any) => { if (message.type() === 'error') report.console.push(message.text()); });
  await page.exposeFunction('__call', async (payload:any) => {
    report.toolCalls.push(payload.name);
    return client.callTool({name:payload.name, arguments:payload.arguments ?? {}});
  });
  await page.goto(hostOrigin);
  await page.evaluate(({html,result}: {html:string;result:any}) => (window as any).__host.mount({html,result}), {html:desktopHtml,result:opened});
  await page.waitForFunction(() => (window as any).__host.connected === true, null, {timeout:120_000});
  let frame = page.frames().find((value:any) => value !== page.mainFrame());
  assert.ok(frame, 'The controlled host must mount a desktop frame.');
  await frame.waitForFunction(() => document.body.dataset.ready === 'true', null, {timeout:120_000});
  await frame.locator('.stage canvas').waitFor({state:'visible', timeout:120_000});
  await waitState(sessionId!, (value:any) => value.hasScene && value.panels.some((panel:any) => panel.surface === 'desktop' && panel.current && panel.availability === 'ready'));
  recordCase('Desktop render and AppBridge attachment completed');
  const ready = await state(sessionId!);
  const openedCompanion:any = await call('open_companion', {...binding(ready,sessionId!),connection:'loopback'});
  // The real loopback companion page is a standalone authenticated HTTP client,
  // not an AppBridge resource. Its bootstrap data is injected by this exact URL.
  const companionUrl = openedCompanion.structuredContent.companion.url as string;
  report.companionUrlShape = new URL(companionUrl).origin;
  companionPage = await context.newPage(); companionPage.setDefaultTimeout(120_000);
  // Raw script avoids tsx's injected function-name helpers crossing the
  // Playwright serialization boundary without their enclosing module.
  await companionPage.addInitScript({content:String.raw`(() => {
    const events = []; window.__voiceLifecycle = events;
    const audio = []; window.__voiceAudio = audio;
    const sources = new WeakMap();
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const entry = {message:document.querySelector('[data-voice-status]')?.textContent,
        duration:this.buffer?.duration ?? 0,started:performance.now(),ended:false,stopped:false};
      sources.set(this,entry);
      if (audio.length < 100) audio.push(entry);
      this.addEventListener('ended', () => { entry.ended = true; }, {once:true});
      return start.apply(this,args);
    };
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (...args) {
      const entry = sources.get(this); if (entry) entry.stopped = true;
      return stop.apply(this,args);
    };
    let previous = '';
    document.addEventListener('DOMContentLoaded', () => {
      const observe = () => {
        const event = { state:document.querySelector('.voice-panel')?.getAttribute('data-voice-state'),
          label:document.querySelector('[data-voice-label]')?.textContent,
          message:document.querySelector('[data-voice-status]')?.textContent };
        const key = JSON.stringify(event);
        if (key !== previous && events.length < 100) { previous = key; events.push({...event, at:performance.now()}); }
      };
      new MutationObserver(observe).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
      observe();
    });
  })();`});
  companionPage.on('pageerror', (error:any) => report.pageErrors.push(`companion: ${error.message}`));
  companionPage.on('console', (message:any) => { if (message.type() === 'error') report.console.push(`companion: ${message.text()}`); });
  companionPage.on('request', (request:any) => {
    if (new URL(request.url()).pathname !== '/tool' || request.method() !== 'POST') return;
    const payload = request.postDataJSON();
    // Retain call names and the synthetic acknowledgement text only. Request
    // bodies also contain credentials and audio, which must never be saved.
    if (typeof payload?.name === 'string') report.companionToolCalls.push(payload.name);
    if (payload?.name === 'voice_acknowledgement') report.voiceRequests.push({name:payload.name,message:payload.args?.message});
  });
  companionPage.on('response', async (response:any) => {
    const request = response.request();
    if (new URL(request.url()).pathname !== '/tool' || request.method() !== 'POST') return;
    const payload = request.postDataJSON(), name = payload?.name;
    if (!['voice_command','voice_acknowledgement','navigate_experience','acknowledge_experience_step'].includes(name)) return;
    try {
      const result = await response.json();
      report.voiceResponses.push({name,status:response.status(),isError:result.isError===true,
        command:result.structuredContent?.command,hasIntent:typeof result.structuredContent?.intentId==='string',
        ...(name==='voice_acknowledgement'?{message:payload.args?.message}:{}),
        ...(name==='acknowledge_experience_step'?{sourceToken:payload.args?.sourceToken,
          panelId:payload.args?.panelId,experienceId:payload.args?.experienceId,
          experienceRevision:payload.args?.experienceRevision,stepIndex:payload.args?.stepIndex,
          acknowledged:result.structuredContent?.experienceAcknowledged===true}:{}),
        hasAudio:typeof result.structuredContent?.wavBase64==='string'});
    } catch { report.voiceResponses.push({name,status:response.status(),unreadable:true}); }
  });
  await companionPage.goto(companionUrl);
  await companionPage.waitForFunction(() => document.body.dataset.ready === 'true', null, {timeout:120_000});
  await companionPage.locator('.stage canvas').waitFor({state:'visible', timeout:120_000});
  await waitState(sessionId!, (value:any) => value.panels.some((panel:any) => panel.surface === 'companion' && panel.current && panel.availability === 'ready'));
  const callsBeforeCancel = report.companionToolCalls.filter((name:string) => name.endsWith('voice_command')).length;
  await companionPage.locator('[data-voice-orb]').click();
  await companionPage.getByText('Finish', {exact:true}).waitFor({timeout:120_000});
  await companionPage.locator('[data-voice-cancel]').click();
  await companionPage.locator('[data-voice-label]').getByText('Talk', {exact:true}).waitFor({timeout:120_000});
  await delay(500);
  assert.equal(report.companionToolCalls.filter((name:string) => name.endsWith('voice_command')).length, callsBeforeCancel,
    'Cancelling microphone capture must not submit audio for transcription.');
  recordCase('Cancelling simulated microphone capture returned to Talk without submitting a voice command');
  const companionBeforeVoice = await state(sessionId!);
  const callsBeforeRecording = report.companionToolCalls.filter((name:string) => name.endsWith('voice_command')).length;
  await companionPage.locator('[data-voice-orb]').click();
  await companionPage.getByText('Finish', {exact:true}).waitFor({timeout:120_000});
  // The production recorder discards captures shorter than 180 ms. A second
  // click immediately after Finish depended on rendering slowness to record
  // enough samples and could silently skip transcription on a faster run.
  await delay(600);
  await companionPage.locator('[data-voice-orb]').click();
  const submitDeadline = Date.now() + 15_000;
  while (Date.now() < submitDeadline
    && report.companionToolCalls.filter((name:string) => name.endsWith('voice_command')).length === callsBeforeRecording) await delay(100);
  assert.equal(report.companionToolCalls.filter((name:string) => name.endsWith('voice_command')).length, callsBeforeRecording + 1,
    `One recorded request must reach transcription: ${await companionPage.locator('[data-voice-status]').innerText()}`);
  // VOICE_TEST_FAST=1 selects the deterministic source-transition acceptance.
  if (process.env.VOICE_TEST_FAST === '1') {
    const moved = await waitState(sessionId!, value => value.sourceToken !== companionBeforeVoice.sourceToken
      && value.hasScene && value.panels.some((panel:any) => panel.surface==='companion' && panel.current && panel.availability==='ready'));
    await companionPage.waitForFunction(() => document.body.dataset.ready === 'true', null, {timeout:120_000});
    // The completed-action caption can be replaced immediately by deferred
    // chapter narration. Observe actual playback to completion, including that
    // it was not stopped, instead of racing a transient 100 ms fixture caption.
    const acknowledgement = 'The requested assembly stage is ready.';
    await companionPage.waitForFunction((message:string) => (window as any).__voiceAudio?.some((entry:any) =>
      entry.message===message && entry.duration>0 && entry.ended && !entry.stopped), acknowledgement, {timeout:30_000});
    await companionPage.locator('[data-voice-label]').getByText('Talk', {exact:true}).waitFor({timeout:120_000});
    assert.equal(await companionPage.locator('.voice-panel').getAttribute('data-voice-state'), 'idle');
    assert.ok(report.voiceResponses.some((entry:any) => entry.name==='voice_command' && entry.status===200
      && !entry.isError && entry.command==='show-tubulin' && !entry.hasIntent), 'The typed command must be recognized successfully.');
    assert.equal(report.companionToolCalls.filter((name:string) => name==='navigate_experience').length, 1,
      'Showing the initial assembly stage must navigate only once.');
    assert.ok(report.voiceResponses.some((entry:any) => entry.name==='voice_acknowledgement' && entry.status===200
      && !entry.isError && entry.message===acknowledgement && entry.hasAudio), 'The action confirmation must receive fixture audio.');
    const finalState = await waitState(sessionId!, value => value.hasScene && value.experience?.applied
      && ['desktop','companion'].every(surface => value.panels.some((panel:any) => panel.surface===surface && panel.current && panel.availability==='ready')));
    assert.equal(finalState.experience.id, 'tubulin-eb3-lattice');
    assert.equal(finalState.experience.stageId, 'tubulin-dimer');
    assert.equal(finalState.experience.stepIndex, 0);
    const finalPanel = await companionPage.locator('body').getAttribute('data-panel-id');
    assert.ok(report.voiceResponses.some((entry:any) => entry.name==='acknowledge_experience_step' && entry.status===200
      && !entry.isError && entry.acknowledged && entry.sourceToken===finalState.sourceToken && entry.panelId===finalPanel
      && entry.experienceId===finalState.experience.id && entry.experienceRevision===finalState.experience.revision && entry.stepIndex===0),
      'The intended companion must confirm the exact final rendered experience.');
    assert.doesNotMatch(await frame.locator('[data-session-outcome]').innerText(), /Voice handoff could not be confirmed/,
      'An ordinary source change must not leave a false desktop handoff failure.');
    report.fastRenderedExperience = finalState.experience;
    report.fastSourceChanged = moved.sourceToken !== companionBeforeVoice.sourceToken;
    recordCase('Fast show-tubulin recognition changed the real companion source once and completed its WebAudio acknowledgement');
    await capture('passed'); report.status = 'passed';
  } else {
  const until = Date.now() + 120_000;
  while (Date.now() < until && (await page.evaluate(() => (window as any).__host.events.length)) === 0) await delay(150);
  const messages = await page.evaluate(() => (window as any).__host.events);
  assert.equal(messages.length, 1, 'One unknown spoken request must reach the host.');
  assert.match(messages[0].content?.[0]?.text ?? '', /microtubule lattice/);
  assert.equal(report.toolCalls.filter((name:string) => name.endsWith('.claim_voice_intent')).length >= 1, true);
  report.messages = [{ delivered: true, transcriptMatched: true }];
  recordCase('Companion microphone sent one unknown request and the desktop AppBridge host received it once');
  const companionPanel = await companionPage.locator('body').getAttribute('data-panel-id');
  assert.ok(companionPanel, 'The real companion must have a panel before a reply is queued.');
  await delay(1_100); // Production per-panel rate limit protects the OAuth subprocess.
  const beforeReply = await state(sessionId!);
  const reply:any = await call('speak_to_headset', {...binding(beforeReply, sessionId!), panelId:companionPanel, message:'The lattice is ready.'});
  assert.equal(reply.structuredContent.queued, true);
  const acknowledged = await waitState(sessionId!, value => value.voice?.lastPlaybackAcknowledgement?.panelId === companionPanel
    && value.voice.lastPlaybackAcknowledgement.id === reply.structuredContent.playbackId);
  assert.equal(acknowledged.voice.pendingPlayback, 0);
  recordCase('The desktop queued a bounded simulated narration and the real companion played it before acknowledging receipt');
  await capture('passed');
  report.status = 'passed';
  }
  assert.deepEqual(report.pageErrors, [], 'Browser voice flow must not produce uncaught page errors.');
  assert.deepEqual(report.console, [], 'Browser voice flow must not produce console errors.');
} catch (error) {
  report.status = 'failed';
  await capture('failure');
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, 'voice-browser-report.json'), JSON.stringify(report, null, 2));
  await companionPage?.close().catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  await new Promise<void>(done => host.close(() => done()));
}
