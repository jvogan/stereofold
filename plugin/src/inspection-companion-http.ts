import { readInlineHtml } from './inline-html.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { DETAILED_VIEW_ROUTES, DETAILED_VIEW_SCRIPT_HASH, detailedViewHtml, readMolstarBundle, resolveMolstarBundle, type MolstarBundle } from './detailed-view-page.js';
import { isPageRoute } from './inspection-page-route.js';
import { pageSourceRefusal } from './inspection-page-source.js';
import { companionRequestCeilingMs } from './inspection-limits.js';
import { stampedBuildId } from './build-identity.js';
import type { DetailedViewHandoff } from './detailed-view-contract.js';

const MAX_LINKS = 8;
const IDLE_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024 + 16 * 1024;
const MAX_ACTIVE_REQUESTS = 8;
// Sockets are tracked on accept, before any header is parsed, so the
// per-request cap cannot bound a slow-header flood. Node destroys anything
// past this cap outright, without emitting a connection event.
const MAX_CONNECTIONS = 32;
const PRIVATE_INSPECTION_META_KEY = 'stereo_structure/inspection';
export const TOOLS = new Set(['get_inspection', 'get_inspection_bytes', 'sync_inspection', 'attach_inspection', 'poll_inspection', 'complete_inspection','report_source_failure', 'detach_inspection', 'undo_last_change', 'redo_last_change', 'push_to_talk', 'push_to_talk_audio', 'navigate_experience', 'acknowledge_experience_step', 'replace_inspection_source', 'grow_structure', 'voice_command', 'voice_acknowledgement', 'speak_to_headset', 'claim_voice_intent', 'acknowledge_voice_intent', 'acknowledge_voice_playback', 'open_detailed_view', 'return_detailed_view', 'poll_detailed_view', 'report_detailed_selection', 'submit_headset_view']);
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
/**
 * The stock Mol* viewer application ships an Emscripten module whose embind
 * glue names its exported functions with `new Function`, so the detailed page
 * cannot run under the policy above. Only that one generated document gets
 * `'unsafe-eval'`, and its markup is built entirely from constants: no request
 * value, no session data and no coordinates reach it. The handoff that does
 * carry coordinates stays behind the bearer on its own route, under the
 * unrelaxed policy, and so does the inspector panel.
 *
 * It is also the one document without `'unsafe-inline'`. Once the page runs,
 * Mol* writes names from the structure file into it as HTML, and an inline
 * event handler in one of them could read the page key. The page's single
 * inline script is admitted by its hash instead.
 */
