/**
 * The third way to see the headset: the browser's own debugger.
 *
 * `captureDeviceView` (headset-view-device.ts) reads the composited panel as
 * pixels, which answers "what does the wearer see" and nothing else. The
 * inspection protocol answers "what will the panel do when I ask it to". In
 * between sits the question neither can reach: why did the page do what it
 * did. A thrown error inside `runFaceAction`, a WebXR session that ended
 * without the Mac hearing about it, a tour that is playing into a blurred
 * compositor — all of those are invisible to a screenshot and invisible to a
 * command receipt, and all of them are one `Runtime.evaluate` away.
 *
 * Quest Browser is Chromium, so it speaks the Chrome DevTools Protocol on an
 * abstract unix socket named `chrome_devtools_remote`. `adb forward` carries
 * that to a loopback port on this Mac, `GET /json` lists the open tabs, and
 * each tab carries a `webSocketDebuggerUrl`. Verified against Quest Browser
 * 150.1.0.24.52 (Chrome 150.0.7871.224, protocol 1.3).
 *
 * Three rules hold this module to reading:
 *
 * - No dependency. `ws` is not in this package and this is not a reason to add
 *   one, so the handshake and the frame codec are here, at about a hundred
 *   lines, and they are unit-tested against a fake socket.
 * - No input. Nothing here calls `Input.dispatchKeyEvent`, `Page.navigate`,
 *   `Page.reload` or `Runtime.callFunctionOn` on a page hook that writes.
 *   `evaluate` hands the caller a loaded gun and says so; every built-in
 *   subcommand is a pure read, because someone is usually wearing the
 *   headset when this runs. The one press the server sends, Enter VR for a
 *   wearer on the flat page, is kept apart in `headset-enter-vr.ts`.
 * - No secrets. A companion address carries a pairing code in its fragment and
 *   the detailed-view address carries a 64-character page key in its, and both
 *   appear in `/json` output, in `location.href`, and in any console line that
 *   logs a URL. Every string that leaves this module goes through
 *   `redactDevtoolsText` first.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

/** Where `adb forward` is expected to have put the headset's debugger. */
export const DEVTOOLS_PORT_ENV_KEY = 'STEREOFOLD_DEVTOOLS_PORT';
export const DEVTOOLS_DEFAULT_PORT = 9333;
/** The abstract socket Quest Browser listens on. Same name as desktop Chrome. */
export const DEVTOOLS_ABSTRACT_SOCKET = 'localabstract:chrome_devtools_remote';
/** A round trip to a headset over USB adb measured 6-15 ms; Wi-Fi is slower. */
export const DEVTOOLS_TIMEOUT_MS = 10_000;
/** One screencast frame at quality 40 is about 40 kB; this bounds a stuck stream. */
export const DEVTOOLS_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/** The port the bridge should use on this Mac. */
export function devtoolsPort(env: NodeJS.ProcessEnv = process.env): number {
  const named = Number(env[DEVTOOLS_PORT_ENV_KEY]);
  return Number.isInteger(named) && named > 0 && named < 65_536 ? named : DEVTOOLS_DEFAULT_PORT;
}

/**
 * The `adb` arguments that open the tunnel. Printed as advice as well as run.
 *
 * The fixed port is rebound on purpose: the launch's tab sweep and the CLI
 * both reuse whatever forward an earlier run left there. Only a forward this
 * process opens for itself on a fresh port (`withOwnedDevtoolsForward`) passes
 * `noRebind`, so a port another process claimed in the meantime fails closed.
 */
export function forwardArguments(serial: string, port: number, { noRebind = false }: { noRebind?: boolean } = {}): string[] {
  return ['-s', serial, 'forward', ...(noRebind ? ['--no-rebind'] : []), `tcp:${port}`, DEVTOOLS_ABSTRACT_SOCKET];
}

/** Reserve an unused loopback port briefly; --no-rebind makes a race fail closed. */
export async function freeDevtoolsPort(): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** Only a forward this call opened may be used or removed. */
export async function withOwnedDevtoolsForward<T>(input: {
  adb: string; serial: string; run: (adb: string, args: string[]) => Promise<{code?: number}>;
  action: (port: number) => Promise<T>; allocate?: () => Promise<number>;
}): Promise<{ok:true;port:number;value:T;cleanupWarning?:string}|{ok:false;reason:string}> {
  let port: number;
  try { port = await (input.allocate ?? freeDevtoolsPort)(); }
  catch (error) { return {ok:false,reason:`No free debugger port was available: ${error instanceof Error ? error.message : String(error)}`}; }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return {ok:false,reason:'No free debugger port was available.'};
  let forwarded;
  try { forwarded = await input.run(input.adb, forwardArguments(input.serial, port, { noRebind: true })); }
  catch (error) { return {ok:false,reason:`adb forward failed: ${error instanceof Error ? error.message : String(error)}`}; }
  if (forwarded.code !== 0) return {ok:false,reason:`adb forward failed with exit code ${forwarded.code ?? 'unknown'}.`};
  let value: T;
  let cleanupWarning: string | undefined;
  try { value = await input.action(port); }
  finally {
    try {
      const removed = await input.run(input.adb, ['-s', input.serial, 'forward', '--remove', `tcp:${port}`]);
      if (removed.code !== 0) cleanupWarning = `adb could not remove its debugger forward (exit ${removed.code ?? 'unknown'}).`;
    } catch (error) { cleanupWarning = `adb could not remove its debugger forward: ${error instanceof Error ? error.message : String(error)}`; }
  }
  return {ok:true,port,value,...(cleanupWarning?{cleanupWarning}:{})};
}

