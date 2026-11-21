import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';

/**
 * The second way to see what the wearer sees, over a debugging cable.
 *
 * The in-page capture reads one eye out of the page's own WebGL context, so it
 * shows the molecule and nothing else, and it needs the page to be in
 * immersion. `adb exec-out screencap` reads the headset's composited display
 * buffer instead: both eyes, passthrough, system UI, the spatial menu, exactly
 * what is on the panels. It is silent, it sends no input, it writes nothing to
 * the headset, and it measures as free to the
 * wearer, 72/72 fps with no stale frames across three back-to-back captures.
 *
 * It is deliberately not Meta's `metavr capture screenshot --method metacam`.
 * That path fires the system screenshot service, so the wearer gets a shutter
 * sound and a "Screenshot saved" toast mid-demo, a JPEG lands in the wearer's
 * gallery, the frame is the app layer alone with passthrough missing, and when
 * its poll for a fresh gallery file loses the race it writes a zero-byte file
 * and still exits 0. All four were reproduced on hardware.
 *
 * The Quest 2 spends about four and a half seconds encoding a 3664x1920 PNG on
 * device, so the frame comes back as raw RGBA and this Mac encodes it. `gzip -1`
 * on the device shrinks 28 MB to about 8 MB and wins on both links: roughly one
 * second over USB and four and a half over Wi-Fi.
 *
 * This module runs `adb` and `ffmpeg` and nothing else. It never installs
 * anything, never touches the headset's storage, and never writes a file at
 * all: the PNG is piped back through memory. Both executables are looked up
 * rather than assumed, and a Mac without either, or with no headset attached,
 * gets a sentence saying so.
 */

/** Width the frame is scaled to when the caller names none. Readable menu text. */
export const DEVICE_CAPTURE_DEFAULT_SIZE = 1_600;
/** Native Quest 2 panel width is 3664; this is the ceiling a caller may ask for. */
export const DEVICE_CAPTURE_MAX_SIZE = 2_048;
/** Wi-Fi adb carries the frame in about four and a half seconds. */
export const DEVICE_CAPTURE_TIMEOUT_MS = 25_000;
export const DEVICE_ADB_TIMEOUT_MS = 5_000;
export const DEVICE_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
/** One 3664x1920 RGBA frame is 28 MB uncompressed; this leaves room for a bigger panel. */
export const DEVICE_RAW_MAX_BYTES = 96 * 1024 * 1024;
/** Names an `adb` outside `PATH`. The prefixed names win over the conventional one. */
export const ADB_ENV_KEYS = Object.freeze(['STEREOFOLD_ADB_BIN', 'STEREOFOLD_ADB', 'ADB']);
/** Names one headset when several are attached. */
export const ADB_SERIAL_ENV_KEYS = Object.freeze(['STEREOFOLD_ADB_SERIAL', 'ANDROID_SERIAL', 'STEREOFOLD_QUEST_SERIAL']);
/**
 * Names an `ffmpeg` outside `PATH`.
 *
 * `STEREOFOLD_FFMPEG_BIN` is first because it is the only
 * one of the three the product documents (docs/install.md, the Claude Code
 * kit) and the only one the transcriber and the reply encoders read. A Mac
 * that keeps ffmpeg off the host's `PATH` — the stripped-`PATH` daemon case —
 * used to get a working voice loop and a silently degraded capture from the
 * same correct setting: no raw pull, no scale, and no asleep-headset check, so
 * a doffed headset came back as a black picture rather than the sentence.
 */
export const FFMPEG_ENV_KEYS = Object.freeze(['STEREOFOLD_FFMPEG_BIN', 'STEREOFOLD_FFMPEG', 'FFMPEG']);
/**
 * A pixel is lit when its brightest channel reaches this, out of 255.
 *
 * A capture the headset blocked and a display that is asleep both come back
 * as exact zeros: a real blocked 3664x1920 still had no channel above 0 in any
 * pixel. Levels 1 to 3 are left as black so rounding or dither in an encoder
 * cannot make an empty panel look drawn; anything from 4 up counts as drawn,
 * however dark, so a dim scene is never mistaken for an empty one.
 */
export const DEVICE_LIT_FLOOR = 4;
/**
 * Below this share of lit pixels the still is refused as black.
 *
 * One in ten thousand is about 700 pixels of a 3664x1920 panel, a patch
 * 26 pixels square: room for a status dot or stray noise, too little for a
 * scene. Every pixel is counted, so no stripe can fall between samples.
 */
export const DEVICE_BLACK_LIT_SHARE = 0.000_1;
/**
 * Below this share of lit pixels, and at or above the last, the still is handed
 * over with a note.
 *
 * A real scene that is still loading and a blocked capture carrying a small
 * mark can be the same pixels, so a still lit over less than one percent of
 * the panel is not refused on the pixels alone; the note says what is
 * uncertain and what the headset's log suggests.
 */
export const DEVICE_SCENE_LIT_SHARE = 0.01;
/**
 * What the headset logs when its capture service blocks a still.
 *
 * The Quest's capture service hands back the whole display as black when it
 * judges a composed layer secure, so a headset that is awake and drawing the
 * scene can still return a black still. Some shell panels are always marked
 * secure and normally do not cause it; it has been seen to persist until the
 * system shell and the camera app were restarted. The line names neither the
 * capture nor its caller, so it is read as a suggestion, never as proof.
 */
export const SECURE_LAYER_LOG = /secure layer detected/iu;
/** Recent enough, in the headset's own seconds, to be worth mentioning beside the capture just made. */
export const SECURE_LAYER_RECENT_SECONDS = 30;
/**
 * Log lines read for that line.
 *
 * Usually far more than half a minute of log, but not on every headset: one
 * logging faster can push the line out, and the reason then does not mention it.
 */
export const SECURE_LAYER_LOG_LINES = 300;

const PNG_MAGIC = 0x89504e47;
/** `screencap`'s format word. 1 is RGBA_8888, which is what a Quest 2 reports. */
const PIXEL_FORMATS: Readonly<Record<number, 'rgba' | 'rgb0' | 'bgra'>> = Object.freeze({ 1: 'rgba', 2: 'rgb0', 5: 'bgra' });

export type DeviceRunOptions = {
  timeout: number;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  /** Bytes to write to the child's stdin before closing it. */
  input?: Buffer;
};

export type DeviceRunner = (file: string, args: readonly string[], options: DeviceRunOptions)
  => Promise<{ stdout: string | Buffer; stderr: string }>;

