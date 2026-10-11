import { createHash, createPrivateKey, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir, networkInterfaces, tmpdir, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { Transform, type Duplex } from 'node:stream';
import { pairFragmentSource } from './inspection-pair-fragment.js';
import { keepPageKeySource, pageKeySource } from './inspection-page-key.js';
import { isPageRoute, renderBudgetSearchSource } from './inspection-page-route.js';
import { pageSourceRefusal } from './inspection-page-source.js';
import { companionRequestCeilingMs } from './inspection-limits.js';
import { RememberedDeviceStore, rememberingEnabled, type RememberedDevice } from './inspection-remembered-devices.js';
import { DETAILED_VIEW_ROUTES } from './detailed-view-page.js';
// @ts-ignore Shared JavaScript headset-capability module.
import { deviceClass as classifyDevice } from '../../lab/browser-roundtrip/input-capabilities.mjs';

// @ts-ignore Shared pairing-page recovery helper.
import { pairingRecovery } from '../../lab/browser-roundtrip/pairing-recovery.mjs';

export type PairingFailure = { launchId: string; failure: 'device_key_missing' | 'device_not_remembered' };

const DEFAULT_PORT = 8443;

/**
 * The full Mol* viewer lives on the same loopback companion as the panel, so
 * a headset that reached this listener can open it on this origin instead of
 * on the Mac. These three carry no structure and are read without a bearer,
 * exactly as `/viewer` is. `DETAILED_VIEW_ROUTES.handoff`, which does carry
 * coordinates, stays behind a paired client's token with `/source`.
 */
const DETAILED_PAGE_PATHS: ReadonlySet<string> = new Set([DETAILED_VIEW_ROUTES.page, DETAILED_VIEW_ROUTES.script, DETAILED_VIEW_ROUTES.style]);

/**
 * The LAN companion normally listens on DEFAULT_PORT. STEREOFOLD_LAN_PORT
 * lets a caller (a test harness sharing the machine with other listeners)
 * override that default without changing the documented default itself.
 * Read at listen time — an explicit `port` argument to `open()` still wins.
 */
export function defaultLanPort(): number {
  const raw = process.env.STEREOFOLD_LAN_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    console.warn(`Ignoring invalid STEREOFOLD_LAN_PORT value ${JSON.stringify(raw)} (expected an integer between 1024 and 65535); using default port ${DEFAULT_PORT}.`);
    return DEFAULT_PORT;
  }
  return parsed;
}
const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const SESSION_LIFETIME_MS = 30 * 60 * 1000;
/**
 * The hard ceiling on one shared session, measured from `open`. Activity pushes
 * the expiry out, so a demo cannot end under a headset that is still calling;
 * this is what stops an unattended listener from being renewed forever.
 */
const SESSION_MAX_LIFETIME_MS = 8 * 60 * 60 * 1000;
/** A deliberate wearer-session ceiling; ordinary launches keep the eight-hour default. */
export function shareMaxLifetimeMs(raw: string | undefined = process.env.STEREOFOLD_SHARE_MAX_HOURS): number {
  if (raw === undefined || raw === '') return SESSION_MAX_LIFETIME_MS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < .5 || hours > 24)
    throw TypeError('STEREOFOLD_SHARE_MAX_HOURS / --share-hours must be hours from 0.5 through 24.');
  return hours * 60 * 60 * 1000;
}
/** How long before a share closes an agent is told, so the wearer can be warned first. */
export const SHARE_NOTICE_MS = 15 * 60 * 1000;
/** A share that closes inside the notice window, or one that already ran out of time. */
export type ShareNotice = { state: 'closing' | 'closed'; reason: 'ceiling' | 'idle'; at: string };
/**
 * How long a paired capability counts as still worn.
 *
 * The companion beats once a second and the host already grants a sixty-second
 * heartbeat grace for a headset that was taken off, so a capability used inside
 * that window belongs to a page that is still there. Redemption may replace the
 * ones outside it and no others.
 */
export const CLIENT_ACTIVE_MS = 60 * 1000;
/** One headset is a handful of pages, never an unbounded stream of them. */
const MAX_CLIENTS_PER_DEVICE = 4;
const MAX_PAIR_ATTEMPTS = 6;
const MAX_PAIR_SOURCES = 256;
const PAIR_WINDOW_MS = 60 * 1000;
const MAX_BODY_BYTES = 1024;
const MAX_TOOL_BODY_BYTES = 2 * 1024 * 1024 + 16 * 1024;
// How long one authenticated proxy request may run is
// `companionRequestCeilingMs(tool)`: 55 seconds for the voice helpers' 45 second
// limit plus a margin, and the page's own longer deadline plus the same margin
// for `navigate_experience`.
const MAX_ACTIVE_REQUESTS = 8;
// Raw sockets are accepted before any header is parsed, so the per-request cap
// cannot bound a slow-header flood. Node destroys anything past this outright.
const MAX_CONNECTIONS = 32;
export const OPENSSL_PATHS = ['/usr/bin/openssl', '/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/bin/openssl'] as const;
export const ALLOWED_TOOLS = new Set(['get_inspection', 'get_inspection_bytes', 'sync_inspection', 'attach_inspection', 'poll_inspection', 'complete_inspection','report_source_failure', 'detach_inspection', 'undo_last_change', 'redo_last_change', 'push_to_talk', 'push_to_talk_audio', 'navigate_experience', 'acknowledge_experience_step', 'replace_inspection_source', 'grow_structure', 'voice_command', 'voice_acknowledgement', 'speak_to_headset', 'claim_voice_intent', 'acknowledge_voice_intent', 'acknowledge_voice_playback', 'open_detailed_view', 'return_detailed_view', 'poll_detailed_view', 'report_detailed_selection', 'submit_headset_view']);

/**
 * How the paired browser identifies its hardware, so the agent can pick a
 * scene tier without asking the wearer. This is the same classifier the
 * headset runtime uses; from the Mac only the User-Agent is available, so a
 * runtime that does not name its model reads as `unknown`, which no caller
 * bounds: only a Quest 2 has a measured ceiling, and visionOS Safari names no
 * model at all. The header is attacker-controlled text from a
 * LAN peer: it is only ever matched against this fixed set of names.
 */
export type HeadsetClass = 'quest2' | 'quest3' | 'quest-pro' | 'vision-pro' | 'hand-only' | 'unknown';
export function headsetClass(userAgent?: string): HeadsetClass {
  try { return classifyDevice({ userAgent: typeof userAgent === 'string' ? userAgent : '' }, []) as HeadsetClass; }
  catch { return 'unknown'; }
}

type Interface = { address: string; family: string | number; internal?: boolean };
type Target = { port: number; token: string };
type Client = { id: string; token: string; createdAt: number; lastUsedAt: number; deviceId?: string; deviceClass: HeadsetClass };
type PairAttempt = { count: number; startedAt: number };
export type LanAddress = { address: string; interface: string };
export type LanCertificate = { key: Buffer; cert: Buffer; fingerprint: string };
export type LanCompanionStatus = {
  url: string; host: string; port: number; fingerprint: string; pairingExpiresAt: string; sessionExpiresAt: string;
  /** The ceiling activity cannot push `sessionExpiresAt` past. */
  sessionMaxExpiresAt: string;
  lastAuthorizedAt?: string;
  launchId: string;
  pairingFailure?: PairingFailure;
  clients: Array<{ id: string; createdAt: string; lastUsedAt: string; deviceId?: string; deviceClass: HeadsetClass }>;
};
export type LanCompanionResult = LanCompanionStatus & { pairingCode: string };