// ---------------------------------------------------------------- redaction

const PAIR_FRAGMENT = /^pair=\d{8}$/u;
const PAGE_KEY_FRAGMENT = /^[0-9a-f]{16,}$/u;
/**
 * Query keys whose values the viewer reads as settings. Their values are
 * evidence (which render budget a run used); every other value is redacted,
 * because a query can carry `access_token=…` or any other credential.
 */
const SETTING_QUERY_KEYS = new Set(['xrRenderBudget', 'roomAnchor']);
/** Anything that looks like a URL, fragment included, anywhere in a line. */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>)\]}]+/giu;
/** Bare long hex runs. */
const LONG_HEX = /\b[0-9a-f]{32,}\b/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/giu;
/**
 * A `data:` URI, which the live page produces by the megabyte.
 *
 * Mol* loads its WebAssembly through one, and Quest Browser's CSP refuses it
 * and logs the whole thing: a single measured console line was
 * about 1.4 MB of base64. Printing it buries every other line and costs an
 * agent its context window for no information — the useful part is the media
 * type and the length. It is also, in the general case, page content nobody
 * audited, which is reason enough not to echo it whole.
 */
const DATA_URI = /\bdata:([\w.+-]+\/[\w.+-]+)?(;[\w-]+=?[\w-]*)*,([A-Za-z0-9+/=%._~-]{64,})/giu;

/** What a redacted value leaves behind. */
export const REDACTED = '<redacted>';

/**
 * Describe a URL's query and fragment instead of printing them.
 *
 * The scheme, host, port and path are evidence a reader needs: they say which
 * host served the page and whether it was `/detailed` or the companion. Query
 * values other than the viewer's own settings, and every fragment, can be
 * credentials. The two fragments this repository mints keep their own labels
 * so a companion link still reads as one.
 */
export function redactUrl(value: string): string {
  const marker = value.indexOf('#');
  const beforeFragment = marker < 0 ? value : value.slice(0, marker);
  const question = beforeFragment.indexOf('?');
  const base = question < 0 ? beforeFragment : beforeFragment.slice(0, question);
  const query = question < 0 ? '' : `?${beforeFragment.slice(question + 1).split('&').map(part => {
    const equals = part.indexOf('=');
    if (equals < 0) return part === '' || SETTING_QUERY_KEYS.has(part) ? part : REDACTED;
    const name = part.slice(0, equals);
    return SETTING_QUERY_KEYS.has(name) ? part : `${name}=${REDACTED}`;
  }).join('&')}`;
  const fragment = marker < 0 ? '' : value.slice(marker + 1);
  const shape = fragment === '' ? ''
    : PAIR_FRAGMENT.test(fragment) ? '#pair=<8 digits>'
      : PAGE_KEY_FRAGMENT.test(fragment) ? '#<page key>'
        : '#<fragment>';
  return `${base}${query}${shape}`;
}

/**
 * Strip credentials from one line of free text before it is printed.
 *
 * Console lines are written by the page, not by this module, so they carry
 * whatever the page logged: a whole href, a device key, an Authorization
 * header echoed into a failed-fetch message. URLs are handled first so a
 * fragment keeps its descriptive label, then the leftovers — bearer tokens and
 * bare 32-plus-character hex runs — are replaced wholesale. Over-redacting a
 * long hash is cheaper than printing a live page key.
 */
export function redactDevtoolsText(value: string): string {
  return value
    .replace(DATA_URI, (_match, media: string | undefined, _params, body: string) =>
      `data:${media ?? 'application/octet-stream'},<${body.length} chars elided>`)
    .replace(URL_IN_TEXT, match => redactUrl(match))
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(LONG_HEX, REDACTED);
}

/** Walk a structure and redact every string in it. */
export function redactDeep<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return redactDevtoolsText(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const copy: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node)) copy[key] = walk(entry);
      return copy;
    }
    return node;
  };
  return walk(value) as T;
}

// ------------------------------------------------------------------ targets

export type DevtoolsTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
};

/** The shape `/json` returns, narrowed to the fields anything here reads. */
export function parseTargets(body: string): DevtoolsTarget[] {
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(entry => {
    if (entry === null || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const socket = typeof record.webSocketDebuggerUrl === 'string' ? record.webSocketDebuggerUrl : '';
    return [{
      id: String(record.id ?? ''),
      type: String(record.type ?? ''),
      title: String(record.title ?? ''),
      url: String(record.url ?? ''),
      webSocketDebuggerUrl: socket,
    }];
  });
}

/** Targets worth attaching to: real tabs with a debugger socket, no chrome:// pages. */
export function pageTargets(targets: readonly DevtoolsTarget[]): DevtoolsTarget[] {
  return targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl
    && !target.url.startsWith('chrome://') && !target.url.startsWith('about:'));
}