export type DeviceCaptureHooks = {
  run: DeviceRunner;
  exists?: (path: string) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

export type DeviceCaptureOutcome =
  | { ok: true; bytes: Buffer; mimeType: 'image/png'; width: number; height: number; ms: number; serial: string;
      /** How the frame came off the device, for the sentence the agent reads. */
      wire: 'gzip' | 'raw' | 'device-png';
      /** Only for a still lit over less than one percent: what the pixels cannot settle. */
      note?: string }
  | { ok: false; reason: string;
      /** Set when a still arrived but was not handed over: black, or not something this Mac could check. */
      still?: 'black' | 'unverified' };

/** The Quest Browser package, which is the one process this module ever names. */
export const QUEST_BROWSER_PACKAGE = 'com.oculus.browser';
/** The health probe is three short shell commands, so it does not need the capture's budget. */
export const BROWSER_HEALTH_TIMEOUT_MS = 10_000;
export const BROWSER_HEALTH_MAX_BYTES = 4 * 1024 * 1024;
/** How many recent logcat lines the probe reads. 400 covers about a minute of a busy headset. */
export const BROWSER_HEALTH_LOG_LINES = 400;
/**
 * How long an ANR line keeps counting as live.
 *
 * The dialog does not stay up: it is raised and torn down on a
 * fixed ten-second cadence, so a window dump taken between two raises is clean
 * even though the wearer's next ten seconds will be blurred again. Ninety
 * seconds is wide enough to cover several of those gaps and narrow enough that
 * an ANR the wearer already closed stops being reported.
 */
export const BROWSER_ANR_RECENT_SECONDS = 90;
/** Separates the probe's three answers in one shell round trip. */
export const BROWSER_HEALTH_SECTION = '--stereofold--';

/**
 * What the Quest Browser is doing, as far as a debugging cable can tell.
 *
 * `anr` means Android is showing its "isn't responding" dialog over the
 * browser, which is what blurs the wearer's immersive session every ten
 * seconds. `unknown` means the probe could not run at all, which is an ordinary
 * state on a Mac with no adb and never an error.
 */
export type HeadsetBrowserHealth = {
  browser: 'ok' | 'anr' | 'unknown';
  /** The headset's own clock on the newest ANR line, exactly as logcat wrote it. */
  since?: string;
  /** A few sanitized device lines, so the agent quotes the headset rather than guessing. */
  evidence: string[];
  /** Only on `unknown`: the one sentence naming what was missing. */
  reason?: string;
};

/**
 * Read the composited panel, compressed on the device.
 *
 * The whole pipeline is one argument to `exec-out` because the pipe has to run
 * in the headset's shell. `gzip` is toybox's, at /system/bin/gzip.
 */
export function screencapArguments(serial: string, { gzip = true }: { gzip?: boolean } = {}): string[] {
  return ['-s', serial, 'exec-out', gzip ? 'screencap | gzip -1' : 'screencap'];
}

/** The fallback: let the headset encode the PNG itself, slowly. */
export function screencapPngArguments(serial: string): string[] {
  return ['-s', serial, 'exec-out', 'screencap', '-p'];
}

/** Turn one raw frame into a bounded PNG on stdout, keeping the panel's aspect. */
export function ffmpegPngArguments({ width, height, pixelFormat, maxWidth }: {
  width: number; height: number; pixelFormat: string; maxWidth: number;
}): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', pixelFormat, '-s', `${width}x${height}`, '-i', 'pipe:0',
    ...(maxWidth < width ? ['-vf', `scale=${maxWidth}:-2`] : []),
    '-frames:v', '1', '-c:v', 'png', '-f', 'image2', 'pipe:1'];
}

/**
 * The size ffmpeg writes for those arguments: `scale=W:-2` keeps the panel's
 * aspect and rounds the height to the nearest even number, the way ffmpeg's
 * own integer rescale does, and a frame no wider than the ceiling keeps its size.
 */
export function ffmpegPngShape({ width, height, maxWidth }: { width: number; height: number; maxWidth: number }): { width: number; height: number } {
  return maxWidth < width ? { width: maxWidth, height: 2 * Math.floor((maxWidth * height + width) / (2 * width)) } : { width, height };
}

async function isExecutable(path: string, exists: (value: string) => Promise<boolean>) {
  return path ? exists(path) : false;
}

const defaultExists = async (path: string) => {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
};

/**
 * Where one executable is on this Mac, or nothing.
 *
 * An environment variable wins, then `PATH`. Nothing here knows about any
 * particular checkout or download directory: a Mac that has the tool only in a
 * scratch directory has to say so through the environment.
 */
export async function findExecutable(name: string, keys: readonly string[], { env = process.env, exists = defaultExists }: {
  env?: NodeJS.ProcessEnv; exists?: (path: string) => Promise<boolean>;
} = {}): Promise<string | undefined> {
  for (const key of keys) {
    const named = env[key];
    if (named && isAbsolute(named) && await isExecutable(named, exists)) return named;
  }
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (await isExecutable(candidate, exists)) return candidate;
  }
  return undefined;
}

export const findAdb = (options: { env?: NodeJS.ProcessEnv; exists?: (path: string) => Promise<boolean> } = {}) =>
  findExecutable('adb', ADB_ENV_KEYS, options);

/** Serial numbers of headsets `adb` reports as ready, ignoring unauthorized and offline ones. */
export function parseAdbDevices(stdout: string): string[] {
  return stdout.split('\n').slice(1)
    .map(line => line.trim().split(/\s+/u))
    .filter(parts => parts.length >= 2 && parts[1] === 'device' && parts[0])
    .map(parts => parts[0]!);
}

/**
 * Which headset to read.
 *
 * An explicitly named serial is never silently replaced: when the environment
 * names one `adb` does not list, the caller says so rather than photographing
 * some other device. Otherwise USB wins, because the same frame takes about a
 * second over the cable and four and a half over Wi-Fi.
 */
export function pickAdbSerial(serials: readonly string[], env: NodeJS.ProcessEnv = {}): { serial?: string; named?: string } {
  for (const key of ADB_SERIAL_ENV_KEYS) {
    const named = env[key]?.trim();
    if (named) return serials.includes(named) ? { serial: named, named } : { named };
  }
  const serial = serials.find(candidate => !candidate.includes(':')) ?? serials[0];
  return serial ? { serial } : {};
}

export type ScreencapFrame = { width: number; height: number; pixelFormat: 'rgba' | 'rgb0' | 'bgra'; body: Buffer };