type Spawn = (command: string, args: readonly string[], options: { shell: false; stdio: 'ignore'; windowsHide: true }) => ChildProcess;
export type LanCompanionOptions = {
  /** Associate an authenticated tool heartbeat with its LAN pairing. */
  onPanelHeartbeat?: (clientId: string, panelId: string) => void;
  /** Override in bounded tests; production stores only in Application Support. */
  certificateStore?: string;
  interfaces?: () => NodeJS.Dict<Interface[]>;
  createCertificate?: (host: string, directory: string) => Promise<LanCertificate>;
  spawn?: Spawn;
  now?: () => number;
  randomToken?: () => string;
  pairingLifetimeMs?: number;
  sessionLifetimeMs?: number;
  /** Ceiling on a renewed session, from `open`. Override in bounded tests. */
  sessionMaxLifetimeMs?: number;
  /** Off with `--no-remember`; a paired headset is then never handed a device key. */
  remember?: boolean;
  deviceStore?: RememberedDeviceStore;
  deviceLifetimeMs?: number;
  /** How long a `/tool` request may run, by tool name. Override in bounded tests. */
  requestCeilingMs?: (tool: string) => number;
};

type State = {
  server: https.Server; sockets: Set<Duplex>; socketClients: Map<Duplex, string>; host: string; port: number; target: Target;
  toolSockets: Set<Duplex>;
  fingerprint: string; pairingCode: string; pairingExpiresAt: number; sessionExpiresAt: number; openedAt: number;
  launchId: string; pairingFailure?: PairingFailure; recoveryConsumed?: boolean; lastAuthorizedAt?: number;
  clients: Map<string, Client>; attempts: Map<string, PairAttempt>; active: number; expiryTimer: ReturnType<typeof setTimeout>; closed: boolean;
};

function isPrivateIPv4(value: string) {
  const parts = value.split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
}

function safeEqual(value: string | undefined, expected: string) {
  if (!value) return false;
  const actual = Buffer.from(value), wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function targetFrom(value: string): Target {
  let url: URL;
  try { url = new URL(value); } catch { throw Error('LAN companion requires a locally issued loopback companion URL.'); }
  const port = Number(url.port);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535
    || url.username || url.password || url.pathname !== '/' || url.search || !/^#[a-f0-9]{64}$/.test(url.hash))
    throw Error('LAN companion requires a locally issued loopback companion URL.');
  return { port, token: url.hash.slice(1) };
}

/**
 * A desktop host can launch this server with HOME unset or relative, which
 * would place private keys under a cwd-relative path. The password-database
 * home is preferred over the environment, and a private directory under the
 * system temporary directory is the last resort, so an odd host still gets an
 * absolute store instead of a silently cwd-relative one.
 */
export function defaultCertificateStore(environment: NodeJS.ProcessEnv = process.env): string {
  // An isolated host must keep its test certificates and remembered devices
  // outside the user's real pairing store without changing the process HOME.
  const configured = environment.STEREOFOLD_LAN_CERTIFICATE_STORE;
  if (configured !== undefined) {
    if (!configured || !isAbsolute(configured)) throw Error('STEREOFOLD_LAN_CERTIFICATE_STORE must be an absolute directory path.');
    return configured;
  }
  let account = '';
  try { account = userInfo().homedir; } catch { /* No password-database entry for this uid. */ }
  for (const home of [homedir(), account]) if (typeof home === 'string' && isAbsolute(home)) return join(home, 'Library', 'Application Support', 'Stereofold', 'lan');
  const temporary = tmpdir();
  return join(isAbsolute(temporary) ? temporary : '/tmp', 'Stereofold', 'lan');
}

/**
 * Hosts launch this server with a stripped PATH, and a PATH lookup for the tool
 * that writes a private key is worth avoiding regardless.
 */
function opensslCommand(): string {
  for (const candidate of OPENSSL_PATHS) { try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Try the next known location. */ } }
  throw Error('openssl was not found at a known absolute path, so the LAN certificate cannot be created.');
}

/**
 * Opening once with O_NOFOLLOW and stating that handle closes the window an
 * lstat-then-readFile pair leaves open, where the checked regular file can be
 * replaced by a symbolic link before the read.
 */
async function readNoFollow(path: string, mode?: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    throw error?.code === 'ELOOP' ? Error('LAN certificate files must not be symbolic links.') : error;
  });
  try {
    if (!(await handle.stat()).isFile()) throw Error('LAN certificate files must not be symbolic links.');
    if (mode !== undefined) await handle.chmod(mode);
    return await handle.readFile();
  } finally { await handle.close(); }
}

function certificateFingerprint(cert: Buffer) {
  const pem = cert.toString('utf8').replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '');
  if (!pem) throw Error('LAN certificate is invalid.');
  return createHash('sha256').update(Buffer.from(pem, 'base64')).digest('hex').match(/.{1,2}/g)!.join(':').toUpperCase();
}

/** Lists only assigned RFC1918 IPv4 addresses; callers choose the LAN interface deliberately. */
export function listLanAddresses(interfaces: () => NodeJS.Dict<Interface[]> = networkInterfaces): LanAddress[] {
  const result: LanAddress[] = [];
  for (const [name, entries] of Object.entries(interfaces())) for (const entry of entries ?? []) {
    if (!entry.internal && (entry.family === 'IPv4' || entry.family === 4) && isPrivateIPv4(entry.address)) result.push({ address: entry.address, interface: name });
  }
  return result.sort((a, b) => a.interface.localeCompare(b.interface) || a.address.localeCompare(b.address));
}

/** Every live share serves this title at `/` to anyone, which is how a busy port is told apart. */
const PAIRING_TITLE = '<title>Pair Stereofold</title>';
/** The busy-port probe only chooses which advice to give, so it is short and reads little. */
const HOLDER_PROBE_MS = 2_000;
const HOLDER_PROBE_BYTES = 4 * 1024;

/**
 * The page holds no pairing secret of its own. It accepts the code the desktop
 * shows, and afterwards may hold a device key this origin's storage was given,
 * which it presents before drawing the form. A returning headset therefore sees
 * no code prompt while its key is still valid, and a rejected key is deleted.
 *
 * A first visit can be spared the typing too: a `#pair=<code>` fragment on the
 * opening link is read and erased before anything else runs, then spent through
 * the same `/pair` body a typed code uses. A stored key still wins, and a
 * fragment that fails falls back to the form with the same message a wrong
 * typed code gets. See `inspection-pair-fragment.ts`.
 */
