import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, it, expect, vi } from 'vitest';

afterEach(() => vi.useRealTimers());
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { captureHeadsetViewSchema, createHeadsetViewStore, defaultHeadsetViewPath } from '../src/headset-view.js';
import type { DeviceCaptureHooks } from '../src/headset-view-device.js';
import * as headsetReadiness from '../src/headset-readiness.js';
import { ALLOWED_TOOLS as LAN_TOOLS } from '../src/inspection-lan.js';
import { TOOLS as COMPANION_TOOLS } from '../src/inspection-companion-http.js';
import { VIEWER_BUILD_PLACEHOLDER } from '../src/viewer-build.js';

// An explicit environment bypasses Vitest's scene-service environment override.
// Keep unknown-session capture requests away from a developer's live scene owner.
const sceneServiceFile = () => join(tmpdir(), `stereofold-headset-view-${randomUUID()}.json`);

/**
 * A device capture that never leaves this process.
 *
 * Without it, a `capture_headset_view` that falls through to the device would
 * read the display buffer of whatever headset is plugged into the machine
 * running the suite. `env` names no adb, so the lookup fails before anything
 * is spawned, and `run` throws if that guard ever regresses.
 */
const noDevice = (): DeviceCaptureHooks => ({
  run: async () => { throw Error('A test must never spawn a device capture.'); },
  exists: async () => false,
  env: { PATH: '' },
});

/** An 8x6 PNG header, which is all the device path reads to report a shape. */
const PNG = (() => {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(0x89504e47, 0); bytes.writeUInt32BE(8, 16); bytes.writeUInt32BE(6, 20);
  return bytes;
})();

/** One 8x6 `screencap` frame: header words, then lit RGBA pixels. */
const FRAME = (() => {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(8, 0); header.writeUInt32LE(6, 4); header.writeUInt32LE(1, 8);
  return Buffer.concat([header, Buffer.alloc(8 * 6 * 4, 180)]);
})();

