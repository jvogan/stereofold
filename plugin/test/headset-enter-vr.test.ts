/**
 * Pressing Enter VR for a wearer on the flat page.
 *
 * A fake debugger stands in for Quest Browser: it answers `/json` with one
 * Stereofold tab and scripts what the page reports before and after the
 * press. The point of the refusals is that none is a thrown tool error: a Mac
 * with no cable, a paused tab and a wearer who has not answered "Allow VR" are
 * ordinary states, and the agent is handed the sentence to act on.
 */
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { CdpSession, decodeFrames, withOwnedDevtoolsForward, type CdpSocketLike, type DevtoolsTransport } from '../src/headset-devtools.js';
import { ENTER_VR_ASK_WEARER, enterHeadsetVr, pressParameters } from '../src/headset-enter-vr.js';
import { createStereoStructureServer } from '../src/server.js';
import type { DeviceCaptureHooks } from '../src/headset-view-device.js';

const VIEWER_URL = 'https://192.168.77.24:8443/viewer#37660ffc790f0ee8e91ef9f940b804325d7eedf034464aa11bb22cc33dd44ee55';
const ORIGIN = 'https://192.168.77.24:8443';
const PRESS = pressParameters(ORIGIN).expression;
const LISTING = JSON.stringify([{ id: '71', type: 'page', title: 'Stereofold', url: VIEWER_URL,
  webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/71' }]);

class FakeSocket extends EventEmitter implements CdpSocketLike {
  readonly sent: Record<string, any>[] = [];
  ended = false;
  constructor(private readonly reply: (message: Record<string, any>, socket: FakeSocket) => void) { super(); }
  write(chunk: Buffer | string): boolean {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    for (const frame of decodeFrames(bytes).frames) {
      if (frame.opcode !== 0x1) continue;
      const message = JSON.parse(frame.payload.toString('utf8')) as Record<string, any>;
      this.sent.push(message);
      this.reply(message, this);
    }
    return true;
  }
  deliver(value: unknown) {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const header = payload.byteLength < 126 ? Buffer.from([0x81, payload.byteLength])
      : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.byteLength); return b; })()]);
    this.emit('data', Buffer.concat([header, payload]));
  }
  end() { this.ended = true; return this as never; }
  destroy() { return this as never; }
}

type PageState = { origin: string; pathname: string; marker: boolean; presenting: boolean | null; phase: string | null; sessionVisibility: string | null;
  mode: string | null; button: string; note: string | null };
const FLAT: PageState = { origin: ORIGIN, pathname: '/viewer', marker: true, presenting: false, phase: 'idle', sessionVisibility: null, mode: null, button: 'enter', note: 'Ready for the headset.' };

/**
 * A page that presents after `readsToPresent` state reads following the press.
 * `after` is what it reports once there; `never` keeps it waiting.
 */
function page({ before = FLAT, after = { ...FLAT, presenting: true, phase: 'active', sessionVisibility: 'visible', mode: 'immersive-ar', button: 'disabled' } as PageState,
  waiting = { ...FLAT, phase: 'requesting-headset', button: 'disabled', note: 'Entering headset view…' } as PageState,
  readsToPresent = 2, never = false, silent = false, pressValue = 'enter', listing = LISTING } = {}) {
  let pressed = false, readsSincePress = 0;
  const sockets: FakeSocket[] = [];
  const transport: DevtoolsTransport = {
    fetch: async () => listing,
    open: async () => {
      const socket = new FakeSocket((message, self) => {
        if (silent) return;
        if (message.method !== 'Runtime.evaluate') { self.deliver({ id: message.id, result: {} }); return; }
        if (message.params.expression === PRESS) {
          pressed = pressValue === 'enter';
          self.deliver({ id: message.id, result: { result: { type: 'string', value: pressValue } } });
          return;
        }
        const state = !pressed ? before : (never || ++readsSincePress < readsToPresent) ? waiting : after;
        self.deliver({ id: message.id, result: { result: { type: 'object', value: state } } });
      });
      sockets.push(socket);
      return new CdpSession(socket, 200);
    },
  };
  return { transport, sockets, pressed: () => pressed };
}

/** A clock that moves only when the poll sleeps, so a 15 s wait takes no time. */
function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => { at += ms; } };
}

