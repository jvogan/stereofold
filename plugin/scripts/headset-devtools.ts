#!/usr/bin/env -S node --enable-source-maps
/**
 * Eyes and a debugger inside the headset's browser, from the Mac.
 *
 *   pnpm exec tsx scripts/headset-devtools.ts targets
 *   pnpm exec tsx scripts/headset-devtools.ts state [--json]
 *   pnpm exec tsx scripts/headset-devtools.ts console [--follow] [--seconds 20]
 *   pnpm exec tsx scripts/headset-devtools.ts eval 'document.visibilityState'
 *   pnpm exec tsx scripts/headset-devtools.ts frame out.png [--seconds 3]
 *   node_modules/.bin/tsx scripts/headset-devtools.ts profile rest.cpuprofile --target ID
 *
 * `profile` temporarily enables CPU sampling; other commands except `eval`
 * only read, and `eval` is whatever the caller types. The owner is usually
 * wearing the headset when an agent runs this, so
 * no subcommand navigates, clicks, reloads, or calls a page hook that writes.
 *
 * The tunnel is set up on demand: `adb forward tcp:<port>
 * localabstract:chrome_devtools_remote`, which is idempotent and costs the
 * wearer nothing. `--no-forward` skips it for a host that cannot run adb but
 * can reach a port somebody else forwarded.
 *
 * Environment: `STEREOFOLD_ADB_BIN` / `ANDROID_SERIAL` are the same keys the
 * device capture reads, and `STEREOFOLD_DEVTOOLS_PORT` moves the loopback port.
 */

import { writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';

import {
  CdpSession, DEVTOOLS_TIMEOUT_MS, PAGE_STATE_EXPRESSION, devtoolsPort, evaluateParameters,
  forwardArguments, formatConsoleEvent, formatConsoleLine, formatTarget, handshakeRequest,
  parseTargets, pickStereofoldTarget, readEvaluateResult, readHandshakeResponse, readScreencastFrame,
  redactDevtoolsText, screencastParameters, summarizeScreencast,
  explainSilentTarget, isSilentTargetError,
  type CdpEvent, type ConsoleLine,
} from '../src/headset-devtools.js';
import { findAdb, parseAdbDevices, pickAdbSerial } from '../src/headset-view-device.js';
import { captureCpuProfile } from '../src/headset-cpu-profile.js';

const ADB_TIMEOUT_MS = 6_000;
/** A live tab answers `Runtime.enable` in about 1 ms over USB adb. */
const LIVENESS_PROBE_MS = 1_500;

function fail(message: string): never {
  process.stderr.write(`${redactDevtoolsText(message)}\n`);
  process.exit(1);
}

const runAdb = (adb: string, args: readonly string[]) => new Promise<string>((resolve, reject) => {
  execFile(adb, [...args], { timeout: ADB_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) reject(Error(error.message.replace(/\s+/gu, ' ').slice(0, 200)));
    else resolve(String(stdout));
  });
});

/**
 * Open the tunnel, or say why not.
 *
 * A failure here is advice rather than a stack trace: Developer Mode off, the
 * cable out, and the headset asleep all reach this line, and all three are
 * ordinary states a reader fixes in ten seconds once somebody names them.
 */
async function ensureForward(port: number): Promise<string> {
  const adb = await findAdb();
  if (!adb) return 'no adb on this host, so the port was not forwarded';
  let serials: string[];
  try { serials = parseAdbDevices(await runAdb(adb, ['devices'])); }
  catch (error) { return `adb devices failed: ${error instanceof Error ? error.message : String(error)}`; }
  const chosen = pickAdbSerial(serials, process.env);
  if (!chosen.serial) {
    return serials.length === 0
      ? 'adb reports no authorized headset; enable Developer Mode and accept the USB trust prompt'
      : `the named serial ${chosen.named} is not ready (attached: ${serials.join(', ')})`;
  }
  try { await runAdb(adb, forwardArguments(chosen.serial, port)); }
  catch (error) { return `adb forward failed: ${error instanceof Error ? error.message : String(error)}`; }
  return `forwarded tcp:${port} to ${chosen.serial}`;
}

function fetchJson(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get({ host: '127.0.0.1', port, path, timeout: DEVTOOLS_TIMEOUT_MS }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    request.on('timeout', () => { request.destroy(Error(`127.0.0.1:${port} did not answer.`)); });
    request.on('error', reject);
  });
}

/** Connect a websocket to one debugger URL and hand back a driven session. */
function openSession(port: number, socketUrl: string): Promise<CdpSession> {
  const path = new URL(socketUrl).pathname;
  const key = randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(handshakeRequest({ path, host: `127.0.0.1:${port}`, key }));
    });
    socket.setTimeout(DEVTOOLS_TIMEOUT_MS, () => { socket.destroy(Error('The debugger handshake timed out.')); });
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const outcome = readHandshakeResponse(buffer, key);
      if (!outcome) return;
      socket.removeListener('data', onData);
      socket.setTimeout(0);
      if (!outcome.ok) { socket.destroy(); reject(Error(outcome.reason)); return; }
      const session = new CdpSession(socket);
      session.prime(outcome.rest);
      resolve(session);
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

