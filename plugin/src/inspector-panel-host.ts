import { readInlineHtml } from './inline-html.js';
/**
 * The inspector panel, served by this server to a browser on this Mac.
 *
 * An MCP Apps host such as the Codex app mounts `dist/inspector.html` itself
 * and forwards the panel's tool calls. Terminal Claude Code mounts nothing,
 * and until a rendered panel saves a scene `open_companion` and
 * `open_detailed_view` refuse the session. This host serves that same file on
 * loopback inside the page `scripts/inspector-host.ts` builds into
 * `dist/inspector-host.js`, and answers the panel's tool calls from the
 * server's own handlers over `/rpc`. The repository's standalone desktop host
 * (`scripts/serve-inspection.ts`) does the same from a checkout with a
 * run-time esbuild; this one needs only `dist/`.
 *
 * Reach: `127.0.0.1` only, an ephemeral port, and one bearer per session that
 * rides in the URL fragment, which browsers never send, so no HTTP response
 * carries it. Every request must name this origin in its Host header, every
 * POST must carry the bearer and the same Origin, and every call is stamped
 * with the session its link was opened for; a call naming another session is
 * refused. A key lives exactly as long as its session: `forget` drops it when
 * the session ends or expires, a sweep asks `live` about every key while the
 * listener is up, and with no key left the listener closes until the next
 * `open`. The page sends no CSP, exactly as the standalone host sends none:
 * the inspector runs in a srcdoc frame under the page's policy, and a header
 * that Mol* was never run under is not something to add without a browser.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export const LOOPBACK_ADDRESS = '127.0.0.1';
const MAX_LINKS = 8;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_CONNECTIONS = 32;
const SWEEP_MS = 30_000;

/**
 * The tools the served panel may call: what `src/inspector.ts` calls on its
 * own, plus the two the page's own bar uses for the detailed view. Nothing
 * that reads the wearer's voice queue or the headset is here: those belong to
 * the agent that started the server, and a page must not consume them.
 */
export const INSPECTOR_PANEL_TOOLS = new Set([
  'get_inspection', 'get_inspection_bytes', 'get_inspection_state', 'resolve_scene_import', 'sync_inspection',
  'attach_inspection', 'poll_inspection', 'complete_inspection', 'detach_inspection',
  'open_companion', 'manage_companion', 'open_detailed_view',
  'navigate_experience', 'acknowledge_experience_step', 'grow_structure',
  'push_to_talk', 'push_to_talk_audio', 'voice_command', 'voice_acknowledgement',
  'claim_voice_intent', 'acknowledge_voice_intent', 'acknowledge_voice_playback',
  'submit_headset_view',
]);

/**
 * The one tool above whose arguments widen its reach: `manage_companion` also
 * forgets remembered headsets, relaunches the page and restarts Quest Browser.
 * The inspector's sharing dialog (`management` in `src/inspector.ts`) sends
 * only these three actions, so the others are refused here by name.
 */
export const INSPECTOR_PANEL_COMPANION_ACTIONS = new Set(['status', 'close', 'revoke']);