/**
 * Split `screencap`'s header off its pixels.
 *
 * The header is four little-endian uint32: width, height, format, colour
 * space. Android builds before 10 stop at the format, so the body length
 * decides which header this device wrote. A frame whose body does not match
 * its own header is a truncated transfer and is refused rather than rendered.
 * So is a pixel format this module cannot read, which is left to the headset's
 * own PNG encoder rather than misread as RGBA, and so is a frame that both
 * headers fit (see `SCREENCAP_COLOR_SPACES`).
 */
export function decodeScreencap(bytes: Buffer): ScreencapFrame | undefined {
  const read = readScreencap(bytes);
  return read && 'body' in read ? read : undefined;
}

/**
 * The colour-space words Android's `screencap` writes in the longer header:
 * unknown, sRGB and Display P3.
 *
 * A frame cut four bytes short of a 16-byte header is exactly as long as a
 * whole one after the 12-byte header, and both put a little-endian word at
 * byte 12: the colour space, or the first pixel. A first word that cannot be a
 * colour space settles it as the shorter header. One that can is a black or
 * near-black corner pixel or a colour space, and the bytes cannot say which, so
 * the frame is refused rather than read one pixel out of place.
 */
const SCREENCAP_COLOR_SPACES = 3;

/**
 * The frame, or why a frame whose length fits a header still cannot be read:
 * a format nothing here reads, or a length both headers fit.
 */
function readScreencap(bytes: Buffer): ScreencapFrame | { unreadable: string } | undefined {
  if (bytes.byteLength < 13) return undefined;
  const width = bytes.readUInt32LE(0), height = bytes.readUInt32LE(4), format = bytes.readUInt32LE(8);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) return undefined;
  const pixels = width * height * 4;
  const offset = bytes.byteLength - 16 === pixels ? 16 : bytes.byteLength - 12 === pixels ? 12 : undefined;
  if (offset === undefined) return undefined;
  const pixelFormat = PIXEL_FORMATS[format];
  if (!pixelFormat) return { unreadable: `the headset sent raw pixels in format ${format}, which this Mac does not read.` };
  if (offset === 12 && bytes.readUInt32LE(12) < SCREENCAP_COLOR_SPACES) {
    return { unreadable: 'the headset\'s raw frame fits both screencap headers, whole after the 12-byte one or four bytes short after the '
      + '16-byte one, so this Mac could not tell where its pixels start.' };
  }
  return { width, height, pixelFormat, body: bytes.subarray(offset) };
}

/** How many of a still's pixels are lit. */
export type StillLight = { pixels: number; lit: number };

/**
 * Count the lit pixels, reading every one.
 *
 * A pixel is lit when its brightest colour channel reaches the floor, so the
 * channel order (RGBA, BGRA, RGBX) does not matter and alpha is never read.
 * The count is over the whole frame because a sparse sample can step over a
 * thin bright stripe; on a 3664x1920 panel the pass takes a few milliseconds.
 */
export function countLitPixels(body: Uint8Array, pixels: number, channels: 3 | 4, floor = DEVICE_LIT_FLOOR): StillLight {
  const whole = Math.min(pixels, Math.floor(body.byteLength / channels));
  let lit = 0;
  // Four-byte pixels on a little-endian host are read a word at a time: with a
  // power-of-two floor, one mask asks whether any colour byte reaches it.
  if (channels === 4 && body.byteOffset % 4 === 0 && LITTLE_ENDIAN && floor > 0 && floor <= 256 && (floor & (floor - 1)) === 0) {
    const mask = ((0x100 - floor) & 0xff) * 0x01_01_01;
    const words = new Uint32Array(body.buffer, body.byteOffset, whole);
    for (let index = 0; index < whole; index++) if (words[index]! & mask) lit += 1;
    return { pixels, lit };
  }
  const end = whole * channels;
  for (let at = 0; at < end; at += channels) {
    if (body[at]! >= floor || body[at + 1]! >= floor || body[at + 2]! >= floor) lit += 1;
  }
  return { pixels, lit };
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Every pixel of one raw frame. */
export const frameLight = (frame: ScreencapFrame): StillLight => countLitPixels(frame.body, frame.width * frame.height, 4);

/**
 * What the lit share says, and no more.
 *
 * `black` is a still with almost no lit pixel: an asleep display or a blocked
 * capture, which is refused. `dim` is lit over less than one percent, which a
 * loading scene and a blocked capture with a status mark can both be, so it is
 * handed over with a note. `lit` is a scene.
 */
export function judgeStill({ pixels, lit }: StillLight): 'black' | 'dim' | 'lit' {
  const share = pixels > 0 ? lit / pixels : 0;
  return share < DEVICE_BLACK_LIT_SHARE ? 'black' : share < DEVICE_SCENE_LIT_SHARE ? 'dim' : 'lit';
}

/** One decoded PNG, or the reason it could not be read, phrased to follow "the PNG the headset encoded". */
export type PngPixels = { width: number; height: number; channels: 3 | 4; pixels: Buffer } | { unreadable: string };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_COLOR_NAMES: Readonly<Record<number, string>> = Object.freeze({ 0: 'grayscale', 3: 'palette', 4: 'grayscale with alpha' });

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let entry = 0; entry < 256; entry++) {
    let value = entry;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    table[entry] = value;
  }
  return table;
})();

/**
 * The CRC-32 a PNG chunk carries, from a table built here.
 *
 * `zlib.crc32` would do, but it arrived in Node 22.2 and this package runs on
 * any Node 22; a missing named export stops the whole server from loading.
 */
