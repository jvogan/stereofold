import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

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
/** Below both of these the panel is showing nothing at all, not a dark scene. */
export const DEVICE_DARK_MEAN = 0.02;
export const DEVICE_DARK_STDDEV = 0.02;

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
      wire: 'gzip' | 'raw' | 'device-png' }
  | { ok: false; reason: string };

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
 * The header is four little-endian uint32: width, height, format, colorspace.
 * Android builds before 10 stop at the format, so the body length decides which
 * header this device wrote. A frame whose body does not match its own header is
 * a truncated transfer and is refused rather than rendered.
 */
export function decodeScreencap(bytes: Buffer): ScreencapFrame | undefined {
  if (bytes.byteLength < 13) return undefined;
  const width = bytes.readUInt32LE(0), height = bytes.readUInt32LE(4), format = bytes.readUInt32LE(8);
  if (width < 1 || height < 1 || width > 16_384 || height > 16_384) return undefined;
  const pixels = width * height * 4;
  const offset = bytes.byteLength - 16 === pixels ? 16 : bytes.byteLength - 12 === pixels ? 12 : undefined;
  if (offset === undefined) return undefined;
  return { width, height, pixelFormat: PIXEL_FORMATS[format] ?? 'rgba', body: bytes.subarray(offset) };
}

/**
 * How much light is in the frame, sampled rather than summed.
 *
 * Seven million pixels do not need to be read to tell an empty panel from a
 * scene, and the wearer is waiting. A stride across the whole frame catches a
 * black panel with a lit corner, which a crop would miss.
 */
export function frameBrightness(frame: ScreencapFrame, samples = 20_000): { mean: number; stddev: number } {
  const pixels = frame.width * frame.height;
  const step = Math.max(1, Math.floor(pixels / Math.max(1, samples)));
  const swapped = frame.pixelFormat === 'bgra';
  let sum = 0, squares = 0, taken = 0;
  for (let index = 0; index < pixels; index += step) {
    const at = index * 4;
    if (at + 2 >= frame.body.byteLength) break;
    const red = frame.body[at + (swapped ? 2 : 0)]!, green = frame.body[at + 1]!, blue = frame.body[at + (swapped ? 0 : 2)]!;
    const luma = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
    sum += luma; squares += luma * luma; taken += 1;
  }
  if (!taken) return { mean: 0, stddev: 0 };
  const mean = sum / taken;
  return { mean, stddev: Math.sqrt(Math.max(0, squares / taken - mean * mean)) };
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
 * A black frame is a device state, not a capture failure, so it is reported as
 * one: the headset is asleep or off the wearer's head, or it is awake and the
 * panel is genuinely empty, and the two say different things.
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
  if (ffmpeg) {
    // Compressed first. A device without gzip writes nothing to stdout and its
    // shell complains on stderr, which is a fall-through rather than a failure.
    try {
      const zipped = toBuffer((await capture(screencapArguments(serial))).stdout);
      if (zipped.byteLength > 2) frame = decodeScreencap(gunzipSync(zipped));
    } catch (error) { captureError = shortReason(error); }
    if (!frame) {
      wire = 'raw';
      try {
        frame = decodeScreencap(toBuffer((await capture(screencapArguments(serial, { gzip: false }))).stdout));
      } catch (error) { captureError ??= shortReason(error); }
    }
  } else {
    captureError = 'No ffmpeg was found to encode the raw frame, so the headset encoded it instead.';
  }

  if (frame && ffmpeg) {
    // Only this path can see the pixels, so only this path can tell a sleeping
    // headset from a busy one.
    const light = frameBrightness(frame);
    if (light.mean < DEVICE_DARK_MEAN && light.stddev < DEVICE_DARK_STDDEV) {
      return { ok: false, reason: await darkFrameReason({ adb, serial, env, run: hooks.run }) };
    }
    try {
      const encoded = toBuffer((await hooks.run(ffmpeg,
        ffmpegPngArguments({ width: frame.width, height: frame.height, pixelFormat: frame.pixelFormat, maxWidth: width }),
        { timeout: timeoutMs, env, maxBuffer: DEVICE_CAPTURE_MAX_BYTES, input: frame.body })).stdout);
      const shape = pngShape(encoded);
      if (shape && encoded.byteLength <= DEVICE_CAPTURE_MAX_BYTES) {
        return { ok: true, bytes: encoded, mimeType: 'image/png', ...shape, ms: now() - started, serial, wire };
      }
      captureError ??= 'ffmpeg wrote something that is not a PNG.';
    } catch (error) { captureError ??= `ffmpeg failed: ${shortReason(error)}`; }
  }

  // Last resort: let the headset encode the PNG. It costs the Quest 2 about
  // four and a half seconds and arrives full size, but it needs nothing on
  // this Mac beyond adb.
  let encoded: Buffer;
  try {
    encoded = toBuffer((await capture(screencapPngArguments(serial))).stdout);
  } catch (error) {
    return { ok: false, reason: `adb screencap failed: ${captureError ?? shortReason(error)}` };
  }
  const shape = pngShape(encoded);
  if (!shape) {
    return { ok: false, reason: `adb screencap returned no usable frame${captureError ? `: ${captureError}` : '.'}` };
  }
  if (encoded.byteLength > DEVICE_CAPTURE_MAX_BYTES) {
    return { ok: false, reason: `The device capture is ${encoded.byteLength} bytes, past the limit.` };
  }
  return { ok: true, bytes: encoded, mimeType: 'image/png', ...shape, ms: now() - started, serial, wire: 'device-png' };
}

/**
 * Why the frame is empty, in the device's own words.
 *
 * A headset the wearer took off is the common case and is not a fault; a panel
 * that is awake and still black is worth escalating. The probe is best effort:
 * when it cannot answer, the sentence covers both.
 */
async function darkFrameReason({ adb, serial, env, run }: {
  adb: string; serial: string; env: NodeJS.ProcessEnv; run: DeviceRunner;
}): Promise<string> {
  let power = '';
  try {
    const dumped = await run(adb, ['-s', serial, 'shell', 'dumpsys', 'power'],
      { timeout: DEVICE_ADB_TIMEOUT_MS, env, maxBuffer: 4 * 1024 * 1024 });
    power = /mWakefulness=(\w+)/u.exec(toBuffer(dumped.stdout).toString('utf8'))?.[1] ?? '';
  } catch { /* The frame is still the answer; the probe is only the wording. */ }
  if (/asleep|dozing/iu.test(power)) {
    return 'The headset display is off or asleep, so the frame is black. Put it back on, or hold it awake with adb shell am broadcast -a com.oculus.vrpowermanager.prox_close.';
  }
  if (power) {
    return `The headset is ${power} but the panel drew nothing, so the frame is black. The session may have dropped out of immersion.`;
  }
  return 'The frame is black: the headset display is off or asleep, or the panel drew nothing at all.';
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