export function pairingHtml() {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${PAIRING_TITLE}<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#071015;color:#e8fbfa;font:18px/1.45 system-ui}main{box-sizing:border-box;width:min(100%,34rem);padding:2rem}h1{font-size:1.7rem}label{display:grid;gap:.6rem}input,button{font:inherit;padding:.8rem;border-radius:.5rem}input{letter-spacing:.14em;background:#18383a;color:#fff;border:1px solid #54847f}button{margin-top:1rem;background:#7fe5d2;color:#071015;border:0;font-weight:700}#status{min-height:1.5em}[hidden]{display:none}</style><main><h1>Pair Stereofold</h1><p>Your Mac pairs this headset through its launch notification.</p><form><label>Pairing code <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required></label><button>Pair</button></form><p id="status" role="status"></p></main><script>(()=>{const knobs=${renderBudgetSearchSource()};const held=${pageKeySource(false)};if(held.key){location.replace('/viewer'+knobs+held.fragment);return}const recovery=(${pairingRecovery.toString()})(location,history,typeof fetch==='function'?fetch:undefined);const fragmentCode=${pairFragmentSource()};recovery.clear();const form=document.querySelector('form'),status=document.querySelector('#status'),STORE='stereofold.device';const read=()=>{try{const raw=localStorage.getItem(STORE);if(!raw)return null;const value=JSON.parse(raw);return /^[a-f0-9]{32}$/.test(value&&value.deviceId)&&/^[a-f0-9]{64}$/.test(value&&value.deviceKey)?{deviceId:value.deviceId,deviceKey:value.deviceKey}:null}catch(error){return null}};const forget=()=>{try{localStorage.removeItem(STORE)}catch(error){}};const enter=data=>{if(!/^[a-f0-9]{64}$/.test(data.token))throw Error('Pairing failed.');if(/^[a-f0-9]{32}$/.test(data.deviceId||'')&&/^[a-f0-9]{64}$/.test(data.deviceKey||'')){try{localStorage.setItem(STORE,JSON.stringify({deviceId:data.deviceId,deviceKey:data.deviceKey}))}catch(error){}}location.replace('/viewer'+knobs+${keepPageKeySource('data.token')})};const pair=async body=>{const response=await fetch('/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit'});const data=await response.json();if(!response.ok)throw Error(data&&data.error||'Pairing failed.');return data};const CODE_FAILED='That pairing link could not be used. Restart the launch on your Mac.';const showForm=message=>{form.hidden=false;status.textContent=message};const useCode=code=>{form.hidden=true;status.textContent='Pairing\u2026';return pair({code:code,remember:true}).then(enter).catch(()=>showForm(CODE_FAILED))};form.addEventListener('submit',async event=>{event.preventDefault();status.textContent='Pairing\u2026';try{enter(await pair({code:new FormData(form).get('code'),remember:true}))}catch(error){status.textContent=CODE_FAILED}});window.addEventListener('hashchange',()=>{const code=${pairFragmentSource()};if(code)void useCode(code)});const remembered=read();if(remembered){form.hidden=true;status.textContent='Opening the remembered headset\u2026';pair(remembered).then(enter).catch(async error=>{if(error.message!=='device_not_remembered'){showForm('Pairing could not reach the Mac.');return}forget();if(fragmentCode)return useCode(fragmentCode);form.hidden=true;status.textContent=await recovery.report('device_not_remembered')?'Tap the new notification to pair this headset.':'Pairing needs recovery on the Mac.'})}else if(fragmentCode)useCode(fragmentCode);else if(recovery.active){form.hidden=true;status.textContent='Waiting for the Mac to send a new notification.';void recovery.report('device_key_missing');}})()</script>`;
}

/**
 * Whether `https://host:port/` answers with the pairing page. The certificate
 * goes unchecked on purpose: the answer only names who holds the port, and the
 * request carries nothing.
 */
export function servesPairingPage(host: string, port: number, timeoutMs = HOLDER_PROBE_MS): Promise<boolean> {
  return new Promise(resolve => {
    let body = '';
    const request = https.get({ host, port, path: '/', headers: { host: `${host}:${port}` }, agent: false, rejectUnauthorized: false,
      signal: AbortSignal.timeout(timeoutMs) }, response => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; if (body.includes(PAIRING_TITLE) || body.length >= HOLDER_PROBE_BYTES) response.destroy(); });
      response.on('error', () => {}).on('close', () => resolve(body.includes(PAIRING_TITLE)));
    });
    request.on('error', () => resolve(false));
  });
}

/** Why a share could not take its port, with the way out for each kind of holder. */
async function portHeld(host: string, port: number): Promise<Error> {
  const address = `${host}:${port}`;
  const message = await servesPairingPage(host, port).catch(() => false)
    ? `The Wi-Fi share cannot listen on ${address}: another Stereofold share on this Mac already does, most likely one opened in another assistant conversation. `
      + 'Call continue_session to join its scene. With role=attached, load structures into the sessionId it returns and open no share here. '
      + 'With role=none, ask the person to have the other assistant call continue_session once, which shares its scene, then call continue_session here again. '
      + 'With role=owner, this conversation shares its own scene, which that headset does not show. '
      + 'To show the structure open here on that headset instead, ask the person to stop the other share with manage_companion action="close" in that conversation, or to end that conversation, then call open_companion here again.'
    : `The Wi-Fi share cannot listen on ${address}: another program on this Mac already does, and it did not answer as a Stereofold share. `
      + `Run lsof -nP -iTCP:${port} -sTCP:LISTEN to name that program, then stop it and call open_companion again. `
      + 'Or call open_companion with another lanPort from 1024 to 65535; a headset then needs the new address.';
  return Object.assign(Error(message), { code: 'EADDRINUSE' });
}

export class LanCompanion {
  readonly #onPanelHeartbeat?: LanCompanionOptions['onPanelHeartbeat'];
  readonly #store: string;
  readonly #interfaces: () => NodeJS.Dict<Interface[]>;
  readonly #createCertificate: (host: string, directory: string) => Promise<LanCertificate>;
  readonly #now: () => number;
  readonly #randomToken: () => string;
  readonly #pairingLifetimeMs: number;
  readonly #sessionLifetimeMs: number;
  readonly #sessionMaxLifetimeMs: number;
  readonly #devices?: RememberedDeviceStore;
  readonly #ceiling: (tool: string) => number;
  #state?: State;
  /**
   * The deadline of the last session that ran out, so a wearer whose share
   * went quiet mid-demo can be told when and what to ask for. Cleared when a
   * listener opens again. Undefined after an explicit close, which needs no
   * explanation.
   */
  #expiredAt?: number;
  /** Which rule ran it out: the ceiling from `open`, or a session lifetime with no paired request. */
  #expiredReason: ShareNotice['reason'] = 'idle';
  #serial: Promise<unknown> = Promise.resolve();

