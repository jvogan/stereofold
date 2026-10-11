/**
 * The debugger bridge, driven against a fake socket.
 *
 * Nothing here attaches to a headset. The transport is a pair of in-memory
 * functions and the "browser" is a handful of scripted CDP replies, so the
 * suite runs on a Mac with no adb, no Quest and no cable, which is where it
 * has to run in CI. The live behaviour these fakes stand in for was measured
 * against Quest Browser 150.1.0.24.52 and the numbers are in the
 * comments, so a future reader can tell a fake that drifted from a browser
 * that changed.
 *
 * The redaction tests model browser messages with synthetic values: a Mol*
 * WebAssembly data URI refused by CSP and a `/detailed` address containing a
 * dummy 64-character page key.
 */

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';

import {
  CdpSession, MessageAssembler, PAGE_STATE_EXPRESSION, classifyMessage, decodeFrames,
  describeRemoteObject, devtoolsPort, encodeTextFrame, evaluateParameters, explainSilentTarget,
  forwardArguments, formatConsoleEvent, formatTarget, handshakeRequest, isSilentTargetError,
  isStereofoldTarget, isStereofoldTargetUrl, pageTargets, parseTargets, pickStereofoldTarget, readEvaluateResult, readHandshakeResponse,
  targetOrigin,
  readHeadsetBrowser, readScreencastFrame, redactDeep, redactDevtoolsText, redactUrl, screencastParameters,
  summarizeReading, summarizeScreencast, websocketAccept,
  DEVTOOLS_DEFAULT_PORT, DEVTOOLS_ABSTRACT_SOCKET, REDACTED,
  type CdpSocketLike, type DevtoolsTransport,
} from '../src/headset-devtools.js';

/** Reserved .test origins and repeated dummy keys never identify a device or session. */
const TEST_PAGE_KEY = '68'.repeat(32);
const TEST_PAIR_CODE = '12345678';
const PAGE_URL = `https://headset.test:8443/detailed#${TEST_PAGE_KEY}`;
const PAIR_URL = `https://headset.test:8443/companion#pair=${TEST_PAIR_CODE}`;

describe('redaction', () => {
  it('describes a page-key fragment instead of printing it', () => {
    const redacted = redactUrl(PAGE_URL);
    expect(redacted).toBe('https://headset.test:8443/detailed#<page key>');
    expect(redacted).not.toContain(TEST_PAGE_KEY.slice(0,8));
  });

  it('keeps a pairing link readable as one while dropping the code', () => {
    expect(redactUrl(PAIR_URL)).toBe('https://headset.test:8443/companion#pair=<8 digits>');
  });

  it('leaves an address with no fragment alone', () => {
    expect(redactUrl('https://headset.test:8443/detailed')).toBe('https://headset.test:8443/detailed');
  });

  it('labels an unrecognised fragment rather than guessing at it', () => {
    expect(redactUrl('https://example.test/x#something-new')).toBe('https://example.test/x#<fragment>');
  });

  it('redacts a secret carried in the query string', () => {
    expect(redactUrl('https://host.test/p?token=abcdef123456&safe=1'))
      .toBe(`https://host.test/p?token=${REDACTED}&safe=${REDACTED}`);
  });

  it('redacts any query value except the viewer settings it reads', () => {
    const redacted = redactUrl('https://host.test/viewer?access_token=a1b2c3d4&xrRenderBudget=scale:0.5&opaque#pair=12345678');
    expect(redacted).toBe(`https://host.test/viewer?access_token=${REDACTED}&xrRenderBudget=scale:0.5&${REDACTED}#pair=<8 digits>`);
    expect(redacted).not.toContain('a1b2c3d4');
    expect(redacted).not.toContain('opaque');
  });

  it('redacts a URL embedded in a console sentence', () => {
    const line = `Refused to load ${PAGE_URL} because of policy`;
    expect(redactDevtoolsText(line)).toBe('Refused to load https://headset.test:8443/detailed#<page key> because of policy');
  });

  it('elides a base64 data URI instead of echoing a megabyte of it', () => {
    // Simulate Mol*'s WebAssembly module refused by connect-src 'self'.
    const body = 'AGFzbQEAAAAB'.repeat(200);
    const line = `Fetch API cannot load data:application/octet-stream;base64,${body}. Refused to connect.`;
    const redacted = redactDevtoolsText(line);
    expect(redacted).toContain('data:application/octet-stream,<');
    expect(redacted).toContain('chars elided>');
    expect(redacted).not.toContain(body);
    expect(redacted.length).toBeLessThan(200);
  });

  it('drops a bearer token and a bare long hex run', () => {
    expect(redactDevtoolsText('Authorization: Bearer abc123.def456.ghi789')).toContain(`Bearer ${REDACTED}`);
    expect(redactDevtoolsText(`key ${'a'.repeat(40)}`)).toBe(`key ${REDACTED}`);
  });

  it('walks a whole structure', () => {
    const walked = redactDeep({ url: PAGE_URL, nested: [{ text: `at ${PAIR_URL}` }], count: 3, flag: true });
    expect(walked.url).toBe('https://headset.test:8443/detailed#<page key>');
    expect(walked.nested[0]!.text).toBe('at https://headset.test:8443/companion#pair=<8 digits>');
    expect(walked.count).toBe(3);
    expect(walked.flag).toBe(true);
  });

  it('redacts the address in a printed target line', () => {
    const line = formatTarget({ id: '69', type: 'page', title: 'Mol* detail', url: PAGE_URL, webSocketDebuggerUrl: 'ws://x/1' });
    expect(line).toContain('#<page key>');
    expect(line).not.toContain(TEST_PAGE_KEY.slice(0,8));
  });
});

