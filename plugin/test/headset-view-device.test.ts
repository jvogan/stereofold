import { readFile } from 'node:fs/promises';
import { deflateSync, gzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { blackStillReason, browserHealthArguments, captureDeviceView, countLitPixels, decodePng, decodeScreencap, deviceClockSeconds,
  dimStillNote, ffmpegPngArguments, ffmpegPngShape, findAdb, forceStopHeadsetBrowser, frameLight, headsetBrowserHealth, judgeStill, parseAdbDevices,
  parseBrowserHealth, pickAdbSerial, pngShape, sanitizeEvidence, screencapArguments, screencapPngArguments, pngCrc32, secureLayerLog,
  secureLayerLogArguments, unverifiedStillReason,
  ADB_ENV_KEYS, ADB_SERIAL_ENV_KEYS, BROWSER_HEALTH_SECTION, DEVICE_BLACK_LIT_SHARE, DEVICE_CAPTURE_DEFAULT_SIZE, DEVICE_LIT_FLOOR,
  DEVICE_RAW_MAX_BYTES, DEVICE_SCENE_LIT_SHARE, FFMPEG_ENV_KEYS, QUEST_BROWSER_PACKAGE, SECURE_LAYER_LOG_LINES,
  type DeviceCaptureHooks, type DeviceRunOptions } from '../src/headset-view-device.js';

/** A 4x3 PNG header is enough: the reader takes width and height from bytes 16 and 20. */
function png(width: number, height: number) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/**
 * One `screencap` frame: the four little-endian header words, then RGBA.
 *
 * `level` fills every channel, so a zero level is the black panel the sleep
 * check has to catch and anything else is a lit one. `paint` then draws on
 * the RGBA body, for a mark, a stripe or texture.
 */
function screencap(width: number, height: number, { level = 200, format = 1, headerWords = 4, paint }: {
  level?: number; format?: number; headerWords?: number; paint?: (body: Buffer, width: number) => void;
} = {}) {
  const header = Buffer.alloc(headerWords * 4);
  header.writeUInt32LE(width, 0); header.writeUInt32LE(height, 4); header.writeUInt32LE(format, 8);
  const body = Buffer.alloc(width * height * 4, level);
  paint?.(body, width);
  return Buffer.concat([header, body]);
}

/** Paint one rectangle of an RGBA body white, alpha included. */
const rect = (x0: number, y0: number, w: number, h: number) => (body: Buffer, width: number) => {
  for (let y = y0; y < y0 + h; y++) body.fill(255, (y * width + x0) * 4, (y * width + x0 + w) * 4);
};

/** A whole native panel frame: 3664x1920 RGBA, black unless painted. */
const NATIVE = { width: 3664, height: 1920 };
const nativeFrame = (paint?: (body: Buffer, width: number) => void) => screencap(NATIVE.width, NATIVE.height, { level: 0, ...(paint ? { paint } : {}) });

/**
 * A whole, valid PNG built the plain way: every row unfiltered (filter 0),
 * one zlib stream, and a real CRC-32 on every chunk. It shares no code with
 * the decoder under test; the row filters are covered by PNGs another
 * encoder wrote (FILTERED below). `samples` is the image, row-major, with
 * `channels` samples per pixel at `depth` bits.
 */
function encodePng(width: number, height: number, samples: Uint8Array | ((x: number, y: number, c: number) => number), {
  color = 6, depth = 8, interlace = 0, idat,
}: { color?: number; depth?: 8 | 16; interlace?: number; idat?: Buffer } = {}) {
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color]!;
  const bytes = depth / 8, stride = width * channels * bytes;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) {
    const value = typeof samples === 'function' ? samples(x, y, c) : samples[(y * width + x) * channels + c]!;
    const at = y * (stride + 1) + 1 + (x * channels + c) * bytes;
    if (bytes === 2) raw.writeUInt16BE(value * 257, at); else raw[at] = value;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = depth; header[9] = color; header[12] = interlace;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', idat ?? deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 one bit at a time: slow, plain, and a different implementation from the table one under test. */
function crc32(bytes: Uint8Array) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1;
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** A PNG's chunks, in order, so a test can reassemble it with one changed. */
function pngChunks(png: Buffer) {
  const chunks: { type: string; body: Buffer }[] = [];
  for (let at = 8; at < png.byteLength;) {
    const length = png.readUInt32BE(at);
    chunks.push({ type: png.toString('latin1', at + 4, at + 8), body: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

/** A PNG made of exactly these chunks, each with a correct CRC. */
const pngOf = (chunks: readonly { type: string; body: Buffer }[]) => Buffer.concat([PNG_SIGNATURE, ...chunks.map(chunk => pngChunk(chunk.type, chunk.body))]);

function pngChunk(type: string, body: Buffer) {
  const chunk = Buffer.alloc(12 + body.byteLength);
  chunk.writeUInt32BE(body.byteLength, 0);
  chunk.write(type, 4, 'latin1');
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + body.byteLength)), 8 + body.byteLength);
  return chunk;
}

/** An opaque RGBA PNG of one level, as `screencap -p` writes a flat panel. */
const flatPng = (width: number, height: number, level: number) => encodePng(width, height, (x, y, c) => c === 3 ? 255 : level);

/** An opaque RGBA PNG of unfiltered rows straight from an RGBA body, fast enough for a whole panel. */
function rgbaPng(width: number, height: number, body: Uint8Array) {
  const stride = width * 4 + 1, raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) raw.set(body.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return pngOf([{ type: 'IHDR', body: header }, { type: 'IDAT', body: deflateSync(raw, { level: 1 }) }, { type: 'IEND', body: Buffer.alloc(0) }]);
}

/**
 * A fake ffmpeg that does what the real one does with `ffmpegPngArguments`:
 * it reads the raw frame it was handed, scales it to the width asked for with
 * the even height ffmpeg picks (nearest pixel, opaque), and writes a whole
 * PNG. Written apart from the module's own size rule, which real ffmpeg was
 * checked against.
 */
function fakeFfmpeg(args: readonly string[], input: Buffer | undefined) {
  const [width, height] = args[args.indexOf('-s') + 1]!.split('x').map(Number) as [number, number];
  const bgra = args[args.indexOf('-pix_fmt') + 1] === 'bgra';
  const scaled = /^scale=(\d+):-2$/u.exec(args.includes('-vf') ? args[args.indexOf('-vf') + 1]! : '');
  const outWidth = scaled ? Number(scaled[1]) : width, outHeight = scaled ? 2 * Math.round(outWidth * height / width / 2) : height;
  if (!input || input.byteLength !== width * height * 4) throw Error('ffmpeg exited 1: short raw input');
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    const row = Math.min(height - 1, Math.floor((y + 0.5) * height / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const from = (row * width + Math.min(width - 1, Math.floor((x + 0.5) * width / outWidth))) * 4, to = (y * outWidth + x) * 4;
      out[to] = input[from + (bgra ? 2 : 0)]!; out[to + 1] = input[from + 1]!; out[to + 2] = input[from + (bgra ? 0 : 2)]!; out[to + 3] = 255;
    }
  }
  return rgbaPng(outWidth, outHeight, out);
}

/** The 16x8 gradient the FILTERED fixtures hold. */
const gradient = (x: number, y: number, c: number) => c === 3 ? 255 : (x * 37 + y * 11 + c * 50) & 0xff;

/**
 * The gradient above, encoded by ffmpeg's PNG encoder with `-pred sub`, `up`,
 * `avg`, `paeth` and (for RGB) `mixed`. Its first row is filter 1 and every
 * later row the named filter, so filters 1 to 4 are all exercised by bytes
 * this repository's code did not produce.
 */
const FILTERED: Record<string, { channels: 3 | 4; base64: string }> = {
  sub: { channels: 4, base64: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADwdn+XAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAO0lEQVR4nGNkMEr5r6qqykAuZuS2zafMADGPKsoMUAxupcwAnbgJlBlgnjmbMgOcSpZRZoBv/UaKDAAAm3tEVVAIi3QAAAAASUVORK5CYII=' },
  up: { channels: 4, base64: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADwdn+XAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAH0lEQVR4nGNkMEr5r6qqykAuZuLm5magBI8aMBgMAAB5rhaW/KUGQwAAAABJRU5ErkJggg==' },
  avg: { channels: 4, base64: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADwdn+XAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAaUlEQVR4nGNkMEr5r6qqykAuZuZWsW2QkJBgwMAzJBhmYBNHk2MW1HJGM2AGnI1pAKYcs5i+B6YBM/AYMANVjFnG1A+nAcR4jVnRKhgzDLD6H7vXmNUdIhsIKcLnNWYd17gGbIowMXY5AB+SPIic/coBAAAAAElFTkSuQmCC' },
  paeth: { channels: 4, base64: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAYAAADwdn+XAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAASElEQVR4nGNkMEr5r6qqykAuZuHm5mbAxKpYxLDL4TAAiFVxGYAqh9sAAliVGANUMcQwvYbFAHz+x/Qadhfg8z9hF+ByPnY5AJ0fF9zQrPIpAAAAAElFTkSuQmCC' },
  mixed: { channels: 3, base64: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAIAAAB/FOjAAAAACXBIWXMAAAAAAAAAAQCEeRdzAAAAFklEQVR4nGNkMEpRJQUwcZMIRjUQAwDrexWXC/8hGQAAAABJRU5ErkJggg==' },
};

/** A headset log whose clock is 1000 and that has one "secure layer detected" line `ago` seconds old. */
const secureLog = (ago: number, tag = 'SurfaceForgerClientImpl') =>
  `1000\n${1000 - ago}.177   961   980 I ${tag}: captureDisplay: secure layer detected, producing black frame\n`;

/**
 * A runner for the dark-still paths: the raw frame (gzipped) and the
 * headset's PNG are what `screencap` returns, `power` what dumpsys says, and
 * `log` what the log probe returns.
 */
function darkRunner({ frame, encoded, converted, power = 'Awake', log = '1000\n', calls = [] }: {
  frame?: Buffer; encoded?: Buffer; converted?: Buffer; power?: string | Error; log?: string; calls?: string[];
}): DeviceCaptureHooks['run'] {
  return async (file, args, options) => {
    calls.push([file.split('/').at(-1), ...args].join(' '));
    if (file.endsWith('ffmpeg')) return { stdout: converted ?? fakeFfmpeg(args, options.input), stderr: '' };
    if (args[0] === 'devices') return { stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
    if (args.includes('dumpsys')) { if (power instanceof Error) throw power; return { stdout: `mWakefulness=${power}\n`, stderr: '' }; }
    if (args.join(' ').includes('logcat')) return { stdout: log, stderr: '' };
    if (args.includes('-p')) return { stdout: encoded ?? Buffer.alloc(0), stderr: '' };
    return { stdout: frame ? gzipSync(frame) : Buffer.alloc(0), stderr: '' };
  };
}

const adbOnly = async (path: string) => path === '/opt/tools/adb';

type Call = { file: string; args: string[]; options: DeviceRunOptions };

/**
 * A fake `adb` and `ffmpeg` that never spawn anything.
 *
 * `frame` is what the device's `screencap` hands back, `encoded` what its
 * `screencap -p` returns, `converted` what `ffmpeg` returns in place of a real
 * conversion of the frame, and `devices` what `adb devices` lists. Anything a
 * test wants to break it supplies as a runner of its own.
 */
function hooks(overrides: Partial<DeviceCaptureHooks> & {
  devices?: string; frame?: Buffer; encoded?: Buffer; converted?: Buffer; gzip?: boolean; env?: NodeJS.ProcessEnv;
} = {}): DeviceCaptureHooks & { calls: Call[] } {
  const calls: Call[] = [];
  const devices = overrides.devices ?? 'List of devices attached\nFAKEQUEST00001\tdevice\n';
  const frame = overrides.frame ?? screencap(8, 6);
  const encoded = overrides.encoded ?? png(8, 6);
  const gzip = overrides.gzip ?? true;
  return {
    calls,
    run: overrides.run ?? (async (file, args, options) => {
      calls.push({ file, args: [...args], options });
      if (file.endsWith('ffmpeg')) return { stdout: overrides.converted ?? fakeFfmpeg(args, options.input), stderr: '' };
      if (args[0] === 'devices') return { stdout: devices, stderr: '' };
      if (args.includes('screencap | gzip -1')) {
        return gzip ? { stdout: gzipSync(frame), stderr: '' } : { stdout: Buffer.alloc(0), stderr: 'gzip: not found' };
      }
      if (args.includes('screencap')) return { stdout: args.includes('-p') ? encoded : frame, stderr: '' };
      return { stdout: Buffer.alloc(0), stderr: '' };
    }),
    exists: overrides.exists ?? (async (path: string) => path === '/opt/tools/adb' || path === '/opt/tools/ffmpeg'),
    env: overrides.env ?? { PATH: '/opt/tools' },
    now: overrides.now,
  };
}

describe('finding the tools without hard-coding a path', () => {
  it('prefers an environment variable, then PATH, and never invents a location', async () => {
    const exists = async (path: string) => path === '/opt/tools/adb' || path === '/elsewhere/adb';
    expect(await findAdb({ env: { STEREOFOLD_ADB_BIN: '/elsewhere/adb', PATH: '/opt/tools' }, exists })).toBe('/elsewhere/adb');
    expect(await findAdb({ env: { STEREOFOLD_ADB: '/elsewhere/adb', PATH: '/opt/tools' }, exists })).toBe('/elsewhere/adb');
    expect(await findAdb({ env: { ADB: '/elsewhere/adb', PATH: '/opt/tools' }, exists })).toBe('/elsewhere/adb');
    expect(await findAdb({ env: { PATH: '/opt/tools' }, exists })).toBe('/opt/tools/adb');
    expect(await findAdb({ env: { PATH: '/nowhere' }, exists })).toBeUndefined();
    // A relative name in the environment is ignored rather than resolved.
    expect(await findAdb({ env: { ADB: 'adb', PATH: '/nowhere' }, exists })).toBeUndefined();
    expect(ADB_ENV_KEYS).toEqual(['STEREOFOLD_ADB_BIN', 'STEREOFOLD_ADB', 'ADB']);
  });

  it('reads only the devices adb calls ready', () => {
    expect(parseAdbDevices('List of devices attached\n1WMH\tdevice\n192.168.77.9:5555\tdevice\n')).toEqual(['1WMH', '192.168.77.9:5555']);
    expect(parseAdbDevices('List of devices attached\n1WMH\tunauthorized\nX\toffline\n')).toEqual([]);
    expect(parseAdbDevices('List of devices attached\n')).toEqual([]);
    expect(parseAdbDevices('')).toEqual([]);
  });

  it('takes the cable over Wi-Fi, and never silently replaces a named headset', () => {
    expect(pickAdbSerial(['192.168.77.9:5555', '1WMH'])).toEqual({ serial: '1WMH' });
    expect(pickAdbSerial(['192.168.77.9:5555'])).toEqual({ serial: '192.168.77.9:5555' });
    expect(pickAdbSerial([])).toEqual({});
    expect(pickAdbSerial(['1WMH', 'OTHER'], { STEREOFOLD_ADB_SERIAL: 'OTHER' })).toEqual({ serial: 'OTHER', named: 'OTHER' });
    expect(pickAdbSerial(['1WMH'], { ANDROID_SERIAL: 'OTHER' })).toEqual({ named: 'OTHER' });
    expect(ADB_SERIAL_ENV_KEYS).toEqual(['STEREOFOLD_ADB_SERIAL', 'ANDROID_SERIAL', 'STEREOFOLD_QUEST_SERIAL']);
  });

  it('uses the explicit launch target for dual transports while preserving diagnostic overrides', () => {
    const ready=['USB-QUEST','192.168.77.9:5555'];
    expect(pickAdbSerial(ready,{STEREOFOLD_QUEST_SERIAL:ready[1]})).toEqual({serial:ready[1],named:ready[1]});
    expect(pickAdbSerial(ready,{STEREOFOLD_QUEST_SERIAL:'missing'})).toEqual({named:'missing'});
    expect(pickAdbSerial(ready,{STEREOFOLD_QUEST_SERIAL:ready[1],ANDROID_SERIAL:ready[0]})).toEqual({serial:ready[0],named:ready[0]});
    expect(pickAdbSerial(ready,{STEREOFOLD_QUEST_SERIAL:ready[0],ANDROID_SERIAL:ready[0],STEREOFOLD_ADB_SERIAL:ready[1]}))
      .toEqual({serial:ready[1],named:ready[1]});
  });
});

describe('reading one screencap frame', () => {
  it('splits either header length off the pixels, and refuses a truncated transfer', () => {
    expect(decodeScreencap(screencap(4, 2))).toMatchObject({ width: 4, height: 2, pixelFormat: 'rgba' });
    // Builds before Android 10 stop the header at the format word.
    expect(decodeScreencap(screencap(4, 2, { headerWords: 3 }))).toMatchObject({ width: 4, height: 2 });
    expect(decodeScreencap(screencap(4, 2, { format: 5 }))).toMatchObject({ pixelFormat: 'bgra' });
    expect(decodeScreencap(screencap(4, 2).subarray(0, 40))).toBeUndefined();
    expect(decodeScreencap(Buffer.alloc(4))).toBeUndefined();
    expect(decodeScreencap(Buffer.alloc(64))).toBeUndefined();
  });

  it('refuses a frame both header lengths fit, rather than reading it one pixel out of place', () => {
    // A frame with the 16-byte header, cut four bytes short, is exactly as long
    // as a whole one after the 12-byte header.
    const whole = screencap(4, 2);
    const short = whole.subarray(0, whole.byteLength - 4);
    expect(short.byteLength).toBe(screencap(4, 2, { headerWords: 3 }).byteLength);
    expect(decodeScreencap(short)).toBeUndefined();
    // Whichever colour space screencap wrote: unknown, sRGB or Display P3.
    for (const space of [0, 1, 2]) {
      const written = Buffer.from(short); written.writeUInt32LE(space, 12);
      expect(decodeScreencap(written), `colour space ${space}`).toBeUndefined();
    }
    // A first pixel no colour space can be settles it: the shorter header, whole.
    expect(decodeScreencap(screencap(4, 2, { headerWords: 3 }))).toMatchObject({ width: 4, height: 2, pixelFormat: 'rgba' });
    const opaqueBlackCorner = screencap(4, 2, { headerWords: 3, paint: body => { body.fill(0, 0, 4); body[3] = 255; } });
    expect(decodeScreencap(opaqueBlackCorner)?.body.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 255]));
    const level3Corner = screencap(4, 2, { headerWords: 3, paint: body => { body.fill(0, 0, 4); body[0] = 3; } });
    expect(decodeScreencap(level3Corner)).toMatchObject({ width: 4, height: 2 });
    // A transparent black corner after the 12-byte header could be either.
    expect(decodeScreencap(screencap(4, 2, { headerWords: 3, paint: body => body.fill(0, 0, 4) }))).toBeUndefined();
    // The whole frame with the 16-byte header is read as before.
    expect(decodeScreencap(whole)).toMatchObject({ width: 4, height: 2 });
  });

  it('tells an empty panel from a lit one', () => {
    expect(frameLight(decodeScreencap(screencap(16, 16, { level: 0 }))!)).toEqual({ pixels: 256, lit: 0 });
    expect(frameLight(decodeScreencap(screencap(16, 16, { level: 200 }))!)).toEqual({ pixels: 256, lit: 256 });
  });

  it('leaves a raw frame in a pixel format it does not know undecoded rather than misread as RGBA', () => {
    // 43 is RGBA_1010102: four bytes a pixel, so the length matches, but the
    // bytes are not RGBA.
    expect(decodeScreencap(screencap(4, 2, { format: 43 }))).toBeUndefined();
    expect(decodeScreencap(screencap(4, 2, { format: 2 }))).toMatchObject({ pixelFormat: 'rgb0' });
  });

  it('builds the screencap and ffmpeg command lines', () => {
    expect(screencapArguments('1WMH')).toEqual(['-s', '1WMH', 'exec-out', 'screencap | gzip -1']);
    expect(screencapArguments('1WMH', { gzip: false })).toEqual(['-s', '1WMH', 'exec-out', 'screencap']);
    expect(screencapPngArguments('1WMH')).toEqual(['-s', '1WMH', 'exec-out', 'screencap', '-p']);
    expect(ffmpegPngArguments({ width: 3664, height: 1920, pixelFormat: 'rgba', maxWidth: 1600 }))
      .toEqual(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
        '-s', '3664x1920', '-i', 'pipe:0', '-vf', 'scale=1600:-2', '-frames:v', '1', '-c:v', 'png', '-f', 'image2', 'pipe:1']);
    // A frame already narrower than the ceiling is never upscaled.
    expect(ffmpegPngArguments({ width: 800, height: 600, pixelFormat: 'rgba', maxWidth: 1600 })).not.toContain('-vf');
  });

  it('knows the size ffmpeg writes, as real ffmpeg wrote it', () => {
    // Each pair was read off the PNG that ffmpeg 9.0.2 wrote for these arguments.
    for (const [width, height, maxWidth, expected] of [
      [3664, 1920, 1600, [1600, 838]], [3664, 1920, 64, [64, 34]], [3664, 1920, 2048, [2048, 1074]], [1832, 1920, 640, [640, 670]],
      [4128, 2208, 1600, [1600, 856]], [1000, 999, 99, [99, 98]], [801, 1203, 65, [65, 98]], [3664, 1918, 1599, [1599, 838]],
    ] as const) expect(ffmpegPngShape({ width, height, maxWidth }), `${width}x${height} at ${maxWidth}`).toEqual({ width: expected[0], height: expected[1] });
    // A frame no wider than the ceiling is never scaled.
    expect(ffmpegPngShape({ width: 800, height: 600, maxWidth: 1600 })).toEqual({ width: 800, height: 600 });
    expect(ffmpegPngShape({ width: 1600, height: 601, maxWidth: 1600 })).toEqual({ width: 1600, height: 601 });
  });

  it('reads a PNG shape, or nothing at all', () => {
    expect(pngShape(png(1600, 838))).toEqual({ width: 1600, height: 838 });
    expect(pngShape(Buffer.from('not a png at all, really not'))).toBeUndefined();
    expect(pngShape(Buffer.alloc(8))).toBeUndefined();
  });
});

describe('the device still', () => {
  it('refuses gzip output past the raw byte ceiling before frame conversion', async () => {
    // The pixels alone fill the limit; the frame header puts the output over it.
    const zipped = gzipSync(screencap(4096, 6144));
    expect(zipped.byteLength).toBeLessThan(DEVICE_RAW_MAX_BYTES);
    let conversions = 0;
    const outcome = await captureDeviceView({ hooks: hooks({ run: async (file, args) => {
      if (file.endsWith('ffmpeg')) { conversions++; return { stdout: png(1600, 2400), stderr: '' }; }
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nfixture-headset\tdevice\n', stderr: '' };
      if (args.includes('screencap | gzip -1')) return { stdout: zipped, stderr: '' };
      throw Error('No fallback frame available');
    } }) });
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toMatch(/adb screencap failed: .*larger than/);
    expect(conversions).toBe(0);
  });

  it('pulls a gzipped frame and encodes it here, never on the headset', async () => {
    const seams = hooks({ frame: screencap(3664, 1920) });
    const outcome = await captureDeviceView({ maxWidth: 1600, hooks: seams });
    expect(outcome).toMatchObject({ ok: true, mimeType: 'image/png', width: 1600, height: 838,
      serial: 'FAKEQUEST00001', wire: 'gzip' });
    // What is handed over is ffmpeg's own PNG, read in full here.
    expect(outcome.ok && decodePng(outcome.bytes)).toMatchObject({ width: 1600, height: 838, channels: 4 });
    expect(seams.calls.map(call => call.args.join(' '))).toEqual([
      'devices',
      '-s FAKEQUEST00001 exec-out screencap | gzip -1',
      ffmpegPngArguments({ width: 3664, height: 1920, pixelFormat: 'rgba', maxWidth: 1600 }).join(' '),
    ]);
    // The raw frame is piped into ffmpeg rather than written anywhere.
    expect(seams.calls[2]!.options.input).toHaveLength(3664 * 1920 * 4);
    expect(seams.calls[2]!.file).toBe('/opt/tools/ffmpeg');
    // Nothing in the command fires the system screenshot service.
    expect(JSON.stringify(seams.calls)).not.toMatch(/metavr|metacam|keyevent|Screenshots/u);
  });

  it('scales to a default wide enough to read the spatial menu', async () => {
    const seams = hooks({ frame: screencap(3664, 1920) });
    await captureDeviceView({ hooks: seams });
    expect(DEVICE_CAPTURE_DEFAULT_SIZE).toBe(1_600);
    expect(seams.calls[2]!.args.join(' ')).toContain(`scale=${DEVICE_CAPTURE_DEFAULT_SIZE}:-2`);
    // And a caller's number is still bounded at both ends.
    const small = hooks({ frame: screencap(3664, 1920) });
    await captureDeviceView({ maxWidth: 1, hooks: small });
    expect(small.calls[2]!.args.join(' ')).toContain('scale=64:-2');
    const huge = hooks({ frame: screencap(3664, 1920) });
    await captureDeviceView({ maxWidth: 99_999, hooks: huge });
    expect(huge.calls[2]!.args.join(' ')).toContain('scale=2048:-2');
  });

  it('falls back to a plain raw transfer when the headset has no gzip', async () => {
    const seams = hooks({ gzip: false });
    const outcome = await captureDeviceView({ hooks: seams });
    expect(outcome).toMatchObject({ ok: true, wire: 'raw' });
    expect(seams.calls[1]!.args).toContain('screencap | gzip -1');
    expect(seams.calls[2]!.args.at(-1)).toBe('screencap');
  });

  it('lets the headset encode the PNG when this Mac has no ffmpeg', async () => {
    const litBytes = flatPng(32, 16, 180);
    const seams = hooks({ encoded: litBytes, exists: adbOnly });
    const outcome = await captureDeviceView({ hooks: seams });
    expect(outcome).toMatchObject({ ok: true, mimeType: 'image/png', width: 32, height: 16, wire: 'device-png' });
    expect(outcome.ok && outcome.bytes.equals(litBytes)).toBe(true);
    expect(outcome.ok && outcome.note).toBeUndefined();
    // And the 28 MB raw transfer nothing here could decode is never made.
    expect(seams.calls.map(call => call.args.at(-1))).toEqual(['devices', '-p']);
  });

  it('refuses a black frame and says what the headset reports, not a cause it cannot know', async () => {
    const off = await captureDeviceView({ hooks: hooks({ run: darkRunner({ frame: screencap(64, 64, { level: 0 }), power: 'Asleep' }) }) });
    expect(off).toMatchObject({ ok: false, still: 'black' });
    expect(!off.ok && off.reason).toMatch(/^The still is almost entirely black \(0 of 4,096 pixels lit\), so it was not handed over as the wearer's view\. Nothing was saved\./u);
    expect(!off.ok && off.reason).toMatch(/The headset reports its display Asleep\./u);
    expect(!off.ok && off.reason).toContain('`adb shell am broadcast -a com.oculus.vrpowermanager.prox_close`');

    // Awake, with nothing in the log: the cause is said to be unknown.
    const awake = await captureDeviceView({ hooks: hooks({ run: darkRunner({ frame: screencap(64, 64, { level: 0 }) }) }) });
    expect(!awake.ok && awake.reason).toMatch(/reports it is Awake, and its log returned no lines to check for a blocked capture, so the cause is unknown/u);
    expect(!awake.ok && awake.reason).toMatch(/source "page" reads the molecule/u);

    // A probe that cannot answer says so.
    const mute = await captureDeviceView({ hooks: hooks({ run: darkRunner({ frame: screencap(64, 64, { level: 0 }), power: Error('closed') }) }) });
    expect(!mute.ok && mute.reason).toMatch(/The headset did not say whether its display is awake\./u);

    // No sentence claims what the pixels and the log cannot establish.
    for (const outcome of [off, awake, mute]) expect(!outcome.ok && outcome.reason).not.toMatch(/on purpose|drew nothing|blanked this still/u);
  });

  it('says a recent log line suggests a blocked capture, and prints each recovery step as a whole command', async () => {
    const seen: string[] = [];
    const outcome = await captureDeviceView({ hooks: hooks({ run: darkRunner({ frame: screencap(64, 64, { level: 0 }), log: secureLog(1), calls: seen }) }) });
    expect(outcome).toMatchObject({ ok: false, still: 'black' });
    const reason = !outcome.ok ? outcome.reason : '';
    expect(reason).toMatch(/^The still is almost entirely black/u);
    expect(reason).toMatch(/A headset log line from 1 s ago says "secure layer detected", which suggests the system blocked this capture; the scene itself may be drawing normally\./u);
    expect(reason).toMatch(/Nothing was saved\./u);
    expect(reason).toMatch(/While the page is in immersion, source "page" reads the molecule/u);
    // Both steps are complete commands, offered as something to try.
    expect(reason).toContain('To try to get the device view back, restart the headset, or run `adb shell am force-stop com.oculus.vrshell` and then `adb shell am force-stop com.oculus.metacam`');
    expect(reason).not.toMatch(/on purpose|then com\.oculus\.metacam;/u);
    expect('bytes' in outcome).toBe(false);
    // One read-only shell round trip: the headset's clock, then its recent log.
    expect(seen).toContain(['adb', ...secureLayerLogArguments('QUEST2')].join(' '));
    expect(seen.join('\n')).not.toMatch(/\binput\b|keyevent|\bpull\b|\bpush\b|\/sdcard|force-stop/u);
    expect(secureLayerLogArguments('QUEST2')).toEqual(['-s', 'QUEST2', 'shell', `date +%s; logcat -d -v epoch -t ${SECURE_LAYER_LOG_LINES}`]);

    // A line minutes old suggests nothing about this capture.
    const old = await captureDeviceView({ hooks: hooks({ run: darkRunner({ frame: screencap(64, 64, { level: 0 }), log: secureLog(200) }) }) });
    expect(!old.ok && old.reason).toMatch(/so the cause is unknown/u);
    expect(!old.ok && old.reason).not.toMatch(/suggests|s ago/u);

    // An asleep display is reported first.
    const asleep = await captureDeviceView({ hooks: hooks({ run: darkRunner({ frame: screencap(64, 64, { level: 0 }), power: 'Asleep', log: secureLog(1) }) }) });
    expect(!asleep.ok && asleep.reason).toMatch(/reports its display Asleep/u);
  });

  it('says what was missing rather than throwing', async () => {
    const noAdb = await captureDeviceView({ hooks: hooks({ exists: async () => false }) });
    expect(noAdb).toMatchObject({ ok: false });
    expect(!noAdb.ok && noAdb.reason).toMatch(/No adb was found/);

    const noHeadset = await captureDeviceView({ hooks: hooks({ devices: 'List of devices attached\n' }) });
    expect(!noHeadset.ok && noHeadset.reason).toMatch(/no authorized headset/);

    const wrongSerial = await captureDeviceView({ hooks: hooks({ env: { PATH: '/opt/tools', STEREOFOLD_ADB_SERIAL: 'SOMEWHERE-ELSE' } }) });
    expect(!wrongSerial.ok && wrongSerial.reason).toMatch(/names SOMEWHERE-ELSE, which adb does not list/);

    const listFailed = await captureDeviceView({ hooks: hooks({ run: async () => { throw Error('spawn adb ENOENT'); } }) });
    expect(!listFailed.ok && listFailed.reason).toMatch(/adb devices failed: spawn adb ENOENT/);

    const captureFailed = await captureDeviceView({ hooks: hooks({ run: async (file, args) => {
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
      throw Error('device offline');
    } }) });
    expect(!captureFailed.ok && captureFailed.reason).toMatch(/adb screencap failed: device offline/);

    const garbage = await captureDeviceView({ hooks: hooks({ gzip: false, frame: Buffer.from('not a frame'), encoded: Buffer.from('nor a png') }) });
    expect(!garbage.ok && garbage.reason).toMatch(/no usable frame/);
  });

  it('says the log could not be checked when it could not, and never that it holds no line', async () => {
    const black = screencap(64, 64, { level: 0 });
    const reasonWith = async (run: DeviceCaptureHooks['run']) => { const outcome = await captureDeviceView({ hooks: hooks({ run }) }); return !outcome.ok ? outcome.reason : ''; };
    // The log command itself is refused.
    const refused = await reasonWith(async (file, args) => {
      if (args.join(' ').includes('logcat')) throw Error('adb: logcat not permitted');
      return darkRunner({ frame: black })(file, args, { timeout: 0, env: {}, maxBuffer: 0 });
    });
    expect(refused).toMatch(/reports it is Awake, and its log could not be checked for a blocked capture, so the cause is unknown/u);
    // The answer has no readable clock, so its lines cannot be dated.
    const clockless = await reasonWith(darkRunner({ frame: black, log: `not a clock\n${secureLog(1).split('\n')[1]}\n` }));
    expect(clockless).toMatch(/its log could not be checked for a blocked capture/u);
    // Read, with only an old matching line: no recent line in the lines read.
    const stale = await reasonWith(darkRunner({ frame: black, log: secureLog(200) }));
    expect(stale).toMatch(/no "secure layer detected" line from the last 30 s was found in the 1 log line read/u);
    // The count is what came back, not what was asked for.
    const three = await reasonWith(darkRunner({ frame: black, log: `${secureLog(200)}999.1 1 2 I Other: a\n999.2 1 2 I Other: b\n--------- beginning of main\n` }));
    expect(three).toMatch(/was found in the 3 log lines read/u);
    for (const reason of [stale, three]) expect(reason).not.toMatch(/300 log lines/u);
    // Both probes failing says both.
    const silent = await reasonWith(async (file, args) => {
      if (args.join(' ').includes('logcat') || args.includes('dumpsys')) throw Error('closed');
      return darkRunner({ frame: black })(file, args, { timeout: 0, env: {}, maxBuffer: 0 });
    });
    expect(silent).toMatch(/did not say whether its display is awake, and its log could not be checked either\./u);
    for (const reason of [refused, clockless, stale, silent]) expect(reason).not.toMatch(/has no line|holds no line/u);
  });

  it('names an unsupported raw format as the cause when the raw pull recovered from a gzip failure', async () => {
    const outcome = await captureDeviceView({ hooks: hooks({ run: async (file, args) => {
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
      if (args.includes('screencap | gzip -1')) return { stdout: Buffer.from('not gzip data at all'), stderr: '' };
      if (args.includes('-p')) return { stdout: encodePng(8, 6, () => 0, { interlace: 1 }), stderr: '' };
      return { stdout: screencap(8, 6, { format: 43 }), stderr: '' };
    } }) });
    expect(outcome).toMatchObject({ ok: false, still: 'unverified' });
    expect(!outcome.ok && outcome.reason).toMatch(/The headset encoded it because the headset sent raw pixels in format 43, which this Mac does not read\./u);
    expect(!outcome.ok && outcome.reason).not.toMatch(/header check/u);
  });

  it('reports the transfer that failed, and never claims the headset encoded a still it did not send', async () => {
    const outcome = await captureDeviceView({ hooks: hooks({ exists: adbOnly, run: async (file, args) => {
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
      throw Error('device offline');
    } }) });
    expect(outcome).toMatchObject({ ok: false });
    expect(!outcome.ok && outcome.reason).toBe('adb screencap failed: device offline. No ffmpeg was found on this Mac, so the headset was asked to encode the still itself.');
    expect(!outcome.ok && outcome.reason).not.toMatch(/encoded it instead/u);
  });

  it('names the failure that sent the still to the headset encoder, not one a later step recovered from', async () => {
    const outcome = await captureDeviceView({ hooks: hooks({ run: async (file, args) => {
      if (file.endsWith('ffmpeg')) throw Error('ffmpeg exited 1');
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
      if (args.includes('screencap | gzip -1')) return { stdout: Buffer.from('not gzip data at all'), stderr: '' };
      if (args.includes('-p')) return { stdout: encodePng(8, 6, () => 0, { interlace: 1 }), stderr: '' };
      return { stdout: screencap(8, 6), stderr: '' };
    } }) });
    expect(outcome).toMatchObject({ ok: false, still: 'unverified' });
    expect(!outcome.ok && outcome.reason).toMatch(/The headset encoded it because ffmpeg failed: ffmpeg exited 1\./u);
    expect(!outcome.ok && outcome.reason).not.toMatch(/header check/u);
  });

  it('dates the secure-layer line on the headset clock and only within the window', () => {
    const line = (at: string) => `${at}   812   830 W ScreenCapture: captureDisplay: secure layer detected, producing black frame`;
    expect(secureLayerLog(`1000\n${line('995.5')}\n`)).toBe(5);
    expect(secureLayerLog(`1000\n${line('960.0')}\n${line('998.0')}\n`)).toBe(2);
    // Read, but the only matching line is too old, or in the future: none recent.
    expect(secureLayerLog(`1000\n${line('960.0')}\n`)).toBe('none');
    expect(secureLayerLog(`1000\n${line('1200.0')}\n`)).toBe('none');
    expect(secureLayerLog('1000\n998.0  1 2 I Other: nothing to see\n')).toBe('none');
    // No clock, so no line in the answer can be dated.
    expect(secureLayerLog(`not a clock\n${line('995.5')}\n`)).toBe('unchecked');
    expect(secureLayerLog('')).toBe('unchecked');
  });

  it('checks a PNG the headset encoded for a black still too, and passes a lit one unchanged', async () => {
    const black = await captureDeviceView({ hooks: hooks({ exists: adbOnly, run: darkRunner({ encoded: flatPng(32, 16, 0) }) }) });
    expect(black).toMatchObject({ ok: false, still: 'black' });
    expect(!black.ok && black.reason).toMatch(/^The still is almost entirely black \(0 of 512 pixels lit\)/u);
    const litBytes = flatPng(32, 16, 180);
    const lit = await captureDeviceView({ hooks: hooks({ exists: adbOnly, encoded: litBytes }) });
    expect(lit).toMatchObject({ ok: true, wire: 'device-png', width: 32, height: 16 });
    expect(lit.ok && lit.bytes.equals(litBytes)).toBe(true);
  });

  it('decodes every PNG row filter another encoder wrote to the exact pixels', () => {
    for (const [name, { channels, base64 }] of Object.entries(FILTERED)) {
      const decoded = decodePng(Buffer.from(base64, 'base64'));
      expect('unreadable' in decoded, name).toBe(false);
      if ('unreadable' in decoded) continue;
      expect(decoded).toMatchObject({ width: 16, height: 8, channels });
      const expected = Buffer.alloc(16 * 8 * channels);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) for (let c = 0; c < channels; c++) expected[(y * 16 + x) * channels + c] = gradient(x, y, c);
      expect(decoded.pixels.equals(expected), name).toBe(true);
    }
    // And the plain encoder's own unfiltered rows.
    const plain = decodePng(encodePng(16, 8, gradient));
    expect('unreadable' in plain ? plain.unreadable : plain.pixels.subarray(0, 8)).toEqual(Buffer.from([0, 50, 100, 255, 37, 87, 137, 255]));
  });

  it('names what it cannot decode instead of judging it', () => {
    const lit = flatPng(8, 6, 200);
    const reason = (bytes: Buffer) => { const decoded = decodePng(bytes); return 'unreadable' in decoded ? decoded.unreadable : 'decoded'; };
    expect(reason(lit)).toBe('decoded');
    // A valid header and checksums around image data that is not a zlib stream.
    expect(reason(encodePng(8, 6, () => 0, { idat: Buffer.from('this is not deflate data at all') }))).toBe('has image data that does not decompress');
    // A zlib stream one row short of what the header promises.
    expect(reason(encodePng(8, 6, () => 0, { idat: deflateSync(Buffer.alloc(5 * 33)) }))).toBe('has less image data than its header promises');
    // A row filter PNG does not define.
    expect(reason(encodePng(8, 6, () => 0, { idat: deflateSync(Buffer.from(Array.from({ length: 6 * 33 }, (_, at) => at % 33 === 0 ? 9 : 0))) })))
      .toBe('uses row filter 9, which PNG does not define');
    // One flipped byte inside the image data: the checksum catches it.
    const flipped = Buffer.from(lit); flipped[lit.indexOf('IDAT', 0, 'latin1') + 6]! ^= 0xff;
    expect(reason(flipped)).toBe('has a IDAT chunk whose checksum does not match');
    expect(reason(lit.subarray(0, lit.byteLength - 12))).toBe('is cut short');
    // The shape-only stub carries four of the eight signature bytes.
    expect(reason(png(8, 6))).toBe('is not a PNG');
    expect(reason(Buffer.from('nor a png, not at all, not one bit of it'))).toBe('is not a PNG');
    // Real PNGs in formats `screencap -p` does not write.
    expect(reason(encodePng(8, 6, () => 0, { color: 0 }))).toBe('is grayscale; only 8-bit RGB and RGBA are read here');
    expect(reason(encodePng(8, 6, () => 0, { color: 4 }))).toBe('is grayscale with alpha; only 8-bit RGB and RGBA are read here');
    expect(reason(encodePng(8, 6, (x, y, c) => c === 3 ? 255 : 0, { depth: 16 }))).toBe('is 16-bit; only 8-bit RGB and RGBA are read here');
    expect(reason(encodePng(8, 6, () => 0, { interlace: 1 }))).toBe('is interlaced; only non-interlaced PNGs are read here');
  });

  it('refuses a PNG whose chunks are out of order, doubled, unknown and critical, or an end that is not empty', () => {
    const reason = (bytes: Buffer) => { const decoded = decodePng(bytes); return 'unreadable' in decoded ? decoded.unreadable : 'decoded'; };
    const white = encodePng(1, 1, () => 255);
    const [header, image, end] = pngChunks(white) as [{ type: string; body: Buffer }, { type: string; body: Buffer }, { type: string; body: Buffer }];
    expect(reason(white)).toBe('decoded');
    const text = { type: 'tEXt', body: Buffer.from('Comment\0fixture', 'latin1') };
    // Ancillary chunks a decoder may skip are skipped, and a suggested palette before the data is allowed.
    expect(reason(pngOf([header, text, image, text, end]))).toBe('decoded');
    expect(reason(pngOf([header, { type: 'PLTE', body: Buffer.from([0, 0, 0]) }, image, end]))).toBe('decoded');
    // A critical chunk it does not know, with a correct CRC.
    expect(reason(pngOf([header, { type: 'ABCD', body: Buffer.from([1, 2, 3]) }, image, end]))).toBe('has a critical ABCD chunk this Mac does not read');
    // A second header that would change the size being checked.
    const small = pngChunks(encodePng(1, 1, () => 0))[0]!;
    const big = pngChunks(encodePng(2, 2, () => 0));
    expect(reason(pngOf([big[0]!, small, big[1]!, big[2]!]))).toBe('has a second header chunk');
    expect(reason(pngOf([big[0]!, big[1]!, small, big[2]!]))).toBe('has a second header chunk');
    // Image data split by another chunk.
    const zlib = image.body;
    const halves = [{ type: 'IDAT', body: zlib.subarray(0, 4) }, { type: 'IDAT', body: zlib.subarray(4) }];
    expect(reason(pngOf([header, ...halves, end]))).toBe('decoded');
    expect(reason(pngOf([header, halves[0]!, text, halves[1]!, end]))).toBe('has its image data split by another chunk');
    // A palette after the data, an end with a body, a header that is not first, a name that is not letters.
    expect(reason(pngOf([header, image, { type: 'PLTE', body: Buffer.from([0, 0, 0]) }, end]))).toBe('has a palette chunk out of place');
    expect(reason(pngOf([header, image, { type: 'IEND', body: Buffer.from([0]) }]))).toBe('has an end chunk that is not empty');
    expect(reason(pngOf([text, header, image, end]))).toBe('does not start with a header chunk');
    expect(reason(pngOf([header, { type: 'ab1D', body: Buffer.alloc(0) }, image, end]))).toBe('has a chunk whose name is not four letters');
  });

  it('reads a palette chunk only when its size is legal', () => {
    const reason = (bytes: Buffer) => { const decoded = decodePng(bytes); return 'unreadable' in decoded ? decoded.unreadable : 'decoded'; };
    const [header, image, end] = pngChunks(encodePng(1, 1, () => 255)) as { type: string; body: Buffer }[];
    const withPalette = (bytes: number) => pngOf([header!, { type: 'PLTE', body: Buffer.alloc(bytes, 7) }, image!, end!]);
    for (const bytes of [3, 768]) expect(reason(withPalette(bytes))).toBe('decoded');
    for (const bytes of [0, 1, 4, 771]) expect(reason(withPalette(bytes))).toBe('has a malformed palette chunk');
  });

  it('refuses a white PNG carrying an unknown critical chunk instead of handing it over', async () => {
    const [header, image, end] = pngChunks(encodePng(1, 1, () => 255));
    const strange = pngOf([header!, { type: 'ABCD', body: Buffer.from([1, 2, 3]) }, image!, end!]);
    const outcome = await captureDeviceView({ hooks: hooks({ exists: adbOnly, run: darkRunner({ encoded: strange }) }) });
    expect(outcome).toMatchObject({ ok: false, still: 'unverified' });
    expect(!outcome.ok && outcome.reason).toMatch(/^Could not verify the still: the PNG the headset encoded has a critical ABCD chunk this Mac does not read/u);
  });

  it('checks chunk CRCs with its own table, which agrees with the standard value and the plain bitwise one', () => {
    expect(pngCrc32(Buffer.from('123456789', 'latin1'))).toBe(0xcbf4_3926);
    expect(pngCrc32(Buffer.alloc(0))).toBe(0);
    const noise = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 2_654_435_761) >>> 24));
    expect(pngCrc32(noise)).toBe(crc32(noise));
    expect(pngCrc32(noise.subarray(1, 1001))).toBe(crc32(noise.subarray(1, 1001)));
  });

  it('runs on any Node 22: nothing it imports from zlib arrived after 22.0', async () => {
    const source = await readFile(new URL('../src/headset-view-device.ts', import.meta.url), 'utf8');
    const named = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:zlib'/gu)].flatMap(match => match[1]!.split(',').map(name => name.trim()).filter(Boolean));
    expect(named.sort()).toEqual(['gunzipSync', 'inflateSync']);
    // `zlib.crc32` arrived in 22.2; the module calls its own table CRC instead.
    expect(source).not.toMatch(/\bcrc32\s*\(/u);
    // Nor does anything else here, tests included: a missing named export stops the whole file loading.
    const { readdir } = await import('node:fs/promises');
    const importers: string[] = [];
    for (const folder of ['../src/', '../scripts/', './']) {
      const directory = new URL(folder, import.meta.url);
      for (const name of await readdir(directory)) {
        if (!/\.(?:ts|mts|mjs)$/u.test(name)) continue;
        const text = await readFile(new URL(name, directory), 'utf8');
        if ([...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(?:node:)?zlib'/gu)].some(match => /\bcrc32\b/u.test(match[1]!))) importers.push(`${folder}${name}`);
      }
    }
    expect(importers).toEqual([]);
  });

  it('refuses a headset PNG it cannot verify, in words that never call it black', async () => {
    const run = (encoded: Buffer) => captureDeviceView({ hooks: hooks({ exists: adbOnly, run: darkRunner({ encoded }) }) });
    const corrupt = await run(encodePng(8, 6, () => 200, { idat: Buffer.from('this is not deflate data at all') }));
    expect(corrupt).toMatchObject({ ok: false, still: 'unverified' });
    expect(!corrupt.ok && corrupt.reason).toBe('Could not verify the still: the PNG the headset encoded has image data that does not decompress, '
      + 'so it was not handed over as the wearer\'s view. Nothing was saved. With ffmpeg on this Mac, or STEREOFOLD_FFMPEG_BIN naming it, '
      + 'the still is read from raw pixels instead. Ask again. While the page is in immersion, source "page" reads the molecule from the page itself.');
    // A valid all-black grayscale PNG is unverified, not black and not a success.
    const gray = await run(encodePng(8, 6, () => 0, { color: 0 }));
    expect(gray).toMatchObject({ ok: false, still: 'unverified' });
    expect(!gray.ok && gray.reason).toMatch(/^Could not verify the still: the PNG the headset encoded is grayscale/u);
    for (const outcome of [corrupt, gray]) expect(!outcome.ok && outcome.reason).not.toMatch(/black/u);

    // When ffmpeg is here but failed, the reason says why the headset encoded it.
    const failed = await captureDeviceView({ hooks: hooks({ run: async (file, args) => {
      if (file.endsWith('ffmpeg')) throw Error('ffmpeg exited 1: broken pipe');
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
      if (args.includes('-p')) return { stdout: encodePng(8, 6, () => 200, { color: 0 }), stderr: '' };
      return { stdout: gzipSync(screencap(8, 6)), stderr: '' };
    } }) });
    expect(!failed.ok && failed.reason).toMatch(/The headset encoded it because ffmpeg failed: ffmpeg exited 1: broken pipe\./u);
  });

  it('hands a raw frame in an unknown pixel format to the headset encoder, pulling it only once', async () => {
    const seams = hooks({ frame: screencap(8, 6, { format: 43 }), encoded: flatPng(8, 6, 200) });
    const outcome = await captureDeviceView({ hooks: seams });
    expect(outcome).toMatchObject({ ok: true, wire: 'device-png' });
    expect(seams.calls.map(call => call.args.at(-1))).toEqual(['devices', 'screencap | gzip -1', '-p']);
    // And when that PNG cannot be read either, the reason says both.
    const unread = await captureDeviceView({ hooks: hooks({ frame: screencap(8, 6, { format: 43 }), encoded: encodePng(8, 6, () => 0, { interlace: 1 }) }) });
    expect(!unread.ok && unread.reason).toMatch(/interlaced.*because the headset sent raw pixels in format 43, which this Mac does not read\./u);
  });

  it('sends a frame both headers fit to the headset encoder, pulling it only once, and names why when that fails too', async () => {
    const whole = screencap(8, 6), short = whole.subarray(0, whole.byteLength - 4);
    const seams = hooks({ frame: short, encoded: flatPng(8, 6, 200) });
    const outcome = await captureDeviceView({ hooks: seams });
    expect(outcome).toMatchObject({ ok: true, wire: 'device-png' });
    expect(seams.calls.map(call => call.args.at(-1))).toEqual(['devices', 'screencap | gzip -1', '-p']);
    const unread = await captureDeviceView({ hooks: hooks({ frame: short, encoded: encodePng(8, 6, () => 0, { interlace: 1 }) }) });
    expect(unread).toMatchObject({ ok: false, still: 'unverified' });
    expect(!unread.ok && unread.reason).toContain('The headset encoded it because the headset\'s raw frame fits both screencap headers, '
      + 'whole after the 12-byte one or four bytes short after the 16-byte one, so this Mac could not tell where its pixels start.');
    // The same over a plain transfer, from a headset without gzip.
    const plain = await captureDeviceView({ hooks: hooks({ gzip: false, frame: short, encoded: encodePng(8, 6, () => 0, { interlace: 1 }) }) });
    expect(!plain.ok && plain.reason).toMatch(/because the headset's raw frame fits both screencap headers/u);
  });

  it('checks the headset PNG after an ffmpeg failure too', async () => {
    const outcome = await captureDeviceView({ hooks: hooks({ run: async (file, args) => {
      if (file.endsWith('ffmpeg')) throw Error('ffmpeg exited 1');
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
      if (args.includes('dumpsys')) return { stdout: 'mWakefulness=Awake\n', stderr: '' };
      if (args.join(' ').includes('logcat')) return { stdout: '1000\n', stderr: '' };
      if (args.includes('-p')) return { stdout: flatPng(8, 6, 0), stderr: '' };
      // A lit raw frame: ffmpeg is what fails, so the headset's PNG is all that is left.
      return { stdout: gzipSync(screencap(8, 6)), stderr: '' };
    } }) });
    expect(outcome).toMatchObject({ ok: false, still: 'black' });
    // The refusal keeps why the headset was asked to encode it, as an unreadable one does.
    expect(!outcome.ok && outcome.reason).toMatch(/^The still is almost entirely black \(0 of 48 pixels lit\), so it was not handed over as the wearer's view\. Nothing was saved\. The headset encoded it because ffmpeg failed: ffmpeg exited 1\. The headset reports it is Awake/u);
  });

  it('refuses an encode past the size ceiling instead of handing it back', async () => {
    const huge = Buffer.concat([png(8, 6), Buffer.alloc(17 * 1024 * 1024)]);
    const outcome = await captureDeviceView({ hooks: hooks({ exists: async (path: string) => path === '/opt/tools/adb', encoded: huge }) });
    expect(!outcome.ok && outcome.reason).toMatch(/past the limit/);
  });

  it('never sends the headset an input event or writes to its storage', async () => {
    const seams = hooks();
    await captureDeviceView({ hooks: seams });
    for (const call of seams.calls) {
      const line = call.args.join(' ');
      expect(line).not.toMatch(/\binput\b|keyevent|\bpull\b|\bpush\b|\bam start|\/sdcard/u);
    }
  });

  // The capture runs in the MCP child, whose default environment keeps only
  // HOME, LOGNAME, PATH, SHELL, TERM and USER. Every name this module looks an
  // executable up under has to be in the launcher's allowlist, or it is a
  // setting someone can type that nothing ever reads. The
  // ffmpeg keys are the easy ones to miss, because the transcriber looks under
  // a different name for the same tool.
  it('names every executable key the launcher has to carry across', async () => {
    const { readFile } = await import('node:fs/promises');
    const host = await readFile(new URL('../scripts/serve-inspection.ts', import.meta.url), 'utf8');
    for (const key of [...ADB_ENV_KEYS, ...ADB_SERIAL_ENV_KEYS, ...FFMPEG_ENV_KEYS]) {
      expect(host, `${key} is read by the capture but not forwarded to the MCP child`).toContain(key);
    }
  });
});

describe('the ffmpeg conversion, read in full before it is handed over', () => {
  /** A whole lit native frame, so the raw pixels pass and only the conversion is in question. */
  const LIT = screencap(3664, 1920);
  const asked = { width: 1600, height: 838 };
  const lastArgs = (seams: { calls: Call[] }) => seams.calls.map(call => call.args.at(-1));
  /** A still whose conversion is refused, with an unreadable headset PNG behind it, so the reason says why. */
  const reasonFor = async (converted: Buffer) => {
    const outcome = await captureDeviceView({ hooks: hooks({ frame: LIT, converted, encoded: encodePng(8, 6, () => 0, { interlace: 1 }) }) });
    expect(outcome).toMatchObject({ ok: false, still: 'unverified' });
    return !outcome.ok ? outcome.reason : '';
  };

  it('hands over a conversion of the asked size whose every pixel was read', async () => {
    const seams = hooks({ frame: LIT });
    const outcome = await captureDeviceView({ hooks: seams });
    expect(outcome).toMatchObject({ ok: true, wire: 'gzip', ...asked });
    expect(outcome.ok && outcome.note).toBeUndefined();
  });

  it('refuses a conversion of the wrong size and lets the headset encode the still', async () => {
    const seams = hooks({ frame: LIT, converted: flatPng(8, 6, 200), encoded: flatPng(32, 16, 180) });
    const outcome = await captureDeviceView({ hooks: seams });
    expect(outcome).toMatchObject({ ok: true, wire: 'device-png', width: 32, height: 16 });
    expect(lastArgs(seams)).toEqual(['devices', 'screencap | gzip -1', 'pipe:1', '-p']);
    expect(await reasonFor(flatPng(8, 6, 200))).toMatch(/The headset encoded it because ffmpeg's conversion is 8x6 where 1600x838 was asked for\./u);
    // One row short of the asked height is the wrong size too.
    expect(await reasonFor(rgbaPng(1600, 837, Buffer.alloc(1600 * 837 * 4, 200)))).toMatch(/ffmpeg's conversion is 1600x837 where 1600x838 was asked for\./u);
  });

  it('refuses a conversion cut short, damaged, or not a PNG at all', async () => {
    const real = rgbaPng(1600, 838, Buffer.alloc(1600 * 838 * 4, 200));
    // The header still names the asked size, which was all that used to be checked.
    expect(pngShape(real.subarray(0, real.byteLength - 12))).toEqual(asked);
    expect(await reasonFor(real.subarray(0, real.byteLength - 12))).toMatch(/because ffmpeg's conversion is cut short\./u);
    const damaged = Buffer.from(real); damaged[real.indexOf('IDAT', 0, 'latin1') + 40]! ^= 0xff;
    expect(await reasonFor(damaged)).toMatch(/because ffmpeg's conversion has a IDAT chunk whose checksum does not match\./u);
    expect(await reasonFor(png(1600, 838))).toMatch(/because ffmpeg's conversion is not a PNG\./u);
  });

  it('refuses a conversion that lost the picture the raw frame had', async () => {
    const black = rgbaPng(1600, 838, Buffer.alloc(1600 * 838 * 4, 0));
    const seams = hooks({ frame: LIT, converted: black, encoded: flatPng(32, 16, 180) });
    expect(await captureDeviceView({ hooks: seams })).toMatchObject({ ok: true, wire: 'device-png' });
    expect(await reasonFor(black)).toMatch(/because ffmpeg's conversion came out almost entirely black \(0 of 1,340,800 pixels lit\) from a raw frame that was not\./u);
    // When the headset's own PNG is black too, the refusal still says the raw frame was not.
    const both = await captureDeviceView({ hooks: hooks({ run: darkRunner({ frame: LIT, encoded: flatPng(32, 16, 0), converted: black }) }) });
    expect(both).toMatchObject({ ok: false, still: 'black' });
    expect(!both.ok && both.reason).toContain('(0 of 512 pixels lit), so it was not handed over as the wearer\'s view. Nothing was saved. The headset '
      + 'encoded it because ffmpeg\'s conversion came out almost entirely black (0 of 1,340,800 pixels lit) from a raw frame that was not.');
  });

  it('notes a conversion that came out dim from a lit frame, with its own count', async () => {
    const body = Buffer.alloc(1600 * 838 * 4, 0);
    for (let y = 400; y < 430; y++) body.fill(220, (y * 1600 + 800) * 4, (y * 1600 + 830) * 4);
    // A 30x30 mark on black: the scaled still is lit over 0.067%, though the native frame is lit everywhere.
    const dim = await captureDeviceView({ hooks: hooks({ frame: LIT, converted: rgbaPng(1600, 838, body) }) });
    expect(dim).toMatchObject({ ok: true, wire: 'gzip', ...asked });
    expect(dim.ok && dim.note).toMatch(/^Almost all of this still is black: 0\.067% of its pixels are lit \(900 of 1,340,800\)\./u);
  });
});

describe('judging a still by every pixel', () => {
  const judge = (frame: Buffer) => { const light = frameLight(decodeScreencap(frame)!); return { ...light, verdict: judgeStill(light) }; };

  it('uses the thresholds it documents', () => {
    expect(DEVICE_LIT_FLOOR).toBe(4);
    expect(DEVICE_BLACK_LIT_SHARE).toBe(0.0001);
    expect(DEVICE_SCENE_LIT_SHARE).toBe(0.01);
  });

  it('counts a thin stripe that a sparse sample steps over', () => {
    // Columns 10 to 19 of 1600: an 80-pixel stride from 0 never lands there.
    expect(judge(screencap(1600, 1000, { level: 0, paint: rect(10, 0, 10, 1000) }))).toEqual({ pixels: 1_600_000, lit: 10_000, verdict: 'dim' });
    // Every column of a one-pixel stripe, wherever it sits.
    for (const x of [0, 1, 79, 80, 1599]) expect(judge(screencap(1600, 1000, { level: 0, paint: rect(x, 0, 1, 1000) })).lit).toBe(1000);
  });

  it('is not fooled by a handful of bright pixels on a black native frame', () => {
    const nine = nativeFrame(body => { for (let k = 0; k < 9; k++) body.fill(255, k * 351 * 4, k * 351 * 4 + 4); });
    expect(judge(nine)).toEqual({ pixels: 7_034_880, lit: 9, verdict: 'black' });
    expect(judge(nativeFrame())).toEqual({ pixels: 7_034_880, lit: 0, verdict: 'black' });
  });

  it('does not decide a lone 64x64 mark: it is handed over with a note', () => {
    expect(judge(nativeFrame(rect(1800, 900, 64, 64)))).toEqual({ pixels: 7_034_880, lit: 4096, verdict: 'dim' });
  });

  it('counts a near-black but textured scene as drawn, and a dark molecule on black as a scene', () => {
    // RGB 1 to 5 everywhere: no pixel is zero, so it is not an empty panel.
    const textured = screencap(64, 64, { level: 0, paint: body => {
      for (let p = 0; p < 64 * 64; p++) for (let c = 0; c < 3; c++) body[p * 4 + c] = 1 + ((p * 7 + c * 3) % 5);
    } });
    expect(judge(textured)).toEqual({ pixels: 4096, lit: 4096, verdict: 'lit' });
    // Levels 1 to 3 everywhere stay below the floor: black to the eye and to the count.
    expect(judge(screencap(64, 64, { level: 0, paint: body => { for (let p = 0; p < 64 * 64 * 4; p++) body[p] = 1 + (p % 3); } })).verdict).toBe('black');
    // A dim structure, levels 10 to 40, over five percent of a black panel.
    const molecule = screencap(400, 200, { level: 0, paint: body => {
      for (let y = 80; y < 120; y++) for (let x = 180; x < 280; x++) for (let c = 0; c < 3; c++) body[(y * 400 + x) * 4 + c] = 10 + ((x + y + c * 7) % 31);
    } });
    expect(judge(molecule)).toMatchObject({ lit: 4000, verdict: 'lit' });
  });

  it('reads the same count whatever the channel order, alignment or alpha', () => {
    const rgba = screencap(32, 8, { level: 0, paint: rect(3, 2, 5, 4) });
    const body = rgba.subarray(16);
    expect(countLitPixels(body, 256, 4)).toEqual({ pixels: 256, lit: 20 });
    // Unaligned, so the byte loop runs instead of the word loop.
    const shifted = Buffer.alloc(body.byteLength + 1); body.copy(shifted, 1);
    expect(countLitPixels(shifted.subarray(1), 256, 4)).toEqual({ pixels: 256, lit: 20 });
    // A floor that is not a power of two takes the byte loop too, and agrees.
    expect(countLitPixels(body, 256, 4, 5)).toEqual({ pixels: 256, lit: 20 });
    // Alpha alone never lights a pixel; blue alone does.
    const alphaOnly = Buffer.alloc(16); alphaOnly[3] = 255; alphaOnly[7] = 255;
    expect(countLitPixels(alphaOnly, 4, 4)).toEqual({ pixels: 4, lit: 0 });
    const blueOnly = Buffer.from([0, 0, 4, 0, 0, 0, 3, 255]);
    expect(countLitPixels(blueOnly, 2, 4)).toEqual({ pixels: 2, lit: 1 });
    expect(countLitPixels(Buffer.from([0, 0, 4, 0, 0, 3]), 2, 3)).toEqual({ pixels: 2, lit: 1 });
    expect(frameLight(decodeScreencap(screencap(4, 2, { format: 5, level: 0, paint: rect(0, 0, 1, 1) }))!)).toEqual({ pixels: 8, lit: 1 });
  });

  it('costs a few milliseconds on a whole native panel', () => {
    const frame = decodeScreencap(nativeFrame())!;
    frameLight(frame);
    const started = performance.now();
    frameLight(frame);
    // Measured at about 6 ms; the bound only catches a pass gone quadratic or per-call allocating.
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('the device still, judged at native size', () => {
  it('refuses a native frame with nine bright pixels as black', async () => {
    const nine = nativeFrame(body => { for (let k = 0; k < 9; k++) body.fill(255, k * 351 * 4, k * 351 * 4 + 4); });
    const seams = hooks({ run: darkRunner({ frame: nine }) });
    const outcome = await captureDeviceView({ hooks: seams });
    expect(outcome).toMatchObject({ ok: false, still: 'black' });
    expect(!outcome.ok && outcome.reason).toMatch(/^The still is almost entirely black \(9 of 7,034,880 pixels lit\)/u);
  });

  it('hands over a native frame with one 64x64 mark, saying what the pixels cannot tell', async () => {
    const calls: string[] = [];
    const quiet = await captureDeviceView({ hooks: hooks({ run: darkRunner({ frame: nativeFrame(rect(1800, 900, 64, 64)), calls }) }) });
    expect(quiet).toMatchObject({ ok: true, wire: 'gzip' });
    expect(quiet.ok && quiet.note).toBe('Almost all of this still is black: 0.058% of its pixels are lit (4,096 of 7,034,880). '
      + 'The pixels cannot tell a scene that is dark or still loading from a blocked capture that kept a small mark. '
      + 'If the wearer should be seeing more than this, ask again. While the page is in immersion, source "page" reads the molecule from the page itself.');
    // The headset is asked about itself for the note, and nothing is written to it.
    expect(calls.some(call => call.includes('logcat'))).toBe(true);
    expect(calls.join('\n')).not.toMatch(/force-stop|\binput\b|keyevent/u);
    // With a recent log line the note says what it suggests, and still hands the still over.
    const logged = await captureDeviceView({ hooks: hooks({ run: darkRunner({ frame: nativeFrame(rect(1800, 900, 64, 64)), log: secureLog(3) }) }) });
    expect(logged).toMatchObject({ ok: true });
    expect(logged.ok && logged.note).toMatch(/A headset log line from 3 s ago says "secure layer detected", which suggests the system blocked this capture\./u);
  });

  it('hands over the stripe the old sample missed, and a textured near-black frame without a note', async () => {
    const stripe = await captureDeviceView({ hooks: hooks({ run: darkRunner({ frame: screencap(1600, 1000, { level: 0, paint: rect(10, 0, 10, 1000) }) }) }) });
    expect(stripe).toMatchObject({ ok: true });
    expect(stripe.ok && stripe.note).toMatch(/^Almost all of this still is black: 0\.63% of its pixels are lit \(10,000 of 1,600,000\)\./u);
    const textured = screencap(64, 64, { level: 0, paint: body => {
      for (let p = 0; p < 64 * 64; p++) for (let c = 0; c < 3; c++) body[p * 4 + c] = 1 + ((p * 7 + c * 3) % 5);
    } });
    const dim = await captureDeviceView({ hooks: hooks({ run: darkRunner({ frame: textured }) }) });
    expect(dim).toMatchObject({ ok: true });
    expect(dim.ok && dim.note).toBeUndefined();
  });

  it('applies the same judgement to the headset PNG when this Mac has no ffmpeg', async () => {
    const mark = encodePng(400, 300, (x, y, c) => c === 3 ? 255 : x >= 10 && x < 13 && y >= 10 && y < 13 ? 255 : 0);
    const handful = await captureDeviceView({ hooks: hooks({ exists: adbOnly, run: darkRunner({ encoded: mark }) }) });
    expect(handful).toMatchObject({ ok: false, still: 'black' });
    expect(!handful.ok && handful.reason).toMatch(/\(9 of 120,000 pixels lit\)/u);
    const stripe = encodePng(400, 300, (x, y, c) => c === 3 ? 255 : x >= 10 && x < 12 ? 255 : 0);
    const dim = await captureDeviceView({ hooks: hooks({ exists: adbOnly, run: darkRunner({ encoded: stripe }) }) });
    expect(dim).toMatchObject({ ok: true, wire: 'device-png', width: 400, height: 300 });
    expect(dim.ok && dim.note).toMatch(/0\.5% of its pixels are lit \(600 of 120,000\)/u);
  });

  it('builds each sentence from what it was given', () => {
    const light = { pixels: 100, lit: 0 };
    expect(blackStillReason(light, { power: 'Dozing', log: 'none' })).toMatch(/reports its display Dozing/u);
    expect(dimStillNote({ pixels: 100_000, lit: 500 }, { power: 'Asleep', log: 0 }))
      .toMatch(/0\.5% .*from 0 s ago says "secure layer detected", which suggests .* The headset reports its display Asleep\./u);
    expect(unverifiedStillReason('is cut short', { ffmpeg: true })).toBe('Could not verify the still: the PNG the headset encoded is cut short, '
      + 'so it was not handed over as the wearer\'s view. Nothing was saved. Ask again. While the page is in immersion, source "page" reads the molecule from the page itself.');
  });
});

/**
 * The device lines below are verbatim logcat output from a headset whose whole
 * run was dimmed every ten seconds by Android's "com.oculus.browser isn't
 * responding" dialog, which only a press of "Close app" inside the headset
 * ended. Nothing here touches a device.
 */
const ANR_DECLARED = '09-10 22:39:21.239  1535  7590 E ActivityManager: ANR in com.oculus.browser (com.oculus.browser/.BrowserActivity)';
const ANR_DIALOG_RAISED = '09-10 22:39:34.688  1535  1554 D CoreBackPreview: Window{8a99117 u0 Application Not Responding: com.oculus.browser}: Setting back callback OnBackInvokedCallbackInfo{mCallback=android.window.WindowOnBackInvokedDispatcher$OnBackInvokedCallbackWrapper@b57a170, mPriority=0, mIsAnimationCallback=false}';
const ANR_DIALOG_TORN_DOWN = '09-10 22:39:37.710  1535  1554 D CoreBackPreview: Window{8a99117 u0 Application Not Responding: com.oculus.browser}: Setting back callback null';
const WEARER_PRESSED_CLOSE = '09-10 22:41:07.113  1535  1573 I ActivityManager: Killing 7799:com.oculus.browser/u0a43 (adj 0): user request after error';
const WINDOW_DUMP_HIT = '  Window #16 Window{8a99117 u0 Application Not Responding: com.oculus.browser}:';

/** One probe answer, in the three sections the device writes them. */
const probe = (clock: string, windows: string[], log: string[]) =>
  [`${clock}\n`, `${windows.join('\n')}\n`, `${log.join('\n')}\n`].join(BROWSER_HEALTH_SECTION);

describe('whether Quest Browser is answering', () => {
  it('calls a dialog in the window dump an ANR, and names when Android declared it', () => {
    const health = parseBrowserHealth(probe('09-10 22:39:35', [WINDOW_DUMP_HIT], [ANR_DECLARED, ANR_DIALOG_RAISED]));
    expect(health.browser).toBe('anr');
    // The declaration is written once; the dialog line repeats on every raise,
    // so "since" is the declaration rather than the newest noise.
    expect(health.since).toBe('09-10 22:39:21');
    expect(health.evidence[0]).toContain('Application Not Responding: com.oculus.browser');
  });

  it('still reports an ANR in the ten-second gap where the window dump is clean', () => {
    // The dialog was torn down three seconds ago and will be raised again in
    // seven. A dump alone would call this healthy and the wearer would keep
    // being dimmed with nobody able to say why.
    const health = parseBrowserHealth(probe('09-10 22:39:40', [], [ANR_DECLARED, ANR_DIALOG_RAISED, ANR_DIALOG_TORN_DOWN]));
    expect(health).toMatchObject({ browser: 'anr', since: '09-10 22:39:21' });
  });

  it('calls it healthy once the process has been killed, however loud the log before it', () => {
    const closed = parseBrowserHealth(probe('09-10 22:41:10', [], [ANR_DECLARED, ANR_DIALOG_RAISED, WEARER_PRESSED_CLOSE]));
    expect(closed.browser).toBe('ok');
    // And the same for this Mac's own recovery, whose kill reads differently.
    // Without this a health read taken right after a recovery would report the
    // ANR it had just cleared.
    const recovered = parseBrowserHealth(probe('09-10 22:41:10', [],
      [ANR_DECLARED, ANR_DIALOG_RAISED, '09-10 22:41:09.004  1535  1573 I ActivityManager: Force stopping com.oculus.browser appid=10043 user=0: from pid 0']));
    expect(recovered.browser).toBe('ok');

    // The trap the real log set: the dialog's own tear-down line is written two
    // milliseconds *after* the kill that ended the loop, so reading it as a
    // sign of a live dialog reported an ANR the wearer had already closed.
    const replayed = parseBrowserHealth(probe('09-10 22:41:30', [], [ANR_DECLARED, ANR_DIALOG_RAISED,
      '09-10 22:41:04.977  1535  1554 D CoreBackPreview: Window{63cef1 u0 Application Not Responding: com.oculus.browser}: Setting back callback OnBackInvokedCallbackInfo{mCallback=x}',
      WEARER_PRESSED_CLOSE,
      '09-10 22:41:07.115  1535  1554 D CoreBackPreview: Window{63cef1 u0 Application Not Responding: com.oculus.browser}: Setting back callback null']));
    expect(replayed.browser).toBe('ok');
  });

  it('lets an old ANR go, and refuses to read an answer it does not understand', () => {
    expect(parseBrowserHealth(probe('09-10 22:45:00', [], [ANR_DECLARED, ANR_DIALOG_RAISED])).browser).toBe('ok');
    expect(parseBrowserHealth('').browser).toBe('unknown');
    expect(parseBrowserHealth('some shell error')).toMatchObject({ browser: 'unknown', evidence: [] });
  });

  it('reads the headset clock and refuses a line it cannot date', () => {
    expect(deviceClockSeconds('09-10 22:39:21')).toBe(deviceClockSeconds('09-10 22:39:20')! + 1);
    expect(deviceClockSeconds('not a time')).toBeUndefined();
  });

  it('keeps addresses and pairing codes out of everything it quotes', () => {
    const dirty = '09-10 22:39:21.239 I ActivityManager: ANR in com.oculus.browser https://headset.test:8443/#pair=12345678';
    expect(sanitizeEvidence(dirty)).not.toMatch(/headset\.test|12345678/u);
    expect(sanitizeEvidence(dirty)).toContain('<address>');
    expect(sanitizeEvidence('x'.repeat(400))).toHaveLength(200);
  });

  it('asks in one round trip, filters on the device, and writes nothing', () => {
    const args = browserHealthArguments('1WMH').join(' ');
    expect(args).toContain('dumpsys window windows | grep');
    expect(args).toContain('logcat -d -t 400');
    expect(args).toContain(QUEST_BROWSER_PACKAGE);
    // Every section is filtered before it crosses the cable: a whole window
    // dump is megabytes and the wearer is waiting.
    expect(args.match(/grep/gu)?.length).toBeGreaterThanOrEqual(3);
    // Nothing in the probe changes the headset.
    expect(args).not.toMatch(/force-stop|am start|\binput\b|keyevent|screencap/u);
  });

  it('reports the wedged browser over a real runner, and says so plainly without adb', async () => {
    const asked: string[][] = [];
    const wedged = await headsetBrowserHealth({ hooks: hooks({
      run: async (file, args) => {
        asked.push([file, ...args]);
        if (args[0] === 'devices') return { stdout: 'List of devices attached\nFAKEQUEST00001\tdevice\n', stderr: '' };
        return { stdout: probe('09-10 22:39:35', [WINDOW_DUMP_HIT], [ANR_DECLARED]), stderr: '' };
      },
    }) });
    expect(wedged).toMatchObject({ browser: 'anr', since: '09-10 22:39:21' });
    expect(asked[1]![1]).toBe('-s');
    expect(asked[1]![2]).toBe('FAKEQUEST00001');

    const noAdb = await headsetBrowserHealth({ hooks: hooks({ exists: async () => false }) });
    expect(noAdb.browser).toBe('unknown');
    expect(noAdb.reason).toMatch(/No adb was found/u);
    const noHeadset = await headsetBrowserHealth({ hooks: hooks({ devices: 'List of devices attached\n' }) });
    expect(noHeadset).toMatchObject({ browser: 'unknown' });
    expect(noHeadset.reason).toMatch(/no authorized headset/u);
    const broken = await headsetBrowserHealth({ hooks: hooks({ run: async (file, args) => {
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nFAKEQUEST00001\tdevice\n', stderr: '' };
      throw Error('adb: device offline');
    } }) });
    expect(broken).toMatchObject({ browser: 'unknown' });
    expect(broken.reason).toMatch(/device offline/u);
  });

  it('stops the browser with one command and nothing else, and refuses without adb', async () => {
    const asked: string[][] = [];
    const seams = hooks({ run: async (file, args) => {
      asked.push([file, ...args]);
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nFAKEQUEST00001\tdevice\n', stderr: '' };
      return { stdout: '', stderr: '' };
    } });
    expect(await forceStopHeadsetBrowser({ hooks: seams })).toEqual({ ok: true });
    expect(asked[1]).toEqual(['/opt/tools/adb', '-s', 'FAKEQUEST00001', 'shell', 'am', 'force-stop', 'com.oculus.browser']);
    expect(asked).toHaveLength(2);

    const refused = await forceStopHeadsetBrowser({ hooks: hooks({ exists: async () => false }) });
    expect(refused).toMatchObject({ ok: false });

    // `am` reports a refusal on stdout with exit status zero, so the words have
    // to be read as well as the status.
    const denied = await forceStopHeadsetBrowser({ hooks: hooks({ run: async (file, args) => {
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nFAKEQUEST00001\tdevice\n', stderr: '' };
      return { stdout: 'Error: java.lang.SecurityException', stderr: '' };
    } }) });
    expect(denied).toMatchObject({ ok: false });
  });
});