  constructor({ certificateStore = defaultCertificateStore(), interfaces = networkInterfaces,
    createCertificate, spawn = nodeSpawn as unknown as Spawn, now = Date.now, randomToken = () => randomBytes(32).toString('hex'),
    pairingLifetimeMs = PAIRING_LIFETIME_MS, sessionLifetimeMs = SESSION_LIFETIME_MS, sessionMaxLifetimeMs = SESSION_MAX_LIFETIME_MS,
    remember = rememberingEnabled(), deviceStore, deviceLifetimeMs, onPanelHeartbeat, requestCeilingMs = companionRequestCeilingMs }: LanCompanionOptions = {}) {
    if (!certificateStore || typeof certificateStore !== 'string' || !isAbsolute(certificateStore) || typeof interfaces !== 'function'
      || typeof now !== 'function' || typeof randomToken !== 'function'
      || !Number.isFinite(pairingLifetimeMs) || pairingLifetimeMs <= 0 || !Number.isFinite(sessionLifetimeMs) || sessionLifetimeMs <= 0
      || !Number.isFinite(sessionMaxLifetimeMs) || sessionMaxLifetimeMs < sessionLifetimeMs || typeof requestCeilingMs !== 'function'
      || !Number.isFinite(requestCeilingMs('')) || requestCeilingMs('') <= 0 || !Number.isFinite(requestCeilingMs('navigate_experience')) || requestCeilingMs('navigate_experience') <= 0)
      throw TypeError('LanCompanion requires an absolute certificate store and valid network and lifetime options.');
    this.#ceiling = requestCeilingMs;
    this.#store = certificateStore; this.#interfaces = interfaces; this.#now = now; this.#randomToken = randomToken;
    this.#onPanelHeartbeat = onPanelHeartbeat;
    this.#pairingLifetimeMs = pairingLifetimeMs; this.#sessionLifetimeMs = sessionLifetimeMs; this.#sessionMaxLifetimeMs = sessionMaxLifetimeMs;
    this.#createCertificate = createCertificate ?? ((host, directory) => this.#certificate(host, directory, spawn));
    // The device file lives beside the private key in the same 0700 store, so
    // remembering adds no second protected location to reason about.
    this.#devices = remember === false ? undefined
      : deviceStore ?? new RememberedDeviceStore({ directory: certificateStore, now, ...(deviceLifetimeMs === undefined ? {} : { lifetimeMs: deviceLifetimeMs }) });
  }