export function pngCrc32(bytes: Uint8Array): number {
  let crc = -1;
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * Decode a PNG the headset encoded itself, or say why it cannot be.
 *
 * Only the 8-bit, non-interlaced RGB and RGBA that `screencap -p` writes are
 * read. Every chunk's checksum is checked; the header has to come first and
 * only once, the image data in one unbroken run, the end chunk empty, and no
 * critical chunk may be one this decoder does not know. The image data has to
 * inflate to exactly the size its header promises, so a damaged transfer is
 * named rather than passed on. Anything else is a still this Mac cannot verify.
 */
export function decodePng(bytes: Buffer): PngPixels {
  if (bytes.byteLength < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { unreadable: 'is not a PNG' };
  let width = 0, height = 0, channels: 3 | 4 | 0 = 0, ended = false, palette = false;
  // Image data has to arrive as one unbroken run of IDAT chunks.
  let run: 'before' | 'inside' | 'after' = 'before';
  const data: Buffer[] = [];
  let at = 8;
  while (at + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(at);
    if (at + 12 + length > bytes.byteLength) break;
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/u.test(type)) return { unreadable: 'has a chunk whose name is not four letters' };
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (pngCrc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) {
      return { unreadable: `has a ${type} chunk whose checksum does not match` };
    }
    if (at === 8 && type !== 'IHDR') return { unreadable: 'does not start with a header chunk' };
    if (type !== 'IDAT' && run === 'inside') run = 'after';
    if (type === 'IHDR') {
      if (at !== 8) return { unreadable: 'has a second header chunk' };
      if (length !== 13) return { unreadable: 'has a malformed header chunk' };
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const depth = body[8]!, color = body[9]!, interlace = body[12]!;
      if (color !== 2 && color !== 6) return { unreadable: `is ${PNG_COLOR_NAMES[color] ?? `colour type ${color}`}; only 8-bit RGB and RGBA are read here` };
      if (depth !== 8) return { unreadable: `is ${depth}-bit; only 8-bit RGB and RGBA are read here` };
      if (interlace !== 0) return { unreadable: 'is interlaced; only non-interlaced PNGs are read here' };
      if (body[10] !== 0 || body[11] !== 0) return { unreadable: 'uses a compression or filter method PNG does not define' };
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      if (run === 'after') return { unreadable: 'has its image data split by another chunk' };
      run = 'inside';
      data.push(body);
    } else if (type === 'IEND') {
      if (length !== 0) return { unreadable: 'has an end chunk that is not empty' };
      ended = true;
      break;
    } else if (type === 'PLTE') {
      // A suggested palette is allowed beside RGB, once and before the image data.
      if (palette || run !== 'before') return { unreadable: 'has a palette chunk out of place' };
      // One to 256 three-byte entries; an RGB or RGBA image may carry it as a suggestion.
      if (length < 3 || length > 768 || length % 3 !== 0) return { unreadable: 'has a malformed palette chunk' };
      palette = true;
    } else if (!(bytes[at + 4]! & 0x20)) {
      // Lower case first letter marks a chunk a decoder may skip; upper case
      // marks one it must understand to read the image at all.
      return { unreadable: `has a critical ${type} chunk this Mac does not read` };
    }
    at += 12 + length;
  }
  if (!ended) return { unreadable: 'is cut short' };
  if (!channels) return { unreadable: 'has no header chunk' };
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) return { unreadable: `claims a ${width}x${height} image` };
  if (!data.length) return { unreadable: 'has no image data' };
  const stride = width * channels, expected = (stride + 1) * height;
  if (expected > DEVICE_RAW_MAX_BYTES) return { unreadable: 'is larger than this Mac will decode' };
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected }); } catch { return { unreadable: 'has image data that does not decompress' }; }
  if (raw.byteLength !== expected) return { unreadable: 'has less image data than its header promises' };
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]!, from = row * (stride + 1) + 1, to = row * stride, up = to - stride;
    if (filter > 4) return { unreadable: `uses row filter ${filter}, which PNG does not define` };
    if (filter === 0) { raw.copy(pixels, to, from, from + stride); continue; }
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? pixels[to + index - channels]! : 0;
      const above = row > 0 ? pixels[up + index]! : 0;
      let predicted: number;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = above;
      else if (filter === 3) predicted = (left + above) >> 1;
      else {
        const corner = row > 0 && index >= channels ? pixels[up + index - channels]! : 0;
        const estimate = left + above - corner;
        const toLeft = Math.abs(estimate - left), toAbove = Math.abs(estimate - above), toCorner = Math.abs(estimate - corner);
        predicted = toLeft <= toAbove && toLeft <= toCorner ? left : toAbove <= toCorner ? above : corner;
      }
      pixels[to + index] = (raw[from + index]! + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/**
 * The headset's clock and its recent log, in one shell round trip, so the age
 * of a line is measured on the headset's own clock.
 */
export function secureLayerLogArguments(serial: string): string[] {
  return ['-s', serial, 'shell', `date +%s; logcat -d -v epoch -t ${SECURE_LAYER_LOG_LINES}`];
}

/**
 * What the log probe can say about a blocked capture.
 *
 * A number is how many seconds ago, on the headset's clock, the newest "secure
 * layer detected" line inside the window was written. `none` means the log was
 * read and held no such line that recent. `unchecked` means the answer had no
 * readable clock, so no line in it can be dated and nothing can be said.
 */
export type SecureLayerLog = number | 'none' | 'unchecked';

export function secureLayerLog(stdout: string, recentSeconds = SECURE_LAYER_RECENT_SECONDS): SecureLayerLog {
  const lines = stdout.split('\n');
  const now = Number(lines[0]?.trim());
  if (!lines[0]?.trim() || !Number.isFinite(now)) return 'unchecked';
  let age: number | undefined;
  for (const line of lines.slice(1)) {
    if (!SECURE_LAYER_LOG.test(line)) continue;
    const at = Number(/^\s*(\d+(?:\.\d+)?)\s/u.exec(line)?.[1]);
    if (!Number.isFinite(at) || now - at > recentSeconds || at - now > 5) continue;
    const seconds = Math.max(0, Math.round(now - at));
    age = age === undefined ? seconds : Math.min(age, seconds);
  }
  return age ?? 'none';
}

/** How many dated lines a log probe answer holds, after its clock line; separators are not counted. */
export function datedLogLines(stdout: string): number {
  return stdout.split('\n').slice(1).filter(line => /^\s*\d+(?:\.\d+)?\s/u.test(line)).length;
}

/** Width and height out of a PNG's IHDR, or nothing. */
export function pngShape(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.byteLength < 24 || bytes.readUInt32BE(0) !== PNG_MAGIC) return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function bound(value: number | undefined, fallback: number) {
  const size = Math.round(Number(value ?? fallback));
  if (!Number.isFinite(size)) return fallback;
  return Math.min(DEVICE_CAPTURE_MAX_SIZE, Math.max(64, size));
}

function shortReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, ' ').slice(0, 200);
}

function toBuffer(value: string | Buffer | undefined): Buffer {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(String(value ?? ''), 'binary');
}

/**
 * Run one child, collect its bytes, and never leave it behind.
 *
 * `execFile` cannot write to a child's stdin, and the raw frame has to be piped
 * into `ffmpeg`, so this is a small `spawn` wrapper rather than a promisified
 * `execFile`. It bounds stdout, kills on timeout, and keeps only the head of
 * stderr, which is all a reported sentence can carry.
 */