describe('targets', () => {
  // Representative Quest Browser 150 response with fixture origins, keys and target IDs.
  const BODY = JSON.stringify([
    { id: '2E759DC4', type: 'other', title: 'Browser UI', url: 'chrome://panel-app-nav/', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/2E759DC4' },
    { id: '69', type: 'page', title: 'Mol* detail - Stereofold structure', url: PAGE_URL, webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/69' },
    { id: '68', type: 'page', title: 'New Tab', url: 'chrome://panel-app-nav/ntp', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/68' },
  ]);

  it('parses the live listing', () => {
    expect(parseTargets(BODY).map(target => target.id)).toEqual(['2E759DC4', '69', '68']);
  });

  it('returns nothing for a body that is not a listing', () => {
    expect(parseTargets('not json')).toEqual([]);
    expect(parseTargets('{"error":1}')).toEqual([]);
  });

  it('keeps only real tabs', () => {
    expect(pageTargets(parseTargets(BODY)).map(target => target.id)).toEqual(['69']);
  });

  it('picks the Stereofold tab out of the browser chrome', () => {
    expect(pickStereofoldTarget(parseTargets(BODY))?.id).toBe('69');
  });

  it('picks the newest Stereofold tab when the wearer has opened a second', () => {
    // The titles are the ones the product serves: `build.ts` titles the viewer
    // `Stereofold`, `detailed-view-page.ts` titles the Mol* tab `Mol* detail`.
    // With no origin to scope by they are half the test for "is this ours".
    const two = parseTargets(JSON.stringify([
      { id: 'a', type: 'page', title: 'Stereofold', url: 'https://host.test:8443/companion', webSocketDebuggerUrl: 'ws://x/a' },
      { id: 'b', type: 'page', title: 'Mol* detail', url: 'https://host.test:8443/detailed', webSocketDebuggerUrl: 'ws://x/b' },
    ]));
    expect(pickStereofoldTarget(two)?.id).toBe('b');
  });

  it('picks the highest tab number when Quest Browser lists the fresh tab first', () => {
    // Measured on hardware: the adb intent opened /viewer as tab 71 while the
    // stale 70 from an earlier run stayed frozen behind it; the list came
    // back 71, 70, 68 and the last-wins rule attached to the dead one.
    const listed = parseTargets(JSON.stringify([
      { id: '71', type: 'page', title: 'Stereofold Inspector', url: 'https://host.test:8443/viewer', webSocketDebuggerUrl: 'ws://x/71' },
      { id: '70', type: 'page', title: 'Stereofold Inspector', url: 'https://host.test:8443/viewer', webSocketDebuggerUrl: 'ws://x/70' },
      { id: '68', type: 'page', title: 'New Tab', url: 'chrome://panel-app-nav/ntp', webSocketDebuggerUrl: 'ws://x/68' },
    ]));
    expect(pickStereofoldTarget(listed)?.id).toBe('71');
  });

  it('lets an explicit id reach a tab the filter would skip', () => {
    // Naming a target by id is the escape hatch for a chrome:// page.
    expect(pickStereofoldTarget(parseTargets(BODY), '68')?.url).toBe('chrome://panel-app-nav/ntp');
  });

  it('never matches a numeric id against the secret in a fragment', () => {
    // Regression: `--target 68` used to select `/detailed` because the page key
    // happens to contain "68". An id must match an id, not a credential.
    const picked = pickStereofoldTarget(parseTargets(BODY), '68');
    expect(picked?.id).toBe('68');
    expect(picked?.url).not.toContain('/detailed');
  });

  it('matches a substring of the address, fragment excluded', () => {
    expect(pickStereofoldTarget(parseTargets(BODY), '/detailed')?.id).toBe('69');
    expect(pickStereofoldTarget(parseTargets(BODY), TEST_PAGE_KEY.slice(0,8))).toBeUndefined();
  });
});

describe('pickStereofoldTarget with an expected origin', () => {
  const share = 'https://host.test:8443';
  const listed = (entries: { id: string; url: string }[]) => parseTargets(JSON.stringify(
    entries.map(entry => ({ ...entry, type: 'page', title: 't', webSocketDebuggerUrl: `ws://x/${entry.id}` }))));

  it('ignores a tab on another site that happens to serve /viewer', () => {
    // The path is not the product: any host may serve /viewer, and attaching
    // to a stranger's tab is how the driver came to read — and schedule for
    // closing — a page that was never ours.
    const targets = listed([
      { id: '90', url: 'https://unrelated.example/viewer' },
      { id: '71', url: `${share}/viewer` },
    ]);
    expect(pickStereofoldTarget(targets, undefined, share)?.id).toBe('71');
  });

  it('prefers the newest tab on the share origin, not the newest tab overall', () => {
    const targets = listed([
      { id: '99', url: 'https://unrelated.example/viewer' },
      { id: '71', url: `${share}/viewer` },
      { id: '70', url: `${share}/detailed` },
    ]);
    expect(pickStereofoldTarget(targets, undefined, share)?.id).toBe('71');
  });

  it('picks nothing rather than an unrelated tab when the share has no page open', () => {
    const targets = listed([{ id: '90', url: 'https://unrelated.example/viewer' }, { id: '91', url: 'https://news.example/' }]);
    expect(pickStereofoldTarget(targets, undefined, share)).toBeUndefined();
  });

  it('still falls back to any page on the share origin, for a path this list has not heard of', () => {
    const targets = listed([{ id: '90', url: 'https://unrelated.example/viewer' }, { id: '80', url: `${share}/something-new` }]);
    expect(pickStereofoldTarget(targets, undefined, share)?.id).toBe('80');
  });

  it('will not take a stranger’s /viewer tab when no origin is known', () => {
    // The cold `open` path runs
    // with no origin (the host has not started sharing when the first status is
    // asked), so this is the rule the driver actually uses at the moment it
    // decides which tab to attach a debugger to. The path alone said yes to any
    // site serving /viewer; the title is the rest of the answer.
    const targets = listed([{ id: '90', url: 'https://unrelated.example/viewer' }]);
    expect(pickStereofoldTarget(targets)).toBeUndefined();
    expect(isStereofoldTarget({ url: 'https://unrelated.example/viewer', title: 'Viewer' })).toBe(false);
  });

  it('still finds our own page by path and title when no origin is known', () => {
    const ours = parseTargets(JSON.stringify([
      { id: '71', type: 'page', title: 'Stereofold', url: 'https://host.test:8443/viewer', webSocketDebuggerUrl: 'ws://x/71' },
    ]));
    expect(pickStereofoldTarget(ours)?.id).toBe('71');
    expect(isStereofoldTarget({ url: 'https://host.test:8443/detailed', title: 'Mol* detail - 1CRN' })).toBe(true);
  });

  it('never falls back to the newest tab on the device when no origin is known', () => {
    // Measured on a Quest: with no Stereofold tab open, the fallback
    // returned whatever the wearer had in front of them, and the driver then
    // waited 45 s on it and reloaded it.
    const targets = listed([{ id: '91', url: 'https://news.example/' }, { id: '92', url: 'https://www.google.com/' }]);
    expect(pickStereofoldTarget(targets)).toBeUndefined();
  });

  it('keeps ignoring the title once the origin is known, because the origin is the better test', () => {
    // A share may serve a page with any title at all; inside the origin that is
    // still our page, and the `/something-new` fallback has to keep working.
    const share2 = 'https://host.test:8443';
    const targets = listed([{ id: '71', url: `${share2}/viewer` }]);
    expect(pickStereofoldTarget(targets, undefined, share2)?.id).toBe('71');
  });

  it('lets an explicitly named tab out of the origin, which is what naming one is for', () => {
    const targets = listed([{ id: '90', url: 'https://unrelated.example/viewer' }, { id: '71', url: `${share}/viewer` }]);
    expect(pickStereofoldTarget(targets, '90', share)?.id).toBe('90');
  });

  it('reads a target origin, and reports an address it cannot parse', () => {
    expect(targetOrigin('https://host.test:8443/viewer#abc')).toBe('https://host.test:8443');
    expect(targetOrigin('not a url')).toBeUndefined();
  });

  it('tests the origin before the path', () => {
    expect(isStereofoldTargetUrl(`${share}/viewer`, share)).toBe(true);
    expect(isStereofoldTargetUrl('https://unrelated.example/viewer', share)).toBe(false);
    expect(isStereofoldTargetUrl(`${share}/somewhere-else`, share)).toBe(false);
    expect(isStereofoldTargetUrl('https://unrelated.example/viewer')).toBe(true);
  });
});

describe('environment and adb wiring', () => {
  it('defaults the port and accepts an override', () => {
    expect(devtoolsPort({})).toBe(DEVTOOLS_DEFAULT_PORT);
    expect(devtoolsPort({ STEREOFOLD_DEVTOOLS_PORT: '9444' })).toBe(9444);
    expect(devtoolsPort({ STEREOFOLD_DEVTOOLS_PORT: 'nonsense' })).toBe(DEVTOOLS_DEFAULT_PORT);
    expect(devtoolsPort({ STEREOFOLD_DEVTOOLS_PORT: '0' })).toBe(DEVTOOLS_DEFAULT_PORT);
  });

  it('builds the forward command adb actually takes', () => {
    expect(forwardArguments('FAKEQUEST00001', 9333))
      .toEqual(['-s', 'FAKEQUEST00001', 'forward', 'tcp:9333', DEVTOOLS_ABSTRACT_SOCKET]);
  });

  it('refuses to rebind only a port the caller owns', () => {
    // 2026-09-28: with --no-rebind on the fixed port, a forward an earlier run
    // left on 9333 made every launch's tab sweep fail, and tabs piled up.
    expect(forwardArguments('FAKEQUEST00001', 50123, { noRebind: true }))
      .toEqual(['-s', 'FAKEQUEST00001', 'forward', '--no-rebind', 'tcp:50123', DEVTOOLS_ABSTRACT_SOCKET]);
  });
});

describe('websocket codec', () => {
  it('computes the accept key RFC 6455 specifies', () => {
    expect(websocketAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('sends no Origin header, which Chromium answers 403 to', () => {
    // Measured: an upgrade carrying Origin got HTTP 403 from Quest Browser.
    expect(handshakeRequest({ path: '/devtools/page/69', host: '127.0.0.1:9333', key: 'k' }))
      .not.toMatch(/origin:/iu);
  });

  it('accepts a correct handshake and hands back the trailing bytes', () => {
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    const head = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`;
    const outcome = readHandshakeResponse(Buffer.concat([Buffer.from(head), Buffer.from([1, 2, 3])]), key);
    expect(outcome).toMatchObject({ ok: true });
    expect((outcome as { rest: Buffer }).rest).toEqual(Buffer.from([1, 2, 3]));
  });

  it('waits rather than failing while the header is still arriving', () => {
    expect(readHandshakeResponse(Buffer.from('HTTP/1.1 101 Swit'), 'k')).toBeUndefined();
  });

  it('refuses a wrong status and a wrong accept key', () => {
    expect(readHandshakeResponse(Buffer.from('HTTP/1.1 403 Forbidden\r\n\r\n'), 'k'))
      .toMatchObject({ ok: false, reason: expect.stringContaining('403') });
    expect(readHandshakeResponse(Buffer.from('HTTP/1.1 101 x\r\nSec-WebSocket-Accept: wrong\r\n\r\n'), 'k'))
      .toMatchObject({ ok: false, reason: expect.stringContaining('accept key') });
  });

  it('round-trips a short, a medium and a long payload', () => {
    for (const length of [5, 200, 70_000]) {
      const text = 'x'.repeat(length);
      // A client frame is masked; unmask it the way a server would.
      const frame = encodeTextFrame(text);
      const { frames, rest } = decodeFrames(frame);
      expect(rest.byteLength).toBe(0);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.payload.toString('utf8')).toBe(text);
      expect(frames[0]!.fin).toBe(true);
    }
  });

  it('returns the leftover when a frame is split across chunks', () => {
    const frame = encodeTextFrame('hello');
    const first = decodeFrames(frame.subarray(0, 4));
    expect(first.frames).toHaveLength(0);
    expect(first.rest.byteLength).toBe(4);
    const second = decodeFrames(Buffer.concat([first.rest, frame.subarray(4)]));
    expect(second.frames[0]!.payload.toString('utf8')).toBe('hello');
  });

  it('refuses a frame that claims to be larger than the limit', () => {
    const header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(64 * 1024 * 1024), 2);
    expect(() => decodeFrames(header)).toThrow(/size limit/u);
  });

  it('reassembles a fragmented message and passes control frames through', () => {
    const assembler = new MessageAssembler();
    const first = assembler.accept([{ opcode: 0x1, fin: false, payload: Buffer.from('{"id":') }]);
    expect(first.messages).toEqual([]);
    const second = assembler.accept([
      { opcode: 0x9, fin: true, payload: Buffer.alloc(0) },
      { opcode: 0x0, fin: true, payload: Buffer.from('1}') },
    ]);
    expect(second.messages).toEqual(['{"id":1}']);
    expect(second.control.map(frame => frame.opcode)).toEqual([0x9]);
  });

  it('ignores a continuation frame with nothing to continue', () => {
    expect(new MessageAssembler().accept([{ opcode: 0x0, fin: true, payload: Buffer.from('x') }]).messages).toEqual([]);
  });
});

describe('CDP message sorting', () => {
  it('tells a reply from an event and rejects noise', () => {
    expect(classifyMessage('{"id":4,"result":{"ok":true}}')).toMatchObject({ kind: 'result', value: { id: 4 } });
    expect(classifyMessage('{"method":"Log.entryAdded","params":{}}')).toMatchObject({ kind: 'event', value: { method: 'Log.entryAdded' } });
    expect(classifyMessage('not json')).toBeUndefined();
    expect(classifyMessage('{"neither":1}')).toBeUndefined();
  });
});

/** A socket that speaks CDP back, replying however the test says to. */
class FakeSocket extends EventEmitter implements CdpSocketLike {
  readonly sent: Record<string, unknown>[] = [];
  ended = false;

  constructor(private readonly reply: (message: Record<string, unknown>, socket: FakeSocket) => void = () => {}) { super(); }

  write(chunk: Buffer | string): boolean {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    for (const frame of decodeFrames(bytes).frames) {
      if (frame.opcode !== 0x1) continue;
      const message = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
      this.sent.push(message);
      this.reply(message, this);
    }
    return true;
  }

  /** Push one unmasked server frame in, the way Chromium would. */
  deliver(value: unknown) {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const header = payload.byteLength < 126
      ? Buffer.from([0x81, payload.byteLength])
      : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.byteLength); return b; })()]);
    this.emit('data', Buffer.concat([header, payload]));
  }

  end() { this.ended = true; return this as never; }
  destroy() { return this as never; }
}

describe('CdpSession', () => {
  it('resolves a reply to the matching request', async () => {
    const socket = new FakeSocket((message, self) => self.deliver({ id: message.id, result: { value: 7 } }));
    const session = new CdpSession(socket);
    await expect(session.send('Runtime.evaluate', { expression: '7' })).resolves.toEqual({ value: 7 });
    expect(socket.sent[0]).toMatchObject({ method: 'Runtime.evaluate', params: { expression: '7' } });
    session.close();
  });

  it('rejects with the debugger\'s own message, redacted', async () => {
    const socket = new FakeSocket((message, self) =>
      self.deliver({ id: message.id, error: { message: `refused ${PAGE_URL}` } }));
    const session = new CdpSession(socket);
    await expect(session.send('Page.navigate')).rejects.toThrow('refused https://headset.test:8443/detailed#<page key>');
    session.close();
  });

  it('times out a request the tab never answers, and says which method', async () => {
    // This is the frozen-tab case: the handshake succeeds, nothing replies.
    const session = new CdpSession(new FakeSocket(), 20);
    await expect(session.send('Runtime.enable')).rejects.toThrow(/Runtime\.enable did not answer within 20 ms/u);
  });

  it('lets one call use a shorter timeout than the session default', async () => {
    const session = new CdpSession(new FakeSocket(), 60_000);
    await expect(session.send('Runtime.enable', {}, 20)).rejects.toThrow(/within 20 ms/u);
  });

  it('delivers events to every listener and stops on unsubscribe', () => {
    const socket = new FakeSocket();
    const session = new CdpSession(socket);
    const seen: string[] = [];
    const stop = session.on(event => seen.push(event.method));
    socket.deliver({ method: 'Log.entryAdded', params: { entry: { text: 'a' } } });
    stop();
    socket.deliver({ method: 'Log.entryAdded', params: { entry: { text: 'b' } } });
    expect(seen).toEqual(['Log.entryAdded']);
    session.close();
  });

  it('answers a ping so Chromium does not drop the stream', () => {
    const socket = new FakeSocket();
    const session = new CdpSession(socket);
    const written: Buffer[] = [];
    const original = socket.write.bind(socket);
    socket.write = (chunk: Buffer | string) => { written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return original(chunk); };
    socket.emit('data', Buffer.from([0x89, 0x00]));
    expect(written.some(frame => frame[0] === 0x8a)).toBe(true);
    session.close();
  });

  it('fails every pending request when the socket closes', async () => {
    const socket = new FakeSocket();
    const session = new CdpSession(socket);
    const pending = session.send('Runtime.evaluate');
    socket.emit('close');
    await expect(pending).rejects.toThrow(/connection closed/u);
  });

  it('ends the socket on close and refuses later sends', async () => {
    const socket = new FakeSocket();
    const session = new CdpSession(socket);
    session.close();
    expect(socket.ended).toBe(true);
    await expect(session.send('Runtime.enable')).rejects.toThrow(/closed/u);
  });
});

describe('evaluate', () => {
  it('asks for a value, not a handle, and never claims a user gesture', () => {
    const parameters = evaluateParameters('1+1');
    expect(parameters).toMatchObject({ returnByValue: true, userGesture: false, awaitPromise: false });
  });

  it('unwraps a returned value and redacts it', () => {
    expect(readEvaluateResult({ result: { value: { href: PAGE_URL } } }))
      .toEqual({ ok: true, value: { href: 'https://headset.test:8443/detailed#<page key>' } });
  });

  it('turns a thrown page exception into one redacted line', () => {
    const outcome = readEvaluateResult({ exceptionDetails: { exception: { description: `TypeError at ${PAGE_URL}\n  at f` } } });
    expect(outcome).toEqual({ ok: false, reason: `TypeError at https://headset.test:8443/detailed#<page key>` });
  });

  it('falls back to a description when there is no plain value', () => {
    expect(readEvaluateResult({ result: { type: 'function', description: 'function f() {}' } }))
      .toEqual({ ok: true, value: 'function f() {}' });
  });

  it('the state expression reads and never writes', () => {
    // The page's write hooks must not appear as calls. `__stereofoldVoice.say`
    // would speak a command into the wearer's ears from a "read".
    expect(PAGE_STATE_EXPRESSION).not.toMatch(/\.say\s*\(/u);
    expect(PAGE_STATE_EXPRESSION).not.toMatch(/loadPanel|applyInspection|setRepresentation|setMotion|dispose/u);
    expect(PAGE_STATE_EXPRESSION).toContain('__stereofoldDiagnostics');
    expect(PAGE_STATE_EXPRESSION).toContain('visibilityState');
  });
});

describe('console lines', () => {
  it('formats a console.log call', () => {
    const line = formatConsoleEvent({ method: 'Runtime.consoleAPICalled',
      params: { type: 'error', timestamp: 0, args: [{ type: 'string', value: 'boom' }, { type: 'number', value: 3 }] } });
    expect(line).toMatchObject({ level: 'error', source: 'console', text: 'boom 3' });
  });

  it('formats the security failure Quest Browser logs that the page never did', () => {
    // The live one: Mol*'s WebAssembly refused by connect-src 'self'.
    const line = formatConsoleEvent({ method: 'Log.entryAdded', params: { entry: {
      source: 'security', level: 'error', timestamp: 0, lineNumber: 24, url: PAGE_URL,
      text: `Connecting to 'data:application/octet-stream;base64,${'AGFzbQ'.repeat(40)}' violates Content Security Policy`,
    } } });
    expect(line?.source).toBe('security');
    expect(line?.url).toBe('https://headset.test:8443/detailed#<page key>');
    expect(line?.text).toContain('chars elided>');
    expect(line?.line).toBe(24);
  });

  it('formats an uncaught exception down to two lines', () => {
    const line = formatConsoleEvent({ method: 'Runtime.exceptionThrown',
      params: { timestamp: 0, exceptionDetails: { exception: { description: 'Error: x\n  at a\n  at b\n  at c' } } } });
    expect(line).toMatchObject({ level: 'error', source: 'exception', text: 'Error: x |   at a' });
  });

  it('ignores an event that is not a console event', () => {
    expect(formatConsoleEvent({ method: 'Page.loadEventFired', params: {} })).toBeUndefined();
  });

  it('describes remote objects without a handle round trip', () => {
    expect(describeRemoteObject({ type: 'string', value: 'hi' })).toBe('hi');
    expect(describeRemoteObject({ type: 'object', description: 'Object' })).toBe('Object');
    expect(describeRemoteObject({ type: 'number', unserializableValue: 'NaN' })).toBe('NaN');
  });
});

describe('screencast', () => {
  it('asks for small cheap JPEGs', () => {
    // Measured live: quality 40 produced ~32 kB frames of a 1280x670 panel.
    expect(screencastParameters()).toMatchObject({ format: 'jpeg', quality: 40 });
  });

  it('summarises a run into rate and size', () => {
    const stats = summarizeScreencast([{ at: 1_000, bytes: 30_000 }, { at: 1_500, bytes: 34_000 }, { at: 2_000, bytes: 32_000 }], 900);
    expect(stats).toMatchObject({ frames: 3, bytes: 96_000, spanMs: 1_000, meanBytes: 32_000, firstMs: 100 });
    expect(stats.fps).toBeCloseTo(2, 5);
  });

  it('reports nothing rather than dividing by zero on an empty run', () => {
    expect(summarizeScreencast([], 0)).toMatchObject({ frames: 0, fps: 0, meanBytes: 0 });
  });

  it('decodes a frame and ignores anything else', () => {
    expect(readScreencastFrame({ method: 'Page.screencastFrame', params: { data: Buffer.from('jpeg').toString('base64'), sessionId: 2 } }))
      .toMatchObject({ sessionId: 2 });
    expect(readScreencastFrame({ method: 'Page.screencastFrame', params: { data: '' } })).toBeUndefined();
    expect(readScreencastFrame({ method: 'Page.loadEventFired', params: {} })).toBeUndefined();
  });
});

describe('the frozen tab', () => {
  it('recognises a timeout as the silence it is', () => {
    expect(isSilentTargetError(Error('Runtime.enable did not answer within 1500 ms.'))).toBe(true);
    expect(isSilentTargetError(Error('connect ECONNREFUSED'))).toBe(false);
  });

  it('names the tab and the fix, with the address redacted', () => {
    const sentence = explainSilentTarget('Runtime.enable', { id: '68', url: PAGE_URL });
    expect(sentence).toContain('target 68');
    expect(sentence).toContain('#<page key>');
    expect(sentence).toMatch(/freezes every tab/u);
  });
});

describe('readHeadsetBrowser', () => {
  /** A transport whose "browser" is one scripted tab. */
  function fakeTransport(reply: (message: Record<string, unknown>, socket: FakeSocket) => void,
    body = JSON.stringify([{ id: '69', type: 'page', title: 'Mol* detail', url: PAGE_URL, webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/69' }])):
  { transport: DevtoolsTransport; sockets: FakeSocket[] } {
    const sockets: FakeSocket[] = [];
    return {
      sockets,
      transport: {
        fetch: async () => body,
        open: async () => { const socket = new FakeSocket(reply); sockets.push(socket); return new CdpSession(socket, 200); },
      },
    };
  }

  const STATE = {
    pathname: '/detailed', title: 'Mol* detail', documentVisibility: 'visible', hasWebXr: true,
    xr: { presenting: true, mode: 'immersive-ar', passthrough: true, visibility: 'visible-blurred' },
    hooks: { diagnostics: true }, diagnosticCount: 12, url: PAGE_URL,
  };

  it('reads state and console over one connection and closes it', async () => {
    const { transport, sockets } = fakeTransport((message, socket) => {
      if (message.method === 'Runtime.evaluate') { socket.deliver({ id: message.id, result: { result: { value: STATE } } }); return; }
      socket.deliver({ id: message.id, result: {} });
      if (message.method === 'Log.enable') {
        socket.deliver({ method: 'Log.entryAdded', params: { entry: { source: 'security', level: 'error', timestamp: 0, text: 'blocked' } } });
      }
    });
    const reading = await readHeadsetBrowser(transport, { port: 9333, consoleMs: 10 });
    expect(reading.target.url).toBe('https://headset.test:8443/detailed#<page key>');
    expect((reading.state as { pathname: string }).pathname).toBe('/detailed');
    expect(reading.console.map(line => line.text)).toEqual(['blocked']);
    expect(sockets[0]!.ended).toBe(true);
    // The state read must not have been preceded by anything that writes.
    expect(sockets[0]!.sent.map(message => message.method))
      .toEqual(['Runtime.enable', 'Log.enable', 'Runtime.evaluate']);
  });

  it('redacts the page key out of the state it returns', async () => {
    const { transport } = fakeTransport((message, socket) => {
      if (message.method === 'Runtime.evaluate') socket.deliver({ id: message.id, result: { result: { value: STATE } } });
      else socket.deliver({ id: message.id, result: {} });
    });
    const reading = await readHeadsetBrowser(transport, { port: 9333, consoleMs: 10 });
    expect(JSON.stringify(reading.state)).not.toContain(TEST_PAGE_KEY.slice(0,8));
  });

  it('explains a frozen tab instead of reporting a bare timeout', async () => {
    const { transport } = fakeTransport(() => { /* A frozen tab answers nothing. */ });
    await expect(readHeadsetBrowser(transport, { port: 9333, livenessMs: 20, consoleMs: 10 }))
      .rejects.toThrow(/freezes every tab/u);
  });

  it('keeps the console when the state expression throws', async () => {
    const { transport } = fakeTransport((message, socket) => {
      if (message.method === 'Runtime.evaluate') {
        socket.deliver({ id: message.id, result: { exceptionDetails: { text: 'ReferenceError' } } });
        return;
      }
      socket.deliver({ id: message.id, result: {} });
    });
    const reading = await readHeadsetBrowser(transport, { port: 9333, consoleMs: 10 });
    expect(reading.state).toBeNull();
    expect(reading.stateReason).toBe('ReferenceError');
  });

  it('says so when the debugger lists no page at all', async () => {
    const { transport } = fakeTransport(() => {}, '[]');
    await expect(readHeadsetBrowser(transport, { port: 9333 })).rejects.toThrow(/no usable page/u);
  });

  it('summarises a presenting session and a quiet one differently', () => {
    expect(summarizeReading({ target: { id: '69', url: 'u', title: 't' }, state: STATE, console: [] }))
      .toBe('The headset browser is on /detailed, presenting immersive-ar with passthrough, document visible. It has logged nothing.');
    expect(summarizeReading({ target: { id: '69', url: 'u', title: 't' },
      state: { pathname: '/detailed', documentVisibility: 'hidden', xr: { presenting: false } },
      console: [{ at: '', level: 'error', source: 'security', text: 'x' }] }))
      .toBe('The headset browser is on /detailed, not in an immersive session, document hidden. It has logged 1 line, 1 of them errors.');
  });
});

/**
 * The tool an agent actually calls.
 *
 * The transport is faked all the way down, so this exercises the registration,
 * the schema, the redaction and the failure sentence without a headset. The
 * point of the failure cases is that none of them is a thrown tool error: a
 * cable that is out and a tab that is asleep are ordinary states, and an agent
 * that gets an exception for one of them stops rather than saying so.
 */
describe('stereo_structure.read_headset_browser', () => {
  const LISTING = JSON.stringify([{ id: '69', type: 'page', title: 'Mol* detail',
    url: PAGE_URL, webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/69' }]);

  function transportFor(reply: (message: Record<string, unknown>, socket: FakeSocket) => void,
    body = LISTING, fetchFails?: Error): DevtoolsTransport {
    return {
      fetch: async () => { if (fetchFails) throw fetchFails; return body; },
      open: async () => new CdpSession(new FakeSocket(reply), 200),
    };
  }

  async function call(transport: DevtoolsTransport, args: Record<string, unknown> = {}) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createStereoStructureServer } = await import('../src/server.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(undefined, { headsetDevtools: transport, environment: {} });
    const client = new Client({ name: 'Headset devtools test', version: '1' });
    await server.connect(b); await client.connect(a);
    try { return await client.callTool({ name: 'stereo_structure.read_headset_browser', arguments: args }) as any; }
    finally { await client.close(); await server.close(); }
  }

  it('reports the page, the session and the console, with the key redacted', async () => {
    const result = await call(transportFor((message, socket) => {
      if (message.method === 'Runtime.evaluate') {
        socket.deliver({ id: message.id, result: { result: { value: {
          pathname: '/detailed', documentVisibility: 'visible', url: PAGE_URL,
          xr: { presenting: true, mode: 'immersive-ar', passthrough: true },
        } } } });
        return;
      }
      socket.deliver({ id: message.id, result: {} });
      if (message.method === 'Log.enable') {
        socket.deliver({ method: 'Log.entryAdded', params: { entry: {
          source: 'security', level: 'error', timestamp: 0, text: `blocked at ${PAGE_URL}` } } });
      }
    }), { consoleMs: 200 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ read: true, port: 9333 });
    expect(result.structuredContent.state.xr).toMatchObject({ presenting: true, mode: 'immersive-ar' });
    expect(result.content[0].text).toContain('presenting immersive-ar with passthrough');
    expect(result.content[0].text).toContain('#<page key>');
    expect(JSON.stringify(result)).not.toContain(TEST_PAGE_KEY.slice(0,8));
  });

  it('answers a missing bridge with advice rather than an error', async () => {
    const result = await call(transportFor(() => {}, LISTING, Error('connect ECONNREFUSED 127.0.0.1:9333')));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ read: false, port: 9333 });
    expect(result.content[0].text).toContain('adb forward tcp:9333 localabstract:chrome_devtools_remote');
  });

  it('answers a frozen tab with the reason it is silent', async () => {
    const result = await call(transportFor(() => { /* Nothing replies. */ }));
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.read).toBe(false);
    expect(result.content[0].text).toMatch(/freezes every tab/u);
  });

  /**
   * Chromium titles its certificate warning "Privacy
   * error", so the page picker, which wants a Stereofold title, never chose
   * that tab, and the read said the debugger listed no usable page.
   */
  const WARNING = { id: '71', type: 'page', title: 'Privacy error', url: 'https://192.168.77.24:8443/viewer',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/71' };
  const warningPage = (message: Record<string, unknown>, socket: FakeSocket) => socket.deliver({ id: message.id, result:
    message.method === 'Runtime.evaluate' ? { result: { value: { href: 'chrome-error://chromewebdata/', title: 'Privacy error',
      code: 'NET::ERR_CERT_AUTHORITY_INVALID' } } } : {} });

  it('reports the certificate warning when it is the only page', async () => {
    const result = await call(transportFor(warningPage, JSON.stringify([WARNING])), { consoleMs: 200 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ read: false, certificateWarning: {
      address: 'https://192.168.77.24:8443', host: '192.168.77.24', code: 'NET::ERR_CERT_AUTHORITY_INVALID', tab: '71' } });
    expect(result.content[0].text).toMatch(/^Quest Browser is showing a certificate warning for https:\/\/192\.168\.77\.24:8443/u);
    expect(result.content[0].text).toContain('Choose Advanced, then "Proceed to 192.168.77.24 (unsafe)". Then tap Enter VR.');
  });

  it('leads with the certificate warning when a viewer tab is also open', async () => {
    const transport: DevtoolsTransport = {
      fetch: async () => JSON.stringify([JSON.parse(LISTING)[0], WARNING]),
      open: async (_port, socketUrl) => new CdpSession(new FakeSocket(socketUrl.endsWith('/71') ? warningPage : (message, socket) => {
        socket.deliver({ id: message.id, result: message.method === 'Runtime.evaluate'
          ? { result: { value: { pathname: '/detailed', documentVisibility: 'hidden' } } } : {} });
      }), 200),
    };
    const result = await call(transport, { consoleMs: 200 });
    expect(result.structuredContent).toMatchObject({ read: true, target: { id: '69' }, certificateWarning: { tab: '71' } });
    expect(result.content[0].text.split('\n')[0]).toMatch(/^Quest Browser is showing a certificate warning/u);
    expect(result.content[0].text).toContain('The headset browser is on /detailed');
  });

  it('is a read-only tool the app cannot see', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createStereoStructureServer } = await import('../src/server.js');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(undefined, {});
    const client = new Client({ name: 'Headset devtools annotations test', version: '1' });
    await server.connect(b); await client.connect(a);
    try {
      const tool = (await client.listTools()).tools.find(entry => entry.name === 'stereo_structure.read_headset_browser');
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      // Model-side, like capture_headset_view: no app visibility marker.
      expect((tool?._meta?.ui as { visibility?: unknown } | undefined)?.visibility).toBeUndefined();
    } finally { await client.close(); await server.close(); }
  });
});
