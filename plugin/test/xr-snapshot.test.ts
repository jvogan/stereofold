import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHeadsetViewStore } from '../src/headset-view.js';
// @ts-ignore Shared JavaScript headset view capture.
import { xrSnapshotFrame, requestHeadsetViewCapture, setHeadsetViewSender, releaseHeadsetView, headsetViewState, uploadHeadsetView, flatColor, HEADSET_VIEW_DEFAULT_WIDTH } from '../../lab/browser-roundtrip/xr-snapshot.mjs';

/**
 * A WebGL2 context that records what the capture asked of it.
 *
 * The frame-loop contract is the part that can hurt the wearer, so it is
 * tested here rather than only in the emulator: what is bound, what is
 * restored, and that a capture nobody asked for touches nothing at all.
 */
function fakeGl({ blitFails = false }: { blitFails?: boolean } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const state: Record<number, unknown> = {};
  let error = 0;
  let blits = 0;
  const constants = {
    READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9, FRAMEBUFFER: 0x8d40, RENDERBUFFER: 0x8d41,
    READ_FRAMEBUFFER_BINDING: 0x8caa, DRAW_FRAMEBUFFER_BINDING: 0x8ca6, RENDERBUFFER_BINDING: 0x8ca7,
    PIXEL_PACK_BUFFER: 0x88eb, PIXEL_PACK_BUFFER_BINDING: 0x88ed,
    PACK_ALIGNMENT: 0x0d05, PACK_ROW_LENGTH: 0x0d02, PACK_SKIP_ROWS: 0x0d03, PACK_SKIP_PIXELS: 0x0d04,
    COLOR_ATTACHMENT0: 0x8ce0, COLOR_BUFFER_BIT: 0x4000, COLOR_WRITEMASK: 0x0c23,
    FRAMEBUFFER_COMPLETE: 0x8cd5, RGBA: 0x1908, RGBA8: 0x8058, UNSIGNED_BYTE: 0x1401,
    LINEAR: 0x2601, NEAREST: 0x2600, SCISSOR_TEST: 0x0c11, STREAM_READ: 0x88e1,
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117, TIMEOUT_EXPIRED: 0x911b, WAIT_FAILED: 0x911d, NO_ERROR: 0,
  };
  const note = (name: string, ...args: unknown[]) => { calls.push({ name, args }); };
  let scissorEnabled = true;
  const gl: any = {
    ...constants,
    calls,
    scissorState: () => scissorEnabled,
    createFramebuffer: () => ({ kind: 'fbo' }), createRenderbuffer: () => ({ kind: 'rbo' }), createBuffer: () => ({ kind: 'buf' }),
    deleteFramebuffer: () => {}, deleteRenderbuffer: () => {}, deleteBuffer: () => {}, deleteSync: () => {},
    bindFramebuffer: (target: number, value: unknown) => { note('bindFramebuffer', target, value); state[target] = value; },
    bindRenderbuffer: (target: number, value: unknown) => { state[constants.RENDERBUFFER_BINDING] = value; },
    bindBuffer: (target: number, value: unknown) => { note('bindBuffer', target, value); state[constants.PIXEL_PACK_BUFFER_BINDING] = value; },
    bufferData: () => note('bufferData'),
    renderbufferStorage: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => constants.FRAMEBUFFER_COMPLETE,
    pixelStorei: (name: number, value: unknown) => { state[name] = value; },
    isEnabled: (name: number) => (name === constants.SCISSOR_TEST ? scissorEnabled : false),
    enable: (name: number) => { if (name === constants.SCISSOR_TEST) { scissorEnabled = true; note('enable', name); } },
    disable: (name: number) => { if (name === constants.SCISSOR_TEST) { scissorEnabled = false; note('disable', name); } },
    colorMask: (...args: unknown[]) => note('colorMask', ...args),
    blitFramebuffer: (...args: unknown[]) => {
      note('blitFramebuffer', ...args);
      blits += 1;
      // Only the first, scaling blit is refused, exactly as a multisampled
      // presentation buffer refuses it on a real device.
      if (blitFails && blits === 1) error = 0x0502;
    },
    readPixels: (...args: unknown[]) => note('readPixels', ...args),
    fenceSync: () => ({ kind: 'sync' }),
    clientWaitSync: () => constants.TIMEOUT_EXPIRED,
    getBufferSubData: () => {},
    flush: () => note('flush'),
    getError: () => { const value = error; error = 0; return value; },
    getParameter: (name: number) => {
      if (name === constants.COLOR_WRITEMASK) return [true, true, true, true];
      if (name === constants.PACK_ALIGNMENT) return 4;
      return state[name] ?? null;
    },
  };
  return gl;
}

