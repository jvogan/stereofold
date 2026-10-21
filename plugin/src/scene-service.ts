/**
 * One scene per Mac, whichever assistant is asking.
 *
 * Every host installs its own copy of this plugin and starts its own MCP
 * server, so Codex's server and Claude's server are two processes that share
 * nothing. Their sessions are process-local maps: a session opened in one is
 * simply absent from the other, so a fixture opened in server A, and reopened
 * there, was reported missing by server B under the same session ID. Nothing was broken. There was just no shared scene
 * for the second host to join.
 *
 * This is that shared scene, and it is deliberately the smallest thing that can
 * be one. The first server asked to share becomes the owner: it opens a
 * loopback listener, writes its address and a token to a per-user runtime file
 * that only this user can read, and keeps serving its own tools. A later server
 * reads that file, checks the file is really this user's, checks the owner is
 * really answering, and then stops keeping a scene of its own: every call it
 * receives for that session is posted to the owner and answered by the owner's
 * state. There is one selection, one lesson position, one chapter, one
 * emphasis and one placement, because there is one scene.
 *
 * Nothing here starts by itself. A host publishes when it is asked to continue
 * a session, or when it opens a private Wi-Fi share, because the headset on
 * that share shows the scene the next assistant has to join. Without a record,
 * that assistant's continue_session finds nothing, and the share it opens next
 * fails on the port this one holds. A host that does neither never publishes,
 * never binds a port and never writes the file. Owning changes nothing about
 * how a host answers its own tools, so a single-host user sees the behaviour
 * they had before.
 */
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { hasLocalControlToken, writeLocalControlState } from '../scripts/local-host-security.js';
import { readLocalConfig, safeConfigName, SCENE_SERVICE_CONFIG_KEY } from './local-helper-config.js';
import { GROWTH_FETCH_TIMEOUT_MS, STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS } from './inspection-limits.js';

/** The record format. A file written by a newer plugin is left alone. */
export const SCENE_SERVICE_VERSION = 1;
/** An absolute path to the runtime file, for a host that keeps it elsewhere. */
export const SCENE_SERVICE_ENV = 'STEREOFOLD_SCENE_SERVICE';
/** The same setting in the local config file the helper lookup already reads. */
export { SCENE_SERVICE_CONFIG_KEY };
/** Where the owner records itself, beside the other control files. */
export const SCENE_SERVICE_FILE = '.stereofold/scene-service.json';
/**
 * An absolute path to a Unix socket that answers the owner's loopback route,
 * for a host whose sandbox cannot open loopback TCP. Claude Science's MCP
 * sandbox allows outbound traffic only to its own proxies, but its
 * `[sandbox.network] allow_unix_sockets` can name a directory; the relay in
 * `scripts/scene-socket-relay.ts` answers there on the owner's behalf.
 */
export const SCENE_SOCKET_ENV = 'STEREOFOLD_SCENE_SOCKET';
/**
 * How often an owner asks its session store to drop idle sessions. The store
 * drops a session only when it is next asked, and an owner nobody calls would
 * otherwise hold its record, and the scene, long after its session expired.
 */
export const SCENE_SWEEP_MS = 60_000;
/** A liveness probe is a loopback round trip; anything slower is a dead owner. */
export const SCENE_ALIVE_TIMEOUT_MS = 2_000;
/** A proxied tool call may be a twenty-second voice long poll, so this is generous. */
export const SCENE_CALL_TIMEOUT_MS = 70_000;
/** Source loading and verification finish before the owner's render wait starts. */
export const SCENE_SOURCE_PREPARATION_TIMEOUT_MS = 120_000;
/** Keep the existing verification allowance after the longer cold tier fetch. */
export const SCENE_GROWTH_PREPARATION_TIMEOUT_MS = GROWTH_FETCH_TIMEOUT_MS
  + (SCENE_SOURCE_PREPARATION_TIMEOUT_MS - STRUCTURE_SOURCE_DOWNLOAD_TIMEOUT_MS);
