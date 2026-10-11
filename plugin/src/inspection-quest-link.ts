import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

// Resolve the installed executable through PATH on macOS, Windows and Linux.
// Hosts with a restricted PATH may explicitly configure an absolute executable.
const CLOUDFLARED = process.env.STEREOFOLD_CLOUDFLARED || 'cloudflared';
const LINK_LIFETIME_MS = 30 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 15 * 1000;
// The MCP tool caller has a one-minute default deadline. Leave room for the
// 15-second cloudflared startup phase and deterministic cleanup.
const READINESS_TIMEOUT_MS = 35 * 1000;
const PROBE_TIMEOUT_MS = 2 * 1000;
const PROBE_RETRY_MS = 250;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const ALLOWED_PATHS = new Set(['/', '/source', '/tool']);
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

type Spawn = (command: string, args: readonly string[], options: {
  shell: false;
  stdio: ['ignore', 'pipe', 'pipe'];
  windowsHide: true;
}) => ChildProcess;
type Probe = (url: string, init: RequestInit) => Promise<{ status: number }>;

export type QuestLinkOptions = {
  /** The installed binary is intentionally not downloaded or updated here. */
  cloudflaredPath?: string;
  spawn?: Spawn;
  now?: () => number;
  randomToken?: () => string;
  startupTimeoutMs?: number;
  lifetimeMs?: number;
  /** Test seam for the public HTTPS readiness request. */
  probe?: Probe;
  readinessTimeoutMs?: number;
  dnsGraceMs?: number;
};

export type QuestLinkResult = { url: string; expiresAt: string };

type Target = { port: number; token: string };
type LinkState = {
  server: http.Server;
  sockets: Set<Socket>;
  target: Target;
  linkToken: string;
  child?: ChildProcess;
  publicOrigin?: string;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  startupTimer?: ReturnType<typeof setTimeout>;
  cancelStartup?: () => void;
  cancelReadiness?: () => void;
  revoked: boolean;
};

function safeEqual(value: string | undefined, expected: string) {
  if (!value) return false;
  const actual = Buffer.from(value), wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function bearer(request: IncomingMessage) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '');
  return match?.[1];
}

function parseTarget(value: string): Target {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Quest link requires a locally issued companion URL.'); }
  const port = Number(url.port);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535
      || url.username || url.password || url.pathname !== '/' || url.search || !/^#[a-f0-9]{64}$/.test(url.hash)) {
    throw new Error('Quest link requires a locally issued companion URL.');
  }
  return { port, token: url.hash.slice(1) };
}

function parsePublicOrigin(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)) return undefined;
  return url.origin;
}

function isWebSocket(request: IncomingMessage) {
  return Boolean(request.headers.upgrade || request.headers['sec-websocket-key'] || /\bupgrade\b/i.test(request.headers.connection ?? ''));
}

function closeServer(server: http.Server, sockets: Set<Socket>) {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  return new Promise<void>(resolve => server.close(() => resolve()));
}

/**
 * Creates one short-lived public HTTPS capability for an existing loopback
 * companion. The upstream companion capability never leaves this process.
 */
export class QuestLink {
  readonly #cloudflaredPath: string;
  readonly #spawn: Spawn;
  readonly #now: () => number;
  readonly #randomToken: () => string;
  readonly #startupTimeoutMs: number;
  readonly #lifetimeMs: number;
  readonly #probe: Probe;
  readonly #readinessTimeoutMs: number;
  readonly #dnsGraceMs: number;
  #state?: LinkState;
  #serial: Promise<unknown> = Promise.resolve();

  constructor({ cloudflaredPath = CLOUDFLARED, spawn = nodeSpawn as unknown as Spawn, now = Date.now,
    randomToken = () => randomBytes(32).toString('hex'), startupTimeoutMs = STARTUP_TIMEOUT_MS,
    lifetimeMs = LINK_LIFETIME_MS, probe = (url, init) => fetch(url, init), readinessTimeoutMs = READINESS_TIMEOUT_MS, dnsGraceMs = 10_000 }: QuestLinkOptions = {}) {
    if (!cloudflaredPath || typeof spawn !== 'function' || typeof now !== 'function' || typeof randomToken !== 'function'
      || typeof probe !== 'function' || !Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0 || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0
      || !Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0 || !Number.isFinite(dnsGraceMs) || dnsGraceMs < 0) {
      throw new TypeError('QuestLink requires valid process and lifetime options.');
    }
    this.#cloudflaredPath = cloudflaredPath;
    this.#spawn = spawn;
    this.#now = now;
    this.#randomToken = randomToken;
    this.#startupTimeoutMs = startupTimeoutMs;
    this.#lifetimeMs = lifetimeMs;
    this.#probe = probe;
    this.#readinessTimeoutMs = readinessTimeoutMs;
    this.#dnsGraceMs = dnsGraceMs;
  }