/** A fake `adb` and `ffmpeg`: the gzipped frame off the device, the PNG out of ffmpeg. */
const deviceStub = (calls: string[][] = []): DeviceCaptureHooks => ({
  run: async (file, args) => {
    calls.push([file, ...args]);
    if (file.endsWith('ffmpeg')) return { stdout: PNG, stderr: '' };
    if (args[0] === 'devices') return { stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
    return { stdout: gzipSync(FRAME), stderr: '' };
  },
  exists: async (path: string) => path === '/opt/tools/adb' || path === '/opt/tools/ffmpeg',
  env: { PATH: '/opt/tools' },
});

/** The smallest thing that is unmistakably a JPEG: SOI, a comment, EOI. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x04, 0x41, 0x42, 0xff, 0xd9]);
const answer = (requestId: string) => ({
  requestId, status: 'captured' as const, eye: 'left' as const, width: 480, height: 533,
  mime: 'image/jpeg' as const, path: 'blit-pack-fence', frameMs: 0.42, capturedAt: 1_700_000_000_000,
  framebufferWidth: 2016, framebufferHeight: 1120, directReadable: true, flatChecked: true, data: JPEG.toString('base64'),
});

describe('the store that holds one headset view', () => {
  it('pins an explicit session/source before the first claim and snapshots that identity', async () => {
    const store = createHeadsetViewStore();
    const view = { sessionId: 'wanted', sourceToken: 'source-a', serverEpoch: 'epoch-a' };
    const expected = { ...view };
    const request = store.request({ view });
    view.sourceToken = 'mutated-by-caller';
    expect(() => store.submit(expected.sessionId, 'panel-a', { ...expected, ...answer(request.id) }))
      .toThrow(/has not been claimed/);
    expect(store.claim('other-panel')).toBeUndefined();
    for (const key of ['sessionId', 'sourceToken', 'serverEpoch'] as const) {
      expect(store.claim('other-panel', { ...expected, [key]: 'other' })).toBeUndefined();
    }
    expect(store.claim('panel-a', expected)?.id).toBe(request.id);
    expect(store.claim('panel-b', expected)).toBeUndefined();
    expect(() => store.submit('other-session', 'panel-a', { ...expected, ...answer(request.id) })).toThrow(/changed view/);
    const result = store.submit(expected.sessionId, 'panel-a', { ...expected, ...answer(request.id) });
    expect(result.ok && result.frame).toMatchObject({ ...expected, panelId: 'panel-a' });
    expect((await store.waitFor(request.id, 1000))?.ok).toBe(true);
  });

  it('reoffers an unanswered request to the first companion panel and nobody else', () => {
    const store = createHeadsetViewStore();
    const request = store.request({ maxWidth: 320 });
    expect(store.claim('panel-a')).toMatchObject({ id: request.id, maxWidth: 320 });
    expect(store.claim('panel-b')).toBeUndefined();
    expect(store.claim('panel-a')).toMatchObject({ id: request.id, maxWidth: 320 });
  });

  it('recovers a dropped poll without retargeting a changed panel, source, session or epoch', async () => {
    let clock = 1;
    const store = createHeadsetViewStore({ now: () => clock, ttlMs: 100 });
    const view = { sessionId: 'session', sourceToken: 'source', serverEpoch: 'epoch' };
    const request = store.request();
    const dropped = store.claim('panel-a', view);
    expect(store.claim('panel-b', view)).toBeUndefined();
    for (const key of ['sessionId', 'sourceToken', 'serverEpoch'] as const) {
      const changed = { ...view, [key]: 'changed' };
      expect(store.claim('panel-a', changed)).toBeUndefined();
      expect(() => store.submit(changed.sessionId, 'panel-a', { ...answer(request.id), ...changed })).toThrow(/changed view/);
    }
    expect(store.claim('panel-a', view)).toEqual(dropped);
    const waiting = store.waitFor(request.id, 1000);
    const failed = store.submit(view.sessionId, 'panel-a', { ...view, requestId: request.id, status: 'failed', reason: 'No immersive frame.' });
    expect(await waiting).toEqual({ ok: false, reason: 'No immersive frame.' });
    expect(store.claim('panel-a', view)).toBeUndefined();
    expect(store.submit(view.sessionId, 'panel-a', { ...view, ...answer(request.id) })).toBe(failed);
    const next = store.request();
    store.claim('panel-a', view);
    clock += 101;
    expect(store.claim('panel-a', view)).toBeUndefined();
    expect(() => store.submit(view.sessionId, 'panel-a', { ...view, ...answer(next.id) })).toThrow(/no longer current/);
  });

  it('replaces an unanswered request rather than queueing a stale one', () => {
    const store = createHeadsetViewStore();
    const first = store.request();
    const second = store.request();
    expect(store.pending()).toBe(1);
    expect(store.claim('panel-a')?.id).toBe(second.id);
    expect(() => store.submit('session', 'panel-a', { requestId: first.id, status: 'captured', data: JPEG.toString('base64') }))
      .toThrow(/no longer current/);
  });

  it('wakes the waiting agent as soon as the page answers', async () => {
    const store = createHeadsetViewStore();
    const request = store.request();
    store.claim('panel-a');
    const waiting = store.waitFor(request.id, 1_000);
    store.submit('session-1', 'panel-a', answer(request.id));
    const outcome = await waiting;
    expect(outcome?.ok).toBe(true);
    expect(outcome && outcome.ok && outcome.frame).toMatchObject({ eye: 'left', width: 480, height: 533, bytes: JPEG.byteLength, directReadable: true });
    expect(store.latest('session-1')?.data.equals(JPEG)).toBe(true);
    store.forget('session-1');
    expect(store.latest('session-1')).toBeUndefined();
  });

  it('carries a page-side failure back instead of leaving the agent to time out', async () => {
    const store = createHeadsetViewStore();
    const request = store.request();
    store.claim('panel-a');
    const waiting = store.waitFor(request.id, 1_000);
    store.submit('session-1', 'panel-a', { requestId: request.id, status: 'failed', reason: 'No current eye viewport.' });
    expect(await waiting).toEqual({ ok: false, reason: 'No current eye viewport.' });
  });

  it('reports nothing when no page answers within the wait', async () => {
    const store = createHeadsetViewStore();
    const request = store.request();
    expect(await store.waitFor(request.id, 5)).toBeUndefined();
  });

  it('retires a timed-out request before a late page can claim or submit it', async () => {
    vi.useFakeTimers();
    const store = createHeadsetViewStore();
    const view = { sessionId: 'session', sourceToken: 'source', serverEpoch: 'epoch' };
    const request = store.request({ view });
    const waiting = store.waitFor(request.id, 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await waiting).toBeUndefined();
    expect(store.pending()).toBe(0);
    expect(store.claim('panel-a', view)).toBeUndefined();
    expect(() => store.submit(view.sessionId, 'panel-a', { ...view, ...answer(request.id) })).toThrow(/no longer current/);
    expect(await store.waitFor(request.id, 1000)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles a superseded caller promptly without letting its old deadline remove the new request', async () => {
    vi.useFakeTimers();
    const store = createHeadsetViewStore();
    const view = { sessionId: 'first-session', sourceToken: 'source', serverEpoch: 'epoch' };
    const first = store.request({ view });
    store.claim('first-panel', view);
    const firstWaiting = store.waitFor(first.id, 500);
    const secondView = { ...view, sessionId: 'second-session' };
    const second = store.request({ view: secondView });
    const secondWaiting = store.waitFor(second.id, 1000);
    expect(await firstWaiting).toMatchObject({ ok: false, reason: expect.stringMatching(/superseded/) });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.claim('second-panel', secondView)?.id).toBe(second.id);
    expect(() => store.submit(view.sessionId, 'first-panel', { ...view, ...answer(first.id) })).toThrow(/no longer current/);
    store.submit(secondView.sessionId, 'second-panel', { ...secondView, ...answer(second.id) });
    expect(await secondWaiting).toMatchObject({ ok: true, frame: { sessionId: secondView.sessionId } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases all waiters when their capture expires and permits the next request', async () => {
    vi.useFakeTimers();
    const store = createHeadsetViewStore();
    for (let i = 0; i < 20; i++) {
      const request = store.request();
      const first = store.waitFor(request.id, 5);
      const second = store.waitFor(request.id, 10_000);
      await vi.advanceTimersByTimeAsync(5);
      expect(await first).toBeUndefined();
      expect(await second).toBeUndefined();
      expect(store.pending()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
    const next = store.request();
    expect(store.claim('next-panel')?.id).toBe(next.id);
  });

  it('refuses an upload that is not a JPEG, and one that is empty', () => {
    const store = createHeadsetViewStore();
    const request = store.request();
    store.claim('panel-a');
    expect(() => store.submit('s', 'panel-a', { ...answer(request.id), data: Buffer.from('not an image').toString('base64') }))
      .toThrow(/not a JPEG/);
    expect(() => store.submit('s', 'panel-a', { requestId: request.id, status: 'captured' })).toThrow(/no image/);
  });

  it('refuses an answer from a panel that did not claim the request', () => {
    const store = createHeadsetViewStore();
    const request = store.request();
    store.claim('panel-a');
    expect(() => store.submit('s', 'panel-b', answer(request.id))).toThrow(/another panel/);
  });

  it('bounds what the agent may ask for', () => {
    expect(captureHeadsetViewSchema.safeParse({}).success).toBe(true);
    expect(captureHeadsetViewSchema.safeParse({ maxWidth: 480, quality: 0.6, waitMs: 4_000 }).success).toBe(true);
    expect(captureHeadsetViewSchema.safeParse({ maxWidth: 4_096 }).success).toBe(false);
    expect(captureHeadsetViewSchema.safeParse({ quality: 2 }).success).toBe(false);
    expect(captureHeadsetViewSchema.safeParse({ waitMs: 60_000 }).success).toBe(false);
    expect(captureHeadsetViewSchema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it('names a default file under the system temporary directory', () => {
    const path = defaultHeadsetViewPath('/tmp', Date.UTC(2026, 8, 10, 11, 8, 7), join);
    expect(path).toBe('/tmp/stereofold-snapshots/2026-09-10T11-08-07-000.jpg');
  });
});

describe('capture_headset_view end to end', () => {
  it('arms on the heartbeat, takes the page answer, and writes the file', async () => {
    const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
    const [a, b] = InMemoryTransport.createLinkedPair();
    let deviceLookups = 0;
    // Heartbeats independently refresh debugging readiness. Stub only that
    // background check, so these counters still catch capture/device-health fallbacks.
    const readiness = vi.spyOn(headsetReadiness, 'readHeadsetDebugging')
      .mockResolvedValue({ checked: false });
    const device = noDevice();
    device.exists = async () => { deviceLookups++; return false; };
    const server = createStereoStructureServer(undefined, { sceneServiceFile: sceneServiceFile(), headsetDevice: device, environment: {} });
    const client = new Client({ name: 'Headset view contract test', version: '1' });
    await server.connect(b); await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
    const savePath = join(tmpdir(), `stereofold-eye-test-${process.pid}.jpg`);
    try {
      const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId;
      const data = (await call('get_inspection', { sessionId }))._meta[KEY];
      const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId,
        selectionKeys: [data.catalog.rows[0].key],
        camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
        inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 30 },
          placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
      const saved = (await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
        baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene })).structuredContent;
      const bound = { sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
        baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
      const companion = (await call('attach_inspection', { ...bound, surface: 'companion' })).structuredContent.panelId;
      const desktop = (await call('attach_inspection', bound)).structuredContent.panelId;

      // Nothing is armed, so an ordinary heartbeat carries no capture request.
      expect((await call('poll_inspection', { ...bound, panelId: companion, availability: 'ready' }))._meta[KEY].headsetViewRequest).toBeUndefined();

      // A mistyped/expired explicit session fails at admission. In particular,
      // auto must not turn it into an unscoped physical-device capture, and a
      // real companion must not receive an orphaned request after the error.
      for (const source of ['page', 'auto']) {
        const unknown = await call('capture_headset_view', {
          sessionId: 'missing-inspection-session', source, waitMs: 500, savePath,
        });
        expect(unknown.isError, source).toBe(true);
        expect(unknown.structuredContent?.captured).not.toBe(true);
        expect(deviceLookups, 'no device fallback or device health probe').toBe(0);
        expect((await call('poll_inspection', { ...bound, panelId: companion, availability: 'ready' }))
          ._meta[KEY].headsetViewRequest, source).toBeUndefined();
      }

      // Another current companion on the same MCP server must not steal an
      // explicitly scoped capture merely because its heartbeat arrives first.
      const otherSession = (await call('inspect', { structureText: cif })).structuredContent.sessionId;
      const otherData = (await call('get_inspection', { sessionId: otherSession }))._meta[KEY];
      const otherSaved = (await call('sync_inspection', { sessionId: otherSession, serverEpoch: otherData.serverEpoch,
        sourceToken: otherData.sourceToken, baseStateRevision: otherData.stateRevision,
        baseInspectionRevision: otherData.inspectionRevision, scene })).structuredContent;
      const otherBound = { sessionId: otherSession, serverEpoch: otherSaved.serverEpoch, sourceToken: otherSaved.sourceToken,
        baseStateRevision: otherSaved.stateRevision, baseInspectionRevision: otherSaved.inspectionRevision };
      const otherPanel = (await call('attach_inspection', { ...otherBound, surface: 'companion' })).structuredContent.panelId;
      // A newer observation explicitly cancels the older auto request; it
      // must not launch a physical-device fallback while the new page capture runs.
      const superseded = call('capture_headset_view', { sessionId, savePath, waitMs: 3_000, source: 'auto' });
      await new Promise(resolve => setTimeout(resolve, 0));
      const replacement = call('capture_headset_view', { sessionId, savePath, waitMs: 3_000, source: 'page' });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect((await superseded).structuredContent).toMatchObject({ captured: false, reason: 'capture_superseded' });
      expect(deviceLookups).toBe(0);
      const replacementRequest = (await call('poll_inspection', { ...bound, panelId: companion, availability: 'ready' }))._meta[KEY].headsetViewRequest;
      expect(replacementRequest).toBeTruthy();
      expect((await call('submit_headset_view', { ...bound, panelId: companion, ...answer(replacementRequest.id) })).structuredContent.accepted).toBe(true);
      expect((await replacement).structuredContent).toMatchObject({ captured: true, sessionId, source: 'page' });
      expect(deviceLookups).toBe(0);

      const capture = call('capture_headset_view', { sessionId, savePath, waitMs: 3_000, maxWidth: 480, source: 'page' });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect((await call('poll_inspection', { ...otherBound, panelId: otherPanel, availability: 'ready' }))
        ._meta[KEY].headsetViewRequest).toBeUndefined();
      // A desktop panel never draws an immersive frame, so it is never offered one.
      const desktopBeat = await call('poll_inspection', { ...bound, panelId: desktop, availability: 'ready' });
      expect(desktopBeat._meta[KEY].headsetViewRequest).toBeUndefined();
      const beat = await call('poll_inspection', { ...bound, panelId: companion, availability: 'ready' });
      const request = beat._meta[KEY].headsetViewRequest;
      expect(request).toMatchObject({ maxWidth: 480 });
      expect(typeof request.id).toBe('string');

      // Treat the first response as lost. A busy heartbeat retries the same
      // pinned request rather than consuming it or assigning a new capture.
      const retry = await call('poll_inspection', { ...bound, panelId: companion, availability: 'busy' });
      expect(retry._meta[KEY].headsetViewRequest).toEqual(request);

      const submitted = await call('submit_headset_view', { ...bound, panelId: companion, ...answer(request.id) });
      expect(submitted.isError).not.toBe(true);
      expect(submitted.structuredContent).toMatchObject({ accepted: true, bytes: JPEG.byteLength });
      expect((await call('poll_inspection', { ...bound, panelId: companion, availability: 'ready' }))._meta[KEY].headsetViewRequest).toBeUndefined();

      const result = await capture;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ captured: true, sessionBound: true, sessionId, panelId: companion,
        sourceToken: bound.sourceToken, serverEpoch: bound.serverEpoch, path: savePath, eye: 'left', width: 480, height: 533,
        bytes: JPEG.byteLength, mimeType: 'image/jpeg', readPath: 'blit-pack-fence', directReadable: true });
      expect(result.content.find((part: any) => part.type === 'image')).toMatchObject({ mimeType: 'image/jpeg' });
      expect((await stat(savePath)).size).toBe(JPEG.byteLength);
      expect(await readFile(savePath)).toEqual(JPEG);

      // A desktop panel cannot answer a capture even with a valid request id.
      const armed = call('capture_headset_view', { savePath, waitMs: 500, source: 'page' });
      const second = (await call('poll_inspection', { ...bound, panelId: companion, availability: 'ready' }))._meta[KEY].headsetViewRequest;
      const refused = await call('submit_headset_view', { ...bound, panelId: desktop, ...answer(second.id) });
      expect(refused.isError).toBe(true);
      expect((await armed).structuredContent.captured).toBe(false);
    } finally { readiness.mockRestore(); await client.close(); await server.close(); await rm(savePath, { force: true }); }
  });

  // A Quest 2 still was taken and lost: the page recorded
  // "upload rejected: request_failed" for a 640x704 left eye. The height bound
  // reused HEADSET_VIEW_MAX_WIDTH, so zod refused any capture taller than 640
  // and the companion route turned that into a bare `request_failed`. A Quest 2
  // eye is taller than it is wide, so every maxWidth above about 582 failed and
  // only the 480 default ever worked.
  it('accepts an eye that is taller than it is wide, as a Quest 2 always is', async () => {
    const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(undefined, { sceneServiceFile: sceneServiceFile(), headsetDevice: noDevice(), environment: {} });
    const client = new Client({ name: 'Headset view aspect test', version: '1' });
    await server.connect(b); await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
    const savePath = join(tmpdir(), `stereofold-eye-aspect-${process.pid}.jpg`);
    try {
      const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId;
      const data = (await call('get_inspection', { sessionId }))._meta[KEY];
      const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId,
        selectionKeys: [data.catalog.rows[0].key],
        camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
        inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 30 },
          placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
      const saved = (await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
        baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene })).structuredContent;
      const bound = { sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
        baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
      const companion = (await call('attach_inspection', { ...bound, surface: 'companion' })).structuredContent.panelId;

      const capture = call('capture_headset_view', { savePath, waitMs: 3_000, maxWidth: 640, source: 'page' });
      const request = (await call('poll_inspection', { ...bound, panelId: companion, availability: 'ready' }))._meta[KEY].headsetViewRequest;
      // The exact shape the headset reported at 23:10:09Z: 640 wide, 704 tall,
      // off a 1728x950 layer at framebuffer scale 0.6.
      const submitted = await call('submit_headset_view', { ...bound, panelId: companion, ...answer(request.id),
        width: 640, height: 704, framebufferWidth: 1728, framebufferHeight: 950, path: 'resolve-blit-pack-fence' });
      expect(submitted.isError).not.toBe(true);
      expect(submitted.structuredContent).toMatchObject({ accepted: true, width: 640, height: 704 });

      const result = await capture;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ captured: true, width: 640, height: 704, readPath: 'resolve-blit-pack-fence' });
      expect(await readFile(savePath)).toEqual(JPEG);
    } finally { await client.close(); await server.close(); await rm(savePath, { force: true }); }
  });

  it('refuses a save path that is relative or not a JPEG', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(undefined, { sceneServiceFile: sceneServiceFile(), headsetDevice: noDevice(), environment: {} });
    const client = new Client({ name: 'Headset view path test', version: '1' });
    await server.connect(b); await client.connect(a);
    try {
      for (const savePath of ['relative.jpg', '/tmp/not-an-image.gif', '/tmp/no-extension']) {
        const result = await client.callTool({ name: 'stereo_structure.capture_headset_view',
          arguments: { savePath, source: 'page', waitMs: 500 } }) as any;
        expect(result.isError).toBe(true);
      }
      // A PNG name is accepted, because the device source writes one.
      const png = await client.callTool({ name: 'stereo_structure.capture_headset_view',
        arguments: { savePath: '/tmp/allowed.png', source: 'page', waitMs: 500 } }) as any;
      expect(png.isError).not.toBe(true);
      expect(png.structuredContent).toMatchObject({ captured: false, source: 'page', reason: 'no_answer' });
    } finally { await client.close(); await server.close(); }
  });

  it('falls back to the device still, and names which source produced it', async () => {
    const calls: string[][] = [];
    const device = deviceStub(calls);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(undefined, { sceneServiceFile: sceneServiceFile(), headsetDevice: device, environment: {} });
    const client = new Client({ name: 'Headset view device test', version: '1' });
    await server.connect(b); await client.connect(a);
    const savePath = join(tmpdir(), `stereofold-device-test-${process.pid}.png`);
    try {
      // No companion page is polling, so "auto" waits, gives up, and asks the
      // device. Both reasons reach the caller.
      const auto = await client.callTool({ name: 'stereo_structure.capture_headset_view',
        arguments: { savePath, waitMs: 500 } }) as any;
      expect(auto.isError).not.toBe(true);
      expect(auto.structuredContent).toMatchObject({ captured: true, source: 'device', sessionBound: false, mimeType: 'image/png', width: 8, height: 6 });
      expect(auto.structuredContent.pageDetail).toMatch(/no companion page answered/);
      expect(auto.content.find((part: any) => part.type === 'image')).toMatchObject({ mimeType: 'image/png' });
      expect(await readFile(savePath)).toEqual(PNG);
      expect(auto.structuredContent.deviceWire).toBe('gzip');
      expect(calls[1]).toEqual(['/opt/tools/adb', '-s', 'QUEST2', 'exec-out', 'screencap | gzip -1']);
      expect(calls[2]![0]).toBe('/opt/tools/ffmpeg');
      // Nothing on this path fires the system screenshot service.
      expect(JSON.stringify(calls)).not.toMatch(/metavr|metacam|keyevent/u);

      // source:"device" skips the page entirely: no wait, no page reason.
      calls.length = 0;
      const direct = await client.callTool({ name: 'stereo_structure.capture_headset_view',
        arguments: { savePath, source: 'device', sessionId: 'not-a-page-session' } }) as any;
      expect(direct.isError, JSON.stringify(direct.content.filter((part: any) => part.type === 'text'))).not.toBe(true);
      expect(direct.structuredContent).toMatchObject({ captured: true, source: 'device', sessionBound: false });
      expect(direct.structuredContent.sessionId).toBeUndefined();
      expect(direct.structuredContent.sourceToken).toBeUndefined();
      expect(direct.structuredContent.pageDetail).toBeUndefined();
      // adb devices, the frame, ffmpeg, then the browser health probe's own
      // device listing and its one filtered shell command.
      expect(calls).toHaveLength(5);
      expect(calls[4]!.join(' ')).toContain('dumpsys window windows');
      // The probe reads and never writes: nothing here starts, stops or taps
      // anything on the headset.
      expect(JSON.stringify(calls)).not.toMatch(/force-stop|am start|input /u);
      // A stub that answers the probe with binary says so rather than guessing.
      expect(direct.structuredContent.browser).toMatchObject({ browser: 'unknown' });
      const requestedJpeg = savePath.replace(/\.png$/u, '.jpg');
      const renamed = await client.callTool({ name: 'stereo_structure.capture_headset_view',
        arguments: { savePath: requestedJpeg, source: 'device' } }) as any;
      expect(renamed.structuredContent).toMatchObject({ captured: true, path: savePath, mimeType: 'image/png' });
      expect(renamed.content[0].text).toContain('The requested extension was changed');
      await expect(stat(requestedJpeg)).rejects.toThrow();
    } finally { await client.close(); await server.close(); await rm(savePath, { force: true }); }
  });

  it('says what both sources were missing when neither can answer', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(undefined, { sceneServiceFile: sceneServiceFile(), headsetDevice: noDevice(), environment: {} });
    const client = new Client({ name: 'Headset view unavailable test', version: '1' });
    await server.connect(b); await client.connect(a);
    try {
      const result = await client.callTool({ name: 'stereo_structure.capture_headset_view', arguments: { waitMs: 500 } }) as any;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ captured: false, source: 'device', reason: 'device_unavailable' });
      expect(result.structuredContent.detail).toMatch(/No adb was found/);
      expect(result.structuredContent.pageDetail).toMatch(/no companion page answered/);
    } finally { await client.close(); await server.close(); }
  });

  // On 2026-09-24, and twice on 2026-09-28, the page answered with a
  // black eye while `adb screencap` showed the structure in front of the
  // wearer, and the result said `captured: true`. On the live run the page's
  // own log for that capture read probeReadable true, probeLit false, centre
  // pixel [0,0,0,0]. The page now checks its raw pixels before encoding and
  // sends that same frame with `flatColor`.
  describe('a page frame that shows no structure', () => {
    /** One session with a companion panel; `upload` is what the page answers with. */
    async function captureWith(device: DeviceCaptureHooks, upload: Record<string, unknown>, args: Record<string, unknown>, viewerPath?:string) {
      const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
      const [a, b] = InMemoryTransport.createLinkedPair();
      const server = createStereoStructureServer(viewerPath, { sceneServiceFile: sceneServiceFile(), headsetDevice: device, environment: {} });
      const client = new Client({ name: 'Headset view unlit frame test', version: '1' });
      await server.connect(b); await client.connect(a);
      const call = async (name: string, input: Record<string, unknown>) => await client.callTool({ name: `stereo_structure.${name}`, arguments: input }) as any;
      try {
        const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId;
        const data = (await call('get_inspection', { sessionId }))._meta[KEY];
        const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId,
          selectionKeys: [data.catalog.rows[0].key],
          camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
          inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 30 },
            placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
        const saved = (await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
          baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene })).structuredContent;
        const bound = { sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
          baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
        const companion = (await call('attach_inspection', { ...bound, surface: 'companion' })).structuredContent.panelId;
        const pending = call('capture_headset_view', { waitMs: 3_000, ...args });
        const request = (await call('poll_inspection', { ...bound, panelId: companion, availability: 'ready' }))._meta[KEY].headsetViewRequest;
        const submitted = await call('submit_headset_view', { ...bound, panelId: companion, ...answer(request.id), ...upload });
        expect(submitted.structuredContent).toMatchObject({ accepted: true });
        return await pending;
      } finally { await client.close(); await server.close(); }
    }

    /** The live frame, as the new page sends it. */
    const LIVE = { width: 640, height: 704, directReadable: true, probeLit: false, flatChecked: true, flatColor: '#000000' };

    it('treats the live black frame (probeReadable true, probeLit false) as a failed page capture and takes the device view', async () => {
      const savePath = join(tmpdir(), `stereofold-unlit-test-${process.pid}.png`);
      try {
        const result = await captureWith(deviceStub(), LIVE, { savePath });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ captured: true, source: 'device', mimeType: 'image/png' });
        expect(result.structuredContent.pageDetail).toBe("the page's frame was one flat colour, #000000, and its centre pixel read empty");
        expect(result.content[0].text).toContain('The in-page capture was tried first and said: the page\'s frame was one flat colour, #000000');
        expect(await readFile(savePath)).toEqual(PNG);
      } finally { await rm(savePath, { force: true }); }
    });

    it('says captured false in plain words when the same frame comes back and this Mac has no adb', async () => {
      const result = await captureWith(noDevice(), LIVE, {});
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ captured: false, source: 'device', reason: 'device_unavailable' });
      expect(result.content[0].text).toMatch(/^Neither source produced a still\. The page said: the page's frame was one flat colour, #000000, and its centre pixel read empty\. The device said: No adb was found/u);
      expect(result.content.some((part: any) => part.type === 'image')).toBe(false);
    });

    it('names the colour and the probe, and saves nothing, when only the page was asked', async () => {
      const result = await captureWith(noDevice(), LIVE, { source: 'page' });
      expect(result.structuredContent).toMatchObject({ captured: false, source: 'page', reason: 'unlit_frame',
        flatColor: '#000000', probeLit: false });
      expect(result.content.some((part: any) => part.type === 'image')).toBe(false);
      expect(result.content[0].text).toContain('source "device"');
    });

    it('keeps a frame whose centre pixel alone read empty, and reports the probe', async () => {
      // A passthrough eye with the structure off to one side: the page found
      // detail, so it sends no flatColor, and the empty centre decides nothing.
      const result = await captureWith(noDevice(), { directReadable: true, probeLit: false }, { source: 'page' });
      expect(result.structuredContent).toMatchObject({ captured: true, source: 'page', probeLit: false });
      expect(result.content[0].text).toContain('Its centre pixel read empty');
    });

    it('refuses an older page upload with no evidence that the flat check ran', async () => {
      const page = await captureWith(noDevice(), { flatChecked: false }, { source: 'page' });
      expect(page.structuredContent).toMatchObject({ captured: false, source: 'page', reason: 'frame_unverified' });
      expect(page.content[0].text).toContain('did not report that it checked');
      const auto = await captureWith(deviceStub(), { flatChecked: false }, { source: 'auto' });
      expect(auto.structuredContent).toMatchObject({ captured: true, source: 'device', mimeType: 'image/png' });
    });

    it('names an outdated page when its frame lacks the flat check', async () => {
      const directory=await mkdtemp(join(tmpdir(),'stereofold-stale-capture-'));
      try {
        const html=`<!doctype html><script>const build='${VIEWER_BUILD_PLACEHOLDER}';</script>`;
        await writeFile(join(directory,'inspector.html'),html.replace(VIEWER_BUILD_PLACEHOLDER,
          createHash('sha256').update(html).digest('hex')));
        const result=await captureWith(noDevice(),{flatChecked:false},{source:'page'},join(directory,'viewer.html'));
        expect(result.structuredContent).toMatchObject({captured:false,reason:'frame_unverified'});
        expect(result.structuredContent.detail).toContain('headset page runs an older Stereofold build');
        expect(result.content[0].text).toContain('reload the Stereofold page');
      } finally { await rm(directory,{recursive:true,force:true}); }
    });

    it('changes a PNG request to a JPEG name for page bytes', async () => {
      const requested = join(tmpdir(), `stereofold-page-extension-${process.pid}.png`);
      const actual = requested.replace(/\.png$/u, '.jpg');
      try {
        const result = await captureWith(noDevice(), {}, { source: 'page', savePath: requested });
        expect(result.structuredContent).toMatchObject({ captured: true, path: actual, mimeType: 'image/jpeg' });
        expect(result.content[0].text).toContain('The requested extension was changed');
        expect(await readFile(actual)).toEqual(JPEG);
        await expect(stat(requested)).rejects.toThrow();
      } finally { await rm(actual, { force: true }); }
    });
  });

  it('publishes the still into the Claude Science bridge when one is configured', async () => {
    const bridge = await mkdtemp(join(tmpdir(), 'stereofold-bridge-test-'));
    const device = deviceStub();
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer(undefined, { sceneServiceFile: sceneServiceFile(), headsetDevice: device, environment: { STEREOFOLD_BRIDGE_DIR: bridge } });
    const client = new Client({ name: 'Headset view bridge test', version: '1' });
    await server.connect(b); await client.connect(a);
    try {
      const result = await client.callTool({ name: 'stereo_structure.capture_headset_view', arguments: { source: 'device' } }) as any;
      expect(result.structuredContent.bridge).toMatchObject({ directory: bridge, file: 'headset-view.png', mediaType: 'image/png', source: 'device' });
      expect(await readFile(join(bridge, 'headset-view.png'))).toEqual(PNG);
      const record = JSON.parse(await readFile(join(bridge, 'headset-view.json'), 'utf8'));
      expect(record).toMatchObject({ file: 'headset-view.png', mediaType: 'image/png', source: 'device',
        width: 8, height: 6, bytes: PNG.byteLength, views: [{ eye: 'none', x: 0, y: 0, width: 8, height: 6 }] });
      expect(record.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
      // Nothing that identifies a capability may reach a directory the
      // assistant reads.
      expect(JSON.stringify(record)).not.toMatch(/token|bearer/i);
    } finally { await client.close(); await server.close(); await rm(bridge, { recursive: true, force: true }); }
  });

  it('lets the headset answer a capture but never ask for one', async () => {
    // The upload is a page route, so it is on both network allowlists. The
    // tool that asks for a view is model-side only, exactly like
    // `read_headset_log`: a paired browser must not be able to make this Mac
    // hold an image of a session it does not own.
    expect(LAN_TOOLS.has('submit_headset_view')).toBe(true);
    expect(COMPANION_TOOLS.has('submit_headset_view')).toBe(true);
    expect(LAN_TOOLS.has('capture_headset_view')).toBe(false);
    expect(COMPANION_TOOLS.has('capture_headset_view')).toBe(false);
    expect([...LAN_TOOLS].sort()).toEqual([...COMPANION_TOOLS].sort());
    const host = await readFile(new URL('../scripts/serve-inspection.ts', import.meta.url), 'utf8');
    const permitted = host.match(/const permitted=new Set\(\[(.+?)\]\);/s)?.[1] ?? '';
    expect(permitted).toContain("'capture_headset_view'");
    expect(permitted).not.toContain("'submit_headset_view'");
  });
});
