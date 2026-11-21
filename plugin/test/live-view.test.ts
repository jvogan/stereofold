import { utimesSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import type { DeviceCaptureHooks } from '../src/headset-view-device.js';
import {
  canonicalBase64, createLiveViewState, jpegSize, LIVE_VIEW_INTERVAL_MS, LIVE_VIEW_MAX_WIDTH, LIVE_VIEW_MIN_SPACING_MS, LIVE_VIEW_OWNER_FILE,
  LIVE_VIEW_CLOSE_DRAIN_MS, LIVE_VIEW_PANEL_HOLD_MS, liveViewFrameShape, liveViewPath, liveViewText, readLiveViewOwner, replaceLiveViewFile, sweepLiveViewFolder,
  writeLiveViewOwner, type LiveViewCheck,
} from '../src/live-view.js';
import { createLiveViewCapture, liveViewSize } from '../src/live-view-capture.js';
import { INSPECTOR_PANEL_TOOLS } from '../src/inspector-panel-host.js';
import { ALLOWED_TOOLS as LAN_TOOLS } from '../src/inspection-lan.js';
import { TOOLS as COMPANION_TOOLS } from '../src/inspection-companion-http.js';

/** Two real 32x18 baseline JPEGs. */
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAASACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAZEAACAwEAAAAAAAAAAAAAAAAAARIVYlH/xAAWAQEBAQAAAAAAAAAAAAAAAAAAAwT/xAAVEQEBAAAAAAAAAAAAAAAAAAAAEv/aAAwDAQACEQMRAD8AlKrIqslrVZFVk2SyUiqrIqslrVZFVkSUpIriEVxAFUyK4hFcQAH/2Q==', 'base64');
const OTHER_JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAASACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCYBMqoAAAAAB//2Q==', 'base64');
/** Text wrapped in JPEG start and end markers: no segments, so no frame size. */
const WRAPPED_TEXT = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('not a picture at all, just words'), Buffer.from([0xff, 0xd9])]);
/** Segments built by hand: one 8-bit quantization table, one Huffman table with one code, 32x18 frame headers, scan headers. */
const DQT = [0xff, 0xdb, 0x00, 0x43, 0x00, ...Array(64).fill(1)];
const DHT = [0xff, 0xc4, 0x00, 0x14, 0x00, 1, ...Array(15).fill(0), 0x00];
const SOF = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x12, 0x00, 0x20, 0x01, 0x01, 0x11, 0x00];
const SOF3 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x12, 0x00, 0x20, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00];
const SOS = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
const jpegOf = (...segments: number[][]) => Buffer.concat([Buffer.from([0xff, 0xd8, ...segments.flat()]), Buffer.from('scan'), Buffer.from([0xff, 0xd9])]);
/** A real 32x18 frame header followed by words: no scan, so not a picture. */
const HEADER_ONLY = Buffer.concat([Buffer.from([0xff, 0xd8, ...SOF]), Buffer.from('words where the scan should be'), Buffer.from([0xff, 0xd9])]);
/** The frame header, then a scan header too short to name any component, then words. */
const SHORT_SCAN = Buffer.concat([Buffer.from([0xff, 0xd8, ...SOF, 0xff, 0xda, 0x00, 0x02]), Buffer.from('words where the scan data should be'), Buffer.from([0xff, 0xd9])]);
const noDevice = (): DeviceCaptureHooks => ({
  run: async () => { throw Error('A test must never spawn a device capture.'); },
  exists: async () => false,
  env: { PATH: '' },
});
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', Q = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** A point a test opens by hand; `arrived` says something is waiting at it. */
function gate() {
  let open!: () => void, reached!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  const arrived = new Promise<void>(resolve => { reached = resolve; });
  return { arrived, open, wait: async () => { reached(); await opened; } };
}
const leftovers = async (root: string) => (await readdir(root)).filter(name => /\.tmp$|^live-view\.lock/u.test(name));

