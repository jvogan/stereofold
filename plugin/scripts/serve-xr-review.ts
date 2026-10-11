import { readInlineHtml } from '../src/inline-html.js';
/**
 * Local, fixture-only first-run review server for the emulated Quest path.
 *
 * The server deliberately has a small surface: it serves the already built
 * inspector and forwards only the source-scoped companion's /source and
 * /tool requests. It does not start a browser, expose an agent/eval route, or
 * turn the companion into a general proxy.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHeadsetBridgeWriter, type BridgeCaptureInput, type HeadsetBridgeWriter } from '../src/headset-bridge.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 7 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;
const LOCAL_HOSTNAME = '127.0.0.1';
const ALLOWED_COMPANION_PATHS = new Set(['/source', '/tool']);
/** Channel C. Only reachable when `--bridge` names a directory. */
const BRIDGE_PATH = '/bridge';
// Two base64 PNGs plus a small JSON state. A 2064x1024 both-eye capture encodes
// well under this; the cap only stops a runaway body from being buffered.
const MAX_BRIDGE_BODY_BYTES = 32 * 1024 * 1024;

export type ReviewVector3 = readonly [number, number, number];
export type ReviewQuaternion = readonly [number, number, number, number];

/** Quaternion for an IWER headset whose default forward vector is -Z. */
export function lookTowardMenuQuaternion(head: ReviewVector3, target: ReviewVector3): ReviewQuaternion {
  const dx = target[0] - head[0], dy = target[1] - head[1], dz = target[2] - head[2];
  const horizontal = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, -dz);
  const pitch = Math.atan2(dy, horizontal);
  const halfYaw = yaw / 2, halfPitch = pitch / 2;
  const sinYaw = -Math.sin(halfYaw), cosYaw = Math.cos(halfYaw);
  const sinPitch = Math.sin(halfPitch), cosPitch = Math.cos(halfPitch);
  return [cosYaw * sinPitch, sinYaw * cosPitch, -sinYaw * sinPitch, cosYaw * cosPitch];
}

export function forwardDotToTarget(head: ReviewVector3, target: ReviewVector3, quaternion: ReviewQuaternion): number {
  const dx = target[0] - head[0], dy = target[1] - head[1], dz = target[2] - head[2];
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 0) || !Number.isFinite(length)) return -1;
  const [x, y, z, w] = quaternion;
  const tx = 2 * (y * -1 - z * 0), ty = 2 * (z * 0 - x * -1), tz = 2 * (x * 0 - y * 0);
  const forward: ReviewVector3 = [-1 * 0 + w * tx + y * tz - z * ty, 0 + w * ty + z * tx - x * tz, -1 + w * tz + x * ty - y * tx];
  return (forward[0] * dx + forward[1] * dy + forward[2] * dz) / length;
}

export type XrReviewArguments = {
  runtimePath: string;
  companionFile: string;
  port: number;
  /** Absolute bridge directory. Absent means the server writes nothing to disk, as before. */
  bridgeDirectory?: string;
};

type CompanionTarget = {
  origin: string;
  path: string;
  token: string;
};

type ReviewServer = ReturnType<typeof createServer> & {
  reviewClose?: () => Promise<void>;
  reviewPort?: number;
};

function usage(): string {
  return [
    'Usage: pnpm exec tsx scripts/serve-xr-review.ts',
    '  --runtime /absolute/path/to/iwer.min.js',
    '  --companion-file /absolute/path/to/private-launch.json',
    '  [--port 0..65535]',
    '  [--bridge /absolute/path/to/bridge]',
  ].join('\n');
}

function argumentError(message: string): never {
  throw new Error(`${message}\n${usage()}`);
}