/** The launcher also allows bounded process startup before source preparation. */
export const SCENE_HOST_START_TIMEOUT_MS = SCENE_SOURCE_PREPARATION_TIMEOUT_MS + 30_000;
/** A declared render wait can use the owner's 300 s source budget after preparation. */
export const SCENE_MAX_CALL_TIMEOUT_MS = 420_000;
export function sceneCallTimeoutMs(name:string,args:Record<string,unknown>):number {
  // Growth returns a pending source receipt; its strict input has no render
  // wait. Do not let an undeclared wait extend its preparation deadline.
  if(name==='grow_structure') return SCENE_GROWTH_PREPARATION_TIMEOUT_MS;
  const legacySource=(name==='open' && ['pdbId','structureText','fixture','source'].some(key=>args[key]!==undefined))
    || (name==='control' && args.action==='load_pdb');
  const sourceCall=legacySource || ['prepare_composite','inspect','inspect_file','inspect_scene','inspect_lesson','inspect_experience','replace_inspection_source','navigate_experience'].includes(name);
  if(!sourceCall) return SCENE_CALL_TIMEOUT_MS;
  if(legacySource) return SCENE_SOURCE_PREPARATION_TIMEOUT_MS;
  const wait=args.waitForRenderMs;
  const renderWait=typeof wait==='number' && Number.isFinite(wait) ? Math.max(0,wait) : 0;
  return Math.min(SCENE_MAX_CALL_TIMEOUT_MS,SCENE_SOURCE_PREPARATION_TIMEOUT_MS+renderWait);
}
/** One proxied request body. Coordinates never travel this route; scenes do. */
export const MAX_SCENE_REQUEST_BYTES = 4 * 1024 * 1024;

export type SceneOwnerRecord = {
  version: number;
  origin: string;
  token: string;
  sceneId: string;
  serverEpoch?: string;
  pid?: number;
  uid?: number;
  startedAt?: string;
};

export type SceneRole = 'owner' | 'attached' | 'none';

export type SceneShareResult = {
  role: SceneRole;
  sessionId?: string;
  origin?: string;
  sceneId?: string;
  /** Set when this server replaced a recorded owner that had stopped answering. */
  tookOver?: boolean;
  /** Why there is nothing to continue, in words a person can act on. */
  reason?: string;
  /** Set when a recorded owner did not answer but its process still runs, so continuing again may join it. */
  retry?: boolean;
};

/**
 * The sessionless tools that belong to the shared scene rather than to this
 * process. The wearer speaks into one headset and hears one answer, so an
 * attached host must reach the owner's queue and the owner's companion instead
 * of its own empty ones.
 */
/** Scene edits a voice request may send with its utteranceId in place of a sessionId. */
export const UTTERANCE_BOUND_TOOLS: ReadonlySet<string> = new Set(['update_inspection', 'control_tour', 'focus_selection', 'emphasize']);
const SHARED: ReadonlyMap<string, { remote: string; assistant: boolean; sessionless: boolean }> = new Map([
  ['listen_voice', { remote: 'scene.listen_voice', assistant: true, sessionless: true }],
  ['poll_voice_transcripts', { remote: 'scene.poll_voice_transcripts', assistant: true, sessionless: false }],
  ['prepare_composite', { remote: 'prepare_composite', assistant: false, sessionless: true }],
  ['say_to_headset', { remote: 'say_to_headset', assistant: false, sessionless: true }],
]);

const ORIGIN = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
/** How many sessions a host remembers having proxied, so it can say so after its attachment is lost. */
const LOST_SESSIONS = 16;
const MOVED = 'this host has since moved to another session';