type Bridge = { session: CdpSession; target: { id: string; url: string; title: string }; forward: string };

async function attach(port: number, { forward, wanted }: { forward: boolean; wanted?: string }): Promise<Bridge> {
  const note = forward ? await ensureForward(port) : 'port forwarding skipped (--no-forward)';
  let body: string;
  try { body = await fetchJson(port, '/json'); }
  catch (error) {
    fail(`No debugger on 127.0.0.1:${port} (${error instanceof Error ? error.message : String(error)}). ${note}. `
      + 'Quest Browser must be open, Developer Mode on, and adb authorized.');
  }
  const targets = parseTargets(body);
  const target = pickStereofoldTarget(targets, wanted);
  if (!target) fail(`The debugger lists no usable page on 127.0.0.1:${port}. ${note}.`);
  return { session: await openSession(port, target.webSocketDebuggerUrl), target, forward: note };
}

// ------------------------------------------------------------- subcommands

async function commandTargets(port: number, forward: boolean) {
  const note = forward ? await ensureForward(port) : 'port forwarding skipped (--no-forward)';
  let version = '';
  try { version = JSON.parse(await fetchJson(port, '/json/version')).Browser ?? ''; } catch { /* Optional. */ }
  let body: string;
  try { body = await fetchJson(port, '/json'); }
  catch (error) { fail(`No debugger on 127.0.0.1:${port} (${error instanceof Error ? error.message : String(error)}). ${note}.`); }
  process.stdout.write(`${note}\n${version ? `browser: ${version}\n` : ''}`);
  const targets = parseTargets(body);
  const chosen = pickStereofoldTarget(targets);
  for (const target of targets) {
    process.stdout.write(`${target.id === chosen?.id ? '*' : ' '} ${formatTarget(target)}\n`);
  }
  if (targets.length === 0) process.stdout.write('(no targets)\n');
}

async function commandEval(bridge: Bridge, expression: string, asJson: boolean) {
  await bridge.session.send('Runtime.enable');
  const raw = await bridge.session.send('Runtime.evaluate', evaluateParameters(expression, { awaitPromise: true }));
  const outcome = readEvaluateResult(raw);
  if (!outcome.ok) fail(`The page threw: ${outcome.reason}`);
  const text = typeof outcome.value === 'string' && !asJson ? outcome.value : JSON.stringify(outcome.value, null, asJson ? 2 : 0);
  process.stdout.write(`${text}\n`);
}

async function commandState(bridge: Bridge, asJson: boolean) {
  await bridge.session.send('Runtime.enable');
  const raw = await bridge.session.send('Runtime.evaluate', evaluateParameters(PAGE_STATE_EXPRESSION));
  const outcome = readEvaluateResult(raw);
  if (!outcome.ok) fail(`The page threw while reporting its state: ${outcome.reason}`);
  if (asJson) { process.stdout.write(`${JSON.stringify(outcome.value, null, 2)}\n`); return; }
  const state = outcome.value as Record<string, any>;
  const rows: [string, unknown][] = [
    ['page', `${state.pathname} (${state.title})`],
    ['document', `${state.documentVisibility}${state.hidden ? ' hidden' : ''}`],
    ['webxr', state.hasWebXr ? 'available' : 'absent'],
    ['xr session', state.xr?.presenting ? `presenting ${state.xr.mode ?? '?'}` : 'not presenting'],
    ['passthrough', state.xr?.passthrough === null ? 'unknown' : state.xr?.passthrough ? 'on (immersive-ar)' : 'off'],
    ['xr visibility', state.xr?.visibility ?? 'unknown'],
    ['tour', state.tour ? JSON.stringify(state.tour.detail) : 'no tour event'],
    ['voice', state.voice ? `${state.voice.kind} ${JSON.stringify(state.voice.detail)}` : 'no voice event'],
    ['toolbar', state.toolbar ? JSON.stringify(state.toolbar.detail) : 'no toolbar event'],
    ['hooks', Object.entries(state.hooks ?? {}).filter(([, value]) => value).map(([name]) => name).join(', ') || 'none'],
    ['diagnostics', `${state.diagnosticCount} entries: ${(state.diagnosticKinds ?? []).join(', ') || 'none'}`],
    ['viewport', `${state.viewport} @${state.devicePixelRatio}x`],
  ];
  for (const [name, value] of rows) process.stdout.write(`${name.padEnd(14)}${String(value).slice(0, 400)}\n`);
  for (const error of state.errors ?? []) process.stdout.write(`page error    ${JSON.stringify(error).slice(0, 400)}\n`);
}

/**
 * Read the console.
 *
 * Without `--follow` this enables the two domains, waits a beat for the backlog
 * Chromium replays on enable, and exits; with it, it streams until the timer
 * runs out. A page that has been open for an hour has a bounded backlog, so
 * the one-shot form is the useful default for an agent that wants to know what
 * broke rather than to watch it break.
 */