export function parseXrReviewArguments(argv: readonly string[]): XrReviewArguments {
  let runtimePath: string | undefined;
  let companionFile: string | undefined;
  let bridgeDirectory: string | undefined;
  let port = 0;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--runtime') {
      if (runtimePath !== undefined || !argv[index + 1]) argumentError('--runtime must be supplied once with a path.');
      runtimePath = argv[++index]!;
    } else if (argument === '--companion-file') {
      if (companionFile !== undefined || !argv[index + 1]) argumentError('--companion-file must be supplied once with a path.');
      companionFile = argv[++index]!;
    } else if (argument === '--bridge') {
      if (bridgeDirectory !== undefined || !argv[index + 1]) argumentError('--bridge must be supplied once with a path.');
      bridgeDirectory = argv[++index]!;
    } else if (argument === '--port') {
      if (index + 1 >= argv.length) argumentError('--port needs a number.');
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 65_535) argumentError('--port must be an integer from 0 through 65535.');
      port = value;
    } else if (argument === '--help' || argument === '-h') {
      throw new Error(usage());
    } else {
      argumentError(`Unknown option: ${argument}`);
    }
  }
  if (!runtimePath || !isAbsolute(runtimePath)) argumentError('--runtime must be an absolute path.');
  if (!companionFile || !isAbsolute(companionFile)) argumentError('--companion-file must be an absolute path.');
  if (bridgeDirectory !== undefined && !isAbsolute(bridgeDirectory)) argumentError('--bridge must be an absolute path.');
  return { runtimePath: resolve(runtimePath), companionFile: resolve(companionFile), port,
    ...(bridgeDirectory ? { bridgeDirectory: resolve(bridgeDirectory) } : {}) };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function equalToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readCompanionTarget(value: unknown): CompanionTarget {
  if (!isPlainRecord(value) || !isPlainRecord(value.companion) || typeof value.companion.url !== 'string') {
    throw new Error('The companion file must contain a companion.url string.');
  }
  let url: URL;
  try { url = new URL(value.companion.url); } catch { throw new Error('The companion URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search
    || url.pathname !== '/' || !/^127\.0\.0\.1$/.test(url.hostname)) {
    throw new Error('The companion URL must be a loopback HTTP(S) root URL.');
  }
  const token = url.hash.slice(1);
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error('The companion URL must carry a 64-hex capability fragment.');
  return { origin: url.origin, path: url.pathname, token: token.toLowerCase() };
}

export function localOrigin(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('The local review server has no bound port.');
  return `http://${LOCAL_HOSTNAME}:${port}`;
}

export function allowedReviewPath(method: string | undefined, requestUrl: string | undefined): boolean {
  if (typeof method !== 'string' || typeof requestUrl !== 'string') return false;
  if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) return false;
  let parsed: URL;
  try { parsed = new URL(requestUrl, 'http://review.invalid'); } catch { return false; }
  if (parsed.search || parsed.hash) return false;
  if (parsed.pathname === '/') return method === 'GET';
  if (parsed.pathname === '/iwer.js' || parsed.pathname === '/setup.js') return method === 'GET';
  if (parsed.pathname === BRIDGE_PATH) return method === 'POST';
  return ALLOWED_COMPANION_PATHS.has(parsed.pathname) && ((parsed.pathname === '/source' && method === 'GET')
    || (parsed.pathname === '/tool' && method === 'POST'));
}

export function sameLocalRequest(request: Pick<IncomingMessage, 'headers'>, origin: string): boolean {
  const host = new URL(origin).host;
  if (request.headers.host !== host) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const requestOrigin = request.headers.origin;
  return requestOrigin === undefined || requestOrigin === origin;
}

function responseHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

function send(response: ServerResponse, status: number, body: string | Buffer, contentType = 'text/plain; charset=utf-8') {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, responseHeaders(contentType));
  response.end(body);
}