  async open({ url }: { url: string }): Promise<QuestLinkResult> {
    return this.#run(async () => {
      const target = typeof url === 'string' ? parseTarget(url) : (() => { throw new Error('Quest link requires a locally issued companion URL.'); })();
      await this.#revoke(this.#state);
      const state = await this.#startProxy(target);
      this.#state = state;
      try {
        const publicOrigin = await this.#startTunnel(state);
        if (state.revoked || this.#state !== state) throw new Error('Quest link was closed while starting.');
        state.publicOrigin = publicOrigin;
        await this.#waitForReadiness(state, publicOrigin);
        if (state.revoked || this.#state !== state) throw new Error('Quest link was closed while starting.');
        return { url: `${publicOrigin}/#${state.linkToken}`, expiresAt: new Date(state.expiresAt).toISOString() };
      } catch (error) {
        await this.#revoke(state);
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    // Do not queue behind a cloudflared startup that may be waiting on the
    // network. Revocation makes that startup reject and tears down its proxy.
    await this.#revoke(this.#state);
    await this.#run(async () => undefined);
  }

  async #run<T>(work: () => Promise<T>) {
    const next = this.#serial.then(work, work);
    this.#serial = next.then(() => undefined, () => undefined);
    return next;
  }

  async #startProxy(target: Target) {
    const sockets = new Set<Socket>();
    // Generate before binding. A bad injected generator must not leave an
    // otherwise unreachable listener behind.
    const linkToken = this.#validToken();
    const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: 5_000 },
      (request, response) => { void this.#proxy(state!, request, response); });
    let state: LinkState | undefined;
    server.setTimeout(REQUEST_TIMEOUT_MS, socket => socket.destroy());
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    }).catch(error => { server.close(); throw error; });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || !Number.isInteger(address.port)) {
      await closeServer(server, sockets); throw new Error('Quest link proxy did not bind loopback.');
    }
    const expiresAt = this.#now() + this.#lifetimeMs;
    state = { server, sockets, target, linkToken, expiresAt, expiryTimer: undefined as unknown as ReturnType<typeof setTimeout>, revoked: false };
    state.expiryTimer = setTimeout(() => { void this.#run(() => this.#revoke(state)); }, this.#lifetimeMs);
    return state;
  }

  #validToken() {
    const token = this.#randomToken();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Quest link token generator returned an invalid token.');
    return token;
  }

  async #startTunnel(state: LinkState) {
    const address = state.server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('Quest link proxy is unavailable.');
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${address.port}`] as const;
    let child: ChildProcess;
    try {
      child = this.#spawn(this.#cloudflaredPath, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error: any) {
      if (error?.code === 'ENOENT') throw new Error(`Quest link needs cloudflared at ${this.#cloudflaredPath}. Install it, then try again.`);
      throw new Error('Quest link could not start cloudflared. Check that cloudflared is installed and executable.');
    }
    state.child = child;
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let outputTail = '';
      const discard = () => { /* Keep cloudflared's pipes flowing after startup. */ };
      const finish = (error?: Error, origin?: string) => {
        if (settled) return;
        settled = true;
        if (state.startupTimer) clearTimeout(state.startupTimer);
        state.cancelStartup = undefined;
        child.stdout?.off('data', read); child.stderr?.off('data', read);
        child.off('error', failed); child.off('exit', exited);
        if (error) { reject(error); return; }
        // A tunnel that later exits is no longer a capability, even if its
        // loopback proxy is still healthy. Keep ownership until close/expiry.
        child.once('exit', () => { void this.#revoke(state); });
        child.once('error', () => { void this.#revoke(state); });
        resolve(origin!);
      };
      const read = (chunk: Buffer | string) => {
        // Only retain a validated origin. Cloudflared output can contain request
        // details, so it is deliberately never logged or included in errors.
        const output = outputTail + String(chunk);
        outputTail = output.slice(-512);
        const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?/i.exec(output);
        const origin = match && parsePublicOrigin(match[0]);
        if (origin) finish(undefined, origin);
      };
      const failed = (error: any) => finish(error?.code === 'ENOENT'
        ? new Error(`Quest link needs cloudflared at ${this.#cloudflaredPath}. Install it, then try again.`)
        : new Error('Quest link could not start cloudflared. Check that cloudflared is installed and executable.'));
      const exited = () => {
        if (!state.revoked) finish(new Error('Quest link closed before cloudflared provided a secure URL.'));
      };
      // `read` is removed once the first valid URL arrives, but this separate
      // listener remains for the tunnel lifetime so a chatty child cannot block
      // on a full stdout/stderr pipe. Its data is never logged or retained.
      child.stdout?.on('data', discard); child.stderr?.on('data', discard);
      child.stdout?.on('data', read); child.stderr?.on('data', read);
      child.once('error', failed); child.once('exit', exited);
      state.startupTimer = setTimeout(() => finish(new Error('Quest link timed out waiting for cloudflared. Check your network and try again.')), this.#startupTimeoutMs);
      state.cancelStartup = () => finish(new Error('Quest link was closed while starting.'));
    });
  }

  async #waitForReadiness(state: LinkState, publicOrigin: string) {
    const deadline = Date.now() + this.#readinessTimeoutMs;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      let controller: AbortController | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (retryTimer) clearTimeout(retryTimer);
        if (probeTimer) clearTimeout(probeTimer);
        controller?.abort();
        state.cancelReadiness = undefined;
        error ? reject(error) : resolve();
      };
      const attempt = async () => {
        if (settled) return;
        if (state.revoked) { finish(new Error('Quest link was closed while waiting for HTTPS.')); return; }
        if (Date.now() >= deadline) { finish(new Error('Quest link timed out waiting for its HTTPS address. Check your network and try again.')); return; }
        controller = new AbortController();
        probeTimer = setTimeout(() => controller?.abort(), PROBE_TIMEOUT_MS);
        try {
          const response = await this.#probe(publicOrigin, { method: 'HEAD', redirect: 'error', signal: controller.signal });
          if (response.status === 405) { finish(); return; }
        } catch { /* DNS and Cloudflare propagation are transient until deadline. */ }
        finally { if (probeTimer) clearTimeout(probeTimer); probeTimer = undefined; controller = undefined; }
        if (!settled) retryTimer = setTimeout(() => { void attempt(); }, PROBE_RETRY_MS);
      };
      state.cancelReadiness = () => finish(new Error('Quest link was closed while waiting for HTTPS.'));
      // A lookup before Cloudflare publishes the fresh record can cache
      // NXDOMAIN for minutes in the OS resolver. Let publication settle before
      // the first lookup; all waits still share the same readiness deadline.
      retryTimer=setTimeout(() => {void attempt();}, Math.min(this.#dnsGraceMs,this.#readinessTimeoutMs));
    });
  }

  async #revoke(state: LinkState | undefined) {
    if (!state || state.revoked) return;
    state.revoked = true;
    if (this.#state === state) this.#state = undefined;
    clearTimeout(state.expiryTimer);
    if (state.startupTimer) clearTimeout(state.startupTimer);
    state.cancelStartup?.();
    state.cancelReadiness?.();
    try { state.child?.kill('SIGTERM'); } catch { /* The owned process already exited. */ }
    await closeServer(state.server, state.sockets);
  }

  #send(response: ServerResponse, status: number) {
    if (!response.writableEnded && !response.destroyed) { response.writeHead(status, { 'Cache-Control': 'no-store' }); response.end(); }
  }

  #proxy(state: LinkState, request: IncomingMessage, response: ServerResponse) {
    if (state.revoked || !state.publicOrigin || isWebSocket(request) || !ALLOWED_PATHS.has(request.url ?? '')) {
      this.#send(response, state.revoked ? 410 : 404); return;
    }
    const path = request.url!;
    const root = path === '/';
    if ((root && request.method !== 'GET') || (path === '/source' && request.method !== 'GET') || (path === '/tool' && request.method !== 'POST')) {
      this.#send(response, 405); return;
    }
    if (!root && (!safeEqual(bearer(request), state.linkToken)
      || request.headers['sec-fetch-site'] === 'cross-site'
      || (request.headers.origin !== undefined && request.headers.origin !== state.publicOrigin)
      || (path === '/tool' && request.headers.origin !== state.publicOrigin))) {
      this.#send(response, 401); return;
    }
    const targetHost = `127.0.0.1:${state.target.port}`;
    const headers: http.OutgoingHttpHeaders = {
      host: targetHost,
      origin: `http://${targetHost}`,
      ...(root ? {} : { authorization: `Bearer ${state.target.token}` }),
    };
    for (const name of ['accept', 'accept-encoding', 'content-type', 'content-length'] as const) {
      const value = request.headers[name]; if (value !== undefined) headers[name] = value;
    }
    try {
      const upstream = http.request({ host: '127.0.0.1', port: state.target.port, path, method: request.method, headers,
        timeout: REQUEST_TIMEOUT_MS }, upstreamResponse => {
        try {
          const status = upstreamResponse.statusCode ?? 502;
          if (status >= 300 && status < 400) { upstreamResponse.resume(); this.#send(response, 502); return; }
          for (const [name, value] of Object.entries(upstreamResponse.headers)) {
            if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== 'location' && name.toLowerCase() !== 'set-cookie') response.setHeader(name, value);
          }
          response.writeHead(status); upstreamResponse.pipe(response);
        } catch { upstreamResponse.resume(); this.#send(response, 502); }
      });
      upstream.once('timeout', () => upstream.destroy());
      upstream.once('error', () => this.#send(response, 502));
      request.pipe(upstream);
    } catch { this.#send(response, 502); }
  }
}