async function commandConsole(bridge: Bridge, { follow, seconds, asJson }: { follow: boolean; seconds: number; asJson: boolean }) {
  const lines: ConsoleLine[] = [];
  const stop = bridge.session.on((event: CdpEvent) => {
    const line = formatConsoleEvent(event);
    if (!line) return;
    lines.push(line);
    if (!asJson) process.stdout.write(`${formatConsoleLine(line)}\n`);
  });
  await bridge.session.send('Runtime.enable');
  await bridge.session.send('Log.enable');
  const waitMs = follow ? seconds * 1000 : 1_200;
  await new Promise(resolve => { const timer = setTimeout(resolve, waitMs); (timer as { unref?: () => void }).unref?.(); });
  stop();
  if (asJson) process.stdout.write(`${JSON.stringify(lines, null, 2)}\n`);
  else if (lines.length === 0) process.stdout.write('(no console output in the replayed backlog)\n');
}

/**
 * One frame out of the browser's own compositor.
 *
 * This is not the wearer's view. `Page.startScreencast` captures the tab's 2D
 * layer, which during an immersive session is whatever the page left on the
 * canvas behind the headset's compositor, not the stereo pair the wearer is
 * looking at. `adb exec-out screencap`, which `capture_headset_view` wraps,
 * is the one that reads the composited panel including passthrough. This is
 * here because it is nearly free and it answers a
 * different question: is the 2D page alive, and what is on it.
 */
async function commandFrame(bridge: Bridge, out: string, seconds: number) {
  const started = Date.now();
  const samples: { at: number; bytes: number }[] = [];
  let latest: Buffer | undefined;
  const stop = bridge.session.on(event => {
    const frame = readScreencastFrame(event);
    if (!frame) return;
    samples.push({ at: Date.now(), bytes: frame.bytes.byteLength });
    latest = frame.bytes;
    void bridge.session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await bridge.session.send('Page.enable');
  await bridge.session.send('Page.startScreencast', screencastParameters());
  await new Promise(resolve => { const timer = setTimeout(resolve, Math.max(500, seconds * 1000)); (timer as { unref?: () => void }).unref?.(); });
  try { await bridge.session.send('Page.stopScreencast'); } catch { /* The tab may have gone. */ }
  stop();
  const stats = summarizeScreencast(samples, started);
  if (!latest) fail('The screencast produced no frames. The tab may be backgrounded, which stops its compositor.');
  // The stream is JPEG regardless of the requested extension; say so rather
  // than writing a .png that is not one.
  const path = out.replace(/\.png$/iu, '.jpg');
  await writeFile(path, latest);
  process.stdout.write(`file:   ${path}  ${latest.byteLength} bytes (jpeg, 2D layer only)\n`);
  process.stdout.write(`frames: ${stats.frames} in ${stats.spanMs} ms  ${stats.fps.toFixed(1)} fps  mean ${stats.meanBytes} bytes  first at ${stats.firstMs} ms\n`);
}

// -------------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
  const positional = argv.filter((item, index) => !item.startsWith('--') && !(index > 0 && ['target', 'seconds', 'port'].includes(argv[index - 1]?.replace(/^--/u, '') ?? '')));
  const command = positional[0] ?? 'state';
  const port = Number(value('port')) || devtoolsPort();
  const forward = !flag('no-forward');
  const asJson = flag('json');
  const seconds = Number(value('seconds')) || (command === 'frame' ? 3 : 20);

  if (command === 'targets') { await commandTargets(port, forward); return; }
  if (!['state', 'eval', 'console', 'frame', 'profile'].includes(command)) {
    fail(`Unknown command "${command}". Use targets, state, console, eval, frame or profile.`);
  }

  const bridge = await attach(port, { forward, ...(value('target') ? { wanted: value('target')! } : {}) });
  try {
    // A live tab answers this in single-digit milliseconds, so a second is
    // generous; a frozen one would otherwise burn the full timeout twice.
    try { await bridge.session.send('Runtime.enable', {}, LIVENESS_PROBE_MS); }
    catch (error) {
      if (isSilentTargetError(error)) fail(explainSilentTarget('Runtime.enable', bridge.target));
      throw error;
    }
    if (command === 'state') await commandState(bridge, asJson);
    else if (command === 'eval') {
      const expression = positional.slice(1).join(' ');
      if (!expression) fail('eval needs an expression, e.g. eval \'document.visibilityState\'.');
      await commandEval(bridge, expression, asJson);
    } else if (command === 'profile') {
      const startedAt = new Date().toISOString();
      const { profile, summary } = await captureCpuProfile(bridge.session);
      const out = positional[1] ?? 'headset-rest.cpuprofile';
      await writeFile(out, JSON.stringify(profile));
      process.stdout.write(`${JSON.stringify({ target: bridge.target.id, startedAt,
        endedAt: new Date().toISOString(), file: out, ...summary }, null, 2)}\n`);
    } else if (command === 'console') await commandConsole(bridge, { follow: flag('follow'), seconds, asJson });
    else await commandFrame(bridge, positional[1] ?? 'headset-frame.jpg', seconds);
  } finally {
    bridge.session.close();
  }
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