async function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('body_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error('body_too_large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function abortAfter(milliseconds: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(milliseconds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref?.();
  return controller.signal;
}

function headerValue(response: Response, name: string, fallback: string): string {
  const value = response.headers.get(name);
  return value && value.length < 256 ? value : fallback;
}

type ToolbarTargetSet = {
  name: string;
  labels: string[];
  points: Array<[number, number, number]>;
  active?: boolean;
  multiPage?: boolean;
  canBack?: boolean;
  canNext?: boolean;
};

function buildSetupScript(toolbarTargets: ToolbarTargetSet[], adapterSource: string): string {
  // This code is intentionally fixture-only. It is served from /setup.js and
  // never enters the packaged inspector or production runtime.
  return `(() => {
  'use strict';
  const TARGETS = ${JSON.stringify(toolbarTargets)};
  const lookTowardMenuQuaternion = ${String(lookTowardMenuQuaternion)};
  const installReferenceSpaceAdapter = ${adapterSource};
  const state = {
    status: 'waiting for immersive-vr', frameCallbacks: 0, twoEyeFrames: 0,
    leftViewport: false, rightViewport: false, referenceChecks: 0,
    referenceError: '', lastEyes: 0, lastPosition: null, lastInput: 'none',
    inputEvents: 0, ended: false, sessions: 0, device: null, active: null,
  };
  const update = () => {
    const node = document.querySelector('[data-emulated-quest-status]');
    if (!node) return;
    const active = state.active;
    const position = state.lastPosition;
    const pose = position ? 'head ' + position.map(value => Number(value).toFixed(2)).join(', ') : 'head not sampled';
    const eyes = active ? state.lastEyes + ' views' : 'waiting';
    node.textContent = [
      'XR ' + (active && !state.ended ? 'ACTIVE' : 'IDLE') + ' · ' + eyes,
      'two-eye viewport frames: ' + state.twoEyeFrames + ' · callbacks: ' + state.frameCallbacks,
      'left/right viewport: ' + (state.leftViewport ? 'yes' : 'pending') + '/' + (state.rightViewport ? 'yes' : 'pending'),
      'reference-space checks: ' + state.referenceChecks + (state.referenceError ? ' · ' + state.referenceError : ''),
      pose,
      'last input: ' + state.lastInput + ' · events: ' + state.inputEvents,
    ].join('\\n');
  };
  const setStatus = (message) => {
    state.status = message;
    const node = document.querySelector('[data-emulated-quest-message]');
    if (node) node.textContent = message;
    update();
  };
  const frameWait = (session, count = 1) => new Promise((resolve, reject) => {
    let left = count;
    const timer = setTimeout(() => reject(new Error('Timed out waiting for an emulated XR frame.')), 10_000);
    const next = () => {
      if (!left--) { clearTimeout(timer); resolve(); return; }
      try { session.requestAnimationFrame(() => next()); } catch (error) { clearTimeout(timer); reject(error); }
    };
    next();
  });
  const installPanel = () => {
    if (document.querySelector('[data-emulated-quest-review]')) return;
    const panel = document.createElement('section');
    panel.dataset.emulatedQuestReview = 'true';
    panel.setAttribute('aria-label', 'Emulated Quest local review controls');
    panel.innerHTML = '<strong>EMULATED QUEST · LOCAL REVIEW</strong>'
      + '<small data-emulated-quest-message>Waiting for Enter VR. Controls affect the fixture runtime only.</small>'
      + '<pre data-emulated-quest-status>XR IDLE</pre>'
      + '<div class="emulated-quest-buttons">'
      + '<button type="button" data-emulated-action="lean-left">Lean left</button>'
      + '<button type="button" data-emulated-action="lean-right">Lean right</button>'
      + '<button type="button" data-emulated-action="walk-around">Walk around</button>'
      + '<button type="button" data-emulated-action="walk-back">Walk back</button>'
      + '<button type="button" data-emulated-action="walk-start">Walk to start</button>'
      + '<button type="button" data-emulated-action="look-menu">Look toward menu</button>'
      + '</div>'
      + '<div class="emulated-quest-trigger"><label>Toolbar target <select data-emulated-target></select></label>'
      + '<button type="button" data-emulated-action="trigger">Trigger selected control</button></div>'
      + '<small>Move the emulated head, then inspect stereo parallax and the world-anchored menu. The trigger uses a real IWER controller press.</small>';
    const style = document.createElement('style');
    style.textContent = '[data-emulated-quest-review]{position:fixed;z-index:10000;top:10px;left:10px;width:min(330px,calc(100vw - 20px));padding:10px;border:2px solid #ffca3a;border-radius:8px;background:#14100aee;color:#fff7da;font:12px/1.35 system-ui,sans-serif;box-shadow:0 4px 20px #0008}[data-emulated-quest-review] strong{display:block;color:#ffca3a;letter-spacing:.04em}[data-emulated-quest-review] small{display:block;margin-top:5px;color:#f7e7b4}[data-emulated-quest-review] pre{margin:7px 0;white-space:pre-wrap;font:11px/1.35 ui-monospace,monospace;color:#d8fff2}[data-emulated-quest-review] button,[data-emulated-quest-review] select{margin:4px 4px 0 0;padding:5px 7px;border:1px solid #a88d47;border-radius:4px;background:#2a2111;color:#fff7da;font:inherit}[data-emulated-quest-review] button:disabled{opacity:.45}[data-emulated-quest-review] label{display:inline-block;margin-top:4px}.emulated-quest-trigger{margin-top:4px}';
    document.head.append(style);
    document.body.append(panel);
    const select = panel.querySelector('[data-emulated-target]');
    TARGETS.forEach((target, targetIndex) => target.labels.forEach((label, index) => {
      const option = document.createElement('option'); option.value = targetIndex + ':' + index; option.textContent = target.name + ' · ' + label; select.append(option);
    }));
    const initialMenu = TARGETS[0]?.labels.lastIndexOf('Menu here');
    if (initialMenu !== undefined && initialMenu >= 0) select.value = '0:' + initialMenu;
    panel.addEventListener('click', event => {
      const button = event.target.closest('[data-emulated-action]');
      if (!button) return;
      void runAction(button.dataset.emulatedAction, select.value).catch(error => setStatus(error instanceof Error ? error.message : String(error)));
    });
    update();
  };
  const activeSession = () => {
    if (!state.active || state.ended || !state.device) throw new Error('Enter VR before using emulated head controls.');
    return state.active;
  };
  const sampleHead = () => {
    const device = state.device;
    if (!device) return;
    const p = device.position;
    state.lastPosition = [p.x, p.y, p.z];
  };
  const setHead = (x, y, z, yaw = 0) => {
    const device = state.device;
    if (!device) throw new Error('IWER device is not installed.');
    device.position.set(x, y, z);
    if (typeof yaw === 'number') device.quaternion.set(0, 0, 0, 1);
    else device.quaternion.set(yaw[0], yaw[1], yaw[2], yaw[3]);
    sampleHead();
  };
  const observe = async (session, device, referenceAdapter) => {
    const record = { session, ended: false, space: null, adapter: referenceAdapter, checked: false };
    state.active = record; state.ended = false; state.sessions++;
    setStatus('XR session started; waiting for a valid two-eye frame.');
    for (const type of ['selectstart', 'select', 'selectend']) session.addEventListener(type, event => {
      state.lastInput = type + (event.inputSource?.handedness ? ' · ' + event.inputSource.handedness : '');
      state.inputEvents++; update();
    });
    session.addEventListener('end', () => {
      record.ended = true; state.ended = true;
      if (state.active === record) state.active = null;
      setStatus('XR session ended; enter VR again to repeat it.');
    }, { once: true });
    try { record.space = await session.requestReferenceSpace('local'); }
    catch (error) { state.referenceError = error instanceof Error ? error.message : String(error); update(); return; }
    const inspect = (time, frame) => {
      if (record.ended) return;
      state.frameCallbacks++;
      try {
        const pose = frame.getViewerPose(record.space);
        const views = pose?.views || [];
        state.lastEyes = views.length;
        if (pose && views.length === 2) {
          state.twoEyeFrames++;
          if (state.twoEyeFrames === 1) setStatus('Two-eye XR frame active; inspect stereo parallax and world anchoring.');
          for (const view of views) {
            const viewport = session.renderState.baseLayer?.getViewport(view);
            if (view.eye === 'left' && viewport?.width > 0 && viewport?.height > 0) state.leftViewport = true;
            if (view.eye === 'right' && viewport?.width > 0 && viewport?.height > 0) state.rightViewport = true;
          }
          if (!record.checked) {
            record.checked = true;
            try { record.adapter.check(frame, record.space); state.referenceChecks++; }
            catch (error) { state.referenceError = error instanceof Error ? error.message : String(error); }
          }
          state.lastPosition = [pose.transform.position.x, pose.transform.position.y, pose.transform.position.z];
        }
      } catch (error) { state.referenceError = error instanceof Error ? error.message : String(error); }
      update();
      if (!record.ended) session.requestAnimationFrame(inspect);
    };
    session.requestAnimationFrame(inspect);
  };
  const triggerController = async (record, targetIndex, index) => {
    const target = TARGETS[targetIndex];
    const point = target?.points[index];
    if (!point) throw new Error('The selected toolbar target is unavailable.');
    const controller = state.device.controllers.right;
    if (!controller) throw new Error('IWER did not provide a right controller.');
    controller.connected = true;
    controller.position.set(point[0], point[1], -0.3);
    controller.quaternion.set(0, 0, 0, 1);
    await frameWait(record.session, 3);
    controller.updateButtonValue('trigger', 1);
    await frameWait(record.session, 3);
    controller.updateButtonValue('trigger', 0);
    await frameWait(record.session, 4);
    state.lastInput = 'triggered ' + target.labels[index] + ' · ' + target.name + ' (row ' + (index + 1) + ')';
    update();
  };
  const selectedToolbarTarget = (selectedIndex) => {
    const [selectedTargetText, selectedRowText] = String(selectedIndex).split(':');
    let targetIndex = Number(selectedTargetText), rowIndex = Number(selectedRowText);
    const selectedTarget = TARGETS[targetIndex];
    const selectedLabel = selectedTarget?.labels[rowIndex];
    const tourRoot = document.querySelector('.tour-player');
    if (tourRoot?.dataset.active === 'true') {
      const page = tourRoot.dataset.tourReadoutPage?.split('/').map(Number);
      const captionPages = page?.[1];
      const nextButton = document.querySelector('[data-tour-next]');
      const backButton = document.querySelector('[data-tour-back]');
      const canNext = nextButton instanceof HTMLButtonElement ? !nextButton.disabled : undefined;
      const canBack = backButton instanceof HTMLButtonElement ? !backButton.disabled : undefined;
      if (!(Number.isInteger(captionPages) && captionPages >= 1) || canNext === undefined || canBack === undefined) {
        throw new Error('Could not infer the current active-tour toolbar rows; trigger was not sent.');
      }
      const activeTarget = TARGETS.find(candidate => candidate.active
        && candidate.multiPage === (captionPages > 1)
        && candidate.canBack === canBack && candidate.canNext === canNext);
      if (!activeTarget) throw new Error('No fixture target matches the current active-tour row layout; trigger was not sent.');
      targetIndex = TARGETS.indexOf(activeTarget);
      let matchingRow = selectedLabel ? activeTarget.labels.indexOf(selectedLabel) : -1;
      if (matchingRow < 0 && selectedLabel?.startsWith('More text ')) {
        matchingRow = activeTarget.labels.findIndex(label => label.startsWith('More text '));
      }
      // Starting a tour changes the first row label to Play tour while
      // preserving its physical action. Every other missing row is stale
      // selection state and must fail instead of hitting a neighboring row.
      if (matchingRow < 0 && selectedLabel === 'Start tour' && activeTarget.labels[0] === 'Play tour') matchingRow = 0;
      if (matchingRow < 0) throw new Error('The selected toolbar control is not present in the current active-tour row layout; trigger was not sent.');
      rowIndex = matchingRow;
    }
    const target = TARGETS[targetIndex];
    if (!target || !Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= target.points.length) {
      throw new Error('Choose a toolbar target matching the current tour caption page.');
    }
    return { targetIndex, rowIndex, target };
  };
  const runAction = async (action, selectedIndex) => {
    const record = activeSession();
    if (action === 'lean-left' || action === 'lean-right') {
      const p = state.device.position; setHead(p.x + (action === 'lean-left' ? -0.25 : 0.25), p.y, p.z, 0);
      setStatus('Head moved; inspect the world-anchored menu and stereo parallax.');
    } else if (action === 'walk-back') {
      const p = state.device.position; setHead(p.x, p.y, p.z + 0.5, 0);
      setStatus('Head walked back 0.5 m; the menu should remain world anchored.');
    } else if (action === 'walk-around') {
      const p = state.device.position; setHead(p.x + 0.75, p.y, p.z - 0.3, 0);
      setStatus('Head walked around the initial view; inspect world anchoring.');
    } else if (action === 'walk-start') {
      setHead(0, 1.6, 0, 0); setStatus('Head returned to the emulated start position.');
    } else if (action === 'look-menu') {
      const p = state.device.position, menu = TARGETS[0]?.points.at(-1);
      if (!menu) throw new Error('The initial menu target is unavailable.');
      setHead(p.x, p.y, p.z, lookTowardMenuQuaternion([p.x, p.y, p.z], menu));
      setStatus('Head yaw points toward the initial menu anchor.');
    } else if (action === 'trigger') {
      const { targetIndex, rowIndex, target } = selectedToolbarTarget(selectedIndex);
      await triggerController(record, targetIndex, rowIndex);
      setStatus('Real IWER controller press sent to ' + target.labels[rowIndex] + ' · ' + target.name + '.');
    }
    sampleHead(); update();
  };
  try {
    if (!globalThis.IWER?.XRDevice || !globalThis.IWER?.metaQuest2) throw new Error('The supplied runtime is not an IWER build with Meta Quest 2 support.');
    const runtime = globalThis.IWER;
    const device = new runtime.XRDevice(runtime.metaQuest2);
    device.installRuntime({ forceInstall: true });
    device.stereoEnabled = true;
    device.primaryInputMode = 'controller';
    state.device = device;
    const referenceAdapter = installReferenceSpaceAdapter(runtime);
    const system = navigator.xr;
    if (!system || typeof system.requestSession !== 'function') throw new Error('IWER did not install navigator.xr.');
    const requestSession = system.requestSession.bind(system);
    system.requestSession = async (mode, options) => {
      const session = await requestSession(mode, options);
      if (mode === 'immersive-vr' || mode === 'immersive-ar') void observe(session, device, referenceAdapter);
      return session;
    };
    globalThis.__emulatedQuestReview = Object.freeze({ state, device, targets: TARGETS });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installPanel, { once: true }); else installPanel();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    document.addEventListener('DOMContentLoaded', () => { installPanel(); setStatus('Fixture setup failed: ' + message); }, { once: true });
  }
})();`;
}

function injectReviewScripts(html: string, localToken: string): string {
  const index = html.search(/<script\b/i);
  if (index < 0) throw new Error('Packaged inspector HTML has no script boundary.');
  const preamble = `<script>location.hash=${JSON.stringify(`#${localToken}`)};window.__STEREOFOLD_COMPANION__=true;</script><script src="/iwer.js"></script><script src="/setup.js"></script>`;
  return `${html.slice(0, index)}${preamble}${html.slice(index)}`;
}

function requireLocalAuth(request: IncomingMessage, localToken: string): boolean {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '');
  return Boolean(match && equalToken(match[1], localToken));
}

async function fetchCompanion(target: CompanionTarget, pathname: string, method: 'GET' | 'POST', body?: Buffer): Promise<Response> {
  const url = `${target.origin}${pathname}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${target.token}`, Origin: target.origin };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  return fetch(url, { method, headers, body: body && new Uint8Array(body), redirect: 'error', signal: abortAfter(UPSTREAM_TIMEOUT_MS) });
}