/** Whether a recorded owner's process still runs. A process this user may not signal still runs. */
function running(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The runtime file this host uses: the environment, then the config file, then the default. */
export function sceneServicePath({ env = process.env, home = homedir(), config }: {
  env?: NodeJS.ProcessEnv; home?: string; config?: Readonly<Record<string, string>>;
} = {}): string {
  const named = (env[SCENE_SERVICE_ENV] ?? '').trim();
  if (named) {
    if (!isAbsolute(named)) throw Error(`${SCENE_SERVICE_ENV} must be an absolute path; received ${named}.`);
    return named;
  }
  const settings = config ?? readLocalConfig({ env, home });
  const configured = (settings[SCENE_SERVICE_CONFIG_KEY] ?? '').trim();
  if (configured) {
    if (!isAbsolute(configured)) throw Error(`${SCENE_SERVICE_CONFIG_KEY} in ${safeConfigName(env, home)} must be an absolute path; received ${configured}.`);
    return configured;
  }
  return resolve(home, SCENE_SERVICE_FILE);
}

/**
 * `fetch` over a Unix domain socket. The origin's host and port ride in the
 * Host header; whatever answers on the socket (the relay, or an owner that
 * listens there itself) forwards to the loopback route. Bodies are read whole:
 * every message on this route is a small JSON envelope.
 */
export function unixSocketFetch(socketPath: string): typeof globalThis.fetch {
  return (input, init) => new Promise<Response>((done, fail) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = { host: url.host };
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const request = http.request({ socketPath, method: init?.method ?? 'GET', path: `${url.pathname}${url.search}`, headers },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', fail);
        response.on('end', () => {
          const status = response.statusCode ?? 502;
          const answered = new Headers();
          for (const [key, value] of Object.entries(response.headers)) if (typeof value === 'string') answered.set(key, value);
          done(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: answered }));
        });
      });
    request.on('error', fail);
    const signal = init?.signal;
    if (signal) {
      const abort = () => request.destroy(signal.reason instanceof Error ? signal.reason : Error('The request was aborted.'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      request.once('close', () => signal.removeEventListener('abort', abort));
    }
    request.end(typeof init?.body === 'string' ? init.body : undefined);
  });
}

/** Read one recorded owner, or say plainly why there is none to trust. */
export function parseSceneOwnerRecord(value: unknown, uid?: number): { record?: SceneOwnerRecord; reason?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reason: 'the scene service record is not a settings object' };
  const raw = value as Record<string, unknown>;
  if (raw.version !== SCENE_SERVICE_VERSION) return { reason: 'the scene service record was written by a different version of this plugin' };
  const origin = typeof raw.origin === 'string' ? raw.origin : '';
  if (!ORIGIN.test(origin)) return { reason: 'the scene service record does not name a loopback address' };
  const token = typeof raw.token === 'string' ? raw.token : '';
  if (!TOKEN.test(token)) return { reason: 'the scene service record has no usable token' };
  const sceneId = typeof raw.sceneId === 'string' && raw.sceneId.length > 0 ? raw.sceneId : '';
  if (!sceneId) return { reason: 'the scene service record names no scene' };
  if (uid !== undefined && typeof raw.uid === 'number' && raw.uid !== uid) return { reason: 'the scene service record belongs to another user' };
  return {
    record: {
      version: SCENE_SERVICE_VERSION, origin, token, sceneId,
      ...(typeof raw.serverEpoch === 'string' ? { serverEpoch: raw.serverEpoch } : {}),
      ...(typeof raw.pid === 'number' ? { pid: raw.pid } : {}),
      ...(typeof raw.uid === 'number' ? { uid: raw.uid } : {}),
      ...(typeof raw.startedAt === 'string' ? { startedAt: raw.startedAt } : {}),
    },
  };
}

export type LocalSceneServiceOptions = {
  /** Test seam; production resolves the per-user runtime file. */
  file?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test seam; production reads this process's own user. */
  uid?: number;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  /** Whether a session ID still names a live scene in this process. */
  live?: (sessionId: string) => boolean;
  /** Drop the sessions that have expired, so `sessionEnded` hears of them. Called while this host owns the scene. */
  sweep?: () => void;
  serverEpoch?: string;
};

export class LocalSceneService {
  readonly #options: LocalSceneServiceOptions;
  readonly #tools = new Map<string, (input: any, signal?: AbortSignal) => Promise<unknown>>();
  readonly #proxied = new Set<string>();
  /** Sessions this host proxied until its attachment dropped, oldest first. */
  readonly #lost = new Set<string>();
  #path: string | undefined;
  #owner: { server: http.Server; origin: string; token: string; sceneId: string; sweep?: NodeJS.Timeout } | undefined;
  #attached: { origin: string; token: string; sessionId: string; sceneId: string } | undefined;
  #sessionId: string | undefined;
  #label: string | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #socketFetch: typeof globalThis.fetch | undefined;
  #serial: Promise<unknown> = Promise.resolve();