/**
 * Which tab is the Stereofold page.
 *
 * The wearer moves between the companion and the `/detailed` Mol* view during
 * a session, and "Open in Mol*" opens a second tab rather than replacing the
 * first, so the answer changes during a session and has to be recomputed
 * rather than cached. The path decides it: this product serves exactly
 * `/detailed`, `/companion` and `/inspection`. A caller that names a tab by id
 * or by a substring of its URL overrides the guess entirely, which is the
 * escape hatch for a page this list has not heard of.
 */
// `/viewer` is where the LAN share actually lands the headset: every tab the
// adb intent opened was /viewer, and without it the picker fell through to
// "any page", which could be the New Tab.
export const STEREOFOLD_PATHS = Object.freeze(['/viewer', '/detailed', '/companion', '/inspection', '/experience']);

/** A target's origin, or nothing when Quest Browser listed an address that will not parse. */
export function targetOrigin(url: string): string | undefined {
  try { return new URL(url).origin; } catch { return undefined; }
}

/**
 * Is this tab one of ours?
 *
 * The path alone is not an answer. `/viewer` is an ordinary path that any site
 * may serve, so a tab the wearer left open on some unrelated page used to
 * satisfy this test, be attached to as "the Stereofold page", and — worse — be
 * handed to `planOpen`, which closes every Stereofold tab but the newest.
 * Closing a stranger's tab is not something an unattended driver may do, so
 * when the caller knows which origin the share is served from, only that
 * origin is considered. Callers that cannot know it (a bare `headset-devtools`
 * read with no host to ask) pass nothing and keep the older, looser rule.
 */
export function isStereofoldTargetUrl(url: string, expectedOrigin?: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (expectedOrigin !== undefined && parsed.origin !== expectedOrigin) return false;
  return STEREOFOLD_PATHS.some(path => parsed.pathname.startsWith(path));
}

/**
 * The titles this product actually serves, for the case where no origin is known.
 *
 * `build.ts` titles the viewer `Stereofold` and the inspector bundle
 * `Stereofold Inspector`; `detailed-view-page.ts` titles the Mol* tab `Mol*
 * detail`, optionally with a PDB id. Nothing else in the tree serves a page the
 * driver drives, so a `/viewer` tab called anything else is somebody else's.
 */
const STEREOFOLD_TITLE = /stereofold|mol\*/i;

/**
 * Is this tab ours, judged on everything the listing carries?
 *
 * With an origin, the origin settles it. Without one — the host is not sharing
 * yet, or `manage_companion` could not be reached — the path alone used to be
 * the whole test, and `/viewer` is an ordinary path any site may serve. The
 * title is the second half of the answer: a page the wearer left open on some
 * unrelated `/viewer` is not called `Stereofold` and is not called `Mol*
 * detail`, so it no longer reads as the page to attach a debugger to.
 *
 * This is a narrowing, not a guarantee. Nothing without an origin may be
 * *closed* — that decision is `planOpen`'s, and it refuses.
 */
export function isStereofoldTarget(target: { url: string; title?: string }, expectedOrigin?: string): boolean {
  if (!isStereofoldTargetUrl(target.url, expectedOrigin)) return false;
  if (expectedOrigin !== undefined) return true;
  return STEREOFOLD_TITLE.test(target.title ?? '');
}

export function pickStereofoldTarget(targets: readonly DevtoolsTarget[], wanted?: string,
  expectedOrigin?: string): DevtoolsTarget | undefined {
  const pages = pageTargets(targets);
  if (wanted) {
    // An explicit id wins over every filter, including the chrome:// exclusion:
    // naming a target by id is how a caller reaches a page this code would
    // otherwise skip. The substring fallbacks deliberately ignore the fragment.
    // A target id is a short hex string and a page key is a long one, so
    // matching an id against a whole href finds the key rather than the tab —
    // `--target 68` picked `/detailed#...68...` before this was split out.
    const withSocket = targets.filter(target => target.webSocketDebuggerUrl);
    return withSocket.find(target => target.id === wanted)
      ?? withSocket.find(target => target.url.split('#')[0]!.includes(wanted))
      ?? withSocket.find(target => target.title.includes(wanted));
  }
  // With an expected origin, every fallback stays inside it: a tab on another
  // host is never "the page the wearer is looking at", however new it is.
  const ours = expectedOrigin === undefined ? pages : pages.filter(target => targetOrigin(target.url) === expectedOrigin);
  const stereofold = ours.filter(target => isStereofoldTarget(target, expectedOrigin));
  // The most recently opened tab wins when both are Stereofold's: "Open in
  // Mol*" is the wearer moving forward, and a second /viewer from the adb
  // intent is the live page while the first sits frozen behind it. Quest
  // Browser numbers tabs in creation order but lists them by recent focus
  // (measured: the fresh tab 71 came before the stale 70, and the
  // driver clicked nothing in a tab that showed "Reload viewer"), so the
  // highest numeric id is the newest; list order is only the fallback.
  // The "any page on the origin" fallback only exists because the share may
  // serve a route this list has not heard of, and it is only safe because the
  // origin fences it. With no origin there is no fence: the fallback used to
  // hand back the newest tab on the device — Google, the New Tab page — which
  // `headset-drive.ts` then waited 45 s on and reloaded. Nothing is a better
  // answer than a stranger's tab.
  return newestTarget(stereofold) ?? (expectedOrigin === undefined ? undefined : newestTarget(ours));
}