async function serveCompanion(request: IncomingMessage, response: ServerResponse, target: CompanionTarget, pathname: string) {
  if (pathname === '/source') {
    const upstream = await fetchCompanion(target, pathname, 'GET');
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('upstream_source_too_large');
    send(response, upstream.status, bytes, headerValue(upstream, 'content-type', 'application/octet-stream'));
    return;
  }
  const body = await readBody(request);
  if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) throw new Error('invalid_request_headers');
  const upstream = await fetchCompanion(target, pathname, 'POST', body);
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error('upstream_response_too_large');
  send(response, upstream.status, bytes, headerValue(upstream, 'content-type', 'application/json; charset=utf-8'));
}

/**
 * Channel C: accept one already-rendered frame and publish it to the bridge.
 *
 * The route carries no capability of its own — it is behind the same in-memory
 * `localToken` and same-origin check as `/tool` — and the writer strips and
 * revalidates everything before anything reaches disk. Validation failures
 * answer 400 rather than the 502 the companion proxy uses, so a caller can
 * tell a bad payload from an unreachable companion.
 */
async function serveBridge(request: IncomingMessage, response: ServerResponse, bridge: HeadsetBridgeWriter | null) {
  if (!bridge) { send(response, 404, 'bridge_disabled'); return; }
  const body = await readBody(request, MAX_BRIDGE_BODY_BYTES);
  if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) throw new Error('invalid_request_headers');
  let payload: unknown;
  try { payload = JSON.parse(body.toString('utf8')); } catch { send(response, 400, 'invalid_bridge_payload'); return; }
  if (!isPlainRecord(payload) || !isPlainRecord(payload.capture)
    || typeof payload.pngBase64 !== 'string' || typeof payload.leftPngBase64 !== 'string') {
    send(response, 400, 'invalid_bridge_payload'); return;
  }
  const frame = payload.capture as Record<string, unknown>;
  const capture: BridgeCaptureInput = {
    at: typeof frame.at === 'string' ? frame.at : new Date().toISOString(),
    width: Number(frame.width), height: Number(frame.height),
    views: frame.views as BridgeCaptureInput['views'],
    paired: Buffer.from(payload.pngBase64, 'base64'),
    left: Buffer.from(payload.leftPngBase64, 'base64'),
  };
  try {
    const written = await bridge.write(payload.state, capture);
    send(response, 200, JSON.stringify({ revision: written.revision, writtenAt: written.writtenAt }), 'application/json; charset=utf-8');
  } catch (error) {
    send(response, 400, error instanceof Error ? error.message.slice(0, 200) : 'bridge_write_failed');
  }
}

