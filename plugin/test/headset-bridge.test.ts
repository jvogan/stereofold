import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_HISTORY_REVISIONS, BRIDGE_SCHEMA_ID, BRIDGE_STALE_AFTER_MS,
  BRIDGE_HEADSET_VIEW_FILES, BRIDGE_HEADSET_VIEW_STATE_FILE,
  BRIDGE_VOICE_FILE, createHeadsetBridgeWriter, readBridgeHeadsetView, readBridgeVoice, stripCapabilityFields,
  summariseSelection, writeBridgeHeadsetView, writeBridgeVoice, writeHeadsetBridge,
  type BridgeCaptureInput, type BridgeHeadsetViewInput,
} from '../src/headset-bridge.js';
import { allowedReviewPath, parseXrReviewArguments } from '../scripts/serve-xr-review.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length) await rm(temporaryRoots.pop()!, { recursive: true, force: true });
});

async function bridgeDirectory(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stereofold-bridge-')));
  temporaryRoots.push(root);
  return join(root, 'bridge');
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/** A real 8-bit RGBA PNG, so the writer's header checks see genuine bytes. */
function makePng(width: number, height: number, fill = 0x20): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride, fill);
  for (let row = 0; row < height; row++) raw[row * stride] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const PAIRED_WIDTH = 64;
const EYE_WIDTH = 32;
const EYE_HEIGHT = 32;

function capture(fill = 0x20): BridgeCaptureInput {
  return {
    at: '2026-09-09T18:04:11.331Z',
    width: PAIRED_WIDTH, height: EYE_HEIGHT,
    views: [
      { eye: 'left', x: 0, y: 0, width: EYE_WIDTH, height: EYE_HEIGHT },
      { eye: 'right', x: EYE_WIDTH, y: 0, width: EYE_WIDTH, height: EYE_HEIGHT },
    ],
    paired: makePng(PAIRED_WIDTH, EYE_HEIGHT, fill),
    left: makePng(EYE_WIDTH, EYE_HEIGHT, fill),
  };
}

const SOURCE_SHA256 = 'a'.repeat(64);

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: '11111111-1111-4111-8111-111111111111',
    serverEpoch: '22222222-2222-4222-8222-222222222222',
    panelId: 'unidentified',
    surface: 'companion',
    sourceSha256: SOURCE_SHA256,
    structureId: '1CRN',
    stateRevision: 17,
    inspectionRevision: 41,
    renderToken: 23,
    representation: 'cartoon',
    selection: summariseSelection(['A/13/CA', 'A/12/CA']),
    camera: {
      mode: 'perspective', fov: 0.79, position: [0, 0, 60], target: [0, 0, 0], up: [0, 1, 0],
      radius: 22.4, radiusMax: 48.1, fog: 50, clipFar: true, minNear: 5, minFar: 0,
    },
    lastCommand: { commandId: '33333333-3333-4333-8333-333333333333', outcome: 'applied', at: '2026-09-09T18:04:11.204Z', detail: null },
    ...overrides,
  };
}

async function mode(path: string): Promise<string> {
  return ((await lstat(path)).mode & 0o777).toString(8);
}

function headsetView(overrides: Partial<BridgeHeadsetViewInput> = {}): BridgeHeadsetViewInput {
  const bytes = overrides.bytes ?? makePng(48, 36, 0x40);
  return {
    at: '2026-09-10T11:08:07.001Z',
    mediaType: 'image/png',
    source: 'device',
    width: 48, height: 36,
    views: [{ eye: 'none', x: 0, y: 0, width: 48, height: 36 }],
    ...overrides,
    bytes,
  };
}