function newestTarget(targets: readonly DevtoolsTarget[]): DevtoolsTarget | undefined {
  if (!targets.length) return undefined;
  if (!targets.every(target => /^\d+$/.test(target.id))) return targets.at(-1);
  return targets.reduce((best, target) => Number(target.id) > Number(best.id) ? target : best);
}

/** One line per target, safe to print. */
export function formatTarget(target: DevtoolsTarget): string {
  return `${target.id}  ${target.type.padEnd(6)}  ${redactUrl(target.url)}  ${redactDevtoolsText(target.title)}`;
}

// -------------------------------------------------------- websocket codec

/** The fixed GUID RFC 6455 hashes the client key against. */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

/** The bytes of the upgrade request, for a socket already connected to the port. */
export function handshakeRequest({ path, host, key }: { path: string; host: string; key: string }): string {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '', '',
  ].join('\r\n');
}

/**
 * Did the server accept the upgrade, and where do the frames start?
 *
 * Returns `undefined` while the header is still arriving, which is how the
 * reader knows to wait for more bytes rather than failing on a split packet.
 */
export function readHandshakeResponse(buffer: Buffer, key: string):
{ ok: true; rest: Buffer } | { ok: false; reason: string } | undefined {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) return buffer.byteLength > 16_384 ? { ok: false, reason: 'The debugger sent no usable HTTP response.' } : undefined;
  const head = buffer.subarray(0, end).toString('utf8');
  const status = /^HTTP\/1\.[01] (\d{3})/u.exec(head)?.[1];
  if (status !== '101') return { ok: false, reason: `The debugger refused the upgrade with HTTP ${status ?? '?'}.` };
  const accept = /\r?\nsec-websocket-accept:\s*(\S+)/iu.exec(head)?.[1];
  if (accept !== websocketAccept(key)) return { ok: false, reason: 'The debugger returned the wrong websocket accept key.' };
  return { ok: true, rest: buffer.subarray(end + 4) };
}

/** One masked client text frame. RFC 6455 requires the mask from a client. */
export function encodeTextFrame(text: string, mask: Buffer = randomBytes(4)): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.byteLength;
  const header = length < 126 ? Buffer.alloc(2)
    : length < 65_536 ? Buffer.alloc(4)
      : Buffer.alloc(10);
  header[0] = 0x81; // FIN + text
  if (length < 126) header[1] = 0x80 | length;
  else if (length < 65_536) { header[1] = 0x80 | 126; header.writeUInt16BE(length, 2); }
  else { header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(length), 2); }
  const masked = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) masked[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([header, mask, masked]);
}

export type WebsocketFrame = { opcode: number; fin: boolean; payload: Buffer };

/**
 * Pull whole frames off a growing buffer.
 *
 * Returns the frames that are complete and the bytes that are not, so a caller
 * appends the next chunk to `rest` and calls again. A CDP screencast frame is
 * a base64 JPEG inside a JSON message and arrives in dozens of TCP segments,
 * so partial reads are the normal case rather than the edge one.
 */
export function decodeFrames(buffer: Buffer): { frames: WebsocketFrame[]; rest: Buffer } {
  const frames: WebsocketFrame[] = [];
  let at = 0;
  for (;;) {
    if (buffer.byteLength - at < 2) break;
    const first = buffer[at]!, second = buffer[at + 1]!;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      if (buffer.byteLength - offset < 2) break;
      length = buffer.readUInt16BE(offset); offset += 2;
    } else if (length === 127) {
      if (buffer.byteLength - offset < 8) break;
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(DEVTOOLS_MAX_MESSAGE_BYTES)) throw Error('The debugger sent a frame past the size limit.');
      length = Number(big); offset += 8;
    }
    let mask: Buffer | undefined;
    if (masked) {
      if (buffer.byteLength - offset < 4) break;
      mask = buffer.subarray(offset, offset + 4); offset += 4;
    }
    if (buffer.byteLength - offset < length) break;
    let payload = buffer.subarray(offset, offset + length);
    if (mask) {
      const copy = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) copy[index] = payload[index]! ^ mask[index % 4]!;
      payload = copy;
    }
    frames.push({ opcode: first & 0x0f, fin: (first & 0x80) !== 0, payload });
    at = offset + length;
  }
  return { frames, rest: buffer.subarray(at) };
}

/**
 * Reassemble fragmented frames into whole CDP messages.
 *
 * Stateful because a fragment sequence spans chunks: opcode 1 or 2 starts a
 * message, opcode 0 continues it, `fin` ends it. Control frames (8, 9, 10)
 * interleave freely and are handed back to the caller untouched, because a
 * ping that goes unanswered closes the connection.
 */
export class MessageAssembler {
  private parts: Buffer[] = [];
  private started = false;

  /** Returns the messages that completed, and any control frames seen. */
  accept(frames: readonly WebsocketFrame[]): { messages: string[]; control: WebsocketFrame[] } {
    const messages: string[] = [], control: WebsocketFrame[] = [];
    for (const frame of frames) {
      if (frame.opcode >= 0x8) { control.push(frame); continue; }
      if (frame.opcode === 0x0 && !this.started) continue; // A continuation with no start is noise.
      if (frame.opcode !== 0x0) { this.parts = []; this.started = true; }
      this.parts.push(frame.payload);
      if (!frame.fin) continue;
      messages.push(Buffer.concat(this.parts).toString('utf8'));
      this.parts = []; this.started = false;
    }
    return { messages, control };
  }
}