const layer = { framebuffer: null, framebufferWidth: 2016, framebufferHeight: 1120,
  getViewport: (view: any) => (view.eye === 'left' ? { x: 0, y: 0, width: 1008, height: 1120 } : { x: 1008, y: 0, width: 1008, height: 1120 }) };
const session = { renderState: { baseLayer: layer } };
const frame = { getViewerPose: () => ({ views: [{ eye: 'left' }, { eye: 'right' }] }) };
const space = {};

describe('the headset snapshot inside the XR frame', () => {
  beforeEach(() => { releaseHeadsetView(); setHeadsetViewSender(undefined); });

  it('does nothing at all when no capture was asked for', () => {
    const gl = fakeGl();
    xrSnapshotFrame({ frame, space, session, gl });
    expect(gl.calls.filter((call: any) => call.name === 'blitFramebuffer' || call.name === 'readPixels')).toEqual([]);
  });

  it('refuses to arm without a registered sender, so a page never captures blind', () => {
    expect(requestHeadsetViewCapture({ id: 'a' })).toBe(false);
    setHeadsetViewSender(() => Promise.resolve({}));
    expect(requestHeadsetViewCapture({ id: 'a' })).toBe(true);
    expect(requestHeadsetViewCapture({ id: '' })).toBe(false);
  });

  it('blits one eye, reads it into a pack buffer and fences, without waiting', () => {
    setHeadsetViewSender(() => Promise.resolve({}));
    const gl = fakeGl();
    requestHeadsetViewCapture({ id: 'req-1', maxWidth: 480 });
    xrSnapshotFrame({ frame, space, session, gl });
    const names = gl.calls.map((call: any) => call.name);
    expect(names).toContain('blitFramebuffer');
    expect(names).toContain('flush');
    const blit = gl.calls.find((call: any) => call.name === 'blitFramebuffer');
    // Source is the left-eye rect; destination is the requested width.
    expect(blit.args.slice(0, 8)).toEqual([0, 0, 1008, 1120, 0, 0, 480, 533]);
    // The image read goes to an offset, not a typed array: it must not block.
    const imageRead = gl.calls.filter((call: any) => call.name === 'readPixels').at(-1);
    expect(imageRead.args.at(-1)).toBe(0);
    expect(headsetViewState().pending).toMatchObject({ id: 'req-1', phase: 'fenced', path: 'blit-pack-fence' });
  });

  it('restores the scissor test and the framebuffer bindings it borrowed', () => {
    setHeadsetViewSender(() => Promise.resolve({}));
    const gl = fakeGl();
    requestHeadsetViewCapture({ id: 'req-2' });
    xrSnapshotFrame({ frame, space, session, gl });
    // Mol* leaves the scissor set to the eye it drew last. A blit obeys it, so
    // the capture turns it off; leaving it off would break the next frame.
    expect(gl.calls.some((call: any) => call.name === 'disable')).toBe(true);
    expect(gl.scissorState()).toBe(true);
    expect(gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)).toBe(null);
    expect(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)).toBe(null);
    expect(gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING)).toBe(null);
  });

  it('falls back to a one-eye resolve when a scaling blit is refused', () => {
    setHeadsetViewSender(() => Promise.resolve({}));
    const gl = fakeGl({ blitFails: true });
    requestHeadsetViewCapture({ id: 'req-3' });
    xrSnapshotFrame({ frame, space, session, gl });
    const blits = gl.calls.filter((call: any) => call.name === 'blitFramebuffer');
    expect(blits).toHaveLength(3);
    // The resolve is one to one, which is what a multisampled read demands.
    expect(blits[1].args.slice(0, 8)).toEqual([0, 0, 1008, 1120, 0, 0, 1008, 1120]);
    expect(headsetViewState().pending).toMatchObject({ path: 'resolve-blit-pack-fence' });
  });

  it('tells the Mac why it could not capture instead of leaving it waiting', async () => {
    const sent: any[] = [];
    setHeadsetViewSender((args: any) => { sent.push(args); return Promise.resolve({}); });
    const gl = fakeGl();
    requestHeadsetViewCapture({ id: 'req-4' });
    xrSnapshotFrame({ frame: { getViewerPose: () => null }, space, session, gl });
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requestId: 'req-4', status: 'failed' });
    expect(sent[0].reason).toMatch(/eye viewport/);
    expect(headsetViewState().pending).toBe(null);
  });

  it('takes one frame per request and never captures again on its own', () => {
    setHeadsetViewSender(() => Promise.resolve({}));
    const gl = fakeGl();
    requestHeadsetViewCapture({ id: 'req-5' });
    xrSnapshotFrame({ frame, space, session, gl });
    const after = gl.calls.filter((call: any) => call.name === 'blitFramebuffer').length;
    for (let index = 0; index < 20; index += 1) xrSnapshotFrame({ frame, space, session, gl });
    expect(gl.calls.filter((call: any) => call.name === 'blitFramebuffer')).toHaveLength(after);
  });

  it('duplicate heartbeat deliveries preserve a pending fence and never repeat the GPU readback', () => {
    setHeadsetViewSender(() => Promise.resolve({}));
    const gl = fakeGl();
    const request = { id: 'reoffered-fence', maxWidth: 480 };
    requestHeadsetViewCapture(request);
    xrSnapshotFrame({ frame, space, session, gl, drawn: true });
    const before = gl.calls.filter((call: any) => ['readPixels', 'blitFramebuffer'].includes(call.name)).length;
    for (let i = 0; i < 5; i++) {
      expect(requestHeadsetViewCapture(request)).toBe(true);
      expect(headsetViewState().pending).toMatchObject({ phase: 'fenced' });
      xrSnapshotFrame({ frame, space, session, gl, drawn: true });
    }
    expect(gl.calls.filter((call: any) => ['readPixels', 'blitFramebuffer'].includes(call.name))).toHaveLength(before);
    releaseHeadsetView(gl);
    requestHeadsetViewCapture(request);
    expect(headsetViewState().pending).toBeNull();
  });

  it('clamps what a request may ask for', () => {
    setHeadsetViewSender(() => Promise.resolve({}));
    const gl = fakeGl();
    requestHeadsetViewCapture({ id: 'req-6', maxWidth: 4_000 });
    xrSnapshotFrame({ frame, space, session, gl });
    expect(gl.calls.find((call: any) => call.name === 'blitFramebuffer').args[6]).toBe(640);
    releaseHeadsetView();
    const narrow = fakeGl();
    requestHeadsetViewCapture({ id: 'req-7', maxWidth: 1 });
    xrSnapshotFrame({ frame, space, session, gl: narrow });
    expect(narrow.calls.find((call: any) => call.name === 'blitFramebuffer').args[6]).toBe(160);
  });

  it('keeps the default width the Mac and the page agree on', () => {
    expect(HEADSET_VIEW_DEFAULT_WIDTH).toBe(480);
  });

  // The black stills of 2026-09-24 and 2026-09-28. The observer runs
  // after every XR callback, and the frame-rate watcher's runs before Mol*'s,
  // so the capture was read from a framebuffer Mol* had not drawn into yet.
  it('waits for the callback that drew, and takes that frame', () => {
    setHeadsetViewSender(() => Promise.resolve({}));
    const gl = fakeGl();
    requestHeadsetViewCapture({ id: 'req-drawn' });
    xrSnapshotFrame({ frame, space, session, gl, drawn: false });
    expect(gl.calls.filter((call: any) => call.name === 'blitFramebuffer')).toEqual([]);
    expect(headsetViewState().pending).toMatchObject({ id: 'req-drawn', phase: 'armed' });
    xrSnapshotFrame({ frame, space, session, gl, drawn: true });
    expect(gl.calls.filter((call: any) => call.name === 'blitFramebuffer')).toHaveLength(1);
    expect(headsetViewState().pending).toMatchObject({ id: 'req-drawn', phase: 'fenced' });
  });

  // The probe used to run once per session, so every later upload repeated the
  // first capture's `probeLit`. The Mac reports it for each frame.
  it('probes the centre pixel again for every capture', () => {
    setHeadsetViewSender(() => Promise.resolve({}));
    const gl = fakeGl();
    const probes = () => gl.calls.filter((call: any) => call.name === 'readPixels' && call.args[2] === 1 && call.args[3] === 1).length;
    requestHeadsetViewCapture({ id: 'req-probe-1' });
    xrSnapshotFrame({ frame, space, session, gl, drawn: true });
    requestHeadsetViewCapture({ id: 'req-probe-2' });
    xrSnapshotFrame({ frame, space, session, gl, drawn: true });
    expect(probes()).toBe(2);
  });
});