describe('the headset still, beside the paired capture', () => {
  it('writes the image and its descriptor on their own, with private modes', async () => {
    const directory = await bridgeDirectory();
    const still = headsetView();
    const record = await writeBridgeHeadsetView(directory, still);

    expect(record).toMatchObject({ file: 'headset-view.png', mediaType: 'image/png', source: 'device',
      width: 48, height: 36, bytes: still.bytes.byteLength });
    expect(record.sha256).toBe(createHash('sha256').update(still.bytes).digest('hex'));
    expect((await readdir(directory)).sort()).toEqual(['headset-view.json', 'headset-view.png', 'history']);
    for (const name of ['headset-view.png', BRIDGE_HEADSET_VIEW_STATE_FILE]) expect(await mode(join(directory, name))).toBe('600');
    expect(await readBridgeHeadsetView(directory)).toEqual(record);
    expect(await readFile(join(directory, 'headset-view.png'))).toEqual(still.bytes);
  });

  it('leaves no stale file of the other media type beside the current one', async () => {
    const directory = await bridgeDirectory();
    await writeBridgeHeadsetView(directory, headsetView());
    expect((await readdir(directory))).toContain('headset-view.png');
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64, 0x11)]);
    const record = await writeBridgeHeadsetView(directory, headsetView({ mediaType: 'image/jpeg', bytes: jpeg, source: 'page' }));
    expect(record.file).toBe(BRIDGE_HEADSET_VIEW_FILES['image/jpeg']);
    expect((await readdir(directory)).sort()).toEqual(['headset-view.jpg', 'headset-view.json', 'history']);
  });

  it('refuses a view that lies outside the still, and a capability field', async () => {
    const directory = await bridgeDirectory();
    await expect(writeBridgeHeadsetView(directory,
      headsetView({ views: [{ eye: 'left', x: 40, y: 0, width: 48, height: 36 }] }))).rejects.toThrow(/outside the 48x36/);
    await expect(writeBridgeHeadsetView(directory, headsetView({ bytes: Buffer.alloc(0) }))).rejects.toThrow(/image bytes/);
    // A caller that passes its whole binding gets the token stripped, not an error.
    const record = await writeBridgeHeadsetView(directory, { ...headsetView(), sourceToken: 'secret' } as BridgeHeadsetViewInput);
    expect(JSON.stringify(record)).not.toMatch(/secret/);
  });

  it('folds the latest still into the next state.json and keeps a history copy', async () => {
    const directory = await bridgeDirectory();
    const still = headsetView({ source: 'page', mediaType: 'image/jpeg', bytes: Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(80, 0x22)]) });
    const record = await writeBridgeHeadsetView(directory, still);
    const written = await writeHeadsetBridge({ directory, revision: 9, state: state(), capture: capture() });

    expect(written.headsetView).toEqual(record);
    const onDisk = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    expect(onDisk.headsetView).toEqual(record);
    expect((await readdir(join(directory, 'history'))).sort())
      .toEqual(['00000009-capture-left.png', '00000009-capture.png', '00000009-headset-view.jpg', '00000009-state.json']);
    expect(await readFile(join(directory, 'history', '00000009-headset-view.jpg'))).toEqual(still.bytes);
  });

  it('lets a caller that already carries a still keep its own', async () => {
    const directory = await bridgeDirectory();
    await writeBridgeHeadsetView(directory, headsetView());
    const carried = { ...headsetView(), file: 'headset-view.png', bytes: 4,
      sha256: 'b'.repeat(64), at: '2026-09-10T12:00:00.000Z' } as unknown as Record<string, unknown>;
    delete carried.bytes;
    const written = await writeHeadsetBridge({ directory, revision: 3,
      state: state({ headsetView: { ...carried, bytes: 4, sha256: 'b'.repeat(64) } }), capture: capture() });
    expect(written.headsetView!.sha256).toBe('b'.repeat(64));
    // The history copy is only kept when the bytes on disk match what the
    // state names, so a carried descriptor that points at nothing writes none.
    expect(await readdir(join(directory, 'history'))).not.toContain('00000003-headset-view.png');
  });
});