// ------------------------------------------------------------- CDP session

export type CdpEvent = { method: string; params: Record<string, unknown> };
export type CdpResult = { id: number; result?: unknown; error?: { message?: string; code?: number } };

/** Sort one inbound CDP message into a reply or an event. */
export function classifyMessage(text: string): { kind: 'result'; value: CdpResult } | { kind: 'event'; value: CdpEvent } | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.id === 'number') {
    return { kind: 'result', value: { id: record.id, result: record.result, error: record.error as CdpResult['error'] } };
  }
  if (typeof record.method === 'string') {
    return { kind: 'event', value: { method: record.method, params: (record.params ?? {}) as Record<string, unknown> } };
  }
  return undefined;
}

/**
 * The minimum a socket has to do for `CdpSession` to drive it. A test seam.
 *
 * Written out structurally rather than as `Pick<Socket, …>`: the real methods
 * return `this` narrowed to `Socket`, so a fake that returns itself fails to
 * satisfy the picked type for a reason that has nothing to do with what this
 * class needs. Nothing here reads a return value.
 */
export type CdpSocketLike = {
  write(chunk: Buffer | string): boolean;
  end(): unknown;
  destroy(error?: Error): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

/**
 * One open debugger connection to one tab.
 *
 * Deliberately thin: `send` returns the reply, `on` streams events, `close`
 * ends the socket. Everything domain-specific — what to evaluate, how to read
 * a console line, when to stop a screencast — lives in the functions below, so
 * the transport can be tested against a fake socket with no headset attached.
 */
export class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly assembler = new MessageAssembler();
  // Annotated rather than inferred: `concat` and `subarray` both widen to
  // `ArrayBufferLike`, and an inferred `Buffer<ArrayBuffer>` rejects them.
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly socket: CdpSocketLike, private readonly timeoutMs = DEVTOOLS_TIMEOUT_MS) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('close', () => this.fail(Error('The debugger connection closed.')));
    socket.on('error', (error: Error) => this.fail(error));
  }

  /** Feed bytes that arrived after the handshake but before the listener attached. */
  prime(rest: Buffer) { if (rest.byteLength) this.receive(rest); }

  private receive(chunk: Buffer) {
    this.buffer = this.buffer.byteLength ? Buffer.concat([this.buffer, chunk]) : chunk;
    let decoded;
    try { decoded = decodeFrames(this.buffer); }
    catch (error) { this.fail(error instanceof Error ? error : Error(String(error))); return; }
    this.buffer = decoded.rest;
    const { messages, control } = this.assembler.accept(decoded.frames);
    for (const frame of control) {
      // A ping must be answered or Chromium drops the connection mid-stream.
      if (frame.opcode === 0x9) this.socket.write(pongFrame(frame.payload));
      if (frame.opcode === 0x8) this.fail(Error('The debugger closed the connection.'));
    }
    for (const message of messages) {
      const sorted = classifyMessage(message);
      if (!sorted) continue;
      if (sorted.kind === 'event') { for (const listener of this.listeners) listener(sorted.value); continue; }
      const waiter = this.pending.get(sorted.value.id);
      if (!waiter) continue;
      this.pending.delete(sorted.value.id);
      clearTimeout(waiter.timer);
      if (sorted.value.error) waiter.reject(Error(redactDevtoolsText(sorted.value.error.message ?? 'The debugger returned an error.')));
      else waiter.resolve(sorted.value.result ?? {});
    }
  }

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(Error('The debugger connection is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`${method} did not answer within ${timeoutMs} ms.`));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeTextFrame(JSON.stringify({ id, method, params })));
    });
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('The bridge closed.')); }
    this.pending.clear();
    // 0x88 is an empty masked close frame; Chromium answers and drops the socket.
    try { this.socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0])); } catch { /* Already gone. */ }
    try { this.socket.end(); } catch { /* Already gone. */ }
  }
}

export function pongFrame(payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.byteLength);
  for (let index = 0; index < payload.byteLength; index += 1) masked[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([Buffer.from([0x8a, 0x80 | Math.min(125, payload.byteLength)]), mask, masked]);
}

// ------------------------------------------------------------- page reading

/**
 * What the page will say about itself, as one expression.
 *
 * Every read is optional-chained and wrapped, because this runs against a page
 * that may be mid-navigation, may predate a hook, or may have torn one down
 * when a session ended. A missing field is reported as `null` rather than
 * throwing: a state call that fails entirely because the tour player is not
 * loaded yet tells the agent nothing, and the agent asks this question exactly
 * when the page is in a state nobody planned for.
 *
 * It writes nothing. `__stereofoldVoice.say` and `__stereofoldInspection`'s
 * mutators are deliberately not touched — someone is usually wearing the
 * headset when an agent runs this, and a "read" that speaks a command into
 * their ears is the one failure mode that would make the bridge unusable.
 */