  constructor(options: LocalSceneServiceOptions = {}) { this.#options = options; }

  /** The way to the owner: the test seam, the Unix socket the environment names, or loopback TCP. */
  #fetch(): typeof globalThis.fetch {
    if (this.#options.fetch) return this.#options.fetch;
    const socket = ((this.#options.env ?? process.env)[SCENE_SOCKET_ENV] ?? '').trim();
    if (!socket) return globalThis.fetch;
    if (!isAbsolute(socket)) throw Error(`${SCENE_SOCKET_ENV} must be an absolute path; received ${socket}.`);
    return (this.#socketFetch ??= unixSocketFetch(socket));
  }

  /** Where this host reads and writes the owner record. */
  get path(): string {
    this.#path ??= this.#options.file ?? sceneServicePath({ env: this.#options.env, home: this.#options.home });
    return this.#path;
  }

  get role(): SceneRole { return this.#owner ? 'owner' : this.#attached ? 'attached' : 'none'; }
  get origin(): string | undefined { return this.#owner?.origin ?? this.#attached?.origin; }
  /** The name this host answers to when the wearer switches assistants. */
  get label(): string | undefined { return this.#label; }
  set label(value: string | undefined) { this.#label = value; }

  /** Make one local tool reachable to an attached host. Raw handler, no proxy. */
  register(name: string, handle: (input: any, signal?: AbortSignal) => Promise<unknown>): void { this.#tools.set(name, handle); }

  /** Remember the newest session this process actually opened. */
  noteSession(sessionId: string): void {
    if (this.#proxied.has(sessionId)) return;
    this.#sessionId = sessionId;
  }

  /**
   * Hear that a session in this process ended. When it is the session this
   * host owns the scene for, the owner lets the scene go: its route stops and
   * its record goes, while the record is still its own. Otherwise every other
   * host would find a live owner with no structure, and no host could publish
   * until this process exited.
   */
  async sessionEnded(sessionId: string): Promise<void> {
    await this.#run(async () => {
      if (sessionId !== this.#sessionId) return;
      this.#sessionId = undefined;
      await this.#release();
    });
  }

  /** Whether this session ID belongs to another server's scene. */
  proxies(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.#attached !== undefined && this.#proxied.has(sessionId);
  }

  /**
   * Send one call to the owner, or answer that this is not ours to send.
   *
   * `undefined` is the ordinary case and has to stay cheap. A call without a
   * session returns at the first test unless this host is attached, and a
   * call carrying a session this host holds goes no further than `live`.
   * Only a session that is neither held here nor proxied reaches the owner
   * file, through `#rejoin`.
   */
  async forward(name: string, input: unknown, signal?: AbortSignal): Promise<{ value: unknown } | undefined> {
    const args = (input ?? {}) as Record<string, unknown>;
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined;
    if (sessionId === undefined && this.#attached === undefined) return undefined;
    const shared = SHARED.get(name);
    let remote: string | undefined;
    if (sessionId !== undefined) { if (this.proxies(sessionId) || await this.#rejoin(sessionId)) remote = shared?.remote ?? name; }
    else if (shared?.sessionless) remote = shared.remote;
    // A voice edit may name only its utterance. The owner recorded that
    // utterance with its session, so the owner is where it can be read.
    else if (this.#attached !== undefined && typeof args.utteranceId === 'string' && UTTERANCE_BOUND_TOOLS.has(name)) remote = name;
    // Prepared handles are private to the owner cache, including new scene opens.
    else if ((args.source as any)?.kind === 'composite' && ['inspect', 'inspect_lesson', 'open'].includes(name)) remote = name;
    if (remote === undefined) return undefined;
    const labelsAction = ['update_inspection','control_tour','focus_selection','emphasize','undo_last_change','redo_last_change'].includes(name);
    const payload = (shared?.assistant || labelsAction) && this.#label ? { ...args, assistant: this.#label } : args;
    const value:any = await this.call(remote, payload, signal);
    if (!value?.isError && value?.structuredContent?.kind === 'inspect' && this.#attached
      && typeof value.structuredContent.sessionId === 'string') {
      this.#attached.sessionId = value.structuredContent.sessionId;
      this.#proxied.add(value.structuredContent.sessionId);
    }
    return { value };
  }

  /**
   * Rejoin the shared scene for a session this host neither holds nor proxies.
   *
   * An attached host loses its attachment when one call to the owner fails,
   * and forgets it when its server restarts. The owner still holds the scene,
   * so the next call carrying its session attaches again, the way `share`
   * does, and is sent. This happens before anything is sent: a call that
   * failed may already have reached the owner, and it is never sent twice.
   *
   * True when the session is now proxied. False when no shared scene can be
   * there, so the local handler answers as it always did. It throws when the
   * session was one this host proxied, or when a recorded owner does not hold
   * it or does not answer while its process runs: the assistant must call
   * continue_session then, because opening a new structure would split the
   * scene.
   */
  async #rejoin(sessionId: string): Promise<boolean> {
    const live = this.#options.live;
    if (this.#closed || !live) return false;
    // A host that owns a scene, or is attached to one, never joins another here.
    if (this.#owner || this.#attached) {
      if (!this.#lost.has(sessionId) || live(sessionId)) return false;
      throw this.#lostError(sessionId, MOVED);
    }
    if (live(sessionId)) return false;
    // `shared` is whether a scene may still be there: its owner answered, or
    // its process still runs though it did not answer. Only then would opening
    // a structure here split a scene.
    const missed = await this.#run(async (): Promise<{ reason: string; shared: boolean } | undefined> => {
      // A call queued ahead of this one may already have rejoined.
      if (this.proxies(sessionId)) return undefined;
      if (this.#closed) return { reason: 'this host is shutting down', shared: false };
      if (this.#owner || this.#attached) return { reason: MOVED, shared: false };
      const found = await this.#readOwner();
      if (!found.record) return { reason: found.reason ?? 'no scene service is recorded on this Mac', shared: false };
      if (!await this.#alive(found.record)) return { reason: 'the recorded scene service is not answering', shared: running(found.record.pid) };
      const joined = await this.#attachTo(found.record, sessionId);
      return joined.role === 'attached' ? undefined : { reason: joined.reason ?? 'the shared scene could not be joined', shared: true };
    });
    if (missed === undefined) return true;
    if (this.#lost.has(sessionId)) throw this.#lostError(sessionId, missed.reason);
    if (missed.shared) {
      throw Error(`Stereofold session was not found in this host or in the shared scene on this Mac (${missed.reason}). `
        + 'Call continue_session to join the shared scene rather than opening a new structure.');
    }
    return false;
  }

  #lostError(sessionId: string, reason: string): Error {
    return Error(`This host lost its connection to the shared scene that held session ${sessionId}, and could not rejoin it (${reason}). `
      + 'Call continue_session to rejoin the shared scene rather than opening a new structure.');
  }

  /**
   * Join the one scene on this Mac, or become it.
   *
   * A live recorded owner always wins: continuing is the whole request, and a
   * second scene is the thing this exists to prevent. A recorded owner that has
   * stopped answering is replaced, once, by a host that has a scene of its own.
   * A host with neither says so rather than inventing an empty one.
   */
  async share(options: { assistant?: string } = {}): Promise<SceneShareResult> { return await this.#run(() => this.#share(options)); }

  async #share({ assistant }: { assistant?: string }): Promise<SceneShareResult> {
    if (this.#closed) return { role: 'none', reason: 'this host is shutting down' };
    if (assistant) this.#label = assistant;
    if (this.#attached) {
      const alive = await this.#alive(this.#attached);
      if (alive) return { role: 'attached', sessionId: this.#attached.sessionId, origin: this.#attached.origin, sceneId: this.#attached.sceneId };
      this.#drop();
    }
    // A host that already owns the scene never joins another one. Owning and
    // proxying at the same time is the one state that could split a scene in
    // two, so it is not reachable from here.
    if (this.#owner) {
      const local = this.#localSession();
      if (local === undefined) return { role: 'none', reason: 'the shared scene on this Mac has no open structure' };
      return { role: 'owner', sessionId: local, origin: this.#owner.origin, sceneId: this.#owner.sceneId };
    }
    const found = await this.#readOwner();
    if (found.record && await this.#alive(found.record)) return await this.#attachTo(found.record);
    const local = this.#localSession();
    if (local === undefined) {
      const reason = found.reason ?? (found.record ? 'the recorded scene service is not answering' : 'no scene service is recorded on this Mac');
      return { role: 'none', reason, ...(found.record && running(found.record.pid) ? { retry: true } : {}) };
    }
    const tookOver = Boolean(found.record);
    await this.#publish();
    return { role: 'owner', sessionId: local, origin: this.#owner!.origin, sceneId: this.#owner!.sceneId, ...(tookOver ? { tookOver } : {}) };
  }

  /**
   * Publish this host's scene after opening a companion connection,
   * when no other host holds one. True when this call published.
   *
   * Nobody asked for this, so it is stricter than `share`: it never attaches,
   * and it leaves any record alone unless that record reads cleanly and its
   * owner neither answers nor runs. A host sandboxed away from loopback cannot
   * reach a live owner, so a running process is the one sign it can still read.
   */
  async offer(): Promise<boolean> {
    return await this.#run(async () => {
      if (this.#closed || this.#owner || this.#attached || this.#localSession() === undefined) return false;
      const found = await this.#readOwner();
      if (found.record ? running(found.record.pid) || await this.#alive(found.record) : !found.missing) return false;
      if (this.#closed) return false;
      await this.#publish();
      return true;
    });
  }

  /** One call on the owner's loopback route, as this host's own result. */
  async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const attached = this.#attached;
    if (!attached) throw Error('This host is not attached to a shared scene on this Mac.');
    return await this.#post(attached, name, args, signal);
  }

  /**
   * One POST to an owner. A failure drops the attachment only while it is the
   * one this call went out on, so a slow call cannot undo a later rejoin.
   */
  async #post(target: { origin: string; token: string }, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const fetching = this.#fetch();
    let response: Response;
    try {
      response = await fetching(`${target.origin}/scene`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
        body: JSON.stringify({ name, arguments: args }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(sceneCallTimeoutMs(name,args))])
          : AbortSignal.timeout(sceneCallTimeoutMs(name,args)),
      });
    } catch (error) {
      // Cancelling a listen is not losing the shared scene. Keep its attachment
      // so the next deliberate listen resumes the same queue and assistant.
      signal?.throwIfAborted();
      // The request may have reached the owner before the connection failed,
      // so it is not sent again. The next call rejoins before it sends.
      if (this.#attached === target) this.#drop();
      throw Error(`This host lost its connection to the shared scene on this Mac (${(error as Error).message}). `
        + 'Call continue_session to rejoin it rather than opening a new structure.');
    }
    const body = await response.json().catch(() => undefined) as any;
    signal?.throwIfAborted();
    if (!response.ok) {
      if (response.status === 403) {
        if (this.#attached === target) this.#drop();
        throw Error('The shared scene on this Mac refused this host. Continue the session again to rejoin it.');
      }
      throw Error(body?.error ?? `The shared scene refused ${name} with status ${response.status}.`);
    }
    return body?.result;
  }

  /**
   * Stop owning the scene. An attached host simply stops proxying.
   *
   * Two callers close one server: the transport's `onclose` and the explicit
   * `close()`. They are one shutdown, awaited by both, so the second caller
   * cannot return before the record is actually gone.
   */
  async close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return await this.#closing;
  }

  async #shutdown(): Promise<void> {
    this.#closed = true;
    this.#drop();
    await this.#release();
  }

  /** Stop answering as the owner. The next host to continue or share can then publish. */
  async #release(): Promise<void> {
    const owner = this.#owner;
    this.#owner = undefined;
    if (!owner) return;
    clearInterval(owner.sweep);
    owner.server.closeAllConnections();
    await new Promise<void>(done => owner.server.close(() => done()));
    // Only retire a record that is still ours. A successor that already took
    // the file over must keep it.
    try {
      const found = await this.#readOwner();
      if (found.record?.token === owner.token) await rm(this.path, { force: true });
    } catch { /* A file we cannot read is a file we must not delete. */ }
  }

  #drop(): void {
    for (const sessionId of this.#proxied) this.#lost.add(sessionId);
    while (this.#lost.size > LOST_SESSIONS) this.#lost.delete(this.#lost.values().next().value!);
    this.#attached = undefined;
    this.#proxied.clear();
  }

  /** One share or offer at a time: two at once could publish twice, or attach to the record the other just wrote. */
  #run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(work, work);
    this.#serial = next.then(() => undefined, () => undefined);
    return next;
  }

  #uid(): number | undefined {
    if (this.#options.uid !== undefined) return this.#options.uid;
    return typeof process.getuid === 'function' ? process.getuid() : undefined;
  }

  #localSession(): string | undefined {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) return undefined;
    const live = this.#options.live;
    if (live && !live(sessionId)) return undefined;
    return sessionId;
  }

  async #readOwner(): Promise<{ record?: SceneOwnerRecord; reason?: string; missing?: boolean }> {
    let path: string;
    try { path = this.path; } catch (error) { return { reason: (error as Error).message }; }
    let info;
    try { info = await stat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reason: 'no scene service is recorded on this Mac', missing: true };
      return { reason: `the scene service record could not be read: ${(error as Error).message}` };
    }
    if (!info.isFile()) return { reason: 'the scene service record is not a regular file' };
    const uid = this.#uid();
    if (uid !== undefined && info.uid !== uid) return { reason: 'the scene service record belongs to another user' };
    if ((info.mode & 0o077) !== 0) return { reason: 'the scene service record is readable by other users' };
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, 'utf8')); }
    catch { return { reason: 'the scene service record is not readable JSON' }; }
    return parseSceneOwnerRecord(parsed, uid);
  }

  /** A recorded owner is only real if it answers on its own token. */
  async #alive(record: { origin: string; token: string }): Promise<boolean> {
    const fetching = this.#fetch();
    try {
      const response = await fetching(`${record.origin}/scene/alive`, {
        headers: { Authorization: `Bearer ${record.token}` },
        signal: AbortSignal.timeout(SCENE_ALIVE_TIMEOUT_MS),
      });
      return response.status === 204;
    } catch { return false; }
  }

  /**
   * Attach to a live owner's scene, or, given `expected`, only when that is
   * the session it holds. Nothing is forwarded until the owner has described
   * its scene, so a refused rejoin sends no other call there.
   */
  async #attachTo(record: SceneOwnerRecord, expected?: string): Promise<SceneShareResult> {
    let described: any;
    try { described = await this.#post(record, 'scene.describe', {}); }
    catch { return { role: 'none', reason: 'the recorded scene service stopped answering', retry: true }; }
    const sessionId = typeof described?.sessionId === 'string' ? described.sessionId : undefined;
    if (!sessionId) return { role: 'none', reason: 'the shared scene on this Mac has no open structure' };
    if (expected !== undefined && sessionId !== expected) return { role: 'none', reason: 'the shared scene holds a different session' };
    this.#attached = { origin: record.origin, token: record.token, sessionId, sceneId: record.sceneId };
    this.#proxied.add(sessionId);
    this.#lost.delete(sessionId);
    return { role: 'attached', sessionId, origin: record.origin, sceneId: record.sceneId };
  }

  async #publish(): Promise<void> {
    const token = randomBytes(32).toString('hex');
    const sceneId = randomUUID();
    const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: SCENE_MAX_CALL_TIMEOUT_MS + 5_000, headersTimeout: 5_000 },
      (request, response) => { void this.#handle(request, response, token); });
    server.setTimeout(SCENE_MAX_CALL_TIMEOUT_MS + 5_000, socket => socket.destroy());
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      throw Error('The scene service did not bind loopback.');
    }
    server.unref();
    const origin = `http://127.0.0.1:${address.port}`;
    const path = this.path;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const record: SceneOwnerRecord = {
      version: SCENE_SERVICE_VERSION, origin, token, sceneId,
      ...(this.#options.serverEpoch ? { serverEpoch: this.#options.serverEpoch } : {}),
      pid: process.pid,
      ...(this.#uid() === undefined ? {} : { uid: this.#uid() }),
      startedAt: new Date((this.#options.now ?? Date.now)()).toISOString(),
    };
    try { await writeLocalControlState(path, record); }
    catch (error) {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      throw Error(`The scene service could not record itself at ${path}: ${(error as Error).message}`);
    }
    const sweep = this.#options.sweep;
    this.#owner = { server, origin, token, sceneId,
      ...(sweep ? { sweep: setInterval(() => { try { sweep(); } catch { /* the next sweep tries again */ } }, SCENE_SWEEP_MS).unref() } : {}) };
  }

  #send(response: http.ServerResponse, status: number, body: unknown): void {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    response.end(status === 204 ? undefined : JSON.stringify(body ?? {}));
  }

  /**
   * The owner's loopback route.
   *
   * It is reachable only from this machine, only with the token in a file only
   * this user can read, and never from a browser: a request that carries an
   * Origin is a page, and no page has business driving another host's scene.
   */
  async #handle(request: http.IncomingMessage, response: http.ServerResponse, token: string): Promise<void> {
    const owner = this.#owner;
    const expected = owner ? new URL(owner.origin).host : undefined;
    if (expected !== undefined && request.headers.host !== expected) { this.#send(response, 403, {}); return; }
    if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] === 'cross-site') { this.#send(response, 403, {}); return; }
    if (!hasLocalControlToken(request.headers.authorization, token)) { this.#send(response, 403, {}); return; }
    const path = (request.url ?? '/').split('?')[0];
    if (request.method === 'GET' && path === '/scene/alive') {
      if (!response.writableEnded && !response.destroyed) { response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end(); }
      return;
    }
    if (request.method !== 'POST' || path !== '/scene' || !String(request.headers['content-type'] ?? '').startsWith('application/json')) {
      this.#send(response, 403, {}); return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > MAX_SCENE_REQUEST_BYTES) throw Error('That scene request was too large.');
        chunks.push(Buffer.from(chunk as Buffer));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { name?: unknown; arguments?: unknown };
      const name = typeof body.name === 'string' ? body.name : '';
      const args = (body.arguments ?? {}) as Record<string, unknown>;
      // A session that ended here would otherwise come back with the local
      // advice to open a new structure, which on the attached host splits the scene.
      const live = this.#options.live;
      if (typeof args.sessionId === 'string' && live && !live(args.sessionId)) {
        throw Error(`Stereofold session ${args.sessionId} is no longer open in the shared scene on this Mac. `
          + 'Call continue_session to find the scene open now rather than opening a new structure.');
      }
      const controller = new AbortController();
      const disconnected = () => { if (!response.writableEnded) controller.abort(Error('The shared caller disconnected.')); };
      response.once('close', disconnected);
      if (response.destroyed) disconnected();
      try { this.#send(response, 200, { result: await this.dispatch(name, args, controller.signal) }); }
      finally { response.off('close', disconnected); }
    } catch (error) { this.#send(response, 409, { error: (error as Error).message }); }
  }

  /** Run one shared call in this process. Used by the route, and by tests. */
  async dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (name === 'scene.describe') {
      return {
        sessionId: this.#localSession(), sceneId: this.#owner?.sceneId,
        ...(this.#options.serverEpoch ? { serverEpoch: this.#options.serverEpoch } : {}),
      };
    }
    const handle = this.#tools.get(name);
    if (!handle) throw Error(`The shared scene does not offer ${name || 'that action'}.`);
    const value:any = await handle(args, signal);
    if (!value?.isError && value?.structuredContent?.kind === 'inspect'
      && typeof value.structuredContent.sessionId === 'string') this.noteSession(value.structuredContent.sessionId);
    return value;
  }
}