describe('headset bridge writer', () => {
  it('writes the stable names, the history triple and nothing else, with private modes', async () => {
    const directory = await bridgeDirectory();
    const frame = capture();
    const written = await writeHeadsetBridge({ directory, revision: 7, state: state(), capture: frame });

    expect(written.schema).toBe(BRIDGE_SCHEMA_ID);
    expect(written.revision).toBe(7);
    expect((await readdir(directory)).sort()).toEqual(['capture-left.png', 'capture.png', 'history', 'state.json']);
    expect((await readdir(join(directory, 'history'))).sort())
      .toEqual(['00000007-capture-left.png', '00000007-capture.png', '00000007-state.json']);

    expect(await mode(directory)).toBe('700');
    expect(await mode(join(directory, 'history'))).toBe('700');
    for (const name of ['state.json', 'capture.png', 'capture-left.png']) expect(await mode(join(directory, name))).toBe('600');

    // The stable PNG and its history copy are the same bytes the caller handed over.
    expect(await readFile(join(directory, 'capture.png'))).toEqual(frame.paired);
    expect(await readFile(join(directory, 'history/00000007-capture.png'))).toEqual(frame.paired);
    expect(await readFile(join(directory, 'capture-left.png'))).toEqual(frame.left);

    const parsed = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    expect(parsed.revision).toBe(7);
    expect(parsed.capture.file).toBe('capture.png');
    expect(parsed.capture.leftFile).toBe('capture-left.png');
    expect(parsed.capture.views).toHaveLength(2);
    expect(parsed.selection).toEqual({ count: 2, digest: expect.stringMatching(/^[0-9a-f]{64}$/), sample: ['A/12/CA', 'A/13/CA'] });
    // The full selection key array is never written, only its summary.
    expect(JSON.stringify(parsed)).not.toContain('selectionKeys');
  });

  it('replaces the stable names atomically and leaves no temporary files behind', async () => {
    const directory = await bridgeDirectory();
    const writer = await createHeadsetBridgeWriter(directory);
    await writer.write(state(), capture(0x10));
    const second = await writer.write(state({ stateRevision: 18 }), capture(0x90));

    expect(second.revision).toBe(2);
    const entries = await readdir(directory);
    expect(entries.filter(entry => entry.startsWith('.') || entry.endsWith('.tmp'))).toEqual([]);
    // A reader that sees revision N is guaranteed the PNG for revision N.
    const parsed = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    const bytes = await readFile(join(directory, 'capture.png'));
    expect(parsed.revision).toBe(2);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(parsed.capture.sha256);
  });

  it('resumes the revision counter above the history already on disk', async () => {
    const directory = await bridgeDirectory();
    const first = await createHeadsetBridgeWriter(directory);
    await first.write(state(), capture());
    await first.write(state(), capture());

    const resumed = await createHeadsetBridgeWriter(directory);
    expect(resumed.revision()).toBe(3);
    expect((await resumed.write(state(), capture())).revision).toBe(3);
  });

  it('strips every token-shaped field and refuses a token hidden in renderToken', async () => {
    const directory = await bridgeDirectory();
    const leaky = state({
      sourceToken: '44444444-4444-4444-8444-444444444444',
      bearerToken: 'Bearer ' + 'b'.repeat(64),
      pairingCode: '123456',
      privateKey: '-----BEGIN ' + 'PRIVATE KEY-----',
    });
    const written = await writeHeadsetBridge({ directory, revision: 1, state: leaky, capture: capture() });

    expect(written).not.toHaveProperty('sourceToken');
    expect(written.renderToken).toBe(23);
    const serialised = await readFile(join(directory, 'state.json'), 'utf8');
    for (const secret of ['sourceToken', 'bearerToken', 'pairingCode', 'privateKey', 'Bearer ', 'BEGIN PRIVATE KEY', '44444444-4444']) {
      expect(serialised).not.toContain(secret);
    }
    // `renderToken` is allowlisted only as a number, so a string capability cannot ride in on it.
    expect(stripCapabilityFields({ renderToken: 'Bearer secret' })).toEqual({});
    await expect(writeHeadsetBridge({ directory, revision: 2, state: state({ renderToken: 'Bearer secret' }), capture: capture() }))
      .rejects.toThrow();
  });

  it('rejects an unknown field rather than publishing it', async () => {
    const directory = await bridgeDirectory();
    await expect(writeHeadsetBridge({ directory, revision: 1, state: state({ homePath: '/home/example/secret' }), capture: capture() }))
      .rejects.toThrow();
    expect(await readdir(directory).catch(() => [])).not.toContain('state.json');
  });

  it('accepts the harness command IDs and still bounds the field', async () => {
    const directory = await bridgeDirectory();
    // Command IDs are caller-chosen labels, not server UUIDs; this is exactly
    // what `companion-browser.ts` sends.
    const command = { commandId: 'companion-xr-uniform', outcome: 'applied', at: '2026-09-09T18:04:11.204Z', detail: null };
    await writeHeadsetBridge({ directory, revision: 1, state: state({ lastCommand: command }), capture: capture() });
    expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).lastCommand.commandId).toBe('companion-xr-uniform');

    for (const commandId of ['a'.repeat(81), 'has space', '../escape', '']) {
      await expect(writeHeadsetBridge({ directory, revision: 2, state: state({ lastCommand: { ...command, commandId } }), capture: capture() }))
        .rejects.toThrow();
    }
  });

  it('refuses a symlinked target and never writes through it', async () => {
    const directory = await bridgeDirectory();
    await writeHeadsetBridge({ directory, revision: 1, state: state(), capture: capture() });

    const outsider = join(directory, '..', 'outside.json');
    await writeFile(outsider, 'untouched', { mode: 0o600 });
    await rm(join(directory, 'state.json'));
    await symlink(outsider, join(directory, 'state.json'));
    await expect(writeHeadsetBridge({ directory, revision: 2, state: state(), capture: capture() }))
      .rejects.toThrow(/symbolic link/i);
    expect(await readFile(outsider, 'utf8')).toBe('untouched');

    const outsiderPng = join(directory, '..', 'outside.png');
    await writeFile(outsiderPng, 'untouched-png', { mode: 0o600 });
    await rm(join(directory, 'state.json'));
    await rm(join(directory, 'capture.png'));
    await symlink(outsiderPng, join(directory, 'capture.png'));
    await expect(writeHeadsetBridge({ directory, revision: 3, state: state(), capture: capture() }))
      .rejects.toThrow(/symbolic link/i);
    expect(await readFile(outsiderPng, 'utf8')).toBe('untouched-png');
  });

  it('keeps only the newest twenty history revisions', async () => {
    const directory = await bridgeDirectory();
    const writer = await createHeadsetBridgeWriter(directory);
    for (let index = 0; index < BRIDGE_HISTORY_REVISIONS + 3; index++) await writer.write(state(), capture());

    const entries = (await readdir(join(directory, 'history'))).sort();
    expect(entries).toHaveLength(BRIDGE_HISTORY_REVISIONS * 3);
    const revisions = [...new Set(entries.map(entry => Number(entry.slice(0, 8))))].sort((left, right) => left - right);
    expect(revisions).toEqual(Array.from({ length: BRIDGE_HISTORY_REVISIONS }, (_value, index) => index + 4));
    // The three stable names are never pruned.
    expect((await readdir(directory)).sort()).toEqual(['capture-left.png', 'capture.png', 'history', 'state.json']);
  });

  it('stamps the staleness fields a reader checks', async () => {
    const directory = await bridgeDirectory();
    const before = Date.now();
    const written = await writeHeadsetBridge({ directory, revision: 1, state: state(), capture: capture() });

    expect(written.staleAfterMs).toBe(BRIDGE_STALE_AFTER_MS);
    expect(BRIDGE_STALE_AFTER_MS).toBe(15_000);
    const writtenAt = Date.parse(written.writtenAt);
    expect(Number.isFinite(writtenAt)).toBe(true);
    expect(writtenAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(writtenAt).toBeLessThanOrEqual(Date.now() + 1_000);
    // `capture.at` is when the framebuffer was read; `writtenAt` is when this file landed.
    expect(written.capture.at).toBe('2026-09-09T18:04:11.331Z');
    const parsed = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    expect(parsed.writtenAt).toBe(written.writtenAt);
    expect(parsed.staleAfterMs).toBe(15_000);
  });

  it('refuses a capture whose PNG does not match its declared geometry', async () => {
    const directory = await bridgeDirectory();
    const mismatched = { ...capture(), left: makePng(EYE_WIDTH + 1, EYE_HEIGHT) };
    await expect(writeHeadsetBridge({ directory, revision: 1, state: state(), capture: mismatched }))
      .rejects.toThrow(/left-eye PNG/);
    const notPng = { ...capture(), paired: Buffer.alloc(64, 1) };
    await expect(writeHeadsetBridge({ directory, revision: 1, state: state(), capture: notPng }))
      .rejects.toThrow(/not a PNG/);
  });
});