  /** True when a paired headset can be handed a device key on this run. */
  get remembering(): boolean { return this.#devices !== undefined; }

  /** Every unexpired remembered device, whether or not a listener is running. */
  async rememberedDevices(): Promise<RememberedDevice[]> { return this.#devices ? this.#devices.list() : []; }

  /**
   * Revoke one remembered device, or every one with 'all'. A revoked device's
   * live session ends with it; leaving that session running would keep serving
   * the headset the key it just lost.
   */
  async forgetDevices(deviceId: string): Promise<string[]> {
    if (!this.#devices || typeof deviceId !== 'string' || !deviceId) return [];
    const forgotten = await this.#devices.forget(deviceId);
    return this.#run(async () => {
      const state = this.#live();
      if (state) for (const [id, client] of [...state.clients]) {
        if (client.deviceId && forgotten.includes(client.deviceId)) { state.clients.delete(id); this.#dropSockets(state, id); }
      }
      return forgotten;
    });
  }

  async open({ url, host, port = defaultLanPort() }: { url: string; host?: string; port?: number }): Promise<LanCompanionResult> {
    return this.#run(async () => {
      const target = targetFrom(url);
      const selected = this.#selectHost(host);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('LAN companion port must be between 1 and 65535.');
      const current = this.#state;
      if (current && !current.closed && this.#now() < current.sessionExpiresAt && current.host === selected && current.port === port) {
        // Re-opening onto the SAME loopback capability is the
        // desktop asking for its address again, not a new capability. Clearing
        // the client map there tells a headset that is still wearing this exact
        // share that its bearer is gone, and the page then re-pairs every
        // fifteen seconds for the rest of the session. Only a capability the
        // old pairings must not reach retires them.
        const replaced = current.target.port !== target.port || !safeEqual(current.target.token, target.token);
        // A completed setup may be retried while the wearer is still opening
        // its link. Keep that link and its recovery identity until the code is
        // spent, expires, or the underlying capability actually changes.
        const freshPairing = replaced || !current.pairingCode || this.#now() >= current.pairingExpiresAt;
        if (freshPairing) { current.launchId = randomBytes(16).toString('hex'); current.pairingFailure = undefined; }
        if (replaced) current.recoveryConsumed = false;
        current.target = target;
        if (replaced) { current.clients.clear(); current.attempts.clear(); this.#dropSockets(current); }
        this.#expiredAt = undefined;
        this.#renewSession(current, replaced);
        if (freshPairing) this.#refreshPairing(current);
        return this.#opened(current);
      }
      await this.#close(current);
      const certificate = await this.#createCertificate(selected, this.#store);
      const sockets = new Set<Duplex>();
      const socketClients = new Map<Duplex, string>();
      const server = https.createServer({ key: certificate.key, cert: certificate.cert, requestTimeout: this.#ceiling(''), headersTimeout: Math.min(5_000, this.#ceiling('')), maxHeaderSize: 8_192 },
        (request, response) => { void this.#handle(request, response); });
      server.setTimeout(this.#ceiling(''), socket => socket.destroy());
      server.maxConnections = MAX_CONNECTIONS;
      server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); socketClients.delete(socket); }); });
      try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, selected, () => { server.off('error', reject); resolve(); }); }); }
      catch (error) {
        await this.#discard(server, sockets);
        throw (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? await portHeld(selected, port) : error;
      }
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== selected || !Number.isInteger(address.port)) { await this.#discard(server, sockets); throw Error('LAN companion did not bind the selected private address.'); }
      const now = this.#now();
      const state: State = { server, sockets, socketClients, toolSockets: new Set(), host: selected, port: address.port, target, fingerprint: certificate.fingerprint, pairingCode: '', pairingExpiresAt: 0,
        sessionExpiresAt: now + this.#sessionLifetimeMs, openedAt: now, launchId: randomBytes(16).toString('hex'), clients: new Map(), attempts: new Map(), active: 0, expiryTimer: undefined as any, closed: false };
      this.#armExpiry(state);
      this.#state = state; this.#expiredAt = undefined; this.#refreshPairing(state); server.unref();
      return this.#opened(state);
    });
  }

  status(): LanCompanionStatus | undefined { const state = this.#live(); return state ? this.#status(state) : undefined; }
  /** Check a captured launch without minting a code or exposing one in status. */
  matchesPairing(code: string | undefined, launchId: string): boolean {
    const state = this.#live();
    return Boolean(state && code && state.pairingCode && state.launchId === launchId
      && this.#now() < state.pairingExpiresAt && safeEqual(code, state.pairingCode));
  }
  /**
   * When the last share ran out of time, as an ISO instant. Undefined while a
   * share is live and after an explicit stop. The wearer's headset sees this
   * as a 410 or a refused connection with no reason, so the agent reads it
   * here and says what to do.
   */
  expiredAt(): string | undefined { this.#live(); return this.#expiredAt === undefined ? undefined : new Date(this.#expiredAt).toISOString(); }
  /**
   * What an agent should hear before the wearer does: that this share closes
   * within `windowMs`, or that it already ran out of time. Undefined while more
   * time is left, after an explicit stop, and when nothing was ever shared.
   */
  notice(windowMs = SHARE_NOTICE_MS): ShareNotice | undefined {
    const state = this.#live();
    if (!state) return this.#expiredAt === undefined ? undefined : { state: 'closed', reason: this.#expiredReason, at: new Date(this.#expiredAt).toISOString() };
    const closing = this.#closing(state);
    return closing.at - this.#now() > windowMs ? undefined : { state: 'closing', reason: closing.reason, at: new Date(closing.at).toISOString() };
  }
  /** Consume this launch's reported failure once, replacing the old code without another push. */
  async recoverPairing(launchId: string): Promise<string | undefined> {
    return this.#run(async () => {
      const state = this.#live();
      if (!state || state.launchId !== launchId || !state.pairingFailure || state.recoveryConsumed || state.clients.size) return undefined;
      state.recoveryConsumed = true;
      this.#refreshPairing(state);
      return state.pairingCode;
    });
  }

  /**
   * The code a fresh headset needs, for a re-launch of a listener that is
   * already running. A code that has been spent or has expired is replaced, so
   * a launch minutes after `open` still pairs; a live one is reused so two
   * launches in a row do not invalidate each other. Undefined when nothing is
   * listening, which is the caller's signal that there is nothing to launch.
   */
  async pairingCode(): Promise<string | undefined> {
    return this.#run(async () => {
      const state = this.#live();
      if (!state) return undefined;
      if (!state.pairingCode || this.#now() >= state.pairingExpiresAt) this.#refreshPairing(state);
      return state.pairingCode;
    });
  }
  /**
   * Keep the bookmark and paired LAN capabilities while replacing only the
   * internal, source-scoped loopback bearer after an explicitly authorized
   * experience/source transition. Cut old coordinate/page streams, but let
   * authenticated tool responses finish: the request causing this retarget
   * still owes its page the new binding and journey rollback/save claim.
   * The dispatcher continues to check every request's source and revisions.
   */
  async retarget(url: string): Promise<LanCompanionStatus> {
    return this.#run(async () => {
      const state = this.#live();
      if (!state) throw Error('LAN companion is not open.');
      state.target = targetFrom(url);
      this.#dropSockets(state, undefined, true);
      return this.#status(state);
    });
  }
  async revoke(clientId: string): Promise<boolean> {
    return this.#run(async () => {
      const state = this.#live();
      if (!state || typeof clientId !== 'string' || !state.clients.delete(clientId)) return false;
      this.#dropSockets(state, clientId); return true;
    });
  }
  /**
   * Closing is serialized behind a possibly in-flight open. Calling #close on
   * the current state directly races before open assigns it, which can leave a
   * listener alive after its owner believes shutdown completed.
   */
  async close(): Promise<void> { await this.#run(async () => { this.#expiredAt = undefined; await this.#close(this.#state); }); }

  #selectHost(requested?: string) {
    const available = listLanAddresses(this.#interfaces);
    if (requested !== undefined) {
      if (typeof requested !== 'string' || !available.some(entry => entry.address === requested)) throw Error('Select an assigned RFC1918 LAN address.');
      return requested;
    }
    if (available.length === 1) return available[0].address;
    const primary = available.filter(entry => entry.interface === 'en0');
    if (primary.length === 1) return primary[0].address;
    throw Error('Select a LAN address explicitly; multiple private interfaces are available.');
  }

  #live() {
    const state = this.#state;
    return state && !state.closed && this.#checkExpiry(state) ? state : undefined;
  }
  #armExpiry(state: State) {
    clearTimeout(state.expiryTimer);
    state.expiryTimer = setTimeout(() => { this.#checkExpiry(state, true); }, Math.max(0, state.sessionExpiresAt - this.#now()));
    state.expiryTimer.unref?.();
  }
  /** The timer and synchronous reads enforce the same inactivity rule. */
  #checkExpiry(state: State, close = false): boolean {
    if (state.closed) return false;
    const now = this.#now(), ceiling = state.openedAt + this.#sessionMaxLifetimeMs;
    if (now < state.sessionExpiresAt && now < ceiling) return true;
    const recent = Math.max(-Infinity, ...[...state.clients.values()].map(client => client.lastUsedAt));
    if (now < ceiling && now - recent < this.#sessionLifetimeMs) {
      state.sessionExpiresAt = Math.min(recent + this.#sessionLifetimeMs, ceiling);
      this.#armExpiry(state);
      return true;
    }
    ({ at: this.#expiredAt, reason: this.#expiredReason } = this.#closing(state));
    // Close this exact state: a queued close() could otherwise retire a newer open.
    if (close) void this.#close(state);
    return false;
  }
  /** When this share closes if no paired headset calls again, and which rule closes it. */
  #closing(state: State): { at: number; reason: ShareNotice['reason'] } {
    const ceiling = state.openedAt + this.#sessionMaxLifetimeMs;
    const recent = Math.max(-Infinity, ...[...state.clients.values()].map(client => client.lastUsedAt));
    const idle = Math.max(state.sessionExpiresAt, recent + this.#sessionLifetimeMs);
    return idle < ceiling ? { at: idle, reason: 'idle' } : { at: ceiling, reason: 'ceiling' };
  }
  /**
   * `fresh` is a new capability behind the same address — a new share, so the
   * hard stop from 6bc891f starts again with it. Re-opening onto the capability
   * that is already running is the desktop asking for its address a second
   * time, and must not hand an unattended listener another whole lifetime.
   */
  #renewSession(state: State, fresh = true) {
    const now = this.#now();
    if (fresh) { state.openedAt = now; state.lastAuthorizedAt = undefined; }
    state.sessionExpiresAt = Math.min(now + this.#sessionLifetimeMs, state.openedAt + this.#sessionMaxLifetimeMs);
    this.#armExpiry(state);
  }
  /** Every authorized request records activity, even below timer granularity. */
  #extendSession(state: State) {
    const now = this.#now(), ceiling = state.openedAt + this.#sessionMaxLifetimeMs;
    state.lastAuthorizedAt = now;
    const next = Math.min(now + this.#sessionLifetimeMs, ceiling);
    const granularity = Math.min(60_000, this.#sessionLifetimeMs / 8);
    if (next <= state.sessionExpiresAt || next - state.sessionExpiresAt < granularity) return;
    state.sessionExpiresAt = next;
    this.#armExpiry(state);
  }
  #refreshPairing(state: State) { state.pairingCode = String(10000000 + (randomBytes(4).readUInt32BE(0) % 90000000)); state.pairingExpiresAt = Math.min(state.sessionExpiresAt, this.#now() + this.#pairingLifetimeMs); }
  #status(state: State): LanCompanionStatus { return { url: `https://${state.host}:${state.port}/`, host: state.host, port: state.port, fingerprint: state.fingerprint,
    pairingExpiresAt: new Date(state.pairingExpiresAt).toISOString(), sessionExpiresAt: new Date(state.sessionExpiresAt).toISOString(),
    ...(state.lastAuthorizedAt === undefined ? {} : { lastAuthorizedAt: new Date(state.lastAuthorizedAt).toISOString() }),
    launchId: state.launchId, ...(state.pairingFailure ? { pairingFailure: state.pairingFailure } : {}),
    sessionMaxExpiresAt: new Date(state.openedAt + this.#sessionMaxLifetimeMs).toISOString(),
    clients: [...state.clients.values()].map(client => ({ id: client.id, createdAt: new Date(client.createdAt).toISOString(), lastUsedAt: new Date(client.lastUsedAt).toISOString(), deviceClass: client.deviceClass, ...(client.deviceId ? { deviceId: client.deviceId } : {}) })) }; }
  #opened(state: State): LanCompanionResult { return { ...this.#status(state), pairingCode: state.pairingCode }; }
  #run<T>(work: () => Promise<T>) { const next = this.#serial.then(work, work); this.#serial = next.then(() => undefined, () => undefined); return next; }

  /**
   * An invalidated bearer must stop streaming at once. #upstream reads the
   * target only when a request starts, so a proxy already running when reuse or
   * revoke happens would otherwise keep serving the old capability until its
   * request timeout expires.
   */
  #dropSockets(state: State, clientId?: string, keepToolResponses = false) {
    // Only connections that actually carried a capability are torn down. The
    // tracked raw sockets are the TCP layer beneath TLS, so attribution is kept
    // against the TLS socket a request is served on.
    for (const [socket, id] of [...state.socketClients]) {
      if (clientId !== undefined && id !== clientId) continue;
      if (keepToolResponses && state.toolSockets.has(socket)) continue;
      state.socketClients.delete(socket); socket.destroy();
    }
  }

  /**
   * A server that never reached #state cannot be reaped later, so an
   * unsuccessful bind has to release its port and any accepted socket before
   * it throws; otherwise the next open on that port can hit EADDRINUSE.
   */
  async #discard(server: https.Server, sockets: Set<Duplex>) {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  async #close(state: State | undefined) {
    if (!state || state.closed) return; state.closed = true; if (this.#state === state) this.#state = undefined;
    clearTimeout(state.expiryTimer); state.clients.clear(); state.attempts.clear(); state.socketClients.clear(); state.toolSockets.clear();
    await this.#discard(state.server, state.sockets);
  }

  #sameHost(request: IncomingMessage, state: State) { return request.headers.host === `${state.host}:${state.port}`; }
  #origin(request: IncomingMessage, state: State, required: boolean) { const origin = request.headers.origin; return required ? origin === `https://${state.host}:${state.port}` : origin === undefined || origin === `https://${state.host}:${state.port}`; }
  #client(request: IncomingMessage, state: State) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1]; if (!token) return undefined;
    for (const client of state.clients.values()) if (safeEqual(token, client.token)) { return client; }
  }
  #headers(response: ServerResponse, contentType = 'application/json; charset=utf-8') {
    response.setHeader('Content-Type', contentType); response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  }
  #send(response: ServerResponse, status: number, body = '', type?: string) {
    if (response.writableEnded || response.destroyed) return;
    // A proxy failure after the upstream already sent headers cannot safely be
    // converted into a second JSON response. Tear down that partial response.
    if (response.headersSent) { response.destroy(); return; }
    this.#headers(response, type); response.writeHead(status); response.end(body);
  }
  async #json(request: IncomingMessage): Promise<{ code: string; remember: boolean } | { deviceId: string; deviceKey: string } | PairingFailure> {
    const length = request.headers['content-length']; if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw Error('invalid');
    const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY_BYTES) throw Error('invalid'); chunks.push(Buffer.from(chunk)); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid');
    const body = value as Record<string, unknown>;
    // Code redemption, remembered-key redemption, or a correlated launch failure.
    // Failure reports carry no key and grant no access to the scene.
    const keys = Object.keys(body);
    if (typeof body.launchId === 'string' && /^[a-f0-9]{32}$/.test(body.launchId)
      && (body.failure === 'device_key_missing' || body.failure === 'device_not_remembered')
      && keys.length === 2) return { launchId: body.launchId, failure: body.failure };
    if (typeof body.code === 'string' && keys.every(key => key === 'code' || key === 'remember')
      && (body.remember === undefined || typeof body.remember === 'boolean')) return { code: body.code, remember: body.remember === true };
    if (typeof body.deviceId === 'string' && typeof body.deviceKey === 'string' && keys.every(key => key === 'deviceId' || key === 'deviceKey'))
      return { deviceId: body.deviceId, deviceKey: body.deviceKey };
    throw Error('invalid');
  }
  #attemptAllowed(state: State, remote: string) {
    const now = this.#now();
    for (const [address, attempt] of state.attempts) if (now - attempt.startedAt >= PAIR_WINDOW_MS) state.attempts.delete(address);
    const prior = state.attempts.get(remote);
    if (!prior && state.attempts.size >= MAX_PAIR_SOURCES) return false;
    const next = prior ? { count: prior.count + 1, startedAt: prior.startedAt } : { count: 1, startedAt: now };
    state.attempts.set(remote, next); return next.count <= MAX_PAIR_ATTEMPTS;
  }

  async #handle(request: IncomingMessage, response: ServerResponse) {
    const state = this.#live(); if (!state || state !== this.#state) { this.#send(response, 410, JSON.stringify({ error: 'closed' })); return; }
    if (state.active >= MAX_ACTIVE_REQUESTS) { this.#send(response, 429, JSON.stringify({ error: 'busy' })); return; }
    state.active++;
    try {
      if (!this.#sameHost(request, state) || request.headers['sec-fetch-site'] === 'cross-site') { this.#send(response, 403, JSON.stringify({ error: 'forbidden' })); return; }
      const path = request.url ?? '';
      // The two pages a wearer types or is redirected to
      // admit `?xrRenderBudget=` and nothing else, so the render-budget knobs
      // are reachable on hardware. `isPageRoute` says why. The capability
      // routes below keep their exact match.
      if (isPageRoute(path, '/') && request.method === 'GET') { this.#send(response, 200, pairingHtml(), 'text/html; charset=utf-8'); return; }
      if (path === '/pair' && request.method === 'POST') { await this.#pair(request, response, state); return; }
      // The viewer proxy carries no capability of its own, but it does stream
      // from the current target, so reuse must be able to cut it. No client id
      // is 32 hex characters of empty string, so revoke never matches it.
      if (isPageRoute(path, '/viewer') && request.method === 'GET') { state.socketClients.set(request.socket, ''); await this.#viewer(response, state); return; }
      if (request.method === 'GET' && DETAILED_PAGE_PATHS.has(path)) { state.socketClients.set(request.socket, ''); await this.#viewer(response, state, path); return; }
      // `/density` is the same kind of route as `/source` — a
      // paired, authorized GET whose body is proxied verbatim — so it is
      // allowlisted here and nowhere else. It is not a tool, so ALLOWED_TOOLS
      // and the `/tool` allowlist below are deliberately untouched.
      if (path !== '/source' && path !== '/density' && path !== '/tool' && path !== DETAILED_VIEW_ROUTES.handoff) { this.#send(response, 404, JSON.stringify({ error: 'not_found' })); return; }
      const tool = path === '/tool';
      const client = this.#origin(request, state, tool) ? this.#client(request, state) : undefined;
      if (!client || (tool && (request.method !== 'POST' || request.headers['content-type'] !== 'application/json' || request.headers['content-encoding'])) || (!tool && request.method !== 'GET')) { this.#send(response, 401, JSON.stringify({ error: 'unauthorized' })); return; }
      // Revoking one capability must cut the streams running on it, so every
      // authorized request marks its socket for as long as it is in flight.
      state.socketClients.set(request.socket, client.id);
      // A paired client that is still polling or calling a tool is a headset
      // someone is still wearing. Push the expiry out before serving it.
      client.lastUsedAt = this.#now();
      this.#extendSession(state);
      if (tool && request.headers['content-length'] && (!/^\d+$/.test(request.headers['content-length']) || Number(request.headers['content-length']) > MAX_TOOL_BODY_BYTES)) { this.#send(response, 413, JSON.stringify({ error: 'body_too_large' })); return; }
      if (tool) {
        let bytes: Buffer;
        try { bytes = await this.#readBody(request, MAX_TOOL_BODY_BYTES); }
        catch (error) {
          const tooLarge = error instanceof Error && error.message === 'body_too_large';
          this.#send(response, tooLarge ? 413 : 400, JSON.stringify({ error: tooLarge ? 'body_too_large' : 'invalid_request' }));
          return;
        }
        let name: string | undefined, args: unknown;
        try {
          const value = JSON.parse(bytes.toString('utf8'));
          if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.name === 'string') { name = value.name; args = value.args; }
        } catch { /* invalid JSON is a 400 below */ }
        if (!name || !ALLOWED_TOOLS.has(name)) { this.#send(response, 400, JSON.stringify({ error: 'invalid_request' })); return; }
        // The loopback companion refuses these too. Refusing here as well keeps
        // a headset's file path, web address or paste off the loopback hop.
        const refusal = pageSourceRefusal(name, args);
        if (refusal) { this.#send(response, 403, JSON.stringify({ error: 'source_not_allowed', message: refusal })); return; }
        state.toolSockets.add(request.socket);
        // The socket idles while the Mac works, so it is held for this tool's
        // own ceiling and put back for the next request on the connection.
        const ceiling = this.#ceiling(name);
        request.socket.setTimeout?.(ceiling);
        try { await this.#proxy(request, response, state, path, bytes, ceiling); }
        finally { request.socket.setTimeout?.(this.#ceiling('')); }
        if (response.statusCode === 200 && name === 'poll_inspection' && args && typeof args === 'object'
          && typeof (args as Record<string,unknown>).panelId === 'string')
          this.#onPanelHeartbeat?.(client.id, (args as Record<string,string>).panelId);
        return;
      }
      await this.#proxy(request, response, state, path);
      // An idle keep-alive socket needs no teardown: a later request on it
      // re-checks the bearer and is refused. Only a running stream does.
    } finally { state.active--; state.socketClients.delete(request.socket); state.toolSockets.delete(request.socket); }
  }

  async #pair(request: IncomingMessage, response: ServerResponse, state: State) {
    if (!this.#origin(request, state, true) || request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) { this.#send(response, 400, JSON.stringify({ error: 'invalid_request' })); return; }
    const remote = request.socket.remoteAddress ?? 'unknown'; if (!this.#attemptAllowed(state, remote)) { this.#send(response, 429, JSON.stringify({ error: 'rate_limited' })); return; }
    try {
      const body = await this.#json(request);
      if ('failure' in body) {
        if (body.launchId !== state.launchId || state.recoveryConsumed || state.clients.size) {
          this.#send(response, 409, JSON.stringify({ error: 'launch_not_pending' })); return;
        }
        state.pairingFailure ??= body;
        this.#send(response, 200, JSON.stringify({ reported: true })); return;
      }
      const agent = request.headers['user-agent'];
      if ('deviceKey' in body) { await this.#redeem(response, state, body.deviceId, body.deviceKey, agent); return; }
      const { code, remember } = body;
      if (this.#now() >= state.pairingExpiresAt || !/^\d{8}$/.test(code) || !safeEqual(code, state.pairingCode)) { this.#send(response, 401, JSON.stringify({ error: 'invalid_code' })); return; }
      // The code is spent before the device key is written, so a failure in the
      // store cannot leave a code that pairs twice.
      state.pairingCode = ''; state.pairingExpiresAt = this.#now();
      const issued = remember && this.#devices ? await this.#devices.issue(typeof agent === 'string' ? agent : undefined).catch(() => undefined) : undefined;
      // Awaiting the store gives a reuse or close a chance to run first. A
      // capability minted onto a retired listener would never be revocable.
      if (this.#live() !== state) { this.#send(response, 410, JSON.stringify({ error: 'closed' })); return; }
      const client = this.#session(state, issued?.deviceId, typeof agent === 'string' ? agent : undefined);
      this.#send(response, 200, JSON.stringify({ token: client.token, clientId: client.id,
        ...(issued ? { deviceId: issued.deviceId, deviceKey: issued.deviceKey, deviceExpiresAt: new Date(issued.expiresAt).toISOString() } : {}) }));
    } catch { this.#send(response, 400, JSON.stringify({ error: 'invalid_request' })); }
  }

  /**
   * A remembered headset presents its key instead of a code. It gets the same
   * bounded session every paired client gets, on the listener that is live now,
   * and never a listener of its own: only open_companion starts one, and its
   * single-owner rule is unchanged.
   */
  async #redeem(response: ServerResponse, state: State, deviceId: string, deviceKey: string, agent: string | string[] | undefined) {
    const devices = this.#devices;
    if (!devices) { this.#send(response, 401, JSON.stringify({ error: 'device_not_remembered' })); return; }
    const device = await devices.redeem(deviceId, deviceKey, typeof agent === 'string' ? agent : undefined);
    if (!device) { this.#send(response, 401, JSON.stringify({ error: 'device_not_remembered' })); return; }
    if (this.#live() !== state) { this.#send(response, 410, JSON.stringify({ error: 'closed' })); return; }
    // A reloaded page replaces its own capability rather than
    // accumulating one per visit — but a page that is still beating has not
    // reloaded. Evicting it here is what made two live pages, and a page whose
    // repair raced its own heartbeat, knock each other out every fifteen
    // seconds while the share stayed wide open. Replace only what this device
    // has stopped using, and keep the count bounded either way.
    const idle = this.#now() - CLIENT_ACTIVE_MS;
    for (const [id, client] of [...state.clients]) if (client.deviceId === device.id && client.lastUsedAt <= idle) { state.clients.delete(id); this.#dropSockets(state, id); }
    const live = [...state.clients].filter(([, client]) => client.deviceId === device.id).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (let over = live.length - (MAX_CLIENTS_PER_DEVICE - 1); over > 0; over--) {
      const [id] = live.shift()!; state.clients.delete(id); this.#dropSockets(state, id);
    }
    const client = this.#session(state, device.id, typeof agent === 'string' ? agent : undefined);
    this.#send(response, 200, JSON.stringify({ token: client.token, clientId: client.id, deviceId: device.id, deviceExpiresAt: new Date(device.expiresAt).toISOString() }));
  }

  #session(state: State, deviceId?: string, userAgent?: string): Client {
    const token = this.#validToken(), id = randomBytes(16).toString('hex'), now = this.#now();
    const client: Client = { id, token, createdAt: now, lastUsedAt: now, deviceClass: headsetClass(userAgent), ...(deviceId ? { deviceId } : {}) };
    state.recoveryConsumed = true; state.pairingFailure = undefined;
    state.clients.set(id, client); this.#extendSession(state); return client;
  }
  async #readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBytes) throw Error('body_too_large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  async #viewer(response: ServerResponse, state: State, path = '/') { await this.#upstream({ method: 'GET', headers: {}, readable: false } as IncomingMessage, response, state, path, undefined, false); }
  async #proxy(request: IncomingMessage, response: ServerResponse, state: State, path: string, body?: Buffer, ceilingMs?: number) { await this.#upstream(request, response, state, path, body, true, ceilingMs); }
  /**
   * `paired` is true when the LAN bearer on this request was already accepted,
   * so a refusal from the loopback companion cannot be about the headset.
   */
  async #upstream(request: IncomingMessage, response: ServerResponse, state: State, path: string, body?: Buffer, paired = false, ceilingMs = this.#ceiling('')) {
    const targetHost = `127.0.0.1:${state.target.port}`;
    const headers: http.OutgoingHttpHeaders = { host: targetHost, origin: `http://${targetHost}`, ...(path === '/' ? {} : { authorization: `Bearer ${state.target.token}` }) };
    for (const name of ['accept', 'accept-encoding', 'content-type', 'content-length'] as const) if (request.headers[name] !== undefined) headers[name] = request.headers[name];
    if (body) headers['content-length'] = String(body.length);
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const fail = (status = 502) => {
        if (settled) return;
        if (response.headersSent) response.destroy();
        else this.#send(response, status, JSON.stringify({ error: status === 413 ? 'body_too_large' : 'upstream_failed' }));
        finish();
      };
      const upstream = http.request({ host: '127.0.0.1', port: state.target.port, path, method: request.method, headers, timeout: ceilingMs }, upstreamResponse => {
        const status = upstreamResponse.statusCode ?? 502;
        if (status >= 300 && status < 400) { upstreamResponse.resume(); fail(); return; }
        // This pairing was checked before the proxy ran, so a
        // 401 or 410 from the loopback companion is this Mac's own source
        // capability gone stale — never the headset's bearer. Relayed verbatim
        // it reaches the page as `companion_expired`, which re-pairs a bearer
        // that was never broken, is answered, and is refused again one second
        // later: the fifteen-second re-pair loop a healthy wearer sat through
        // while the share stayed open to its hard stop. Name the
        // real fault instead, on a status the page reports without re-pairing.
        if (paired && (status === 401 || status === 410)) {
          upstreamResponse.resume();
          this.#send(response, 409, JSON.stringify({ error: 'source_unavailable',
            message: 'Sharing is still open, but this Mac’s link to the structure went stale. Reopen the companion from the desktop inspection; this headset stays paired.' }));
          finish(); return;
        }
        for (const [name, value] of Object.entries(upstreamResponse.headers)) if (value !== undefined && !['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'set-cookie', 'location'].includes(name.toLowerCase())) response.setHeader(name, value);
        response.writeHead(status);
        upstreamResponse.once('aborted', () => fail());
        upstreamResponse.once('error', () => fail());
        upstreamResponse.once('end', finish);
        upstreamResponse.pipe(response);
      });
      upstream.once('timeout', () => upstream.destroy(Error('upstream_timeout')));
      upstream.once('error', () => fail());
      // A disconnected LAN peer must not leave a loopback request or active
      // slot running until its timeout. `writableEnded` distinguishes a normal
      // response close from a client abort after headers.
      response.once('close', () => { if (!response.writableEnded) { upstream.destroy(); finish(); } });
      response.once('error', () => { upstream.destroy(); finish(); });
      // /viewer deliberately synthesizes a bodyless request to the loopback
      // companion, so only real IncomingMessage instances have EventEmitter
      // lifecycle hooks here.
      if (typeof (request as any).once === 'function') {
        request.once('aborted', () => { upstream.destroy(); finish(); });
        request.once('error', () => { upstream.destroy(); finish(); });
      }
      if (body) upstream.end(body);
      else if (request.readable) {
        if (path !== '/tool') request.pipe(upstream);
        else {
          let size = 0;
          const limiter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > MAX_TOOL_BODY_BYTES ? Error('body_too_large') : undefined, chunk); } });
          limiter.once('error', () => { request.destroy(); upstream.destroy(); fail(413); });
          request.pipe(limiter).pipe(upstream);
        }
      } else upstream.end();
    });
  }
  #validToken() { const token = this.#randomToken(); if (!/^[a-f0-9]{64}$/.test(token)) throw Error('LAN token generator returned an invalid token.'); return token; }
  async #certificate(host: string, directory: string, spawn: Spawn): Promise<LanCertificate> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await lstat(directory); if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw Error('LAN certificate directory must be a private directory.');
    await chmod(directory, 0o700);
    const label = createHash('sha256').update(host).digest('hex'), keyPath = join(directory, `${label}.key`), certPath = join(directory, `${label}.crt`);
    try {
      const [key, cert] = await Promise.all([readNoFollow(keyPath, 0o600), readNoFollow(certPath)]); const x509 = new X509Certificate(cert);
      if (Date.parse(x509.validTo) <= this.#now() || !(x509.subjectAltName ?? '').split(/,\s*/u).includes(`IP Address:${host}`)) throw Error('LAN certificate does not match its selected IP address.');
      // A half-applied replacement leaves a new key beside the old certificate.
      // Every other reuse check passes on that pair, so only the key-to-
      // certificate match can catch it before TLS fails on every handshake.
      if (!x509.checkPrivateKey(createPrivateKey(key))) throw Error('LAN certificate does not match its stored private key.');
      return { key, cert, fingerprint: certificateFingerprint(cert) };
    } catch (error) { if (error instanceof Error && error.message.includes('symbolic links')) throw error; /* A missing or stale regular pair is replaced together. */ }
    const nonce = randomBytes(8).toString('hex'), pendingKey = `${keyPath}.${nonce}.tmp`, pendingCert = `${certPath}.${nonce}.tmp`;
    try {
      await new Promise<void>((resolve, reject) => { let child: ChildProcess; try { child = spawn(opensslCommand(), ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', pendingKey, '-out', pendingCert, '-days', '825', '-subj', `/CN=${host}`, '-addext', `subjectAltName=IP:${host}`], { shell: false, stdio: 'ignore', windowsHide: true }); } catch (error) { reject(error); return; } child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('openssl could not create the LAN certificate.'))); });
      // Retire the old certificate first. An interrupted replacement can then
      // only leave a key with no certificate, which the reuse path regenerates,
      // never a key beside a certificate it does not match.
      await chmod(pendingKey, 0o600); await rm(certPath, { force: true });
      await rename(pendingKey, keyPath); await rename(pendingCert, certPath);
      const [key, cert] = await Promise.all([readNoFollow(keyPath), readNoFollow(certPath)]); const x509 = new X509Certificate(cert);
      if (!(x509.subjectAltName ?? '').split(/,\s*/u).includes(`IP Address:${host}`) || Date.parse(x509.validTo) <= this.#now()) throw Error('openssl created an invalid LAN certificate.');
      if (!x509.checkPrivateKey(createPrivateKey(key))) throw Error('openssl created an invalid LAN certificate.');
      return { key, cert, fingerprint: certificateFingerprint(cert) };
    } catch (error) { await Promise.allSettled([rm(pendingKey, { force: true }), rm(pendingCert, { force: true })]); throw Error(error instanceof Error && error.message.includes('openssl') ? error.message : 'Could not create the LAN certificate with openssl.'); }
  }
}