export const PAGE_STATE_EXPRESSION = `(() => {
  const pick = fn => { try { const value = fn(); return value === undefined ? null : value; } catch { return null; } };
  const diagnostics = pick(() => globalThis.__stereofoldDiagnostics);
  const entries = diagnostics ? (pick(() => diagnostics.entries()) ?? []) : [];
  const last = kind => { for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i] && entries[i].kind === kind) return entries[i]; return null; };
  const sessionStart = last('session-start'), sessionEnd = last('session-end');
  const startedAt = sessionStart ? (sessionStart.at ?? sessionStart.time ?? null) : null;
  const endedAt = sessionEnd ? (sessionEnd.at ?? sessionEnd.time ?? null) : null;
  const visibility = last('xr-visibility');
  const tour = last('tour');
  const voice = last('voice-press') || last('voice');
  const toolbar = last('toolbar');
  return {
    at: new Date().toISOString(),
    url: pick(() => location.href),
    pathname: pick(() => location.pathname),
    title: pick(() => document.title),
    documentVisibility: pick(() => document.visibilityState),
    hidden: pick(() => document.hidden),
    hasWebXr: pick(() => Boolean(navigator.xr)),
    secureContext: pick(() => isSecureContext),
    devicePixelRatio: pick(() => devicePixelRatio),
    viewport: pick(() => innerWidth + 'x' + innerHeight),
    hooks: {
      diagnostics: Boolean(diagnostics),
      voice: pick(() => Boolean(globalThis.__stereofoldVoice)),
      inspection: pick(() => Boolean(globalThis.__stereofoldInspection)),
      roundtrip: pick(() => Boolean(globalThis.__stereofoldRoundtrip)),
      replyAudio: pick(() => Boolean(globalThis.__stereofoldReplyAudio)),
    },
    xr: {
      sessionStarted: startedAt,
      sessionEnded: endedAt,
      presenting: Boolean(sessionStart) && (!sessionEnd || (startedAt !== null && endedAt !== null ? startedAt > endedAt : false)),
      mode: sessionStart ? (sessionStart.detail && sessionStart.detail.mode) ?? null : null,
      blendMode: sessionStart ? (sessionStart.detail && (sessionStart.detail.blendMode ?? sessionStart.detail.environmentBlendMode)) ?? null : null,
      passthrough: sessionStart ? (sessionStart.detail && sessionStart.detail.mode) === 'immersive-ar' : null,
      visibility: visibility ? (visibility.detail && (visibility.detail.state ?? visibility.detail.visibilityState)) ?? null : null,
      visibilityAt: visibility ? (visibility.at ?? visibility.time ?? null) : null,
    },
    tour: tour ? { detail: tour.detail ?? null, at: tour.at ?? tour.time ?? null } : null,
    voice: voice ? { kind: voice.kind, detail: voice.detail ?? null, at: voice.at ?? voice.time ?? null } : null,
    toolbar: toolbar ? { detail: toolbar.detail ?? null, at: toolbar.at ?? toolbar.time ?? null } : null,
    diagnosticKinds: Array.from(new Set(entries.map(entry => entry && entry.kind).filter(Boolean))),
    diagnosticCount: entries.length,
    errors: entries.filter(entry => entry && (entry.kind === 'page-error' || entry.kind === 'error')).slice(-3),
  };
})()`;

/**
 * Say what a silent target means.
 *
 * Quest Browser freezes a tab the moment it stops being the visible one, and a
 * frozen tab completes its websocket handshake and then answers nothing at
 * all — not even `Runtime.enable`. Measured: the foreground
 * `/detailed` tab answered in 1.4 ms median, the background New Tab timed out
 * at the full ten seconds. Without this the caller sees a bare timeout and
 * concludes the bridge is broken, when the bridge is fine and the tab is
 * asleep. The fix is always the same: bring that tab to the front in the
 * headset, or attach to the one that is already there.
 */
export function explainSilentTarget(method: string, target?: { id: string; url: string }): string {
  const which = target ? ` (target ${target.id}, ${redactUrl(target.url)})` : '';
  return `${method} got no answer${which}. Quest Browser freezes every tab that is not the visible one, `
    + 'so a backgrounded tab accepts the debugger connection and then never replies. '
    + 'Run `targets` and attach to the tab the wearer is actually looking at.';
}

/** Whether a failure is the frozen-tab silence rather than a real fault. */
export function isSilentTargetError(error: unknown): boolean {
  return error instanceof Error && /did not answer within/u.test(error.message);
}

/** `Runtime.evaluate`'s parameters for a pure read that returns a plain object. */
export function evaluateParameters(expression: string, { awaitPromise = false } = {}): Record<string, unknown> {
  return {
    expression,
    returnByValue: true,
    awaitPromise,
    // The page's own code is not a user gesture and this must never act like one.
    userGesture: false,
    generatePreview: false,
  };
}

/** Unwrap `Runtime.evaluate`, turning a thrown page exception into a reason. */
export function readEvaluateResult(raw: unknown): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'The debugger returned no result.' };
  const record = raw as Record<string, unknown>;
  const thrown = record.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
  if (thrown) {
    const text = thrown.exception?.description ?? thrown.text ?? 'The page threw.';
    return { ok: false, reason: redactDevtoolsText(String(text).split('\n')[0] ?? '') };
  }
  const result = record.result as { value?: unknown; description?: string; type?: string } | undefined;
  if (result && 'value' in result) return { ok: true, value: redactDeep(result.value) };
  if (result?.description !== undefined) return { ok: true, value: redactDevtoolsText(result.description) };
  return { ok: true, value: null };
}

// ---------------------------------------------------------------- console