export const spawnDeviceRunner: DeviceRunner = async (file, args, options) => {
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let outBytes = 0, errBytes = 0, done = false;
    const settle = (error?: Error, value?: { stdout: Buffer; stderr: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(Error(`${file} took longer than ${options.timeout} ms.`));
    }, options.timeout);
    (timer as { unref?: () => void }).unref?.();
    child.on('error', error => settle(error instanceof Error ? error : Error(String(error))));
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.byteLength;
      if (outBytes > options.maxBuffer) {
        child.kill('SIGKILL');
        settle(Error(`${file} produced more than ${options.maxBuffer} bytes.`));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (errBytes < 8_192) { errBytes += chunk.byteLength; err.push(chunk); } });
    child.on('close', code => {
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code !== 0) { settle(Error(`${file} exited ${code}${stderr ? `: ${stderr.slice(0, 160)}` : ''}`)); return; }
      settle(undefined, { stdout: Buffer.concat(out), stderr });
    });
    // A child that never reads stdin closes the pipe under us; that EPIPE is
    // the normal end of a transfer, not a capture failure.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
};

/**
 * Which `adb` and which headset every device route here talks to.
 *
 * Split out of the capture so the health probe reaches the same headset by the
 * same rules and, more importantly, refuses in the same words: a Mac with no
 * Developer Mode must read the same sentence whether it asked for a picture or
 * for the browser's health.
 */
export async function resolveAdbTarget({ env, exists = defaultExists, run }: {
  env: NodeJS.ProcessEnv; exists?: (path: string) => Promise<boolean>; run: DeviceRunner;
}): Promise<{ ok: true; adb: string; serial: string } | { ok: false; reason: string }> {
  const adb = await findAdb({ env, exists });
  if (!adb) {
    return { ok: false, reason: 'No adb was found. Install Android platform-tools, or set STEREOFOLD_ADB_BIN to its absolute path, then pair the headset once over USB.' };
  }
  let serials: string[];
  try {
    const listed = await run(adb, ['devices'], { timeout: DEVICE_ADB_TIMEOUT_MS, env, maxBuffer: 1024 * 1024 });
    serials = parseAdbDevices(toBuffer(listed.stdout).toString('utf8'));
  } catch (error) {
    return { ok: false, reason: `adb devices failed: ${shortReason(error)}` };
  }
  if (serials.length === 0) {
    return { ok: false, reason: 'adb reports no authorized headset. Enable Developer Mode, connect once over USB and accept the trust prompt, then run adb tcpip 5555 and adb connect <headset-ip>:5555.' };
  }
  const chosen = pickAdbSerial(serials, env);
  if (!chosen.serial) {
    return { ok: false, reason: `STEREOFOLD_ADB_SERIAL names ${chosen.named}, which adb does not list as ready. Attached: ${serials.join(', ')}.` };
  }
  return { ok: true, adb, serial: chosen.serial };
}

/**
 * Take one still off the headset's display buffer.
 *
 * The whole path is guarded rather than attempted: no `adb`, no attached
 * headset, a named serial nobody is listening on, a command that fails, or a
 * frame that decodes to nothing each return a sentence naming what was
 * missing. A caller reports that sentence; it never turns into a thrown tool
 * error, because a Mac without Developer Mode enabled is an ordinary state,
 * not a fault.
 *
 * Every still is checked before it is handed over. One that is almost
 * entirely black is refused with what the headset says about itself; one this
 * Mac cannot decode is refused as unverified, never as black; one lit over
 * only a small area is handed over with a note saying what the pixels cannot
 * settle.
 */
export async function captureDeviceView({ maxWidth, hooks, timeoutMs = DEVICE_CAPTURE_TIMEOUT_MS }: {
  maxWidth?: number; hooks: DeviceCaptureHooks; timeoutMs?: number;
}): Promise<DeviceCaptureOutcome> {
  const env = hooks.env ?? process.env;
  const now = hooks.now ?? Date.now;
  const exists = hooks.exists ?? defaultExists;
  const started = now();
  const width = bound(maxWidth, DEVICE_CAPTURE_DEFAULT_SIZE);

  const target = await resolveAdbTarget({ env, exists, run: hooks.run });
  if (!target.ok) return { ok: false, reason: target.reason };
  const { adb, serial } = target;

  const capture = (args: readonly string[]) => hooks.run(adb, args, { timeout: timeoutMs, env, maxBuffer: DEVICE_RAW_MAX_BYTES });

  // Without ffmpeg there is nothing here to turn raw pixels into a picture, so
  // the 28 MB transfer is not worth making: go straight to the slow on-device
  // encode rather than pulling the frame twice.
  const ffmpeg = await findExecutable('ffmpeg', FFMPEG_ENV_KEYS, { env, exists });
  let frame: ScreencapFrame | undefined;
  let wire: 'gzip' | 'raw' = 'gzip';
  let captureError: string | undefined;
  // Why a whole raw frame that arrived could not be read here.
  let unreadable: string | undefined;
  const take = (bytes: Buffer) => {
    const read = readScreencap(bytes);
    if (read && 'unreadable' in read) unreadable = read.unreadable;
    return read && 'body' in read ? read : undefined;
  };
  if (ffmpeg) {
    // Compressed first. A device without gzip writes nothing to stdout and its
    // shell complains on stderr, which is a fall-through rather than a failure.
    try {
      const zipped = toBuffer((await capture(screencapArguments(serial))).stdout);
      if (zipped.byteLength > 2) frame = take(gunzipSync(zipped, { maxOutputLength: DEVICE_RAW_MAX_BYTES }));
    } catch (error) { captureError = shortReason(error); }
    // A whole frame nothing here can read would arrive the same way
    // uncompressed, so it goes straight to the headset's own encoder.
    if (!frame && unreadable === undefined) {
      wire = 'raw';
      try {
        frame = take(toBuffer((await capture(screencapArguments(serial, { gzip: false }))).stdout));
      } catch (error) { captureError ??= shortReason(error); }
    }
    // A whole raw frame that arrived, readable or not, makes an earlier gzip
    // failure history: only what it says, and what goes wrong after it, can
    // explain a fall back to the headset's PNG.
    if (frame || unreadable !== undefined) captureError = unreadable;
  } else {
    captureError = 'No ffmpeg was found on this Mac, so the headset was asked to encode the still itself.';
  }

  const probe = () => probeStill({ adb, serial, env, run: hooks.run });

  if (frame && ffmpeg) {
    // Every pixel of the raw frame is read before anything is encoded, so a
    // black still is refused without spending the encode on it.
    const light = frameLight(frame);
    const verdict = judgeStill(light);
    if (verdict === 'black') return { ok: false, still: 'black', reason: blackStillReason(light, await probe()) };
    try {
      const encoded = toBuffer((await hooks.run(ffmpeg,
        ffmpegPngArguments({ width: frame.width, height: frame.height, pixelFormat: frame.pixelFormat, maxWidth: width }),
        { timeout: timeoutMs, env, maxBuffer: DEVICE_CAPTURE_MAX_BYTES, input: frame.body })).stdout);
      // What is handed over is ffmpeg's PNG, so it is read in full and judged
      // too: a conversion of the wrong size, cut short, or emptied of the
      // frame that was judged goes to the headset's own encoder instead.
      const converted = judgeConversion(encoded, ffmpegPngShape({ width: frame.width, height: frame.height, maxWidth: width }));
      if ('fault' in converted) captureError = converted.fault;
      else {
        // The native frame is the panel as drawn, so its count leads a note; a
        // scaled still that came out dim from a lit frame gets its own.
        const dim = verdict === 'dim' ? light : converted.verdict === 'dim' ? converted.light : undefined;
        const note = dim ? dimStillNote(dim, await probe()) : undefined;
        return { ok: true, bytes: encoded, mimeType: 'image/png', width: converted.width, height: converted.height,
          ms: now() - started, serial, wire, ...(note ? { note } : {}) };
      }
    } catch (error) { captureError ??= `ffmpeg failed: ${shortReason(error)}`; }
  }

  // Last resort: let the headset encode the PNG. It costs the Quest 2 about
  // four and a half seconds and arrives full size, but it needs nothing on
  // this Mac beyond adb.
  let encoded: Buffer;
  try {
    encoded = toBuffer((await capture(screencapPngArguments(serial))).stdout);
  } catch (error) {
    // The transfer that just failed is the answer; why this route was taken
    // follows it as context, never as the cause.
    const context = captureError ? ` ${captureError.replace(/^(?!ffmpeg)[a-z]/u, letter => letter.toUpperCase()).replace(/([^.])$/u, '$1.')}` : '';
    return { ok: false, reason: `adb screencap failed: ${shortReason(error).replace(/\.$/u, '')}.${context}` };
  }
  const shape = pngShape(encoded);
  if (!shape) {
    return { ok: false, reason: `adb screencap returned no usable frame${captureError ? `: ${captureError}` : '.'}` };
  }
  if (encoded.byteLength > DEVICE_CAPTURE_MAX_BYTES) {
    return { ok: false, reason: `The device capture is ${encoded.byteLength} bytes, past the limit.` };
  }
  // The headset's own PNG is decoded and every pixel read, the same check as a
  // raw frame. One this Mac cannot decode is refused rather than passed on
  // unread, because nothing here can say what it shows.
  const decoded = decodePng(encoded);
  if ('unreadable' in decoded) {
    return { ok: false, still: 'unverified', reason: unverifiedStillReason(decoded.unreadable, { ffmpeg: Boolean(ffmpeg), captureError }) };
  }
  const light = countLitPixels(decoded.pixels, decoded.width * decoded.height, decoded.channels);
  const verdict = judgeStill(light);
  if (verdict === 'black') {
    // A raw frame or a conversion that was not black is part of what the agent needs to know.
    return { ok: false, still: 'black', reason: blackStillReason(light, await probe(), ffmpeg ? captureError : undefined) };
  }
  const note = verdict === 'dim' ? dimStillNote(light, await probe()) : undefined;
  return { ok: true, bytes: encoded, mimeType: 'image/png', width: decoded.width, height: decoded.height,
    ms: now() - started, serial, wire: 'device-png', ...(note ? { note } : {}) };
}