describe('enterHeadsetVr', () => {
  it('presses Enter VR once, as a user gesture, and waits for the page to present', async () => {
    const fake = page();
    const outcome = await enterHeadsetVr(fake.transport, { port: 9333, expectedOrigin: ORIGIN, ...clock() });
    expect(outcome).toMatchObject({ entered: true, pressed: true, state: 'presenting', mode: 'immersive-ar', waitedMs: 500 });
    expect(outcome.text).toBe('Pressed Enter VR; the headset is presenting immersive-ar after 0.5 s.');
    const sent = fake.sockets[0]!.sent;
    const presses = sent.filter(message => message.params?.expression === PRESS);
    expect(presses).toHaveLength(1);
    expect(presses[0]!.params.userGesture).toBe(true);
    // Every read around the press is a plain read, never a gesture.
    expect(sent.filter(message => message.method === 'Runtime.evaluate' && message.params.expression !== PRESS)
      .every(message => message.params.userGesture === false)).toBe(true);
    expect(fake.sockets[0]!.ended).toBe(true);
    // The page key in the tab's address never reaches the agent.
    expect(JSON.stringify(outcome)).not.toContain('37660ffc');
  });

  it('presses nothing when the page is already presenting', async () => {
    const fake = page({ before: { ...FLAT, presenting: true, phase: 'active', mode: 'immersive-ar', button: 'disabled' } });
    const outcome = await enterHeadsetVr(fake.transport, { port: 9333, expectedOrigin: ORIGIN, ...clock() });
    expect(outcome).toMatchObject({ entered: true, pressed: false, state: 'already-presenting' });
    expect(fake.pressed()).toBe(false);
  });

  it('reports a hidden presenting session without claiming the wearer is in VR', async () => {
    const fake = page({ before: { ...FLAT, presenting: true, phase: 'active', sessionVisibility: 'hidden',
      mode: 'immersive-ar', button: 'disabled' } });
    const outcome = await enterHeadsetVr(fake.transport, { port: 9333, expectedOrigin: ORIGIN, ...clock() });
    expect(outcome).toMatchObject({ entered: true, pressed: false, state: 'hidden', sessionVisibility: 'hidden' });
    expect(outcome.text).toContain('wearer.state "in-vr" after visible frames resume');
    expect(fake.pressed()).toBe(false);
  });

  it('says the wearer has to answer Allow VR when the request is still held at the deadline', async () => {
    const fake = page({ never: true });
    const outcome = await enterHeadsetVr(fake.transport, { port: 9333, expectedOrigin: ORIGIN, timeoutMs: 15_000, ...clock() });
    expect(outcome).toMatchObject({ entered: false, pressed: true, state: 'awaiting-allow', phase: 'requesting-headset' });
    expect(outcome.text).toContain('"Allow VR" prompt that only the wearer can answer');
  });

  it('asks the wearer when no debugger answers on this Mac', async () => {
    const transport: DevtoolsTransport = {
      fetch: async () => { throw Error('connect ECONNREFUSED 127.0.0.1:9333'); },
      open: async () => { throw Error('A refused debugger must not be opened.'); },
    };
    const outcome = await enterHeadsetVr(transport, { port: 9333, expectedOrigin: ORIGIN, ...clock() });
    expect(outcome).toMatchObject({ entered: false, pressed: false, state: 'no-debugger', reason: 'connect ECONNREFUSED 127.0.0.1:9333' });
    expect(outcome.text).toBe(ENTER_VR_ASK_WEARER);
  });

  it('names a paused tab instead of timing out on it', async () => {
    const outcome = await enterHeadsetVr(page({ silent: true }).transport, { port: 9333, expectedOrigin: ORIGIN, livenessMs: 50, ...clock() });
    expect(outcome).toMatchObject({ entered: false, pressed: false, state: 'paused-tab' });
    expect(outcome.text).toMatch(/switch to it and tap Enter VR/u);
  });

  it('refuses the full Mol* viewer, which has no Enter VR', async () => {
    const outcome = await enterHeadsetVr(page({ before: { ...FLAT, pathname: '/detailed', button: 'none' } }).transport, { port: 9333, expectedOrigin: ORIGIN, ...clock() });
    expect(outcome).toMatchObject({ entered: false, pressed: false, state: 'detailed-view' });
  });

  it('refuses an unbound share, two matching tabs, and a tab that navigates before the press', async () => {
    const one = page();
    expect((await enterHeadsetVr(one.transport, { port: 9333, ...clock() })).state).toBe('no-share');
    expect(one.pressed()).toBe(false);
    const two = page({ listing: JSON.stringify([...JSON.parse(LISTING), { ...JSON.parse(LISTING)[0], id: '72' }]) });
    expect((await enterHeadsetVr(two.transport, { port: 9333, expectedOrigin: ORIGIN, ...clock() })).state).toBe('ambiguous-page');
    const moved = page({ pressValue: 'identity' });
    expect((await enterHeadsetVr(moved.transport, { port: 9333, expectedOrigin: ORIGIN, ...clock() })).state).toBe('changed-page');
    expect(moved.pressed()).toBe(false);
    expect(String(PRESS)).toContain('location.origin !==');
    expect(String(PRESS)).toContain('__stereofoldMenu.xrStartup()');
  });

  it('checks the live origin, route, page marker and presentation inside the click expression', () => {
    const page = (origin: string, pathname: string, marker: boolean, presenting: boolean) => {
      let clicks = 0;
      const button = { disabled: false, closest: () => null, getClientRects: () => [1], click: () => { clicks += 1; } };
      const context = { location: { origin, pathname },
        __stereofoldMenu: marker ? { xrStartup: () => ({ presenting, phase: 'idle' }) } : undefined,
        document: { querySelector: (selector: string) => selector.includes('immersive-ar') ? button : null } };
      const result = runInNewContext(String(PRESS), context);
      return { result, clicks };
    };
    expect(page(ORIGIN, '/viewer', true, false)).toEqual({ result: 'enter', clicks: 1 });
    expect(page('https://other.example', '/viewer', true, false)).toEqual({ result: 'identity', clicks: 0 });
    expect(page(ORIGIN, '/other', true, false)).toEqual({ result: 'identity', clicks: 0 });
    expect(page(ORIGIN, '/viewer', false, false)).toEqual({ result: 'identity', clicks: 0 });
    expect(page(ORIGIN, '/viewer', true, true)).toEqual({ result: 'presenting', clicks: 0 });
  });

  it('returns a target URL with its query values and fragment redacted', async () => {
    const listing = JSON.stringify([{ ...JSON.parse(LISTING)[0], url: `${ORIGIN}/viewer?session=credential#page-key` }]);
    const outcome = await enterHeadsetVr(page({ listing }).transport, { port: 9333, expectedOrigin: ORIGIN, ...clock() });
    expect(outcome.target?.url).toBe(`${ORIGIN}/viewer?session=<redacted>#<fragment>`);
    expect(JSON.stringify(outcome)).not.toContain('credential');
  });
});

