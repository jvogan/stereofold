import { gzipSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { browserHealthArguments, captureDeviceView, decodeScreencap, deviceClockSeconds, ffmpegPngArguments, findAdb,
  forceStopHeadsetBrowser, frameBrightness, headsetBrowserHealth, parseAdbDevices, parseBrowserHealth, pickAdbSerial,
  pngShape, sanitizeEvidence, screencapArguments, screencapPngArguments,
  ADB_ENV_KEYS, ADB_SERIAL_ENV_KEYS, BROWSER_HEALTH_SECTION, DEVICE_CAPTURE_DEFAULT_SIZE, FFMPEG_ENV_KEYS, QUEST_BROWSER_PACKAGE,
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
 * check has to catch and anything else is a lit one.
 */
function screencap(width: number, height: number, { level = 200, format = 1, headerWords = 4 } = {}) {
  const header = Buffer.alloc(headerWords * 4);
  header.writeUInt32LE(width, 0); header.writeUInt32LE(height, 4); header.writeUInt32LE(format, 8);
  const body = Buffer.alloc(width * height * 4, level);
  return Buffer.concat([header, body]);
}

type Call = { file: string; args: string[]; options: DeviceRunOptions };

/**
 * A fake `adb` and `ffmpeg` that never spawn anything.
 *
 * `frame` is what the device's `screencap` hands back, `encoded` what `ffmpeg`
 * returns, and `devices` what `adb devices` lists. Anything a test wants to
 * break it supplies as a runner of its own.
 */
function hooks(overrides: Partial<DeviceCaptureHooks> & {
  devices?: string; frame?: Buffer; encoded?: Buffer; gzip?: boolean; env?: NodeJS.ProcessEnv;
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
      if (file.endsWith('ffmpeg')) return { stdout: encoded, stderr: '' };
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

  it('tells an empty panel from a lit one', () => {
    expect(frameBrightness(decodeScreencap(screencap(16, 16, { level: 0 }))!)).toEqual({ mean: 0, stddev: 0 });
    expect(frameBrightness(decodeScreencap(screencap(16, 16, { level: 200 }))!).mean).toBeGreaterThan(0.5);
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

  it('reads a PNG shape, or nothing at all', () => {
    expect(pngShape(png(1600, 838))).toEqual({ width: 1600, height: 838 });
    expect(pngShape(Buffer.from('not a png at all, really not'))).toBeUndefined();
    expect(pngShape(Buffer.alloc(8))).toBeUndefined();
  });
});

describe('the device still', () => {
  it('pulls a gzipped frame and encodes it here, never on the headset', async () => {
    const seams = hooks({ frame: screencap(3664, 1920), encoded: png(1600, 838) });
    const outcome = await captureDeviceView({ maxWidth: 1600, hooks: seams });
    expect(outcome).toMatchObject({ ok: true, mimeType: 'image/png', width: 1600, height: 838,
      serial: 'FAKEQUEST00001', wire: 'gzip' });
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
    const seams = hooks({ encoded: png(3664, 1920), exists: async (path: string) => path === '/opt/tools/adb' });
    const outcome = await captureDeviceView({ hooks: seams });
    expect(outcome).toMatchObject({ ok: true, mimeType: 'image/png', width: 3664, height: 1920, wire: 'device-png' });
    // And the 28 MB raw transfer nothing here could decode is never made.
    expect(seams.calls.map(call => call.args.at(-1))).toEqual(['devices', '-p']);
  });

  it('reports a black frame as a headset state, not a capture success', async () => {
    const asleep = hooks({ frame: screencap(64, 64, { level: 0 }),
      run: async (file, args) => {
        if (args[0] === 'devices') return { stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
        if (args.includes('dumpsys')) return { stdout: 'mWakefulness=Asleep\n', stderr: '' };
        return { stdout: gzipSync(screencap(64, 64, { level: 0 })), stderr: '' };
      } });
    const off = await captureDeviceView({ hooks: asleep });
    expect(off.ok).toBe(false);
    expect(!off.ok && off.reason).toMatch(/display is off or asleep/);
    expect(!off.ok && off.reason).toMatch(/prox_close/);

    // Awake and still black is a different sentence: that one is worth chasing.
    const awake = hooks({ run: async (file, args) => {
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
      if (args.includes('dumpsys')) return { stdout: 'mWakefulness=Awake\n', stderr: '' };
      return { stdout: gzipSync(screencap(64, 64, { level: 0 })), stderr: '' };
    } });
    const empty = await captureDeviceView({ hooks: awake });
    expect(!empty.ok && empty.reason).toMatch(/Awake but the panel drew nothing/);

    // A probe that cannot answer still gets a sentence covering both.
    const mute = hooks({ run: async (file, args) => {
      if (args[0] === 'devices') return { stdout: 'List of devices attached\nQUEST2\tdevice\n', stderr: '' };
      if (args.includes('dumpsys')) throw Error('closed');
      return { stdout: gzipSync(screencap(64, 64, { level: 0 })), stderr: '' };
    } });
    const either = await captureDeviceView({ hooks: mute });
    expect(!either.ok && either.reason).toMatch(/off or asleep, or the panel drew nothing/);
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