export type InspectorPanelHostOptions = {
  /** `dist/inspector.html`, the same file the MCP App resource serves. */
  htmlPath: string;
  /** `dist/inspector-host.js`, the built page that mounts it. */
  hostScriptPath: string;
  /** The `inspect`-kind result the page mounts with; it hydrates from there. */
  opened: (sessionId: string) => Promise<unknown>;
  /** One tool call for the bound session; `args` already carries that sessionId. */
  dispatch: (sessionId: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
  /**
   * Whether a session is still held, asked without counting as a use of it.
   * While the listener is up every key is checked this way once per sweep;
   * unset, keys leave only through `forget` and `close`.
   */
  live?: (sessionId: string) => boolean;
  /** Milliseconds between sweeps; the default is thirty seconds. */
  sweepMs?: number;
  /** Only `127.0.0.1` is accepted; the option exists so a test can prove the refusal. */
  bind?: string;
};

type Link = { token: string; sessionId: string };

/** The document the browser opens: a bar, the inspector frame, and the two scripts. */
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Stereofold Inspector</title></head>'
  + '<body style="margin:0;background:#071015;height:100vh;overflow:hidden">'
  + '<div id="host-bar" style="display:flex;gap:10px;align-items:center;padding:6px 10px;font:13px/1.4 system-ui,sans-serif;color:#dceaf0;background:#0d1a21">'
  + '<button id="host-detailed" type="button" style="font:inherit;padding:4px 10px;cursor:pointer">Detailed view</button><span id="host-status"></span></div>'
  + '<iframe title="Stereofold inspector" allow="xr-spatial-tracking" style="display:block;border:0;width:100%;height:calc(100% - 33px)"></iframe>'
  + '<script src="/host.js"></script><script src="/boot.js"></script></body></html>';

/**
 * The page key comes from the fragment and never leaves this origin. The
 * bootstrap answer is the inspector document and the result it mounts with,
 * and `/rpc` is how the mounted inspector's `callServerTool` reaches the
 * server, through `window.__call` in `scripts/inspector-host.ts`.
 */
const BOOT = 'const bearer=location.hash.slice(1);'
  + 'const status=document.querySelector("#host-status");const say=t=>{status.textContent=t;};'
  + 'const missingKey="Open the exact address the tool returned, including the part after #.";'
  + 'window.__call=async p=>{if(!bearer)throw Error(missingKey);'
  + 'const r=await fetch("/rpc",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+bearer},body:JSON.stringify(p)});'
  + 'if(!r.ok)throw Error("Local host request failed ("+r.status+")");return r.json();};'
  + '(async()=>{if(!bearer)throw Error(missingKey);'
  + 'const r=await fetch("/bootstrap",{headers:{Authorization:"Bearer "+bearer},cache:"no-store"});const d=await r.json();'
  + 'if(!r.ok)throw Error(d.error||"Local host request failed");'
  + 'await window.__host.mount(d.html,d.opened,{theme:"dark"});})().catch(e=>say(e.message));'
  + 'const detailed=document.querySelector("#host-detailed");'
  + 'detailed.addEventListener("click",async()=>{detailed.disabled=true;say("Opening the full Mol* viewer.");'
  + 'try{const state=await window.__call({name:"get_inspection_state",arguments:{}});const c=state.structuredContent;'
  + 'if(!c||!c.hasScene)throw Error("Save the inspection in the panel first, then open the detailed view.");'
  + 'const opened=await window.__call({name:"open_detailed_view",arguments:{serverEpoch:c.serverEpoch,sourceToken:c.sourceToken,baseStateRevision:c.stateRevision,baseInspectionRevision:c.inspectionRevision}});'
  + 'if(opened&&opened.isError)throw Error(opened.content&&opened.content[0]&&opened.content[0].text||"The detailed view did not open.");'
  + 'const view=opened.structuredContent&&opened.structuredContent.detailedView;if(!view||!view.url)throw Error("The detailed view did not open.");'
  + 'window.open(view.url,"_blank","noopener");say("Full Mol* viewer opened in a new tab.");}'
  + 'catch(e){say(e&&e.message?e.message:"The detailed view could not open.");}finally{detailed.disabled=false;}});';

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bearerOf(header: string | undefined): string | undefined {
  return /^Bearer ([a-f0-9]{64})$/u.exec(header ?? '')?.[1];
}

function sameToken(candidate: string, token: string): boolean {
  return candidate.length === token.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

export class InspectorPanelHost {
  readonly #htmlPath: string;
  readonly #hostScriptPath: string;
  readonly #opened: InspectorPanelHostOptions['opened'];
  readonly #dispatch: InspectorPanelHostOptions['dispatch'];
  readonly #live: InspectorPanelHostOptions['live'];
  readonly #sweepMs: number;
  readonly #links = new Map<string, Link>();
  readonly #sockets = new Set<Socket>();
  #server: http.Server | undefined;
  #port: number | undefined;
  #start: Promise<void> | undefined;
  #html: string | undefined;
  #hostScript: string | undefined;
  #sweeper: NodeJS.Timeout | undefined;
  #closed = false;

  constructor({ htmlPath, hostScriptPath, opened, dispatch, live, sweepMs = SWEEP_MS, bind = LOOPBACK_ADDRESS }: InspectorPanelHostOptions) {
    if (bind !== LOOPBACK_ADDRESS) throw new Error(`The inspector panel host binds ${LOOPBACK_ADDRESS} only; refusing ${bind}.`);
    if (typeof htmlPath !== 'string' || !htmlPath || typeof hostScriptPath !== 'string' || !hostScriptPath
      || typeof opened !== 'function' || typeof dispatch !== 'function') {
      throw new Error('The inspector panel host needs its two files, a mount result and a dispatcher.');
    }
    if (live !== undefined && typeof live !== 'function') throw new Error('The inspector panel host takes live as a function.');
    if (!Number.isInteger(sweepMs) || sweepMs <= 0) throw new Error('The inspector panel host sweeps every whole positive number of milliseconds.');
    this.#live = live;
    this.#sweepMs = sweepMs;
    this.#htmlPath = htmlPath;
    this.#hostScriptPath = hostScriptPath;
    this.#opened = opened;
    this.#dispatch = dispatch;
  }

  /** The bound port while the listener is up, otherwise undefined. */
  get port(): number | undefined { return this.#server?.listening ? this.#port : undefined; }

  /** How many sessions hold a page key. */
  get links(): number { return this.#links.size; }

  /**
   * The address for one session. A session that already has a page key gets
   * the same address again, so a second call never invalidates an open tab.
   */
  async open(sessionId: string): Promise<{ url: string; origin: string; port: number }> {
    if (this.#closed) throw new Error('The inspector panel host is closed.');
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('The inspector panel host needs a session.');
    let link = [...this.#links.values()].find(candidate => candidate.sessionId === sessionId);
    let created = false;
    if (!link) {
      if (this.#links.size >= MAX_LINKS) {
        const oldest = this.#links.keys().next().value;
        if (oldest !== undefined) this.#links.delete(oldest);
      }
      link = { token: randomBytes(32).toString('hex'), sessionId };
      this.#links.set(link.token, link);
      created = true;
    }
    try { await this.#listen(); }
    catch (error) { if (created) this.#links.delete(link.token); throw error; }
    // The session can end while its page is being readied: `forget` ran under
    // the awaits above and took the key with it.
    if (!this.#links.has(link.token)) {
      if (this.#links.size === 0) await this.#stop();
      throw new Error('The session ended before its inspector page could be served.');
    }
    const origin = `http://${LOOPBACK_ADDRESS}:${this.#port}`;
    return { url: `${origin}/#${link.token}`, origin, port: this.#port! };
  }

  /** For good: every key goes, every connection is cut, and `open` refuses from here on. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#links.clear();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await this.#stop();
  }

  /**
   * Drop one session's page key because that session ended or expired. With
   * no key left the listener stops; the next `open` starts a fresh one.
   */
  async forget(sessionId: string): Promise<void> {
    for (const [token, link] of this.#links) if (link.sessionId === sessionId) this.#links.delete(token);
    if (this.#links.size === 0) await this.#stop();
  }

  /** Every key whose session is gone leaves, and a host with no key stops listening. */
  #sweep(): void {
    const live = this.#live;
    if (!live) return;
    for (const [token, link] of this.#links) {
      let held = false;
      try { held = live(link.sessionId) === true; } catch { held = false; }
      if (!held) this.#links.delete(token);
    }
    if (this.#links.size === 0) void this.#stop().catch(() => undefined);
  }

  /**
   * Stop listening without closing the host. An idle keep-alive connection
   * ends now; a request in flight finishes its response first, inside the
   * server's own timeouts.
   */
  async #stop(): Promise<void> {
    if (this.#sweeper) { clearInterval(this.#sweeper); this.#sweeper = undefined; }
    const server = this.#server;
    this.#server = undefined;
    this.#port = undefined;
    this.#html = undefined;
    this.#hostScript = undefined;
    if (!server) return;
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  async #listen(): Promise<void> {
    if (this.#closed) throw new Error('The inspector panel host is closed.');
    if (this.#server?.listening) return;
    if (!this.#start) this.#start = this.#startServer().finally(() => { this.#start = undefined; });
    await this.#start;
    if (this.#closed) throw new Error('The inspector panel host is closed.');
    if (!this.#server?.listening) throw new Error('The inspector panel host stopped before its page was served.');
  }

  async #startServer(): Promise<void> {
    const [html, hostScript] = await Promise.all([readInlineHtml(this.#htmlPath), readFile(this.#hostScriptPath, 'utf8')]);
    if (this.#closed) throw new Error('The inspector panel host is closed.');
    this.#html = html;
    this.#hostScript = hostScript;
    const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 20_000, headersTimeout: 5_000 },
      (request, response) => { void this.#handle(request, response); });
    server.setTimeout(20_000, socket => socket.destroy());
    server.maxConnections = MAX_CONNECTIONS;
    server.on('connection', socket => { this.#sockets.add(socket); socket.once('close', () => this.#sockets.delete(socket)); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, LOOPBACK_ADDRESS, () => { server.off('error', reject); resolve(); });
      });
    } catch (error) { await this.#discard(server); throw error; }
    if (this.#closed) { await this.#discard(server); throw new Error('The inspector panel host is closed.'); }
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== LOOPBACK_ADDRESS || !Number.isInteger(address.port)) {
      await this.#discard(server); throw new Error('The inspector panel host did not bind loopback.');
    }
    server.unref();
    this.#server = server;
    this.#port = address.port;
    if (this.#live) { this.#sweeper = setInterval(() => this.#sweep(), this.#sweepMs); this.#sweeper.unref(); }
  }

  async #discard(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  #origin(): string { return `http://${LOOPBACK_ADDRESS}:${this.#port}`; }

  #sameOrigin(request: IncomingMessage): boolean {
    if (request.headers.host !== `${LOOPBACK_ADDRESS}:${this.#port}`) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = request.headers.origin;
    return !origin || origin === this.#origin();
  }

  #link(request: IncomingMessage): Link | undefined {
    const candidate = bearerOf(request.headers.authorization);
    if (!candidate) return undefined;
    for (const link of this.#links.values()) if (sameToken(candidate, link.token)) return link;
    return undefined;
  }

  async #body(request: IncomingMessage): Promise<string> {
    // Chunks are Buffers. Concatenating them as strings decodes each chunk in
    // isolation, so a UTF-8 code point split across a boundary is destroyed.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: string | object, type = 'application/json; charset=utf-8') => {
      // A client that aborts mid-request leaves a socket that cannot take
      // another response; writing one anyway would throw out of this handler.
      if (response.writableEnded || response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      if (!this.#sameOrigin(request)) { send(403, {}); return; }
      const path = (request.url ?? '/').split('?')[0];
      if (request.method === 'GET') {
        if (path === '/') { send(200, PAGE, 'text/html; charset=utf-8'); return; }
        if (path === '/alive') { send(204, '', 'text/plain'); return; }
        if (path === '/host.js') { send(200, this.#hostScript ?? '', 'text/javascript; charset=utf-8'); return; }
        if (path === '/boot.js') { send(200, BOOT, 'text/javascript; charset=utf-8'); return; }
        if (path === '/bootstrap') {
          const link = this.#link(request);
          if (!link) { send(401, { error: 'This page key is not current. Open the address the tool returned.' }); return; }
          try { send(200, { html: this.#html, opened: await this.#opened(link.sessionId) }); }
          catch (error) { send(409, { error: messageOf(error) }); }
          return;
        }
        send(404, {}); return;
      }
      if (request.method !== 'POST' || path !== '/rpc') { send(404, {}); return; }
      // An Origin header is only meaningful inside a browser; any local
      // process can send it verbatim. The route therefore needs the bearer too.
      const link = this.#link(request);
      if (!link) { send(401, {}); return; }
      if (request.headers.origin !== this.#origin() || request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) {
        send(403, {}); return;
      }
      let input: unknown;
      try { input = JSON.parse(await this.#body(request)); }
      catch (error) { send(messageOf(error) === 'body_too_large' ? 413 : 400, {}); return; }
      const name = String(plainRecord(input) ? input.name ?? '' : '').replace(/^stereo_structure\./u, '');
      const args = plainRecord(input) && plainRecord(input.arguments) ? input.arguments : {};
      try {
        if (!INSPECTOR_PANEL_TOOLS.has(name)) throw new Error('Tool unavailable');
        if (name === 'manage_companion' && typeof args.action === 'string' && !INSPECTOR_PANEL_COMPANION_ACTIONS.has(args.action)) {
          throw new Error(`The panel may call manage_companion with action status, close or revoke; "${args.action}" belongs to the agent.`);
        }
        if (args.sessionId !== undefined && args.sessionId !== link.sessionId) throw new Error('Wrong session');
        send(200, JSON.stringify(await this.#dispatch(link.sessionId, name, { ...args, sessionId: link.sessionId })));
      } catch (error) {
        // The MCP SDK turns a handler's exception into an error result, and
        // that is the shape the mounted inspector reads its messages from.
        send(200, { content: [{ type: 'text', text: messageOf(error) }], isError: true });
      }
    } catch { send(500, {}); }
  }
}