describe('live view file', () => {
  it('lives beside the scene record and accepts only JPEGs whose structure it can read', () => {
    expect(liveViewPath('/tmp/example/.stereofold/scene-service.json')).toBe('/tmp/example/.stereofold/live-view.jpg');
    expect(jpegSize(JPEG)).toEqual({ width: 32, height: 18 });
    expect(jpegSize(OTHER_JPEG)).toEqual({ width: 32, height: 18 });
    // The smallest picture built by hand passes, so each refusal below is the one thing changed.
    expect(jpegSize(jpegOf(DQT, DHT, SOF, SOS))).toEqual({ width: 32, height: 18 });
    for (const fake of [WRAPPED_TEXT, HEADER_ONLY, SHORT_SCAN,
      jpegOf(SOF, SOS), jpegOf(DQT, SOF, SOS),
      // An empty quantization segment beside a whole Huffman table, the other way round, and a table cut short.
      jpegOf([0xff, 0xdb, 0x00, 0x02], DHT, SOF, SOS),
      jpegOf(DQT, [0xff, 0xc4, 0x00, 0x02], SOF, SOS),
      jpegOf(DQT.slice(0, -1).map((byte, index) => index === 3 ? 0x42 : byte), DHT, SOF, SOS),
      jpegOf(DQT, [0xff, 0xc4, 0x00, 0x13, 0x00, 1, ...Array(15).fill(0)], SOF, SOS),
      // A scan naming fewer components than the frame has.
      jpegOf(DQT, DHT, SOF3, SOS),
    ]) expect(jpegSize(fake)).toBeUndefined();
    expect(jpegSize(JPEG.subarray(0, JPEG.length - 2))).toBeUndefined();
    expect(jpegSize(Buffer.from('\x89PNG\r\n\x1a\n00000000000000000000', 'binary'))).toBeUndefined();
    expect(jpegSize(Buffer.alloc(0))).toBeUndefined();
    // A frame header whose length does not fit its component count, and a scan naming a component the frame lacks.
    const offset = JPEG.indexOf(Buffer.from([0xff, 0xc0]));
    const longFrame = Buffer.from(JPEG); longFrame[offset + 3] += 3;
    expect(jpegSize(longFrame)).toBeUndefined();
    const scan = JPEG.indexOf(Buffer.from([0xff, 0xda]));
    const strangerScan = Buffer.from(JPEG); strangerScan[scan + 5] = 0x09;
    expect(jpegSize(strangerScan)).toBeUndefined();
  });

  it('takes only canonical base64', () => {
    const image = liveViewFrameShape.image;
    const spelled = JPEG.toString('base64');
    expect(image.safeParse(spelled).success).toBe(true);
    expect(spelled.endsWith('2Q==')).toBe(true);
    // The same bytes with nonzero padding bits are a second spelling, refused.
    const respelled = `${spelled.slice(0, -3)}R==`;
    expect(Buffer.from(respelled, 'base64')).toEqual(JPEG);
    expect(canonicalBase64(respelled)).toBeUndefined();
    expect(image.safeParse(respelled).success).toBe(false);
    expect(image.safeParse('QUJDRA').success).toBe(false);
    expect(image.safeParse('QUJDRA=====').success).toBe(false);
    expect(image.safeParse('QUJD RA==QUJDRA==').success).toBe(false);
  });

  it('replaces the picture in one rename, private, only when the step publishes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-'));
    try {
      const path = join(root, 'fresh', 'live-view.jpg');
      expect(await replaceLiveViewFile(path, JPEG, publish => { publish(); return 'landed'; })).toBe('landed');
      expect(await readFile(path)).toEqual(JPEG);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, 'fresh'))).mode & 0o777).toBe(0o700);
      expect(await replaceLiveViewFile(path, OTHER_JPEG, () => 'kept')).toBe('kept');
      expect(await readFile(path)).toEqual(JPEG);
      await expect(replaceLiveViewFile(path, OTHER_JPEG, () => { throw Error('refused'); })).rejects.toThrow('refused');
      expect(await readdir(join(root, 'fresh'))).toEqual(['live-view.jpg']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('names the latest start and reads a missing or older record as nobody', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-owner-'));
    try {
      const path = join(root, 'live-view.jpg');
      const first = { claim: 'first', serverEpoch: 'epoch-1', pid: 4242 }, second = { claim: 'second', serverEpoch: 'epoch-2', pid: 4243 };
      expect(readLiveViewOwner(path)).toBeUndefined();
      writeLiveViewOwner(path, first);
      writeLiveViewOwner(path, second);
      expect(readLiveViewOwner(path)).toEqual(second);
      // A record from an earlier version names no claim, so it names nobody.
      await writeFile(join(root, LIVE_VIEW_OWNER_FILE), JSON.stringify({ serverEpoch: 'old', pid: 1 }));
      expect(readLiveViewOwner(path)).toBeUndefined();
      expect(await leftovers(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('sweeps old temporary files and an earlier build\'s lock files, and leaves everything else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-sweep-'));
    try {
      const path = join(root, 'live-view.jpg'), hourAgo = (Date.now() - 3_600_000) / 1000;
      const old = ['.live-view.jpg.aaaaaaaaaaaa.tmp', 'live-view.owner.json.bbbbbbbbbbbb.tmp'];
      const kept = ['live-view.jpg', LIVE_VIEW_OWNER_FILE, '.live-view.jpg.cccccccccccc.tmp', 'scene-service.json', 'notes.tmp'];
      for (const name of [...old, ...kept, 'live-view.lock', 'live-view.lock.0123456789abcdef.break']) writeFileSync(join(root, name), 'x');
      for (const name of [...old, 'notes.tmp']) utimesSync(join(root, name), hourAgo, hourAgo);
      await sweepLiveViewFolder(path);
      expect((await readdir(root)).sort()).toEqual([...kept].sort());
      // A folder that is not there is no reason to fail.
      await sweepLiveViewFolder(join(root, 'missing', 'live-view.jpg'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reserves frames in order for one claim and one panel, remembers the last picture, and voids frames on stop, a new start or a later landing', () => {
    let clock = 1_000;
    const state = createLiveViewState({ now: () => clock });
    const frame = { width: 960, height: 540, bytes: 10, panelId: P };
    const written = { bytes: JPEG, source: 'source-1' };
    expect(state.request(A)).toBeUndefined();
    expect(state.admit(A, P)).toEqual({ reason: 'not-requested' });
    state.arm(A, 'claim-1');
    expect(state.request(A)).toEqual({ intervalMs: LIVE_VIEW_INTERVAL_MS, maxWidth: LIVE_VIEW_MAX_WIDTH });
    expect(state.request(B)).toBeUndefined();
    const first = state.admit(A, P) as { token: { claim: string; order: number } };
    expect(first.token).toEqual({ claim: 'claim-1', order: 1 });
    // A second frame at the same moment is turned away before any file work, and so is another panel while this one posts.
    expect(state.admit(A, P)).toEqual({ reason: 'too-soon' });
    clock += LIVE_VIEW_MIN_SPACING_MS;
    expect(state.admit(A, Q)).toEqual({ reason: 'other-panel' });
    const second = state.admit(A, P) as { token: { claim: string; order: number } };
    // The later frame lands first; the earlier one may not land over it.
    expect(state.commit(second.token, frame, written)).toBe(true);
    expect(state.written()).toBe(written);
    expect(state.refusal(first.token)).toBe('older');
    expect(state.commit(first.token, frame, { bytes: OTHER_JPEG, source: 'source-1' })).toBe(false);
    expect(state.written()).toBe(written);
    // A new start for the same session keeps its last picture.
    state.arm(A, 'claim-1b');
    expect(state.written()).toBe(written);
    // A stop voids what is reserved.
    clock += LIVE_VIEW_MIN_SPACING_MS;
    const third = state.admit(A, P) as { token: { claim: string; order: number } };
    expect(state.end(B)).toBeUndefined();
    expect(state.end(A)).toBe('claim-1b');
    expect(state.refusal(third.token)).toBe('stopped');
    expect(state.written()).toBeUndefined();
    // A start for another session supersedes this one, which says so until it starts again.
    state.arm(A, 'claim-2');
    const fourth = state.admit(A, P) as { token: { claim: string; order: number } };
    state.arm(B, 'claim-3');
    expect(state.current(fourth.token)).toBe(false);
    expect(state.status(A)).toEqual({ active: false, superseded: 'another-session' });
    expect(state.status(B)).toMatchObject({ active: true });
    expect(state.status(B).frame).toBeUndefined();
    expect(state.feeding()).toEqual({ sessionId: B, claim: 'claim-3' });
    clock += LIVE_VIEW_PANEL_HOLD_MS;
    expect(state.admit(B, Q)).toHaveProperty('token');
    // Another server's start, seen in the record, supersedes the feeding session too.
    state.supersede('claim-3', 'another-host');
    expect(state.status(B)).toEqual({ active: false, superseded: 'another-host' });
    expect(state.request(B)).toBeUndefined();
    state.arm(A, 'claim-4');
    expect(state.status(A)).toMatchObject({ active: true });
    expect(state.status(A).superseded).toBeUndefined();
  });

  it('tells the agent the path, the picture age, the one step a person takes, and who else holds the file', () => {
    const path = '/tmp/example/.stereofold/live-view.jpg';
    const waiting = liveViewText({ path, action: 'start', active: true, now: 0 });
    expect(waiting).toContain(path);
    expect(waiting).toContain('No picture has arrived yet');
    expect(waiting).toContain('Files, This computer');
    expect(waiting).toContain('reloads the picture by itself');
    const drawn = liveViewText({ path, action: 'status', active: true, now: 5_000,
      frame: { at: 1_000, width: 960, height: 540, bytes: 10, panelId: 'p' } });
    expect(drawn).toContain('960x540, written 4 s ago');
    expect(liveViewText({ path, action: 'stop', active: false, now: 0 })).toContain('no longer replaced');
    expect(liveViewText({ path, action: 'stop', active: false, now: 0, otherSession: true })).toContain('another session on this Mac still replaces it');
    expect(liveViewText({ path, action: 'status', active: false, now: 0 })).toContain('No live view is running');
    expect(liveViewText({ path, action: 'stop', active: false, now: 0, otherHost: true })).toContain('the latest live view start on this Mac came from another Stereofold host');
    expect(liveViewText({ path, action: 'status', active: false, now: 0, otherHost: true })).toContain('came from another Stereofold host');
    const later = liveViewText({ path, action: 'status', active: false, now: 0, superseded: 'another-host' });
    expect(later).toContain('This session has stopped feeding it: another Stereofold host on this Mac started its own live view after this one');
    expect(later).toContain('action "start" to feed it again');
    expect(liveViewText({ path, action: 'status', active: false, now: 0, superseded: 'owner-gone' })).toContain('gone or unreadable');
  });
});

/** Mol*'s didDraw is an RxJS BehaviorSubject: a new subscriber is called at once with the last value. */
function replayingSubject() {
  const listeners = new Set<() => void>();
  return {
    next() { for (const listener of [...listeners]) listener(); },
    subscribe(next: () => void) { listeners.add(next); next(); return { unsubscribe: () => { listeners.delete(next); } }; },
  };
}

describe('live view capture in the desktop panel', () => {
  function rig() {
    const didDraw = replayingSubject();
    let draws = 0, clock = 0, subscribers = 0;
    const timers: { run: () => void; at: number }[] = [];
    const canvas3d = {
      didDraw: { subscribe(next: () => void) {
        subscribers++;
        const subscription = didDraw.subscribe(next);
        return { unsubscribe: () => { subscribers--; subscription.unsubscribe(); } };
      } },
      requestDraw: () => { draws++; },
    };
    const drawn: { width: number; height: number }[] = [];
    const copy = { width: 0, height: 0, getContext: () => ({ drawImage: (_s: unknown, _x: number, _y: number, w: number, h: number) => drawn.push({ width: w, height: h }) }) };
    const submitted: { image: string; width: number; height: number; source: string }[] = [];
    let fail = false, paused = false, source = 'source-1';
    let pendingEncode: ((image: string) => void) | undefined;
    let deferEncode = false;
    const capture = createLiveViewCapture({
      canvas3d: () => canvas3d,
      canvas: () => ({ width: 1920, height: 1081 }),
      context: () => ({ source }),
      paused: () => paused,
      submit: async (picture, context) => { if (fail) throw Error('refused'); submitted.push({ ...picture, source: context.source }); },
      encode: () => deferEncode ? new Promise<string>(resolve => { pendingEncode = resolve; }) : Promise.resolve('AAAA'),
      createCanvas: () => copy,
      now: () => clock,
      setTimer: (run, ms) => { const timer = { run, at: clock + ms }; timers.push(timer); return timer; },
      clearTimer: timer => { const index = timers.indexOf(timer as never); if (index >= 0) timers.splice(index, 1); },
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const draw = async () => { didDraw.next(); await settle(); };
    const advance = (ms: number) => {
      clock += ms;
      for (const timer of timers.filter(entry => entry.at <= clock)) { timers.splice(timers.indexOf(timer), 1); timer.run(); }
    };
    return { capture, draw, advance, settle, submitted, drawn, timers,
      get subscribers() { return subscribers; }, get draws() { return draws; },
      setFail: (value: boolean) => { fail = value; }, setPaused: (value: boolean) => { paused = value; },
      setSource: (value: string) => { source = value; }, deferEncodes: () => { deferEncode = true; },
      finishEncode: (image: string) => pendingEncode?.(image) };
  }

  it('fits the canvas into the requested width with an even size', () => {
    expect(liveViewSize({ width: 1920, height: 1081 }, 960)).toEqual({ width: 960, height: 540 });
    expect(liveViewSize({ width: 640, height: 480 }, 960)).toEqual({ width: 640, height: 480 });
    expect(liveViewSize({ width: 0, height: 480 }, 960)).toBeUndefined();
  });

  it('ignores the replay a subscription gets and copies only inside a real draw', async () => {
    const r = rig();
    r.capture.update({ intervalMs: 1_000, maxWidth: 960 });
    await r.settle();
    expect(r.drawn).toHaveLength(0);
    expect(r.submitted).toHaveLength(0);
    expect(r.draws).toBe(1);
    await r.draw();
    expect(r.submitted).toEqual([{ image: 'AAAA', width: 960, height: 540, source: 'source-1' }]);
  });

  it('captures nothing until asked, then one picture per interval from the draws it is given', async () => {
    const r = rig();
    await r.draw();
    expect(r.subscribers).toBe(0);
    expect(r.submitted).toHaveLength(0);
    r.capture.update({ intervalMs: 1_000, maxWidth: 960 });
    expect(r.draws).toBe(1);
    await r.draw();
    expect(r.submitted).toHaveLength(1);
    expect(r.drawn).toEqual([{ width: 960, height: 540 }]);
    // A draw inside the interval is owed, not taken.
    r.advance(400); await r.draw();
    expect(r.submitted).toHaveLength(1);
    // Once the interval passes, the timer asks for the draw that settles it.
    r.advance(700);
    expect(r.draws).toBe(2);
    await r.draw();
    expect(r.submitted).toHaveLength(2);
    // A quiet scene is not redrawn for a picture it already has.
    r.advance(5_000);
    expect(r.draws).toBe(2);
  });

  it('copies nothing while the panel is paused, and catches up after', async () => {
    const r = rig();
    r.capture.update({ intervalMs: 1_000, maxWidth: 960 });
    r.setPaused(true);
    await r.draw();
    r.advance(1_500);
    expect(r.drawn).toHaveLength(0);
    expect(r.draws).toBe(1);
    r.setPaused(false);
    r.advance(1_000);
    expect(r.draws).toBe(2);
    await r.draw();
    expect(r.submitted).toHaveLength(1);
  });

  it('drops a picture whose capture was restarted while it was encoding, rather than send it under the new source', async () => {
    const r = rig();
    r.deferEncodes();
    r.capture.update({ intervalMs: 1_000, maxWidth: 960 });
    await r.draw();
    expect(r.drawn).toHaveLength(1);
    // The source changes: the poll withdraws the request, then asks again.
    r.capture.update(undefined);
    r.setSource('source-2');
    r.capture.update({ intervalMs: 1_000, maxWidth: 960 });
    r.finishEncode('OLD');
    await r.settle();
    expect(r.submitted).toHaveLength(0);
    // The restarted capture still delivers, under the new source.
    r.advance(1_000);
    r.finishEncode('NEW');
    await r.draw();
    r.finishEncode('NEW');
    await r.settle();
    expect(r.submitted.map(entry => entry.source)).toEqual(['source-2']);
  });

  it('keeps a refused picture owed and asks for another draw once the backoff passes', async () => {
    const r = rig();
    r.setFail(true);
    r.capture.update({ intervalMs: 1_000, maxWidth: 960 });
    await r.draw();
    expect(r.draws).toBe(1);
    r.setFail(false);
    // No draw happens on its own; the timer asks for one once interval plus backoff has passed.
    r.advance(1_000);
    expect(r.draws).toBe(1);
    r.advance(2_000);
    expect(r.draws).toBe(2);
    await r.draw();
    expect(r.submitted).toHaveLength(1);
  });

  it('stops and lets go of the renderer when the request is withdrawn', async () => {
    const r = rig();
    r.capture.update({ intervalMs: 1_000, maxWidth: 960 });
    expect(r.capture.active).toBe(true);
    r.capture.update(undefined);
    expect(r.capture.active).toBe(false);
    expect(r.subscribers).toBe(0);
    expect(r.timers).toHaveLength(0);
    await r.draw();
    expect(r.submitted).toHaveLength(0);
    r.capture.update({ intervalMs: Number.NaN, maxWidth: 960 });
    expect(r.capture.active).toBe(false);
  });

  it('backs off after the host refuses a picture', async () => {
    const r = rig();
    r.setFail(true);
    r.capture.update({ intervalMs: 1_000, maxWidth: 960 });
    await r.draw();
    r.setFail(false);
    r.advance(1_500); await r.draw();
    expect(r.submitted).toHaveLength(0);
    r.advance(1_000); await r.draw();
    expect(r.submitted).toHaveLength(1);
  });
});

describe('live view tools', () => {
  type Call = (name: string, args: Record<string, unknown>) => Promise<any>;
  /** `folder` holds the scene service record, and so the picture; `now` is the server's clock, given the test's clock. */
  type Options = { sessionTtlMs?: number; folder?: string; now?: (clock: { now: number }) => number };
  /**
   * One server on the folder, with a clock the test moves, a point where the
   * next frame waits once its bytes are written, and word of each check the
   * server makes of the file.
   */
  async function connected(root: string, clock = { now: 1_000_000 }, { sessionTtlMs, folder = root, now = c => c.now }: Options = {}) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    let pending: ReturnType<typeof gate> | undefined;
    const gates: ReturnType<typeof gate>[] = [];
    const checks: LiveViewCheck[] = [], waiting: ((outcome: LiveViewCheck) => void)[] = [];
    const server = createStereoStructureServer(undefined, { sceneServiceFile: join(folder, 'scene-service.json'), headsetDevice: noDevice(), environment: {},
      now: () => now(clock), ...(sessionTtlMs === undefined ? {} : { sessionTtlMs }),
      liveView: {
        written: async () => { const held = pending; pending = undefined; await held?.wait(); },
        checked: outcome => { const next = waiting.shift(); if (next) next(outcome); else checks.push(outcome); },
      } });
    const client = new Client({ name: 'Live view contract test', version: '1' });
    await server.connect(b); await client.connect(a);
    const call: Call = async (name, args) => await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
    return { server, client, call, clock,
      /** The next frame to finish writing its bytes waits at this gate. */
      holdNextFrame: () => { pending = gate(); gates.push(pending); return pending; },
      /** Lets every held frame go, so a test that failed while one was held still shuts its server down. */
      openGates: () => { for (const held of gates) held.open(); },
      /** The outcome of this server's next finished check of the file. */
      nextCheck: () => checks.length ? Promise.resolve(checks.shift()!) : new Promise<LiveViewCheck>(resolve => waiting.push(resolve)) };
  }
  async function bound(call: Call) {
    const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
    const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId;
    const data = (await call('get_inspection', { sessionId }))._meta[KEY];
    const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId,
      selectionKeys: [data.catalog.rows[0].key],
      camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
      inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 30 },
        placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
    const saved = (await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
      baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene })).structuredContent;
    return { cif, sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
      baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  }
  /** A server with one session whose desktop panel is attached. */
  async function host(root: string, clock?: { now: number }, options?: Options) {
    const connection = await connected(root, clock, options);
    const { cif, ...binding } = await bound(connection.call);
    const desktop = (await connection.call('attach_inspection', binding)).structuredContent.panelId as string;
    const send = (picture: Buffer, panelId = desktop) => connection.call('submit_live_view',
      { ...binding, panelId, image: picture.toString('base64'), width: 32, height: 18 });
    const asked = async (panelId = desktop) => (await connection.call('poll_inspection', { ...binding, panelId, availability: 'ready' }))._meta[KEY].liveViewRequest;
    const live = (action?: 'start' | 'stop' | 'status') => connection.call('show_live_view', { sessionId: binding.sessionId, ...(action ? { action } : {}) });
    return { ...connection, cif, binding, desktop, send, asked, live,
      close: async () => { connection.openGates(); await connection.client.close(); await connection.server.close(); } };
  }
  const accepted = { accepted: true, bytes: JPEG.byteLength };

  it('asks only desktop panels, writes only what an armed session sends, and says where it is', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-tools-'));
    const { server, client, call } = await connected(root);
    try {
      const { cif: _cif, ...binding } = await bound(call);
      const { sessionId } = binding;
      const companion = (await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId;
      const desktop = (await call('attach_inspection', binding)).structuredContent.panelId;
      const picture = { image: JPEG.toString('base64'), width: 32, height: 18 };
      const file = join(root, 'live-view.jpg');
      const beat = async (panelId: string) => (await call('poll_inspection', { ...binding, panelId, availability: 'ready' }))._meta[KEY];

      // Nothing is asked for, and nothing is written, until the agent asks.
      expect((await beat(desktop)).liveViewRequest).toBeUndefined();
      expect((await call('submit_live_view', { ...binding, panelId: desktop, ...picture })).structuredContent).toEqual({ accepted: false, reason: 'not-requested' });
      await expect(stat(file)).rejects.toThrow();

      const started = await call('show_live_view', { sessionId });
      expect(started.isError).toBeFalsy();
      expect(started.structuredContent.liveView).toEqual({ path: file, active: true });
      expect(started.content[0].text).toContain(file);
      expect(started.content[0].text).toContain('No picture has arrived yet');
      expect((await beat(desktop)).liveViewRequest).toEqual({ intervalMs: LIVE_VIEW_INTERVAL_MS, maxWidth: LIVE_VIEW_MAX_WIDTH });
      // A headset page is never asked, and cannot answer.
      expect((await beat(companion)).liveViewRequest).toBeUndefined();
      const fromHeadset = await call('submit_live_view', { ...binding, panelId: companion, ...picture });
      expect(fromHeadset.isError).toBe(true);
      expect(fromHeadset.content[0].text).toContain('Only a current desktop panel');
      // A changed source is refused, and so is anything that is not a JPEG of the declared size.
      expect((await call('submit_live_view', { ...binding, sourceToken: '00000000-0000-4000-8000-000000000000', panelId: desktop, ...picture })).isError).toBe(true);
      for (const wrong of [{ image: WRAPPED_TEXT.toString('base64') }, { image: SHORT_SCAN.toString('base64') }, { width: 960 }, { height: 540 }]) {
        const refused = await call('submit_live_view', { ...binding, panelId: desktop, ...picture, ...wrong });
        expect(refused.isError).toBe(true);
        expect(refused.content[0].text).toContain('JPEG of the declared size');
      }
      await expect(stat(file)).rejects.toThrow();

      expect((await call('submit_live_view', { ...binding, panelId: desktop, ...picture })).structuredContent).toEqual(accepted);
      expect(await readFile(file)).toEqual(JPEG);
      const owner = readLiveViewOwner(file);
      expect(owner).toMatchObject({ pid: process.pid, serverEpoch: binding.serverEpoch });
      // A second picture inside the spacing is turned away rather than written.
      expect((await call('submit_live_view', { ...binding, panelId: desktop, ...picture, image: OTHER_JPEG.toString('base64') })).structuredContent)
        .toEqual({ accepted: false, reason: 'too-soon' });
      expect(await readFile(file)).toEqual(JPEG);

      const status = await call('show_live_view', { sessionId, action: 'status' });
      expect(status.structuredContent.liveView).toMatchObject({ path: file, active: true, lastFrame: { width: 32, height: 18, bytes: JPEG.byteLength } });
      expect(status.content[0].text).toContain('32x18');

      const stopped = await call('show_live_view', { sessionId, action: 'stop' });
      expect(stopped.structuredContent.liveView).toEqual({ path: file, active: false });
      expect(stopped.content[0].text).toContain('no longer replaced');
      expect((await beat(desktop)).liveViewRequest).toBeUndefined();
      expect((await call('submit_live_view', { ...binding, panelId: desktop, ...picture })).structuredContent.accepted).toBe(false);
      // Stopping leaves the last picture where the person's pane is showing it. The record stays,
      // naming a claim no session holds, so it hands the file to nobody until the next start.
      expect(await readFile(file)).toEqual(JPEG);
      expect(readLiveViewOwner(file)).toEqual(owner);
      expect(await leftovers(root)).toEqual([]);
    } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('drops a picture written before another server started, and the file keeps the later start\'s picture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-two-hosts-'));
    const first = await host(root), second = await host(root);
    try {
      const file = join(root, 'live-view.jpg');
      await first.live();
      // The first server's picture is written, then waits before the step that lands it.
      const held = first.holdNextFrame();
      const late = first.send(JPEG);
      await held.arrived;
      // Meanwhile the second server starts and its picture lands.
      expect((await second.live()).structuredContent.liveView.active).toBe(true);
      expect((await second.send(OTHER_JPEG)).structuredContent).toEqual({ ...accepted, bytes: OTHER_JPEG.byteLength });
      held.open();
      expect((await late).structuredContent).toEqual({ accepted: false, reason: 'taken-over' });
      expect(await readFile(file)).toEqual(OTHER_JPEG);
      expect(readLiveViewOwner(file)?.serverEpoch).toBe(second.binding.serverEpoch);
      // The first server has stopped: its panel is no longer asked, and its status says why.
      expect(await first.asked()).toBeUndefined();
      const status = await first.live('status');
      expect(status.structuredContent.liveView).toEqual({ path: file, active: false, superseded: 'another-host' });
      expect(status.content[0].text).toContain('another Stereofold host on this Mac started its own live view after this one');
      // Stopping it leaves the later start's record alone.
      expect((await first.live('stop')).content[0].text).toContain('the latest live view start on this Mac came from another Stereofold host');
      expect(readLiveViewOwner(file)?.serverEpoch).toBe(second.binding.serverEpoch);
      expect(await leftovers(root)).toEqual([]);
    } finally { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('has the owner replace a late picture from a superseded server at its next check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-repair-'));
    const clock = { now: 1_000_000 };
    const first = await host(root, clock), second = await host(root, clock);
    try {
      const file = join(root, 'live-view.jpg');
      await first.live();
      expect((await first.send(JPEG)).structuredContent).toEqual(accepted);
      await second.live();
      expect((await second.send(OTHER_JPEG)).structuredContent.accepted).toBe(true);
      // The one race left: the first server read the record before the second started and renames
      // its picture after. Its late picture is the one it last landed, so here it is written by hand.
      writeFileSync(file, JPEG);
      // The owner's panel polls; its check finds the file is not its picture, and the record names it.
      expect(await second.asked()).toBeDefined();
      expect(await second.nextCheck()).toBe('repaired');
      expect(await readFile(file)).toEqual(OTHER_JPEG);
      // The next check, an interval later, finds the file settled.
      clock.now += LIVE_VIEW_INTERVAL_MS;
      expect(await second.asked()).toBeDefined();
      expect(await second.nextCheck()).toBe('same');
      expect(await leftovers(root)).toEqual([]);
    } finally { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('never has a superseded server repair the file, even when the file is not its picture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-no-fight-'));
    const clock = { now: 1_000_000 };
    const first = await host(root, clock), second = await host(root, clock);
    try {
      const file = join(root, 'live-view.jpg');
      await first.live();
      expect((await first.send(JPEG)).structuredContent).toEqual(accepted);
      await second.live();
      expect((await second.send(OTHER_JPEG)).structuredContent.accepted).toBe(true);
      // The first server has not heard of the second start yet; its panel still polls.
      expect(await first.asked()).toBeDefined();
      expect(await first.nextCheck()).toBe('superseded');
      expect(await readFile(file)).toEqual(OTHER_JPEG);
      expect(await first.asked()).toBeUndefined();
      expect((await first.live('status')).structuredContent.liveView).toMatchObject({ active: false, superseded: 'another-host' });
    } finally { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('reports a later start elsewhere in status at once, without waiting for a refused picture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-status-'));
    const first = await host(root), second = await host(root);
    try {
      expect((await first.live()).structuredContent.liveView.active).toBe(true);
      expect(await first.asked()).toBeDefined();
      await second.live();
      const status = await first.live('status');
      expect(status.structuredContent.liveView).toMatchObject({ active: false, superseded: 'another-host' });
      expect(status.content[0].text).not.toContain('replaced about once a second');
      expect(await first.asked()).toBeUndefined();
    } finally { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('never hands the file back to an older session when the latest start stops, its server closes, or the record is removed by hand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-older-'));
    const clock = { now: 1_000_000 };
    const first = await host(root, clock);
    try {
      const file = join(root, 'live-view.jpg');
      await first.live();
      expect((await first.send(JPEG)).structuredContent).toEqual(accepted);
      for (const leave of ['stop', 'close', 'removed'] as const) {
        const second = await host(root, clock);
        await second.live();
        // The later start leaves before the first server sends again.
        if (leave === 'stop') await second.live('stop');
        if (leave === 'close') await second.close();
        if (leave === 'removed') await rm(join(root, LIVE_VIEW_OWNER_FILE));
        clock.now += LIVE_VIEW_MIN_SPACING_MS;
        expect((await first.send(OTHER_JPEG)).structuredContent).toEqual({ accepted: false, reason: 'taken-over' });
        expect(await readFile(file)).toEqual(JPEG);
        const status = await first.live('status');
        expect(status.structuredContent.liveView).toMatchObject({ active: false, superseded: leave === 'removed' ? 'owner-gone' : 'another-host' });
        expect(status.content[0].text).toContain('Call show_live_view with action "start" to feed it again');
        expect(await first.asked()).toBeUndefined();
        if (leave === 'removed') {
          // The latest start cannot show it started last either, so it stops too rather than write.
          expect((await second.send(OTHER_JPEG)).structuredContent).toEqual({ accepted: false, reason: 'taken-over' });
          expect(readLiveViewOwner(file)).toBeUndefined();
        }
        // Only a new start feeds the file again.
        expect((await first.live()).structuredContent.liveView.active).toBe(true);
        clock.now += LIVE_VIEW_PANEL_HOLD_MS;
        expect((await first.send(JPEG)).structuredContent).toEqual(accepted);
        if (leave !== 'close') await second.close();
      }
    } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('drops a picture whose source changed after it was checked and before it would land', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-source-'));
    const first = await host(root);
    try {
      const file = join(root, 'live-view.jpg');
      await first.live();
      const held = first.holdNextFrame();
      const late = first.send(JPEG);
      await held.arrived;
      // The session's source is replaced while the picture waits.
      expect((await first.call('open', { sessionId: first.binding.sessionId, structureText: first.cif })).isError).not.toBe(true);
      held.open();
      expect((await late).structuredContent).toEqual({ accepted: false, reason: 'source-changed' });
      await expect(stat(file)).rejects.toThrow();
      expect((await first.live('status')).structuredContent.liveView.lastFrame).toBeUndefined();
      // A picture sent under the old binding afterwards is refused outright.
      expect((await first.send(JPEG)).isError).toBe(true);
      expect(await leftovers(root)).toEqual([]);
    } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('answers a stop while a picture is still being written, and that picture never lands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-stop-'));
    const clock = { now: 1_000_000 };
    const first = await host(root, clock);
    try {
      const file = join(root, 'live-view.jpg');
      await first.live();
      expect((await first.send(JPEG)).structuredContent).toEqual(accepted);
      clock.now += LIVE_VIEW_MIN_SPACING_MS;
      const held = first.holdNextFrame();
      const late = first.send(OTHER_JPEG);
      await held.arrived;
      // The stop answers on its own, with the picture still held before the step that lands it.
      const stopped = await first.live('stop');
      expect(stopped.structuredContent.liveView.active).toBe(false);
      expect(await readFile(file)).toEqual(JPEG);
      held.open();
      expect((await late).structuredContent).toEqual({ accepted: false, reason: 'stopped' });
      expect(await readFile(file)).toEqual(JPEG);
      expect(await leftovers(root)).toEqual([]);
    } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('keeps one panel feeding and never lets an earlier picture land over a later one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-panels-'));
    const clock = { now: 1_000_000 };
    const first = await host(root, clock);
    try {
      const file = join(root, 'live-view.jpg');
      const other = (await first.call('attach_inspection', first.binding)).structuredContent.panelId as string;
      await first.live();
      const held = first.holdNextFrame();
      const earlier = first.send(JPEG);
      await held.arrived;
      // Past the spacing, the other panel still waits while the first one posts; the first panel's next picture lands.
      clock.now += LIVE_VIEW_MIN_SPACING_MS + 50;
      expect((await first.send(OTHER_JPEG, other)).structuredContent).toEqual({ accepted: false, reason: 'other-panel' });
      expect((await first.send(OTHER_JPEG)).structuredContent).toEqual({ ...accepted, bytes: OTHER_JPEG.byteLength });
      held.open();
      expect((await earlier).structuredContent).toEqual({ accepted: false, reason: 'older' });
      expect(await readFile(file)).toEqual(OTHER_JPEG);
      expect(await leftovers(root)).toEqual([]);
    } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a start once shutdown begins, and does not finish shutting down while a picture is still being written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-close-'));
    const first = await host(root);
    let closed = false;
    try {
      const file = join(root, 'live-view.jpg');
      await first.live();
      const held = first.holdNextFrame();
      void first.send(JPEG).catch(() => undefined);
      await held.arrived;
      const closing = first.server.close().then(() => { closed = true; });
      // A whole request and answer goes through while the picture is held: shutdown is still waiting for it.
      const refused = await first.live();
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('shutting down');
      expect(closed).toBe(false);
      held.open();
      await closing;
      // The held picture's work, temporary file included, was over before the shutdown answered, and it never landed.
      expect(await leftovers(root)).toEqual([]);
      await expect(stat(file)).rejects.toThrow();
    } finally { first.openGates(); if (!closed) await first.server.close(); await first.client.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('starts in a folder that does not exist yet, and lands the first picture there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-new-folder-'));
    const folder = join(root, 'not', 'yet');
    const first = await host(root, undefined, { folder });
    try {
      const file = join(folder, 'live-view.jpg');
      await expect(stat(folder)).rejects.toThrow();
      const started = await first.live();
      expect(started.isError).toBeFalsy();
      expect(started.structuredContent.liveView).toEqual({ path: file, active: true });
      expect((await stat(folder)).mode & 0o777).toBe(0o700);
      expect(readLiveViewOwner(file)?.serverEpoch).toBe(first.binding.serverEpoch);
      expect((await first.send(JPEG)).structuredContent).toEqual(accepted);
      expect(await readFile(file)).toEqual(JPEG);
      expect(await leftovers(folder)).toEqual([]);
    } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('disarms a start whose answer cannot be built', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-start-fails-'));
    let trap = false;
    // The clock fails only when the start's answer asks it the time, which is after the session was armed.
    const first = await host(root, undefined, { now: clock => {
      if (trap && /\banswer\b/u.test(new Error().stack ?? '')) throw Error('The clock is unavailable.');
      return clock.now;
    } });
    try {
      trap = true;
      const failed = await first.live();
      trap = false;
      expect(failed.isError).toBe(true);
      expect(failed.content[0].text).toContain('The clock is unavailable.');
      expect(await first.asked()).toBeUndefined();
      expect((await first.send(JPEG)).structuredContent).toEqual({ accepted: false, reason: 'not-requested' });
      expect((await first.live('status')).structuredContent.liveView.active).toBe(false);
    } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
  });

  for (const cancel of ['source replacement', 'stop', 'session end'] as const) {
    it(`cancels a repair the owner has written but not landed when ${cancel} comes first`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-repair-cancel-'));
      const clock = { now: 1_000_000 };
      const first = await host(root, clock, { sessionTtlMs: 60_000 });
      try {
        const file = join(root, 'live-view.jpg');
        await first.live();
        expect((await first.send(JPEG)).structuredContent).toEqual(accepted);
        writeFileSync(file, OTHER_JPEG);
        // The owner's check finds the file changed and writes its repair, which waits before it would land.
        const held = first.holdNextFrame();
        expect(await first.asked()).toBeDefined();
        await held.arrived;
        if (cancel === 'source replacement') expect((await first.call('open', { sessionId: first.binding.sessionId, structureText: first.cif })).isError).not.toBe(true);
        if (cancel === 'stop') await first.live('stop');
        if (cancel === 'session end') {
          clock.now += 60_000;
          expect((await first.call('inspect', { structureText: first.cif })).isError).not.toBe(true);
        }
        held.open();
        expect(await first.nextCheck()).toBe('skipped');
        expect(await readFile(file)).toEqual(OTHER_JPEG);
        expect(await leftovers(root)).toEqual([]);
      } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
    });
  }

  it('stops waiting for a picture that is never written once shutdown has waited two seconds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-close-bound-'));
    const first = await host(root);
    let closed = false;
    try {
      const file = join(root, 'live-view.jpg');
      await first.live();
      const held = first.holdNextFrame();
      void first.send(JPEG).catch(() => undefined);
      await held.arrived;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const closing = first.server.close().then(() => { closed = true; });
      // While shutdown waits, a start is refused, and no amount of request traffic ends the wait.
      expect((await first.live()).content[0].text).toContain('shutting down');
      await vi.advanceTimersByTimeAsync(LIVE_VIEW_CLOSE_DRAIN_MS - 1);
      expect(closed).toBe(false);
      // The picture is still held when the bound passes, and shutdown goes on without it.
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      // Only a missing bound reaches the five-second guard; it fails the test instead of hanging it.
      let guard: ReturnType<typeof setTimeout> | undefined;
      expect(await Promise.race([closing.then(() => 'closed'), new Promise(resolve => { guard = setTimeout(resolve, 5_000, 'still waiting'); })])).toBe('closed');
      clearTimeout(guard);
      await expect(stat(file)).rejects.toThrow();
    } finally {
      vi.useRealTimers(); first.openGates();
      if (!closed) await first.server.close();
      await first.client.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it('stops feeding when the session ends, and a picture being written never lands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-ended-'));
    const clock = { now: 1_000_000 };
    const first = await host(root, clock, { sessionTtlMs: 60_000 });
    try {
      const file = join(root, 'live-view.jpg');
      await first.live();
      const held = first.holdNextFrame();
      const late = first.send(JPEG);
      await held.arrived;
      // The session expires, and the next use of the session store drops it.
      clock.now += 60_000;
      expect((await first.call('inspect', { structureText: first.cif })).isError).not.toBe(true);
      held.open();
      expect((await late).structuredContent).toEqual({ accepted: false, reason: 'stopped' });
      await expect(stat(file)).rejects.toThrow();
      expect(await leftovers(root)).toEqual([]);
    } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
  });

  // A privileged user writes into a read-only folder anyway, so the refusal cannot be staged there.
  it.skipIf(process.getuid?.() === 0)('drops a picture whose bytes cannot be written, and the next one lands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stereofold-live-view-unwritable-'));
    const clock = { now: 1_000_000 };
    const first = await host(root, clock);
    try {
      const file = join(root, 'live-view.jpg');
      await first.live();
      await chmod(root, 0o500);
      try { expect((await first.send(JPEG)).structuredContent).toEqual({ accepted: false, reason: 'failed' }); }
      finally { await chmod(root, 0o700); }
      clock.now += LIVE_VIEW_MIN_SPACING_MS;
      expect((await first.send(JPEG)).structuredContent).toEqual(accepted);
      expect(await readFile(file)).toEqual(JPEG);
      expect(await leftovers(root)).toEqual([]);
    } finally { await first.close(); await rm(root, { recursive: true, force: true }); }
  });

  it('keeps the picture route on the desktop panel and off every network route', async () => {
    expect(INSPECTOR_PANEL_TOOLS.has('submit_live_view')).toBe(true);
    expect(INSPECTOR_PANEL_TOOLS.has('show_live_view')).toBe(false);
    for (const tools of [LAN_TOOLS, COMPANION_TOOLS]) {
      expect(tools.has('submit_live_view')).toBe(false);
      expect(tools.has('show_live_view')).toBe(false);
    }
    const host = await readFile(new URL('../scripts/serve-inspection.ts', import.meta.url), 'utf8');
    const permitted = host.match(/const permitted=new Set\(\[(.+?)\]\);/s)?.[1] ?? '';
    const panelOnly = host.match(/const panelOnly=new Set\(\[(.+?)\]\);/s)?.[1] ?? '';
    expect(permitted).toContain("'show_live_view'");
    expect(permitted).not.toContain("'submit_live_view'");
    expect(panelOnly).toContain("'submit_live_view'");
  });
});