describe('an owned debugger forward', () => {
  it('aborts on a failed forward and removes only a successful mapping', async () => {
    const calls: string[][] = [];
    let fail = true;
    const run = async (_adb: string, args: string[]) => { calls.push(args); return { code: fail ? 1 : 0 }; };
    const failed = await withOwnedDevtoolsForward({ adb: 'adb', serial: 'QUEST', run, allocate: async () => 49152,
      action: async () => { throw Error('A failed forward must not reach the debugger.'); } });
    expect(failed).toMatchObject({ ok: false });
    expect(calls).toHaveLength(1);
    calls.length = 0;
    fail = false;
    const success = await withOwnedDevtoolsForward({ adb: 'adb', serial: 'QUEST', run, allocate: async () => 49153,
      action: async port => port });
    expect(success).toEqual({ ok: true, port: 49153, value: 49153 });
    expect(calls[0]).toContain('--no-rebind');
    expect(calls[1]).toEqual(['-s', 'QUEST', 'forward', '--remove', 'tcp:49153']);
  });
});

describe('manage_companion action="enter-vr"', () => {
  const noDevice = (): DeviceCaptureHooks => ({
    run: async () => { throw Error('A test must never run adb.'); },
    exists: async () => false,
    env: { PATH: '' },
  });

  async function call(transport: DevtoolsTransport) {
    const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(undefined, { headsetDevtools: transport, headsetDevice: noDevice(), environment: {} });
    const client = new Client({ name: 'Enter VR test', version: '1' });
    await server.connect(b); await client.connect(a);
    try {
      const sessionId = (await client.callTool({ name: 'stereo_structure.inspect', arguments: { structureText: cif } }) as any).structuredContent.sessionId;
      return await client.callTool({ name: 'stereo_structure.manage_companion', arguments: { sessionId, action: 'enter-vr' } }) as any;
    } finally { await client.close(); await server.close(); }
  }

  it('answers a Mac with no adb and no debugger with the one sentence to ask the wearer', async () => {
    const result = await call({ fetch: async () => { throw Error('connect ECONNREFUSED 127.0.0.1:9333'); },
      open: async () => { throw Error('unreachable'); } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.enterVr).toMatchObject({ entered: false, pressed: false, state: 'no-share' });
  });

  it('does not use an existing debugger without this session owning a share', async () => {
    const result = await call(page().transport);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.enterVr).toMatchObject({ entered: false, pressed: false, state: 'no-share' });
  });
});