/**
 * Whether ffmpeg's PNG is a whole, readable picture of the size it was asked
 * for, and what its own pixels say, by the rule the raw frame was judged by.
 * A fault is phrased to follow "the headset encoded it because".
 */
function judgeConversion(encoded: Buffer, expected: { width: number; height: number }):
{ fault: string } | { width: number; height: number; light: StillLight; verdict: 'dim' | 'lit' } {
  if (encoded.byteLength > DEVICE_CAPTURE_MAX_BYTES) return { fault: `ffmpeg's conversion is ${encoded.byteLength} bytes, past the limit.` };
  const decoded = decodePng(encoded);
  if ('unreadable' in decoded) return { fault: `ffmpeg's conversion ${decoded.unreadable}.` };
  if (decoded.width !== expected.width || decoded.height !== expected.height) {
    return { fault: `ffmpeg's conversion is ${decoded.width}x${decoded.height} where ${expected.width}x${expected.height} was asked for.` };
  }
  const light = countLitPixels(decoded.pixels, decoded.width * decoded.height, decoded.channels);
  const verdict = judgeStill(light);
  if (verdict === 'black') {
    return { fault: `ffmpeg's conversion came out almost entirely black (${count(light.lit)} of ${count(light.pixels)} pixels lit) from a raw frame that was not.` };
  }
  return { width: decoded.width, height: decoded.height, light, verdict };
}

/**
 * What the headset says about itself when a still comes back dark. `power` is
 * empty when it did not answer; `log` is `unchecked` when the log probe failed.
 */
export type StillProbe = { power: string; log: SecureLayerLog;
  /** How many dated log lines came back, so the sentence never claims more than were read. */
  linesRead?: number };

/**
 * Ask the headset whether its display is awake and whether its log mentions a
 * blocked capture, in parallel. Best effort: a probe that fails only changes
 * the wording, never the verdict on the pixels.
 */
async function probeStill({ adb, serial, env, run }: {
  adb: string; serial: string; env: NodeJS.ProcessEnv; run: DeviceRunner;
}): Promise<StillProbe> {
  const options = { timeout: DEVICE_ADB_TIMEOUT_MS, env, maxBuffer: 4 * 1024 * 1024 };
  const [dumped, logged] = await Promise.allSettled([
    run(adb, ['-s', serial, 'shell', 'dumpsys', 'power'], options),
    run(adb, secureLayerLogArguments(serial), options),
  ]);
  const power = dumped.status === 'fulfilled' ? /mWakefulness=(\w+)/u.exec(toBuffer(dumped.value.stdout).toString('utf8'))?.[1] ?? '' : '';
  const answer = logged.status === 'fulfilled' ? toBuffer(logged.value.stdout).toString('utf8') : undefined;
  const log = answer === undefined ? 'unchecked' : secureLayerLog(answer);
  return { power, log, ...(answer === undefined ? {} : { linesRead: datedLogLines(answer) }) };
}

const count = (value: number) => value.toLocaleString('en-US');
const percent = (light: StillLight) => `${Number((100 * light.lit / Math.max(1, light.pixels)).toPrecision(2))}%`;
const ASLEEP = /asleep|dozing/iu;
const PAGE_SOURCE = 'While the page is in immersion, source "page" reads the molecule from the page itself.';
const RECOVERY = 'To try to get the device view back, restart the headset, or run `adb shell am force-stop com.oculus.vrshell` '
  + 'and then `adb shell am force-stop com.oculus.metacam` (the headset\'s menus reload), and ask again.';