describe('snapshot encoder lifetime', () => {
  const workers: any[] = [];
  const sent: any[] = [];
  let revoke: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    releaseHeadsetView(); vi.useFakeTimers(); workers.length = 0; sent.length = 0;
    setHeadsetViewSender((message: any) => { sent.push(message); });
    vi.stubGlobal('OffscreenCanvas', class {});
    vi.stubGlobal('Worker', class {
      onmessage?: (message: any) => void;
      onerror?: () => void;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() { workers.push(this); }
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:snapshot-test');
    revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    releaseHeadsetView(); setHeadsetViewSender(undefined);
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  const startEncoding = async (id: string) => {
    const gl = fakeGl(); gl.clientWaitSync = () => 0x911a;
    requestHeadsetViewCapture({ id });
    xrSnapshotFrame({ frame, space, session, gl, drawn: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(headsetViewState().pending).toMatchObject({ id, phase: 'encoding' });
    expect(workers).toHaveLength(1);
    return gl;
  };

  it('terminates a stalled encoder when its immersive session ends', async () => {
    const gl = await startEncoding('ended');
    releaseHeadsetView(gl);
    await Promise.resolve();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
    expect(headsetViewState().pending).toBeNull();
    expect(sent).toEqual([]);
  });

  it('terminates a timed-out encoder and reports one failure', async () => {
    await startEncoding('timeout');
    await vi.advanceTimersByTimeAsync(6000);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requestId: 'timeout', status: 'failed', reason: 'stalled in encoding' });
  });

  it('duplicate requests cannot extend the original timeout or restart a failed capture', async () => {
    await startEncoding('duplicate-timeout');
    await vi.advanceTimersByTimeAsync(5900);
    requestHeadsetViewCapture({ id: 'duplicate-timeout' });
    expect(workers[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requestId: 'duplicate-timeout', status: 'failed', reason: 'stalled in encoding' });
    requestHeadsetViewCapture({ id: 'duplicate-timeout' });
    expect(headsetViewState().pending).toBeNull();
    expect(workers).toHaveLength(1);
  });

  it('duplicate delivery during encoding and upload produces one worker and one answer', async () => {
    const gl = await startEncoding('duplicate-encoding');
    requestHeadsetViewCapture({ id: 'duplicate-encoding' });
    expect(headsetViewState().pending).toMatchObject({ phase: 'encoding' });
    expect(workers[0].terminate).not.toHaveBeenCalled();
    workers[0].onmessage({ data: { encoded: new Uint8Array([255, 216, 255, 217]).buffer } });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    requestHeadsetViewCapture({ id: 'duplicate-encoding' });
    const reads = gl.calls.filter((call: any) => call.name === 'readPixels').length;
    xrSnapshotFrame({ frame, space, session, gl, drawn: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(headsetViewState().pending).toBeNull();
    expect(workers).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(gl.calls.filter((call: any) => call.name === 'readPixels')).toHaveLength(reads);
  });

  it('reoffers the same encoded bytes after both uploads fail before reaching the host', async () => {
    const store = createHeadsetViewStore();
    const view = { sessionId: 'session', sourceToken: 'source', serverEpoch: 'epoch' };
    const request = store.request();
    const offer = store.claim('panel', view)!;
    let online = false;
    setHeadsetViewSender(async (payload: any) => {
      sent.push(payload);
      if (!online) throw Error('network failed before server acceptance');
      return store.submit(view.sessionId, 'panel', { ...view, ...payload });
    });
    requestHeadsetViewCapture(offer);
    const gl = await startEncoding(request.id);
    workers[0].onmessage({ data: { encoded: new Uint8Array([255, 216, 255, 217]).buffer } });
    await vi.advanceTimersByTimeAsync(250);
    expect(sent).toHaveLength(2);
    expect(await store.waitFor(request.id, 0)).toBeUndefined();
    expect(store.claim('panel', view)).toEqual(offer);
    const reads = gl.calls.filter((call: any) => call.name === 'readPixels').length;
    online = true;
    requestHeadsetViewCapture(store.claim('panel', view));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toBe(sent[0]);
    expect(sent[2].data).toBe('/9j/2Q==');
    expect(await store.waitFor(request.id, 0)).toMatchObject({ ok: true, frame: { requestId: request.id } });
    expect(store.claim('panel', view)).toBeUndefined();
    requestHeadsetViewCapture(offer);
    xrSnapshotFrame({ frame, space, session, gl, drawn: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(3);
    expect(workers).toHaveLength(1);
    expect(gl.calls.filter((call: any) => call.name === 'readPixels')).toHaveLength(reads);
  });

  it('serializes repeated reoffers while the first upload is unresolved', async () => {
    let accept!: () => void;
    setHeadsetViewSender((payload: any) => {
      sent.push(payload);
      return new Promise<void>(resolve => { accept = resolve; });
    });
    await startEncoding('slow-upload');
    workers[0].onmessage({ data: { encoded: new Uint8Array([255, 216, 255, 217]).buffer } });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 8; i++) requestHeadsetViewCapture({ id: 'slow-upload' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(1);
    expect(workers).toHaveLength(1);
    accept();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
  });

  it('retries the original capture failure receipt when its transport failed', async () => {
    let online = false;
    setHeadsetViewSender((payload: any) => {
      sent.push(payload);
      if (!online) throw Error('offline');
    });
    await startEncoding('failed-receipt');
    await vi.advanceTimersByTimeAsync(6250);
    expect(sent).toHaveLength(2);
    online = true;
    requestHeadsetViewCapture({ id: 'failed-receipt' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toBe(sent[0]);
    expect(sent[2]).toMatchObject({ status: 'failed', reason: 'stalled in encoding' });
    expect(workers).toHaveLength(1);
  });

  it.each(['expiry', 'new-request', 'sender-change', 'release'] as const)(
    '%s retires the cached payload and cancels a scheduled upload retry', async reason => {
      setHeadsetViewSender((payload: any) => { sent.push(payload); throw Error('offline'); });
      const id = `retire-${reason}`;
      requestHeadsetViewCapture({ id, expiresAt: Date.now() + (reason === 'expiry' ? 100 : 15_000) });
      await startEncoding(id);
      workers[0].onmessage({ data: { encoded: new Uint8Array([255, 216, 255, 217]).buffer } });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(1);
      if (reason === 'new-request') requestHeadsetViewCapture({ id: 'replacement' });
      if (reason === 'sender-change') setHeadsetViewSender((payload: any) => { sent.push(payload); });
      if (reason === 'release') releaseHeadsetView();
      await vi.advanceTimersByTimeAsync(250);
      requestHeadsetViewCapture({ id, expiresAt: Date.now() + 15_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(1);
      expect(workers).toHaveLength(1);
    });

  it('queues a replacement terminal payload behind an old upload without reviving the old retry', async () => {
    let rejectOld!: (error: Error) => void;
    setHeadsetViewSender((payload: any) => {
      sent.push(payload);
      if (payload.requestId === 'old-upload') return new Promise((_resolve, reject) => { rejectOld = reject; });
    });
    await startEncoding('old-upload');
    workers[0].onmessage({ data: { encoded: new Uint8Array([255, 216, 255, 217]).buffer } });
    await vi.advanceTimersByTimeAsync(0);
    requestHeadsetViewCapture({ id: 'replacement-upload' });
    xrSnapshotFrame({ frame: { getViewerPose: () => null }, space, session, gl: fakeGl() });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    rejectOld(Error('old network call failed'));
    await vi.advanceTimersByTimeAsync(250);
    expect(sent.map(payload => payload.requestId)).toEqual(['old-upload', 'replacement-upload']);
    requestHeadsetViewCapture({ id: 'old-upload' });
    await vi.advanceTimersByTimeAsync(250);
    expect(sent).toHaveLength(2);
  });

  it('expires pending encoding at the original host deadline even when reoffered later', async () => {
    requestHeadsetViewCapture({ id: 'short-deadline', expiresAt: Date.now() + 100 });
    await startEncoding('short-deadline');
    await vi.advanceTimersByTimeAsync(90);
    requestHeadsetViewCapture({ id: 'short-deadline', expiresAt: Date.now() + 15_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(headsetViewState().pending).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('retires an older encoder without consuming or failing the replacement request', async () => {
    await startEncoding('old');
    const lateMessage = workers[0].onmessage;
    requestHeadsetViewCapture({ id: 'new' });
    await Promise.resolve();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    lateMessage({ data: { encoded: new Uint8Array([255, 216, 255, 217]).buffer } });
    await Promise.resolve();
    expect(headsetViewState().pending).toMatchObject({ id: 'new', phase: 'armed' });
    expect(sent).toEqual([]);
  });

  it('encodes only once after worker failure and ignores retired worker callbacks', async () => {
    const callbacks: ((blob: any) => void)[] = [];
    vi.stubGlobal('ImageData', class {});
    vi.stubGlobal('document', { createElement: () => ({
      getContext: () => ({ putImageData() {} }),
      toBlob: (callback: (blob: any) => void) => { callbacks.push(callback); },
    }) });
    await startEncoding('fallback');
    const worker = workers[0], retiredError = worker.onerror, retiredMessage = worker.onmessage;
    retiredError(); retiredError();
    expect(callbacks).toHaveLength(1);
    retiredMessage({ data: { encoded: new Uint8Array([1, 2, 3]).buffer } });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    const bytes = new Uint8Array([255, 216, 255, 217]).buffer;
    callbacks[0]({ arrayBuffer: async () => bytes });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requestId: 'fallback', status: 'captured', data: '/9j/2Q==' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
  });
});

describe('a frame of one flat colour', () => {
  const eye = (width: number, height: number, rgba: [number, number, number, number]) => {
    const pixels = new Uint8Array(width * height * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(rgba, offset);
    return pixels;
  };

  it('names the colour of an all-black or all-background eye', () => {
    expect(flatColor(eye(640, 704, [0, 0, 0, 0]))).toBe('#000000');
    expect(flatColor(eye(64, 70, [25, 39, 52, 255]))).toBe('#192734');
    // A passthrough pixel is shown over black, whatever colour it carries.
    expect(flatColor(eye(64, 70, [200, 10, 10, 0]))).toBe('#000000');
  });

  it('finds the structure in an eye that has any of it', () => {
    const pixels = eye(64, 70, [0, 0, 0, 0]);
    // One lit pixel on a sampled position, the way a far-away structure looks.
    pixels.set([230, 160, 60, 255], 7 * 4 * 300);
    expect(flatColor(pixels)).toBeUndefined();
  });
});

/**
 * On a Quest 2 a captured frame was lost to a single "upload rejected:
 * request_failed". Nothing retried, and nothing told the agent: it sat out its
 * deadline and reported no image at all.
 */
describe('the upload that carries the frame back to the Mac', () => {
  const message = { requestId: 'req-up', status: 'captured', width: 640, height: 704,
    path: 'resolve-blit-pack-fence', data: 'AAAA' };

  it('sends once when the Mac accepts it', async () => {
    const sent: any[] = [];
    const ok = await uploadHeadsetView((args: any) => { sent.push(args); return Promise.resolve({}); }, message, { retryMs: 0 });
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requestId: 'req-up', status: 'captured' });
  });

  it('posts the same bytes a second time when the first attempt is refused', async () => {
    const sent: any[] = [];
    const ok = await uploadHeadsetView((args: any) => {
      sent.push(args);
      return sent.length === 1 ? Promise.reject(Error('request_failed')) : Promise.resolve({});
    }, message, { retryMs: 0 });
    expect(ok).toBe(true);
    expect(sent).toHaveLength(2);
    // A retry re-sends what was already captured. It never asks for a frame.
    expect(sent[1]).toEqual(sent[0]);
  });

  it('hands the failure reason back as a receipt rather than letting the agent time out', async () => {
    const sent: any[] = [];
    const ok = await uploadHeadsetView((args: any) => { sent.push(args); return Promise.reject(Error('request_failed')); },
      message, { retryMs: 0 });
    expect(ok).toBe(false);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toMatchObject({ requestId: 'req-up', status: 'failed' });
    expect(sent[2].reason).toBe('upload rejected twice: request_failed');
    // The notice carries no image, so a refusal the pixels provoked cannot
    // also swallow the explanation.
    expect(sent[2].data).toBeUndefined();
  });

  it('survives a sender that throws outright, and one that fails twice over', async () => {
    const thrower = () => { throw Error('no route'); };
    await expect(uploadHeadsetView(thrower, message, { retryMs: 0 })).resolves.toBe(false);
  });
});