export async function createXrReviewServer(options: XrReviewArguments): Promise<{ server: ReviewServer; port: number; close: () => Promise<void> }> {
  const [runtime, html, launchText] = await Promise.all([
    readFile(options.runtimePath),
    readInlineHtml(resolve(ROOT, 'dist/inspector.html')),
    readFile(options.companionFile, 'utf8'),
  ]);
  if (runtime.byteLength === 0 || runtime.byteLength > 30 * 1024 * 1024) throw new Error('The IWER runtime is empty or unreasonably large.');
  let launch: unknown;
  try { launch = JSON.parse(launchText); } catch { throw new Error('The companion file is not valid JSON.'); }
  const target = readCompanionTarget(launch);
  const bridge = options.bridgeDirectory ? await createHeadsetBridgeWriter(options.bridgeDirectory) : null;
  const localToken = randomBytes(32).toString('hex');
  const require = createRequire(import.meta.url);
  const adapters = require(resolve(ROOT, '../lab/headset-preview/adapters.cjs')) as {
    installReferenceSpaceAdapter: (runtime: unknown) => unknown;
  };
  const { createToolbarPanel, SPATIAL_TOOLBAR_LAYOUT } = await import(pathToFileURL(resolve(ROOT, '../lab/browser-roundtrip/spatial-toolbar-geometry.mjs')).href);
  const { spatialToolbarRows } = await import(pathToFileURL(resolve(ROOT, '../lab/browser-roundtrip/spatial-toolbar-content.mjs')).href);
  const head = { position: { x: 0, y: 1.6, z: 0 }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  const activeVariants = [
    { canBack: false, canNext: false },
    { canBack: false, canNext: true },
    { canBack: true, canNext: false },
    { canBack: true, canNext: true },
  ];
  const targetSets = [
    { name: 'Initial menu', active: false, rows: spatialToolbarRows({ collapsed: true, mode: 'move', paused: true }) },
    ...activeVariants.flatMap(({ canBack, canNext }) => [
      {
        name: `Active tour · one caption page · ${canBack ? 'Back' : 'first'}${canNext ? ' + Next' : ''}`,
        active: true, multiPage: false, canBack, canNext,
        rows: spatialToolbarRows({ collapsed: true, mode: 'move', paused: true,
          tour: { active: true, autoplay: false, navigating: false, menuOpen: false, canBack, canNext,
            bodyPageCount: 1, bodyPageIndex: 0, selectedId: 'review' } }),
      },
      {
        name: `Active tour · caption pages · ${canBack ? 'Back' : 'first'}${canNext ? ' + Next' : ''}`,
        active: true, multiPage: true, canBack, canNext,
        rows: spatialToolbarRows({ collapsed: true, mode: 'move', paused: true,
          tour: { active: true, autoplay: false, navigating: false, menuOpen: false, canBack, canNext,
            bodyPageCount: 2, bodyPageIndex: 0, selectedId: 'review' } }),
      },
    ]),
  ].map(({ name, rows, ...metadata }: { name: string; rows: Array<{ label: string }>; active?: boolean; multiPage?: boolean; canBack?: boolean; canNext?: boolean }) => {
    const panel = createToolbarPanel({ rows, head, constants: SPATIAL_TOOLBAR_LAYOUT });
    if (!panel?.buttons?.length) throw new Error(`The production toolbar geometry did not produce a ${name} review target.`);
    return { ...metadata, name, labels: rows.map((row: { label: string }) => row.label), points: panel.buttons.map((button: { point: readonly number[] }) => [button.point[0], button.point[1], button.point[2]] as [number, number, number]) };
  });
  const setup = buildSetupScript(targetSets, String(adapters.installReferenceSpaceAdapter));
  const page = injectReviewScripts(html, localToken);
  const server: ReviewServer = createServer({ maxHeaderSize: 8192, requestTimeout: UPSTREAM_TIMEOUT_MS, headersTimeout: 5_000 }, (request, response) => {
    void (async () => {
      const port = server.reviewPort;
      if (!port) { send(response, 503, 'starting'); return; }
      const origin = localOrigin(port);
      const parsed = new URL(request.url ?? '/', origin);
      if (!sameLocalRequest(request, origin) || !allowedReviewPath(request.method, request.url)) { send(response, 403, 'forbidden'); return; }
      if (parsed.pathname === '/') { send(response, 200, page, 'text/html; charset=utf-8'); return; }
      if (parsed.pathname === '/iwer.js') { send(response, 200, runtime, 'text/javascript; charset=utf-8'); return; }
      if (parsed.pathname === '/setup.js') { send(response, 200, setup, 'text/javascript; charset=utf-8'); return; }
      if (!requireLocalAuth(request, localToken)) { send(response, 401, 'unauthorized'); return; }
      if (request.method === 'POST' && request.headers.origin !== origin) { send(response, 403, 'forbidden'); return; }
      if (parsed.pathname === BRIDGE_PATH) { await serveBridge(request, response, bridge); return; }
      await serveCompanion(request, response, target, parsed.pathname);
    })().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.writableEnded && !response.destroyed) send(response, message === 'body_too_large' ? 413 : 502, message === 'body_too_large' ? 'body_too_large' : 'upstream_unavailable');
    });
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolveListen(); };
    server.once('error', onError); server.once('listening', onListening); server.listen(options.port, LOCAL_HOSTNAME);
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== LOCAL_HOSTNAME || !Number.isInteger(address.port)) {
    server.close(); throw new Error('The review server did not bind loopback.');
  }
  server.reviewPort = address.port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    if (!server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  };
  server.reviewClose = close;
  return { server, port: address.port, close };
}

async function main() {
  const options = parseXrReviewArguments(process.argv.slice(2));
  const review = await createXrReviewServer(options);
  console.log(`Open the EMULATED QUEST local review: ${localOrigin(review.port)}/`);
  console.log('This server is fixture-only and loopback-bound. Ctrl-C closes it.');
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await review.close(); process.exit(0); };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry && entry === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