export type ConsoleLine = { at: string; level: string; source: string; text: string; url?: string; line?: number };

const CONSOLE_LEVELS: Readonly<Record<string, string>> = Object.freeze({
  error: 'error', assert: 'error', warning: 'warn', warn: 'warn',
  info: 'info', log: 'log', debug: 'debug', verbose: 'debug', trace: 'debug',
});

/** One `Runtime.RemoteObject` as the text a reader wants. */
export function describeRemoteObject(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value);
  const record = value as Record<string, unknown>;
  if ('value' in record) {
    const inner = record.value;
    return typeof inner === 'string' ? inner : JSON.stringify(inner);
  }
  if (typeof record.description === 'string') return record.description;
  if (typeof record.unserializableValue === 'string') return record.unserializableValue;
  return String(record.type ?? 'object');
}

/**
 * Turn a console or log event into one printable line.
 *
 * Both `Runtime.consoleAPICalled` and `Log.entryAdded` are accepted because
 * they carry different things: the first has the arguments a `console.log`
 * passed, the second has the network and security failures the page never
 * logged itself — a blocked mixed-content request, a refused certificate — and
 * those are exactly the failures a self-signed LAN host produces. Anything
 * else returns `undefined` rather than a half-filled line.
 */
export function formatConsoleEvent(event: CdpEvent, now: () => number = Date.now): ConsoleLine | undefined {
  if (event.method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(event.params.args) ? event.params.args : [];
    const stamp = typeof event.params.timestamp === 'number' ? event.params.timestamp : now();
    const type = String(event.params.type ?? 'log');
    return {
      at: new Date(stamp).toISOString(),
      level: CONSOLE_LEVELS[type] ?? 'log',
      source: 'console',
      text: redactDevtoolsText(args.map(describeRemoteObject).join(' ')),
    };
  }
  if (event.method === 'Log.entryAdded') {
    const entry = (event.params.entry ?? {}) as Record<string, unknown>;
    const stamp = typeof entry.timestamp === 'number' ? entry.timestamp : now();
    const url = typeof entry.url === 'string' ? redactUrl(entry.url) : undefined;
    return {
      at: new Date(stamp).toISOString(),
      level: CONSOLE_LEVELS[String(entry.level ?? 'log')] ?? String(entry.level ?? 'log'),
      source: String(entry.source ?? 'log'),
      text: redactDevtoolsText(String(entry.text ?? '')),
      ...(url ? { url } : {}),
      ...(typeof entry.lineNumber === 'number' ? { line: entry.lineNumber } : {}),
    };
  }
  if (event.method === 'Runtime.exceptionThrown') {
    const details = (event.params.exceptionDetails ?? {}) as Record<string, unknown>;
    const exception = (details.exception ?? {}) as Record<string, unknown>;
    const stamp = typeof event.params.timestamp === 'number' ? event.params.timestamp : now();
    const described = typeof exception.description === 'string' ? exception.description : String(details.text ?? 'Uncaught exception');
    return {
      at: new Date(stamp).toISOString(),
      level: 'error',
      source: 'exception',
      text: redactDevtoolsText(described.split('\n').slice(0, 2).join(' | ')),
      ...(typeof details.url === 'string' ? { url: redactUrl(details.url) } : {}),
    };
  }
  return undefined;
}

export function formatConsoleLine(line: ConsoleLine): string {
  const where = line.url ? `  (${line.url}${line.line !== undefined ? `:${line.line}` : ''})` : '';
  return `${line.at}  ${line.level.padEnd(5)}  ${line.source.padEnd(8)}  ${line.text}${where}`;
}

// -------------------------------------------------------------- screencast

/** `Page.startScreencast` parameters tuned for "cheap and often" over "pretty". */
export function screencastParameters({ quality = 40, maxWidth = 1024, maxHeight = 1024, everyNthFrame = 1 } = {}): Record<string, unknown> {
  return { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame };
}

export type ScreencastStats = { frames: number; bytes: number; firstMs: number; spanMs: number; fps: number; meanBytes: number };

/** What a screencast run actually cost, for a report rather than for a picture. */
export function summarizeScreencast(samples: readonly { at: number; bytes: number }[], startedAt: number): ScreencastStats {
  if (samples.length === 0) return { frames: 0, bytes: 0, firstMs: 0, spanMs: 0, fps: 0, meanBytes: 0 };
  const bytes = samples.reduce((total, sample) => total + sample.bytes, 0);
  const spanMs = samples.length > 1 ? samples.at(-1)!.at - samples[0]!.at : 0;
  return {
    frames: samples.length,
    bytes,
    firstMs: samples[0]!.at - startedAt,
    spanMs,
    fps: spanMs > 0 ? ((samples.length - 1) / spanMs) * 1000 : 0,
    meanBytes: Math.round(bytes / samples.length),
  };
}

// ----------------------------------------------------------- connecting

/** How the bridge reaches the forwarded port. Both are replaced in tests. */
export type DevtoolsTransport = {
  /** `GET http://127.0.0.1:<port><path>`, returning the body. */
  fetch: (port: number, path: string) => Promise<string>;
  /** An open, handshaken CDP session for one debugger URL. */
  open: (port: number, socketUrl: string) => Promise<CdpSession>;
};