const WAKE = 'If the headset is off the wearer\'s head, put it back on, or hold it awake with `adb shell am broadcast -a com.oculus.vrpowermanager.prox_close`.';
const secureLine = (age: number) => `A headset log line from ${age} s ago says "secure layer detected", which suggests the system blocked this capture`;
/** What the log said, or could not say, when it names no recent blocked capture. */
const logSaid = (log: 'none' | 'unchecked', linesRead?: number) => log === 'unchecked'
  ? 'its log could not be checked for a blocked capture'
  : linesRead === 0 ? 'its log returned no lines to check for a blocked capture'
    : `no "secure layer detected" line from the last ${SECURE_LAYER_RECENT_SECONDS} s was found in the `
      + (linesRead === undefined ? 'log lines read' : `${linesRead} log line${linesRead === 1 ? '' : 's'} read`);

/**
 * Why a black still was refused, saying only what was observed.
 *
 * The pixels establish that the still is black and nothing more. The power
 * state is what the headset reports, and a recent "secure layer detected" line
 * suggests a blocked capture without proving this one was blocked, so each is
 * reported as exactly that, followed by what to try. `fallback` is why the
 * headset encoded the still when this Mac could not, which is said first.
 */
export function blackStillReason(light: StillLight, { power, log, linesRead }: StillProbe, fallback?: string): string {
  const seen = `The still is almost entirely black (${count(light.lit)} of ${count(light.pixels)} pixels lit), `
    + 'so it was not handed over as the wearer\'s view. Nothing was saved.' + encodedBecause(fallback);
  if (ASLEEP.test(power)) return `${seen} The headset reports its display ${power}. ${WAKE}`;
  if (typeof log === 'number') return `${seen} ${secureLine(log)}; the scene itself may be drawing normally. ${PAGE_SOURCE} ${RECOVERY}`;
  if (power) {
    return `${seen} The headset reports it is ${power}, and ${logSaid(log, linesRead)}, so the cause is unknown: `
      + `the session may have left immersion, or the capture may have been blocked. ${PAGE_SOURCE} Otherwise ask again.`;
  }
  return `${seen} The headset did not say whether its display is awake${log === 'unchecked' ? ', and its log could not be checked either' : ''}. ${WAKE} ${PAGE_SOURCE}`;
}

/**
 * The note on a still lit over less than one percent, which is handed over.
 *
 * A scene still loading and a blocked capture carrying a status mark can be
 * the same pixels, so this says what is uncertain instead of choosing.
 */
export function dimStillNote(light: StillLight, { power, log }: StillProbe): string {
  return `Almost all of this still is black: ${percent(light)} of its pixels are lit (${count(light.lit)} of ${count(light.pixels)}). `
    + 'The pixels cannot tell a scene that is dark or still loading from a blocked capture that kept a small mark.'
    + (typeof log === 'number' ? ` ${secureLine(log)}.` : '')
    + (ASLEEP.test(power) ? ` The headset reports its display ${power}.` : '')
    + ` If the wearer should be seeing more than this, ask again. ${PAGE_SOURCE}`;
}

/** " The headset encoded it because ...", or nothing when there is no reason to give. */
const encodedBecause = (cause: string | undefined) => cause
  ? ` The headset encoded it because ${cause.replace(/^[A-Z]/u, letter => letter.toLowerCase()).replace(/\.$/u, '')}.` : '';

/** Why a still this Mac could not decode was refused, which is never the same as black. */
export function unverifiedStillReason(unreadable: string, { ffmpeg, captureError }: { ffmpeg: boolean; captureError?: string | undefined }): string {
  return `Could not verify the still: the PNG the headset encoded ${unreadable}, so it was not handed over as the wearer's view. Nothing was saved.`
    + (ffmpeg ? encodedBecause(captureError) : ' With ffmpeg on this Mac, or STEREOFOLD_FFMPEG_BIN naming it, the still is read from raw pixels instead.')
    + ` Ask again. ${PAGE_SOURCE}`;
}

/* ------------------------------------------------ is the browser responding */

/**
 * One round trip that answers three questions: what time the headset thinks it
 * is, whether an ANR dialog is on screen right now, and what the log says about
 * recent ones.
 *
 * The window dump is the only thing that can prove a dialog is up, but it alone
 * is not enough: the dialog is torn down and re-raised on a ten-second cadence,
 * so a dump taken in the gap looks clean while the wearer's session is still
 * about to be blurred again. The log answers that, and the device's own clock
 * is read in the same breath so a line's age can be measured without this Mac
 * guessing the headset's time zone.
 *
 * Everything is filtered on the device: the whole probe returns a few hundred
 * bytes rather than a window dump the size of a photograph. `true` at the end
 * keeps a `grep` that matched nothing from looking like a failed command.
 */
export function browserHealthArguments(serial: string, {
  packageName = QUEST_BROWSER_PACKAGE, lines = BROWSER_HEALTH_LOG_LINES,
}: { packageName?: string; lines?: number } = {}): string[] {
  return ['-s', serial, 'shell',
    `date '+%m-%d %H:%M:%S'; echo ${BROWSER_HEALTH_SECTION}; `
    + `dumpsys window windows | grep -i 'not responding'; echo ${BROWSER_HEALTH_SECTION}; `
    + `logcat -d -t ${lines} | grep -e 'ANR in ' -e 'Application Not Responding' -e 'Input dispatching timed out' -e 'user request after error' -e 'Force stopping' | grep '${packageName}'; `
    + 'true'];
}

/** `am force-stop` on the browser: the one write this module ever makes to a headset. */
export function forceStopBrowserArguments(serial: string, packageName = QUEST_BROWSER_PACKAGE): string[] {
  return ['-s', serial, 'shell', 'am', 'force-stop', packageName];
}

/**
 * "09-11 22:39:21.239 ..." as seconds inside the year.
 *
 * logcat writes no year and no zone, and the device clock is read in the same
 * format in the same round trip, so the two subtract cleanly without this Mac
 * knowing either. A month boundary makes the difference too large rather than
 * too small, which loses an ANR report rather than inventing one.
 */
export function deviceClockSeconds(stamp: string): number | undefined {
  const match = /^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/u.exec(stamp.trim());
  if (!match) return undefined;
  const [month, day, hour, minute, second] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  return month * 2_678_400 + day * 86_400 + hour * 3_600 + minute * 60 + second;
}