describe('serve-xr-review bridge flag', () => {
  it('takes an absolute --bridge directory and leaves it unset by default', () => {
    const base = ['--runtime', '/tmp/iwer.min.js', '--companion-file', '/tmp/private-launch.json'];
    expect(parseXrReviewArguments(base).bridgeDirectory).toBeUndefined();
    expect(parseXrReviewArguments([...base, '--bridge', '/tmp/bridge']).bridgeDirectory).toBe('/tmp/bridge');
    expect(() => parseXrReviewArguments([...base, '--bridge', 'relative/bridge'])).toThrow(/absolute path/);
    expect(() => parseXrReviewArguments([...base, '--bridge', '/a', '--bridge', '/b'])).toThrow(/once/);
  });

  it('allows only a POST to the bridge route', () => {
    expect(allowedReviewPath('POST', '/bridge')).toBe(true);
    expect(allowedReviewPath('GET', '/bridge')).toBe(false);
    expect(allowedReviewPath('POST', '/bridge?x=1')).toBe(false);
    // The existing routes are unchanged.
    expect(allowedReviewPath('GET', '/')).toBe(true);
    expect(allowedReviewPath('POST', '/tool')).toBe(true);
    expect(allowedReviewPath('GET', '/source')).toBe(true);
  });
});

describe('bridge voice file', () => {
  const utterance = {
    utteranceId: '44444444-4444-4444-8444-444444444444',
    text: 'open the microtubule lattice',
    durationMs: 2_400,
    receivedAt: '2026-09-09T18:04:12.000Z',
    model: 'ggml-small.en.bin',
  };

  it('round-trips one utterance at 0600 beside the state file', async () => {
    const directory = await bridgeDirectory();
    expect(await readBridgeVoice(directory)).toBeUndefined();
    await writeBridgeVoice(directory, utterance);
    expect(await mode(join(directory, BRIDGE_VOICE_FILE))).toBe('600');
    expect(await readBridgeVoice(directory)).toEqual(utterance);
  });

  it('refuses a model path, an unlisted key, or a runaway transcript', async () => {
    const directory = await bridgeDirectory();
    await expect(writeBridgeVoice(directory, { ...utterance, model: '/home/example/.cache/ggml-small.en.bin' })).rejects.toThrow();
    // A capability-shaped key is stripped before validation, exactly as it is
    // on the state path, so the honest write succeeds without the leak.
    expect(await writeBridgeVoice(directory, { ...utterance, sourceToken: 'x' })).toEqual(utterance);
    await expect(writeBridgeVoice(directory, { ...utterance, text: 'x'.repeat(2_100) })).rejects.toThrow();
  });

  it('folds the latest utterance into the next state.json', async () => {
    const directory = await bridgeDirectory();
    await writeBridgeVoice(directory, utterance);
    const written = await writeHeadsetBridge({ directory, revision: 3, state: state(), capture: capture() });
    expect(written.voice).toEqual(utterance);
    expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).voice.text).toBe(utterance.text);
  });

  it('leaves state.json without a voice field until the wearer speaks', async () => {
    const directory = await bridgeDirectory();
    const written = await writeHeadsetBridge({ directory, revision: 1, state: state(), capture: capture() });
    expect(written.voice).toBeUndefined();
  });
});