export const DETAILED_VIEW_CSP = CSP.replace("script-src 'self' 'unsafe-inline' blob:", `script-src 'self' ${DETAILED_VIEW_SCRIPT_HASH} 'unsafe-eval' blob:`);
// This page intentionally has no application state, iframe, audio, or
// microphone side effects. It isolates native WebXR admission from Mol* and
// the companion's authenticated transport. A timed-out native promise has no
// WebXR abort API, so late sessions/streams are closed and the page requires a
// full reload before another attempt.
const XR_CHECK_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stereofold WebXR check</title><style>body{font:16px system-ui,sans-serif;background:#071015;color:#e6f3f4;max-width:44rem;margin:2rem auto;padding:0 1rem}button{font:inherit;margin:.35rem .35rem .35rem 0;padding:.65rem .8rem;background:#12343b;color:inherit;border:1px solid #45bfa4;border-radius:.45rem}button:disabled{opacity:.5}pre{white-space:pre-wrap;background:#0d2025;padding:1rem;border-radius:.45rem;min-height:8rem}</style><main><h1>Native WebXR check</h1><p>Use one button at a time. This page does not load the molecular viewer.</p><button id="support">Check support</button><button id="vr">Request VR (no options)</button><button id="mic">Request microphone</button><pre id="out" role="status">Ready.</pre></main><script>
(()=>{
  const out=document.querySelector('#out'), buttons=[...document.querySelectorAll('button')]; let busy=false, blocked=false;
  const wait=(value,ms,label)=>{let timer;return Promise.race([Promise.resolve(value),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error(label),{code:'probe_timeout'})),ms)})]).finally(()=>clearTimeout(timer))};
  const cleanMessage=value=>String(value??'').replace(/https?:\\/\\/[^\\s]+/g,'[url]').slice(0,240);
  const policy=()=>{try{const p=document.permissionsPolicy||document.featurePolicy;return typeof p?.allowsFeature==='function'?p.allowsFeature('xr-spatial-tracking'):null}catch{return null}};
  const base=()=>({origin:location.origin,topLevel:window.top===window,secureContext:isSecureContext,xr:Boolean(navigator.xr),xrSpatialTracking:policy()});
  const show=value=>{out.textContent=JSON.stringify(value,null,2)};
  const setBusy=value=>{busy=value;for(const button of buttons)button.disabled=value||blocked};
  async function support(){if(busy||blocked)return;setBusy(true);try{const xr=navigator.xr;show({...base(),vr:await wait(xr?.isSessionSupported('immersive-vr'),5000,'VR support check timed out'),ar:await wait(xr?.isSessionSupported('immersive-ar'),5000,'AR support check timed out')})}catch(error){show({...base(),error:cleanMessage(error?.message||error?.name)})}finally{setBusy(false)}}
  async function vr(){if(busy||blocked)return;setBusy(true);let expired=false,native,session,sessionAccepted=false,phase='requesting',result;try{const xr=navigator.xr;if(!xr)throw Error('navigator.xr is unavailable');native=xr.requestSession('immersive-vr');const accepted=Promise.resolve(native).then(async value=>{if(expired){try{await value.end()}catch{}throw Error('Late VR session closed after timeout')}return value});session=await wait(accepted,5000,'VR request timed out');sessionAccepted=true;phase='reference-space';const local=await wait(session.requestReferenceSpace('local'),5000,'local reference space timed out');phase='accepted';result={...base(),sessionAccepted:true,localReferenceSpace:Boolean(local),phase}}catch(error){if(error?.code==='probe_timeout'){expired=true;blocked=true}result={...base(),sessionAccepted,phase,blockedUntilReload:blocked,error:{name:error?.name||'Error',message:cleanMessage(error?.message||error?.name)}}}finally{if(session){phase='closing';try{await wait(session.end(),3000,'VR session close timed out')}catch(error){blocked=true;result={...base(),sessionAccepted,phase,blockedUntilReload:true,error:{name:error?.name||'Error',message:cleanMessage(error?.message||error?.name)}}}}show(result);setBusy(false)}}
  async function mic(){if(busy||blocked)return;setBusy(true);let expired=false,native;try{if(!navigator.mediaDevices?.getUserMedia)throw Error('getUserMedia is unavailable');native=navigator.mediaDevices.getUserMedia({audio:true});const accepted=Promise.resolve(native).then(stream=>{if(expired){for(const track of stream.getTracks())track.stop();throw Error('Late microphone stream closed after timeout')}return stream});const stream=await wait(accepted,5000,'microphone request timed out');for(const track of stream.getTracks())track.stop();show({...base(),microphoneAccepted:true})}catch(error){if(error?.code==='probe_timeout'){expired=true;blocked=true}show({...base(),microphoneAccepted:false,blockedUntilReload:blocked,error:cleanMessage(error?.message||error?.name)})}finally{setBusy(false)}}
  document.querySelector('#support').addEventListener('click',support);document.querySelector('#vr').addEventListener('click',vr);document.querySelector('#mic').addEventListener('click',mic);
})();</script></html>`;

type Source = { text: string; sha256: string };
/**
 * A density map on its way to the page.
 *
 * `contour` rides with the bytes because it is the one number the page cannot
 * recover from them: it is the absolute isosurface level the lesson was
 * authored at, measured on THIS prepared map, and meshing at anything else
 * gives the wearer a different molecule.
 */
type Density = { bytes: Buffer; sha256: string; contour: number };
type Link = { token: string; sessionId: string; sourceToken: string; retargetedFrom?: string; lastUsed: number };
type ToolResult = Record<string, unknown>;
type FreshSource = Source & { bytes: Buffer };

export type InspectionCompanionHttpOptions = {
  htmlPath: string;
  dispatch: (sessionId: string, sourceToken: string, name: string, args: Record<string, unknown>) => Promise<any>;
  source: (sessionId: string, sourceToken: string) => Promise<Source>;
  /**
   * The session's density map, or `undefined` when the loaded tier is atomic.
   * Omitted entirely, `/density` is 404 for every session, which is what every
   * host that predates the volume tier gets.
   */
  density?: (sessionId: string, sourceToken: string) => Promise<Density | undefined>;
  /** Roots the full Mol* viewer bundle is served from. Omitted, the detailed view is unavailable. */
  molstarRoots?: { distRoot: string; packageRoot: string };
  /** Builds the one-shot cinematic-to-detailed handoff for the current saved inspection. */
  detailed?: (sessionId: string, sourceToken: string) => Promise<DetailedViewHandoff>;
  now?: () => number;
  /** How long a `/tool` request may run, by tool name. Override in bounded tests. */
  requestCeilingMs?: (tool: string) => number;
};

function safeEqual(value: string | undefined, expected: string) {
  if (!value) return false;
  const actual = Buffer.from(value), wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function errorBody(code: string, message?: string) {
  return JSON.stringify(message ? { error: code, message } : { error: code });
}

export class InspectionCompanionHttp {
  readonly #htmlPath: string;
  readonly #dispatch: InspectionCompanionHttpOptions['dispatch'];
  readonly #source: InspectionCompanionHttpOptions['source'];
  readonly #density: InspectionCompanionHttpOptions['density'];
  readonly #molstarRoots: InspectionCompanionHttpOptions['molstarRoots'];
  readonly #detailed: InspectionCompanionHttpOptions['detailed'];
  readonly #now: () => number;
  readonly #ceiling: (tool: string) => number;
  #server?: http.Server;
  #start?: Promise<void>;
  #html?: Buffer;
  #servedBuildId?: string | null;
  #port?: number;
  #closed = false;
  #active = 0;
  #links = new Map<string, Link>();
  #sockets = new Set<import('node:net').Socket>();

  #bundle?: MolstarBundle;
  #molstar?: { script: Buffer; style: Buffer };
  #detailedHtml?: Buffer;

  constructor({ htmlPath, dispatch, source, density, molstarRoots, detailed, now = Date.now, requestCeilingMs = companionRequestCeilingMs }: InspectionCompanionHttpOptions) {
    if (typeof htmlPath !== 'string' || !htmlPath || typeof dispatch !== 'function' || typeof source !== 'function' || typeof now !== 'function'
      || typeof requestCeilingMs !== 'function' || !(requestCeilingMs('') > 0) || !(requestCeilingMs('navigate_experience') > 0)) {
      throw new TypeError('InspectionCompanionHttp requires an inspector HTML path and source-scoped callbacks.');
    }
    this.#ceiling = requestCeilingMs;
    this.#htmlPath = htmlPath;
    this.#dispatch = dispatch;
    this.#source = source;
    this.#density = density;
    this.#molstarRoots = molstarRoots;
    this.#detailed = detailed;
    this.#now = now;
  }

  async open(sessionId: string, sourceToken: string): Promise<{ url: string; port: number }> {
    if (this.#closed || typeof sessionId !== 'string' || !sessionId || typeof sourceToken !== 'string' || !sourceToken) {
      throw new Error('Companion transport is unavailable.');
    }
    this.#prune();
    for (const [token, link] of this.#links) {
      if (link.sessionId === sessionId && link.sourceToken === sourceToken) {
        link.lastUsed = this.#now();
        await this.#listen();
        return { url: this.#url(link.token), port: this.#port! };
      }
      // A source replacement revokes every older capability for this session.
      // Otherwise a stale companion can keep an unusable token alive by polling
      // and eventually consume the global bounded link pool.
      if (link.sessionId === sessionId) this.#links.delete(token);
    }
    if (this.#links.size >= MAX_LINKS) throw new Error('Companion link limit reached.');
    const link: Link = { token: randomBytes(32).toString('hex'), sessionId, sourceToken, lastUsed: this.#now() };
    this.#links.set(link.token, link);
    try { await this.#listen(); }
    catch (error) { this.#links.delete(link.token); throw error; }
    return { url: this.#url(link.token), port: this.#port! };
  }

  /** Retarget one existing bearer only after the server authenticated a source transition. */
  async retarget(sessionId: string, previousSourceToken: string, sourceToken: string): Promise<{ url: string; port: number }> {
    if (this.#closed || !sessionId || !previousSourceToken || !sourceToken) throw new Error('Companion transport is unavailable.');
    this.#prune();
    for (const link of this.#links.values()) {
      if (link.sessionId === sessionId && (link.sourceToken === previousSourceToken
        || (link.sourceToken === sourceToken && link.retargetedFrom === previousSourceToken))) {
        this.#retargetLink(link, previousSourceToken, sourceToken);
        await this.#listen();
        return { url: this.#url(link.token), port: this.#port! };
      }
    }
    throw new Error('The companion link is no longer current.');
  }

  #retargetLink(link: Link, previousSourceToken: string, sourceToken: string): void {
    if (link.sourceToken === previousSourceToken) {
      if (sourceToken !== previousSourceToken) {
        link.retargetedFrom = previousSourceToken;
        link.sourceToken = sourceToken;
      }
    } else if (link.sourceToken !== sourceToken || link.retargetedFrom !== previousSourceToken) {
      throw new Error('The companion link is no longer current.');
    }
    // Overlapping authenticated reads may finish the exact same handoff. Do
    // not rotate its bearer again or revive any older step in the source chain.
    link.lastUsed = this.#now();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#links.clear();
    const server = this.#server;
    this.#server = undefined;
    this.#port = undefined;
    this.#html = undefined;
    this.#servedBuildId = undefined;
    this.#molstar = undefined;
    this.#detailedHtml = undefined;
    this.#start = undefined;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  #url(token: string, path = '/') { return `http://127.0.0.1:${this.#port}${path}#${token}`; }

  /**
   * Whether this host serves the full Mol* viewer to a page it
   * served. The same pair of options gates `openDetailed` and the three
   * `DETAILED_VIEW_ROUTES` in `#serve`, and the LAN listener proxies those
   * routes straight through, so this one boolean is true exactly when the
   * headset's own origin can show the viewer.
   *
   * The host reports it in every inspection state so the wearer's page never
   * has to probe its own origin. A host whose Mol* bundle is missing on disk
   * still says true and fails the same way on both routes, with a caption,
   * rather than downgrading a headset press to a Mac monitor.
   */
  get servesDetailedView(): boolean { return Boolean(this.#detailed && this.#molstarRoots); }

  get servedBuildId(): string | null | undefined { return this.#servedBuildId; }

  /** Keep the build stamp and the served page from the same disk read. */
  async prepareHtml(): Promise<void> {
    if(this.#closed) throw new Error('Companion transport is unavailable.');
    if(this.#html) return;
    const original = await readInlineHtml(this.#htmlPath);
    if(this.#closed) throw new Error('Companion transport is unavailable.');
    const injection = '<script>window.__STEREOFOLD_COMPANION__=true;</script>';
    const index = original.search(/<script\b/i);
    if (index < 0) throw new Error('Companion inspector HTML has no script boundary.');
    this.#servedBuildId = stampedBuildId(original);
    this.#html = Buffer.from(`${original.slice(0, index)}${injection}${original.slice(index)}`, 'utf8');
  }

  /**
   * The detailed view rides the companion link this session already holds, so
   * it inherits the same source capability and the same revocation. It never
   * mints a second bearer and never opens a second listener.
   */
  async openDetailed(sessionId: string, sourceToken: string): Promise<{ url: string; port: number }> {
    if (!this.#detailed || !this.#molstarRoots) throw new Error('This host cannot open the full Mol* viewer.');
    // Fail before a link exists if the bundle is missing, so a packaged host
    // without it reports the install problem instead of a blank page.
    await this.#viewerBundle();
    const link = await this.open(sessionId, sourceToken);
    const token = link.url.slice(link.url.indexOf('#') + 1);
    return { url: this.#url(token, DETAILED_VIEW_ROUTES.page), port: link.port };
  }

  async #viewerBundle() {
    if (!this.#molstarRoots) throw new Error('This host cannot open the full Mol* viewer.');
    if (!this.#bundle) this.#bundle = await resolveMolstarBundle(this.#molstarRoots);
    if (!this.#molstar) this.#molstar = await readMolstarBundle(this.#bundle);
    if (!this.#detailedHtml) this.#detailedHtml = Buffer.from(detailedViewHtml(), 'utf8');
    return this.#molstar;
  }

  #prune() {
    const cutoff = this.#now() - IDLE_MS;
    for (const [token, link] of this.#links) if (link.lastUsed <= cutoff) this.#links.delete(token);
  }

  async #listen() {
    if(this.#closed) throw new Error('Companion transport is unavailable.');
    if (this.#server?.listening) return;
    if (!this.#start) this.#start = this.#startServer();
    try { await this.#start;if(this.#closed)throw new Error('Companion transport is unavailable.'); }
    catch (error) { this.#start = undefined; throw error; }
  }

  async #startServer() {
    await this.prepareHtml();
    // OAuth transcription/narration has its own 45 second process limit. The
    // loopback proxy leaves a small bounded delivery margin only for those
    // authenticated tool calls; other client calls retain their 15 second UI
    // deadline in inspection-companion-client. `navigate_experience` has a
    // longer page deadline and so a longer ceiling, set per request below.
    const server = http.createServer({maxHeaderSize:8192,requestTimeout:this.#ceiling(''),headersTimeout:Math.min(5000,this.#ceiling('')) },(request, response) => { void this.#handle(request, response); });
    server.setTimeout(this.#ceiling(''),socket=>socket.destroy());
    server.maxConnections = MAX_CONNECTIONS;
    server.on('connection', socket => { this.#sockets.add(socket); socket.once('close', () => this.#sockets.delete(socket)); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
    } catch (error) { await this.#discard(server); throw error; }
    if(this.#closed) { await this.#discard(server); throw new Error('Companion transport is unavailable.'); }
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || !Number.isInteger(address.port)) {
      await this.#discard(server); throw new Error('Companion transport did not bind loopback.');
    }
    server.unref();
    this.#server = server;
    this.#port = address.port;
  }

  /**
   * A server that never reached #server cannot be reaped later, so an
   * unsuccessful bind has to release its port and any accepted socket before
   * it throws.
   */
  async #discard(server: http.Server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  #headers(response: ServerResponse, type = 'application/json; charset=utf-8', csp = CSP) {
    response.setHeader('Content-Type', type);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', csp);
  }

  #send(response: ServerResponse, status: number, body: string | Buffer, type?: string, csp?: string) {
    if (response.writableEnded || response.destroyed) return;
    this.#headers(response, type, csp);
    response.writeHead(status); response.end(body);
  }

  #sameOrigin(request: IncomingMessage) {
    const host = `127.0.0.1:${this.#port}`;
    if (request.headers.host !== host) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    const origin = request.headers.origin;
    return !origin || origin === `http://${host}`;
  }

  #link(request: IncomingMessage) {
    const auth = request.headers.authorization;
    const match = /^Bearer ([a-f0-9]{64})$/.exec(auth ?? '');
    if (!match) return undefined;
    this.#prune();
    const link = this.#links.get(match[1]);
    if (!link || !safeEqual(match[1], link.token)) return undefined;
    link.lastUsed = this.#now();
    return link;
  }

  async #readJson(request: IncomingMessage) {
    const contentLength = request.headers['content-length'];
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) throw new Error('body_too_large');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
      chunks.push(Buffer.from(chunk));
    }
    if (!size) throw new Error('invalid_request');
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!plainRecord(value) || Object.keys(value).some(key=>key!=='name'&&key!=='args') || typeof value.name !== 'string' || !plainRecord(value.args)) throw new Error('invalid_request');
      return value as { name: string; args: Record<string, unknown> };
    } catch { throw new Error('invalid_request'); }
  }

  async #freshSource(link: Link): Promise<FreshSource> {
    const source = await this.#source(link.sessionId, link.sourceToken);
    if (!source || typeof source.text !== 'string' || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) {
      throw new Error('source_unavailable');
    }
    const bytes = Buffer.from(source.text, 'utf8');
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('source_unavailable');
    return { ...source, bytes };
  }

  /**
   * The session's map, hashed here rather than trusted.
   *
   * `#freshSource` re-digests the coordinates on every send because the thing
   * being protected is what the page draws, and that is exactly as true of a
   * map. The digest is computed over the BYTES — there is no text, no encoding
   * and no catalog to cross-check it against, so this and the page's own
   * re-digest are the only two checks the map ever gets.
   */
  async #freshDensity(link: Link): Promise<Density> {
    if (!this.#density) throw new Error('density_unavailable');
    const density = await this.#density(link.sessionId, link.sourceToken);
    if (!density || !Buffer.isBuffer(density.bytes) || density.bytes.byteLength < 1
      || typeof density.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(density.sha256)
      || typeof density.contour !== 'number' || !Number.isFinite(density.contour)) {
      throw new Error('density_unavailable');
    }
    if (createHash('sha256').update(density.bytes).digest('hex') !== density.sha256) throw new Error('density_unavailable');
    return density;
  }

  #withoutCoordinates(result: ToolResult, source: FreshSource, density?: Density) {
    const copy = structuredClone(result) as ToolResult;
    const meta = copy._meta;
    if (!plainRecord(meta) || !plainRecord(meta[PRIVATE_INSPECTION_META_KEY])) return copy;
    const privateMeta = meta[PRIVATE_INSPECTION_META_KEY] as Record<string, unknown>;
    delete privateMeta.structureText;
    const handoff = privateMeta.nativeStructureViewerHandoff;
    if (!plainRecord(handoff) || handoff.kind !== 'public-pdb') delete privateMeta.nativeStructureViewerHandoff;
    privateMeta.source = { url: '/source', sha256: source.sha256, bytes: source.bytes.byteLength };
    // The map's descriptor sits beside the source's and is
    // absent for every atomic tier, which is how the page knows whether to ask
    // for one at all. The contour travels here and again as a response header:
    // the page compares them, so a level cannot be changed by one of the two.
    if (density) privateMeta.density = { url: '/density', sha256: density.sha256, bytes: density.bytes.byteLength, contour: density.contour };
    else delete privateMeta.density;
    return copy;
  }

  async #handle(request: IncomingMessage, response: ServerResponse) {
    if (this.#active >= MAX_ACTIVE_REQUESTS) { this.#send(response, 429, errorBody('busy')); return; }
    this.#active++;
    let extended = false;
    try {
      if (this.#closed || !this.#sameOrigin(request)) { this.#send(response, 403, errorBody('forbidden')); return; }
      // The wearer's page, and the only route that admits a
      // query — `?xrRenderBudget=` and nothing else. See `isPageRoute`.
      if (isPageRoute(request.url, '/') && request.method === 'GET') { this.#send(response, 200, this.#html!, 'text/html; charset=utf-8'); return; }
      if (request.url === '/xr-check' && request.method === 'GET') { this.#send(response, 200, XR_CHECK_HTML, 'text/html; charset=utf-8'); return; }
      // The detailed page and the library behind it carry no structure, so
      // they are readable without a bearer exactly as the inspector page is.
      // The handoff below, which does carry coordinates, is not.
      if (request.method === 'GET' && (request.url === DETAILED_VIEW_ROUTES.page
          || request.url === DETAILED_VIEW_ROUTES.script || request.url === DETAILED_VIEW_ROUTES.style)) {
        if (!this.#detailed || !this.#molstarRoots) { this.#send(response, 404, errorBody('not_found')); return; }
        try {
          const bundle = await this.#viewerBundle();
          if (request.url === DETAILED_VIEW_ROUTES.page) this.#send(response, 200, this.#detailedHtml!, 'text/html; charset=utf-8', DETAILED_VIEW_CSP);
          else if (request.url === DETAILED_VIEW_ROUTES.script) this.#send(response, 200, bundle.script, 'text/javascript; charset=utf-8');
          else this.#send(response, 200, bundle.style, 'text/css; charset=utf-8');
        } catch { this.#send(response, 409, errorBody('viewer_unavailable')); }
        return;
      }
      if (request.url !== '/source' && request.url !== '/density' && request.url !== '/tool' && request.url !== DETAILED_VIEW_ROUTES.handoff) { this.#send(response, 404, errorBody('not_found')); return; }
      const link = this.#link(request);
      if (!link) { this.#send(response, 401, errorBody('unauthorized')); return; }
      if (request.url === DETAILED_VIEW_ROUTES.handoff) {
        if (request.method !== 'GET') { this.#send(response, 405, errorBody('method_not_allowed')); return; }
        if (!this.#detailed) { this.#send(response, 404, errorBody('not_found')); return; }
        try { this.#send(response, 200, JSON.stringify(await this.#detailed(link.sessionId, link.sourceToken))); }
        catch { this.#send(response, 409, errorBody('detailed_view_unavailable')); }
        return;
      }
      if (request.url === '/source') {
        if (request.method !== 'GET') { this.#send(response, 405, errorBody('method_not_allowed')); return; }
        try {
          const source = await this.#freshSource(link);
          response.setHeader('Digest', `sha-256=${createHash('sha256').update(source.bytes).digest('base64')}`);
          response.setHeader('X-Stereofold-Source-SHA256', source.sha256);
          this.#send(response, 200, source.bytes, 'chemical/x-mmcif; charset=utf-8');
        } catch { this.#send(response, 409, errorBody('source_unavailable')); }
        return;
      }
      if (request.url === '/density') {
        if (request.method !== 'GET') { this.#send(response, 405, errorBody('method_not_allowed')); return; }
        if (!this.#density) { this.#send(response, 404, errorBody('not_found')); return; }
        try {
          const density = await this.#freshDensity(link);
          response.setHeader('Digest', `sha-256=${createHash('sha256').update(density.bytes).digest('base64')}`);
          response.setHeader('X-Stereofold-Density-SHA256', density.sha256);
          // The level the mesh is built at is not a JSON field the page can be
          // talked out of: it arrives on the response that carries the bytes.
          response.setHeader('X-Stereofold-Density-Contour', String(density.contour));
          this.#send(response, 200, density.bytes, 'application/octet-stream');
        } catch { this.#send(response, 409, errorBody('density_unavailable')); }
        return;
      }
      if (request.method !== 'POST' || request.headers.origin !== `http://127.0.0.1:${this.#port}`
          || request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) {
        this.#send(response, 400, errorBody('invalid_request')); return;
      }
      let operation = 'unknown';
      try {
        const input = await this.#readJson(request);
        operation = input.name.slice(0, 80);
        if (!TOOLS.has(input.name) || ('sessionId' in input.args && typeof input.args.sessionId !== 'string')) {
          this.#send(response, 400, errorBody('invalid_request')); return;
        }
        // Distinct from a malformed request: a page left on an earlier session
        // after a restart or a re-share recovers by reading the link's session.
        if ('sessionId' in input.args && input.args.sessionId !== link.sessionId) {
          this.#send(response, 400, errorBody('session_changed', 'This link shares a different session.')); return;
        }
        // The LAN listener, the Quest link and a loopback page all end here.
        // See inspection-page-source.ts.
        const refusal = pageSourceRefusal(input.name, input.args);
        if (refusal) { this.#send(response, 403, errorBody('source_not_allowed', refusal)); return; }
        // The socket idles while the Mac works, so a tool with a longer page
        // deadline holds it for its own ceiling; the finally below puts it back.
        const ceiling = this.#ceiling(input.name);
        if (ceiling !== this.#ceiling('')) { request.socket.setTimeout?.(ceiling); extended = true; }
        // Dispatch hydration before reading coordinates so a heartbeat after
        // a desktop-origin transition can authorize this bearer onto the new
        // source first.
        let source: FreshSource|undefined;
        // `poll_detailed_view` joins the two reads that skip
        // this. It touches no coordinates — it asks whether one sentence is
        // waiting — and it runs every two seconds for as long as a wearer
        // studies a structure, so hydrating the source behind it would put a
        // needless round trip between the panel and every other caller.
        // `get_inspection_bytes` is a read of one slice by offset, and the page
        // makes hundreds of them for a large comparison. Re-digesting the whole
        // primary source before each one would cost more than the slice.
        if(input.name!=='get_inspection' && input.name!=='get_inspection_bytes' && input.name!=='poll_inspection' && input.name!=='poll_detailed_view') await this.#source(link.sessionId,link.sourceToken);
        const dispatchedSourceToken = link.sourceToken;
        const result = await this.#dispatch(link.sessionId, dispatchedSourceToken, input.name, { ...input.args, sessionId: link.sessionId });
        // A successful, server-authorized experience transition is the one
        // deliberate capability re-target. Normal source replacement still
        // revokes the companion URL at the dispatcher boundary.
        const transition = plainRecord(result?.structuredContent) && ((input.name === 'navigate_experience' && plainRecord(result.structuredContent.experienceTransition) && result.structuredContent.experienceTransition.sourceChanged === true) || ((input.name === 'replace_inspection_source' || input.name === 'grow_structure') && plainRecord(result.structuredContent.sourceTransition) && result.structuredContent.sourceTransition.sourceChanged === true));
        const readRetarget = (input.name==='poll_inspection' || input.name==='get_inspection')
          && typeof result?.structuredContent?.sourceToken === 'string'
          && result.structuredContent.sourceToken !== link.sourceToken;
        const replacement = (transition || readRetarget) && typeof result.structuredContent.sourceToken === 'string' ? result.structuredContent.sourceToken : undefined;
        if (replacement) this.#retargetLink(link, dispatchedSourceToken, replacement);
        let density: Density|undefined;
        if(input.name==='get_inspection') {
          source=await this.#freshSource(link);
          // An atomic tier has no map and must not fail hydration over it.
          if(this.#density) density=await this.#freshDensity(link).catch(()=>undefined);
        }
        const value = source ? this.#withoutCoordinates(result, source, density) : result;
        this.#send(response, 200, JSON.stringify(value));
      } catch (error) {
        const reason = error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240) : 'unknown error';
        console.error(`Stereofold companion request failed (${operation}): ${reason}`);
        this.#send(response, error instanceof Error && error.message === 'body_too_large' ? 413 : 409,
          errorBody('request_failed', error instanceof Error && error.message === 'body_too_large' ? undefined : reason));
      }
    } finally { this.#active--; if (extended) request.socket.setTimeout?.(this.#ceiling('')); }
  }
}