/** Nothing with an address or a code in it ever reaches an agent's transcript. */
export function sanitizeEvidence(line: string): string {
  return line.replace(/\b(?:https?|wss?|content|file):\/\/\S+/giu, '<address>')
    .replace(/#pair=\d+/gu, '#pair=<code>')
    .replace(/\s+/gu, ' ').trim().slice(0, 200);
}

const splitLines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);

/** The device clock at the head of one logcat line, or nothing. */
const stampOf = (line: string) => /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/u.exec(line)?.[0];

/** The newest matching line's place in the buffer. Order is the whole point: a kill after an ANR ended it. */
function lastIndexWhere(lines: readonly string[], matches: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) if (matches(lines[index]!)) return index;
  return -1;
}

/**
 * Read the probe's three sections into one verdict.
 *
 * A dialog in the window dump is the strongest evidence there is and settles it
 * on its own. Otherwise a recent ANR for this package counts, unless the log
 * also shows the process being killed afterwards, which is exactly what
 * pressing "Close app" writes, and that line ends the blur loop for
 * the rest of the session.
 */
export function parseBrowserHealth(stdout: string, {
  packageName = QUEST_BROWSER_PACKAGE, recentSeconds = BROWSER_ANR_RECENT_SECONDS,
}: { packageName?: string; recentSeconds?: number } = {}): HeadsetBrowserHealth {
  const sections = stdout.split(BROWSER_HEALTH_SECTION);
  if (sections.length < 3) return { browser: 'unknown', evidence: [], reason: 'The headset answered the health probe with something this Mac could not read.' };
  const now = deviceClockSeconds(sections[0] ?? '');
  const dialogs = splitLines(sections[1] ?? '').filter(line => /not responding/iu.test(line) && line.includes(packageName));
  const log = splitLines(sections.slice(2).join(BROWSER_HEALTH_SECTION));
  // "Setting back callback null" on the dialog's own window is the tear-down
  // half of a raise, and it is written a couple of milliseconds *after* the
  // kill that ends the loop, so counting it as evidence of a live dialog kept
  // reporting an ANR the wearer had already closed.
  const torndown = (line: string) => /Setting back callback null/iu.test(line);
  const anrAt = lastIndexWhere(log, line => /ANR in |Application Not Responding/iu.test(line) && line.includes(packageName) && !torndown(line));
  // Two lines end the loop, and both have to count. "user request after error"
  // is what the wearer's own "Close app" press writes, and it
  // ends the blur loop for the rest of the session. "Force stopping" is what
  // this Mac's own recovery writes; without it a health read taken right after
  // a recovery would report the ANR it had just cleared, because the lines that
  // declared it are still sitting in the same log buffer.
  const clearedAt = lastIndexWhere(log, line => /user request after error|Force stopping/iu.test(line) && line.includes(packageName));
  const newest = anrAt >= 0 ? log[anrAt]! : undefined;
  // `ANR in <package>` is written once when Android declares the ANR, while the
  // dialog line repeats on every raise, so the declaration is the honest answer
  // to "since when".
  const declaredAt = lastIndexWhere(log, line => /ANR in /u.test(line) && line.includes(packageName));
  const since = stampOf(declaredAt >= 0 ? log[declaredAt]! : newest ?? '');
  const seenAt = stampOf(newest ?? '');
  const age = now !== undefined && seenAt !== undefined ? now - (deviceClockSeconds(seenAt) ?? now) : undefined;
  const answered = clearedAt > anrAt;
  const stillLooping = newest !== undefined && !answered && age !== undefined && age >= 0 && age <= recentSeconds;
  const evidence = [...dialogs, ...(newest ? [newest] : [])].slice(0, 4).map(sanitizeEvidence);
  if (dialogs.length || stillLooping) return { browser: 'anr', ...(since ? { since } : {}), evidence };
  return { browser: 'ok', evidence: newest && !answered ? [sanitizeEvidence(newest)] : [] };
}

/**
 * Ask the headset whether Quest Browser is wedged.
 *
 * This is the probe the agent runs before it starts guessing from blurred
 * frames. It reads and never writes, it sends the headset no input, and a Mac
 * with no adb gets `unknown` and a sentence rather than an error, because a Mac
 * without Developer Mode is an ordinary state.
 */
export async function headsetBrowserHealth({ hooks, timeoutMs = BROWSER_HEALTH_TIMEOUT_MS, packageName = QUEST_BROWSER_PACKAGE }: {
  hooks: DeviceCaptureHooks; timeoutMs?: number; packageName?: string;
}): Promise<HeadsetBrowserHealth> {
  const env = hooks.env ?? process.env;
  const exists = hooks.exists ?? defaultExists;
  const target = await resolveAdbTarget({ env, exists, run: hooks.run });
  if (!target.ok) return { browser: 'unknown', evidence: [], reason: target.reason };
  try {
    const answered = await hooks.run(target.adb, browserHealthArguments(target.serial, { packageName }),
      { timeout: timeoutMs, env, maxBuffer: BROWSER_HEALTH_MAX_BYTES });
    return parseBrowserHealth(toBuffer(answered.stdout).toString('utf8'), { packageName });
  } catch (error) {
    return { browser: 'unknown', evidence: [], reason: `The headset health probe failed: ${shortReason(error)}` };
  }
}

/**
 * Kill the wedged browser.
 *
 * This is the only thing in this module that changes the headset, so it is a
 * separate call the server gates rather than something a capture can trip into.
 * Killing the process is what removes the dialog: the dialog belongs to
 * system_server, but it is torn down with the process record it names, which is
 * what the wearer's own "Close app" press does.
 */
export async function forceStopHeadsetBrowser({ hooks, timeoutMs = DEVICE_ADB_TIMEOUT_MS, packageName = QUEST_BROWSER_PACKAGE }: {
  hooks: DeviceCaptureHooks; timeoutMs?: number; packageName?: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const env = hooks.env ?? process.env;
  const exists = hooks.exists ?? defaultExists;
  const target = await resolveAdbTarget({ env, exists, run: hooks.run });
  if (!target.ok) return { ok: false, reason: target.reason };
  try {
    const stopped = await hooks.run(target.adb, forceStopBrowserArguments(target.serial, packageName),
      { timeout: timeoutMs, env, maxBuffer: 1024 * 1024 });
    const said = toBuffer(stopped.stdout).toString('utf8');
    if (/^Error|Exception/imu.test(`${said}\n${stopped.stderr}`)) return { ok: false, reason: `adb refused to stop the browser: ${sanitizeEvidence(said || stopped.stderr)}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `adb could not stop the browser: ${shortReason(error)}` };
  }
}