/**
 * The real transport: loopback HTTP and a raw socket upgrade.
 *
 * `node:net` and `node:http` are imported lazily so that everything above —
 * the codec, the redaction, the parsers — stays importable in a test that
 * never opens a socket, and so a host that only wants the pure functions pays
 * nothing for the ones that talk.
 */
export function nodeDevtoolsTransport(): DevtoolsTransport {
  return {
    async fetch(port, path) {
      const { get } = await import('node:http');
      return await new Promise<string>((resolve, reject) => {
        const request = get({ host: '127.0.0.1', port, path, timeout: DEVTOOLS_TIMEOUT_MS }, response => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        request.on('timeout', () => request.destroy(Error(`127.0.0.1:${port} did not answer.`)));
        request.on('error', reject);
      });
    },
    async open(port, socketUrl) {
      const { connect } = await import('node:net');
      const path = new URL(socketUrl).pathname;
      const key = randomBytes(16).toString('base64');
      return await new Promise<CdpSession>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port }, () => {
          // No `Origin` header: Chromium's DevTools HTTP handler answers 403 to
          // any upgrade that carries one unless the browser was started with
          // --remote-allow-origins, and Quest Browser was not. Verified by
          // sending one deliberately.
          socket.write(handshakeRequest({ path, host: `127.0.0.1:${port}`, key }));
        });
        socket.setTimeout(DEVTOOLS_TIMEOUT_MS, () => socket.destroy(Error('The debugger handshake timed out.')));
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
    },
  };
}

export type HeadsetBrowserReading = {
  target: { id: string; url: string; title: string };
  state: Record<string, unknown> | null;
  stateReason?: string;
  console: ConsoleLine[];
};

/**
 * One connection, both answers.
 *
 * `state` and `console` are separate questions but never separate trips: the
 * expensive part is the handshake and the tab freeze check, and an agent that
 * asks "what is the page doing" almost always wants "and what did it complain
 * about" in the same breath. Enabling `Runtime` and `Log` replays Chromium's
 * backlog, so a single short wait collects what the page has said since it
 * loaded rather than only what it says next.
 *
 * Nothing here writes. The caller gets a reading or a reason, and a frozen tab
 * is reported as the ordinary state it is rather than thrown as a fault.
 */
export async function readHeadsetBrowser(transport: DevtoolsTransport, {
  port, wanted, expectedOrigin, consoleMs = 1_200, livenessMs = 1_500,
}: { port: number; wanted?: string; expectedOrigin?: string; consoleMs?: number; livenessMs?: number }): Promise<HeadsetBrowserReading> {
  const targets = parseTargets(await transport.fetch(port, '/json'));
  const target = pickStereofoldTarget(targets, wanted, expectedOrigin);
  if (!target) throw Error(`The debugger on 127.0.0.1:${port} lists no usable page.`);
  const session = await transport.open(port, target.webSocketDebuggerUrl);
  const lines: ConsoleLine[] = [];
  const stop = session.on(event => { const line = formatConsoleEvent(event); if (line) lines.push(line); });
  try {
    try { await session.send('Runtime.enable', {}, livenessMs); }
    catch (error) {
      if (isSilentTargetError(error)) throw Error(explainSilentTarget('Runtime.enable', target));
      throw error;
    }
    await session.send('Log.enable');
    const raw = await session.send('Runtime.evaluate', evaluateParameters(PAGE_STATE_EXPRESSION));
    const outcome = readEvaluateResult(raw);
    await new Promise(resolve => { const timer = setTimeout(resolve, consoleMs); (timer as { unref?: () => void }).unref?.(); });
    return {
      target: { id: target.id, url: redactUrl(target.url), title: redactDevtoolsText(target.title) },
      state: outcome.ok ? outcome.value as Record<string, unknown> : null,
      ...(outcome.ok ? {} : { stateReason: outcome.reason }),
      console: lines,
    };
  } finally {
    stop();
    session.close();
  }
}

/** The sentence an agent reads first, before any of the structure. */
export function summarizeReading(reading: HeadsetBrowserReading): string {
  const state = (reading.state ?? {}) as Record<string, any>;
  const xr = state.xr ?? {};
  const errors = reading.console.filter(line => line.level === 'error').length;
  const where = state.pathname ? `The headset browser is on ${state.pathname}` : 'The headset browser answered';
  const immersion = xr.presenting
    ? `, presenting ${xr.mode ?? 'an XR session'}${xr.passthrough ? ' with passthrough' : ''}`
    : ', not in an immersive session';
  const seen = state.documentVisibility ? `, document ${state.documentVisibility}` : '';
  const said = reading.console.length === 0
    ? ' It has logged nothing.'
    : ` It has logged ${reading.console.length} line${reading.console.length === 1 ? '' : 's'}, ${errors} of them errors.`;
  return `${where}${immersion}${seen}.${said}`;
}

/** Pull the JPEG out of one `Page.screencastFrame`, or nothing. */
export function readScreencastFrame(event: CdpEvent): { bytes: Buffer; sessionId: number } | undefined {
  if (event.method !== 'Page.screencastFrame') return undefined;
  const data = event.params.data;
  if (typeof data !== 'string' || data === '') return undefined;
  const sessionId = typeof event.params.sessionId === 'number' ? event.params.sessionId : 0;
  return { bytes: Buffer.from(data, 'base64'), sessionId };
}
