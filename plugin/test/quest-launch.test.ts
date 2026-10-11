import { describe, expect, it, vi } from 'vitest';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAC_OPEN, MAC_PBCOPY, OPENER_ENV, WEB_LAUNCH_BASE, attemptLocalOpen, attemptWebLaunch, copyAppleLinkToClipboard, headsetLaunchRoute, isLocalCompanionLink, launchCompanion, resolveOpener,
  detachedOpener, GUARDIAN_BLOCKED_MESSAGE, webLaunchLink, type OpenerSpawn,
} from '../src/quest-launch.js';
import { fakeQuestAdb, GUARDIAN_DUMP } from './helpers/fake-quest-adb.js';

const ADDRESS = 'https://192.168.77.24:8443/';
const CODE = '12345678';

/** Records what would have been spawned instead of spawning it. */
function opener() {
  const calls: Array<{ command: string; args: string[] }> = [];
  return { calls, launch: (command: string, args: readonly string[]) => { calls.push({ command, args: [...args] }); return { reason: 'started' as const }; } };
}

describe('choosing the program that opens a URL', () => {
  it('defaults to the absolute path, which is the only form a stripped PATH can run', () => {
    expect(resolveOpener({})).toBe(MAC_OPEN);
    expect(resolveOpener({ [OPENER_ENV]: '   ' })).toBe(MAC_OPEN);
    expect(MAC_OPEN.startsWith('/')).toBe(true);
  });

  it('takes an absolute override so a test can prove a launch without a browser', () => {
    expect(resolveOpener({ [OPENER_ENV]: '/bin/echo' })).toBe('/bin/echo');
    expect(() => resolveOpener({ [OPENER_ENV]: 'echo' })).toThrow('absolute path');
  });

  it('opens only the Meta link, whatever the opener is', async () => {
    const spy = opener();
    await expect(attemptWebLaunch({ link: ADDRESS, platform: 'darwin', launch: spy.launch })).rejects.toThrow('Only the Meta Web Launch link');
    expect(spy.calls).toHaveLength(0);
  });
});

describe('opening a page this Mac serves to itself', () => {
  const detailed = 'http://127.0.0.1:52341/detailed#0123456789abcdef';

  it('opens the loopback address it was handed, and nothing else', async () => {
    const spy = opener();
    const attempt = await attemptLocalOpen({ link: detailed, platform: 'darwin', opener: '/bin/echo', launch: spy.launch });
    expect(attempt).toEqual({ opened: true, reason: 'started', link: detailed });
    expect(spy.calls).toEqual([{ command: '/bin/echo', args: [detailed] }]);
    expect((await attemptLocalOpen({ link: 'http://localhost:52341/detailed#abc', platform: 'darwin', launch: spy.launch })).opened).toBe(true);
  });

  it('refuses every address that is not this Mac serving itself', async () => {
    const spy = opener();
    for (const link of ['https://example.com/', 'http://192.168.77.24:8443/#k', 'http://127.0.0.1.example.com:80/#k',
      'http://user:secret@127.0.0.1:52341/#k', 'http://127.0.0.1/#k', 'file:///etc/passwd', 'not a url'])
      await expect(attemptLocalOpen({ link, platform: 'darwin', launch: spy.launch }), link).rejects.toThrow('loopback address');
    expect(spy.calls).toHaveLength(0);
    expect(isLocalCompanionLink(detailed)).toBe(true);
    expect(isLocalCompanionLink('http://127.0.0.1:52341/')).toBe(true);
  });

  it('says plainly that it opened nothing off macOS or when the spawn fails', async () => {
    expect(await attemptLocalOpen({ link: detailed, platform: 'linux', launch: () => { throw Error('unreachable'); } }))
      .toEqual({ opened: false, reason: 'not-macos', link: detailed });
    expect(await attemptLocalOpen({ link: detailed, platform: 'darwin', launch: () => { throw Error('spawn ENOENT'); } }))
      .toEqual({ opened: false, reason: 'failed', detail: 'spawn ENOENT', link: detailed });
  });
});

describe('launching the companion from the server', () => {
  it('returns the actual adb error and scoped recovery alongside an automatic Web Launch fallback', async () => {
    const spy=opener();
    const report=await launchCompanion({mode:'auto',target:'meta',companionUrl:ADDRESS,code:CODE,
      environment:{STEREOFOLD_CONFIG:'/fixture/missing-config.json',STEREOFOLD_QUEST_ADDRESS:'192.168.77.5:5555'},
      platform:'darwin',launch:spy.launch,find:()=>'/fixture/adb',
      run:async(_command,args)=>({code:0,stdout:args[0]==='connect'
        ?'failed to connect to 192.168.77.5:5555: No route to host':'List of devices attached\n',stderr:''})});
    expect(report).toMatchObject({route:'meta-web',opened:true,
      debugging:{available:false,kind:'no-route',stage:'connect',detail:expect.stringContaining('No route to host')}});
    expect(report.debugging?.hint).toContain('adb kill-server');
    expect(report.message).toContain('No route to host');
    expect(spy.calls).toHaveLength(1);
  });

  it('preserves a failed debugging discovery when auto falls back to Web Launch', async () => {
    const spy=opener();
    const report=await launchCompanion({mode:'auto',target:'meta',companionUrl:ADDRESS,code:CODE,
      environment:{STEREOFOLD_CONFIG:'/fixture/missing-config.json'},platform:'darwin',launch:spy.launch,
      find:()=>'/fixture/adb',run:async()=>({code:0,stdout:'List of devices attached\n',stderr:''})});
    expect(report).toMatchObject({route:'meta-web',opened:true,debugging:{available:false}});
    expect(report.debugging?.detail).toContain('No authorized Quest debugging connection was verified');
    expect(report.message).toContain('does not establish whether the headset is on');
    expect(report.message).toContain('headset delivery is not confirmed');
    expect(spy.calls).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain(CODE);
  });

  it('copies the one-time Apple link through pbcopy stdin without exposing the code in the launch report', async () => {
    const spy = opener();
    const stdin = new PassThrough();
    let copied = '';
    stdin.on('data', chunk => { copied += chunk.toString(); });
    const child = Object.assign(new EventEmitter(), { stdin }) as unknown as ChildProcess;
    const clipboardSpawn = vi.fn<OpenerSpawn>().mockImplementation(() => {
      stdin.once('finish', () => queueMicrotask(() => child.emit('close', 0)));
      return child;
    });
    const report = await launchCompanion({ mode: 'auto', target: 'apple', companionUrl: ADDRESS, code: CODE,
      platform: 'darwin', opener: '/bin/echo', launch: spy.launch, clipboardSpawn, find: () => '/opt/homebrew/bin/adb' });
    expect(spy.calls).toHaveLength(0);
    expect(clipboardSpawn).toHaveBeenCalledWith(MAC_PBCOPY, [], { stdio: ['pipe', 'ignore', 'ignore'] });
    expect(copied).toBe(`${ADDRESS}#pair=${CODE}`);
    expect(report).toMatchObject({ mode: 'auto', opened: false, target: 'apple', address: ADDRESS, handoff: 'clipboard' });
    expect(report.message).toContain('Universal Clipboard');
    expect(report.message).toContain('expires with the pairing code');
    expect(report.message).toContain('This Connection Is Not Private');
    expect(JSON.stringify(report)).not.toContain(CODE);
  });

  it('does not infer Vision Pro from a missing optional developer tool', async () => {
    const spy = opener();
    expect(headsetLaunchRoute({ mode: 'auto', target: 'auto', find: () => undefined })).toBe('manual');
    const report = await launchCompanion({ mode: 'auto', target: 'auto', companionUrl: ADDRESS, code: CODE,
      platform: 'darwin', opener: '/bin/echo', launch: spy.launch, find: () => undefined });
    expect(spy.calls).toHaveLength(0);
    expect(report).toMatchObject({ mode: 'auto', opened: false, route: 'manual', address: ADDRESS,
      handoff: 'manual' });
    expect(report.target).toBeUndefined();
    expect(report.message).not.toContain('Safari');
    expect(JSON.stringify(report)).not.toContain(CODE);
  });

  it('keeps manual Apple pairing explicit and falls back when clipboard delivery fails', async () => {
    const spawnChild = vi.fn<OpenerSpawn>().mockImplementation(() => { throw Error(`private ${CODE}`); });
    const manual = await launchCompanion({ mode: 'auto', target: 'apple', appleHandoff: 'manual', companionUrl: ADDRESS,
      code: CODE, platform: 'darwin', clipboardSpawn: spawnChild });
    expect(spawnChild).not.toHaveBeenCalled();
    const failed = await launchCompanion({ mode: 'auto', target: 'apple', companionUrl: ADDRESS,
      code: CODE, platform: 'darwin', clipboardSpawn: spawnChild });
    for (const report of [manual, failed]) {
      expect(report.handoff).toBe('manual');
      expect(report.message).toContain('enter the pairing code');
      expect(JSON.stringify(report)).not.toContain(CODE);
    }
    expect(spawnChild).toHaveBeenCalledOnce();
  });

  it('kills a stalled clipboard child before reporting manual pairing, even if kill emits a successful close', async () => {
    vi.useFakeTimers();
    try {
      const stdin = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdin, kill: vi.fn(() => {
        child.emit('close', 0);
        return true;
      }) }) as unknown as ChildProcess;
      const pending = launchCompanion({ mode: 'auto', target: 'apple', companionUrl: ADDRESS, code: CODE,
        platform: 'darwin', clipboardSpawn: () => child });
      await vi.advanceTimersByTimeAsync(3_000);
      const report = await pending;
      expect(child.kill).toHaveBeenCalledOnce();
      expect(report.handoff).toBe('manual');
      child.emit('close', 0);
      expect(report.handoff).toBe('manual');
    } finally { vi.useRealTimers(); }
  });

  it('kills the clipboard child when stdin fails before reporting manual pairing', async () => {
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, kill: vi.fn(() => {
      child.emit('close', 0);
      return true;
    }) }) as unknown as ChildProcess;
    const pending = launchCompanion({ mode: 'auto', target: 'apple', companionUrl: ADDRESS, code: CODE,
      platform: 'darwin', clipboardSpawn: () => child });
    stdin.emit('error', new Error('stdin closed'));
    const report = await pending;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(report.handoff).toBe('manual');
  });

  it('refuses to copy on other platforms without spawning', async () => {
    const spawnChild = vi.fn<OpenerSpawn>();
    expect(await copyAppleLinkToClipboard(ADDRESS, CODE, { platform: 'linux', spawnChild })).toBe(false);
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it('keeps explicit Meta Web Launch available without adb', async () => {
    const spy = opener();
    const report = await launchCompanion({ mode: 'auto', target: 'meta', companionUrl: ADDRESS, code: CODE,
      platform: 'darwin', opener: '/bin/echo', launch: spy.launch, find: () => undefined });
    expect(report).toMatchObject({ mode: 'auto', opened: true });
    expect(spy.calls[0].args[0]).toBe(webLaunchLink(ADDRESS, CODE));
  });

  it('automatically launches on a verified Wi-Fi Quest without opening Meta', async () => {
    const spy = opener();
    const fake = fakeQuestAdb({ devices: 'List of devices attached\n192.168.77.22:5555\tdevice\n' });
    const report = await launchCompanion({ mode: 'auto', target: 'meta', companionUrl: ADDRESS,
      code: CODE, environment: { STEREOFOLD_CONFIG: '/dev/null' }, run: fake.run,
      find: () => '/test/adb', launch: spy.launch, recheckMs: 0 });
    expect(report).toMatchObject({ mode: 'auto', route: 'adb', opened: true, reason: 'attempted' });
    expect(spy.calls).toHaveLength(0);
    expect(fake.calls.some(call => call.args.includes('start'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain(CODE);
  });

  it('uses Meta for a first-time Quest user without any authorized device', async () => {
    const spy = opener();
    const fake = fakeQuestAdb({ devices: 'List of devices attached\n' });
    const report = await launchCompanion({ mode: 'auto', target: 'meta', companionUrl: ADDRESS,
      code: CODE, environment: { STEREOFOLD_CONFIG: '/dev/null' }, run: fake.run,
      find: () => '/test/adb', platform: 'darwin', launch: spy.launch });
    expect(report).toMatchObject({ route: 'meta-web', reason: 'started' });
    expect(report.message).toContain('headset delivery is not confirmed');
    expect(report.message).toContain('account setup');
    expect(spy.calls).toHaveLength(1);
    expect(fake.calls.some(call => call.args.includes('start'))).toBe(false);
  });

  it('does not bypass a refused device identity when adb was explicitly requested', async () => {
    const run = vi.fn(async (_command: string, args: readonly string[]) => ({ code: 0, stderr: '',
      stdout: args[0] === 'devices' ? 'List of devices attached\nPHONE\tdevice\n'
        : '[ro.product.model]: [Pixel 9]\n[ro.serialno]: [PHONE]\n' }));
    const report = await launchCompanion({ mode: 'adb', target: 'meta', companionUrl: ADDRESS,
      environment: { STEREOFOLD_CONFIG: '/dev/null' }, run, find: () => '/test/adb' });
    expect(report).toMatchObject({ route: 'adb', opened: false, reason: 'failed' });
    expect(report.message).toContain('verified as a Quest');
    expect(run.mock.calls.some(([,args]) => args.includes('start'))).toBe(false);
  });

  // 2026-09-28: the agent relays this sentence once, so it has
  // to carry every step a new user meets, in the order they meet them.
  it('lists the steps after a started Web Launch in the order the person meets them', async () => {
    const report = await launchCompanion({ mode: 'web', companionUrl: ADDRESS, code: CODE, platform: 'darwin', opener: '/bin/echo', launch: opener().launch });
    const steps = ['click Open once', 'signed in to the headset’s Meta account', 'click Allow', 'select the Web Launch notification',
      '“Your connection is not private”, select Advanced, then Proceed', 'Tap Enter VR'];
    const at = steps.map(step => report.message.indexOf(step));
    expect(at, report.message).not.toContain(-1);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  // The Vision Pro result is relayed once too, so it runs to the immersive view.
  it('lists the Vision Pro steps through Enter VR and Safari’s Allow, in order', async () => {
    const report = await launchCompanion({ mode: 'auto', target: 'apple', appleHandoff: 'manual', companionUrl: ADDRESS, code: CODE,
      platform: 'darwin' });
    const steps = ['Safari on Vision Pro', 'This Connection Is Not Private', 'tap Enter VR',
      'choose Allow when Safari asks whether the page may launch an immersive experience'];
    const at = steps.map(step => report.message.indexOf(step));
    expect(at, report.message).not.toContain(-1);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('opens the link with the code and reports it in a sentence, without repeating the code', async () => {
    const spy = opener();
    const report = await launchCompanion({ mode: 'web', companionUrl: ADDRESS, code: CODE, platform: 'darwin', opener: '/bin/echo', launch: spy.launch });
    expect(spy.calls).toEqual([{ command: '/bin/echo', args: [webLaunchLink(ADDRESS, CODE)] }]);
    expect(report.opened).toBe(true);
    expect(report.message).toContain('click Open');
    expect(report.message).toContain('expires in ten minutes');
    // The result already carries the code once as companion.pairingCode. The
    // link handed back for a manual retry therefore carries no code at all.
    expect(JSON.stringify(report)).not.toContain(CODE);
    expect(report.link).toBe(webLaunchLink(ADDRESS));
    expect(report.link?.startsWith(WEB_LAUNCH_BASE)).toBe(true);
  });

  it('uses the absolute macOS opener when the caller injects nothing', async () => {
    const spy = opener();
    const report = await launchCompanion({ mode: 'web', companionUrl: ADDRESS, code: CODE, platform: 'darwin', environment: {}, launch: spy.launch });
    expect(spy.calls[0].command).toBe(MAC_OPEN);
    expect(report.opened).toBe(true);
  });

  it('says plainly that it opened nothing off macOS or when the spawn fails', async () => {
    const elsewhere = await launchCompanion({ mode: 'web', companionUrl: ADDRESS, code: CODE, platform: 'linux', launch: () => { throw Error('unreachable'); } });
    expect(elsewhere.opened).toBe(false);
    expect(elsewhere.message).toContain('only on macOS');
    expect(elsewhere.link).toBe(webLaunchLink(ADDRESS));
    const broken = await launchCompanion({ mode: 'web', companionUrl: ADDRESS, code: CODE, platform: 'darwin', opener: '/bin/echo', launch: () => { throw Error('spawn ENOENT'); } });
    expect(broken.opened).toBe(false);
    expect(broken.message).toContain('spawn ENOENT');
    expect(broken.link).toBe(webLaunchLink(ADDRESS));
  });

  it('refuses an address that is not the printed companion origin', async () => {
    await expect(launchCompanion({ mode: 'web', companionUrl: 'http://192.168.77.24:8443/', platform: 'darwin', launch: () => {} })).rejects.toThrow('https://');
    await expect(launchCompanion({ mode: 'adb', companionUrl: `${ADDRESS}?token=abc`, platform: 'darwin' })).rejects.toThrow();
  });

  it('fires one VIEW intent carrying the code and names the device it reached', async () => {
    // Around the intent the launch lists the devices, reads the headset and
    // asks whether Quest Browser is on it, then fires the intent at it by name.
    const fake = fakeQuestAdb({ devices: 'List of devices attached\n1WMHH000X0 device\n' });
    const report = await launchCompanion({ mode: 'adb', companionUrl: ADDRESS, code: CODE, run: fake.run,
      find: () => '/opt/homebrew/bin/adb', recheckMs: 0 });
    expect(report).toMatchObject({ opened: true, reason: 'attempted', headset: { guardianDialog: false } });
    expect(report.message).toContain('1WMHH000X0');
    const intents = fake.calls.filter(call => call.args.includes('am'));
    expect(intents).toHaveLength(1);
    expect(intents[0]!.args).toContain(`${ADDRESS}#pair=${CODE}`);
    expect(intents[0]!.args).toEqual(expect.arrayContaining(['-p', 'com.oculus.browser']));
    // The CLI indents every line it prints; a tool result is a sentence.
    expect(report.message.startsWith(' ')).toBe(false);
  });

  it('reports Meta\'s boundary screen as a failed launch in words the agent can repeat', async () => {
    const fake = fakeQuestAdb({ activities: GUARDIAN_DUMP });
    const report = await launchCompanion({ mode: 'adb', companionUrl: ADDRESS, code: CODE, run: fake.run,
      find: () => '/opt/homebrew/bin/adb', recheckMs: 0 });
    expect(report).toMatchObject({ opened: false, reason: 'failed', blocked: 'guardian-dialog' });
    expect(report.message).toBe(GUARDIAN_BLOCKED_MESSAGE);
    expect(fake.calls.some(call => call.args.includes('am'))).toBe(false);
  });

  it('calls a kept tab started rather than attempted, and sends no intent', async () => {
    const fake = fakeQuestAdb();
    const report = await launchCompanion({ mode: 'adb', companionUrl: ADDRESS, code: CODE, run: fake.run,
      find: () => '/opt/homebrew/bin/adb', recheckMs: 0, tabs: { before: async () => ({ probed: true, launch: false, keep: '71',
        closed: ['70'], tabs: [], strip: { enumerated: true, stranded: 0, closed: 0 }, note: 'Kept the live viewer tab 71 (menu).' }) } });
    expect(report).toMatchObject({ opened: true, reason: 'started', tabHygiene: { keep: '71' } });
    expect(report.message).toBe('Kept the live viewer tab 71 (menu). The wearer is already on the page.');
    expect(fake.calls.some(call => call.args.includes('am'))).toBe(false);
  });

  it('reports this host could not find adb without claiming the headset is absent', async () => {
    const report = await launchCompanion({ mode: 'adb', companionUrl: ADDRESS, code: CODE, find: () => undefined });
    expect(report.opened).toBe(false);
    expect(report.message).toContain('This host could not find an adb executable');
  });
});


describe('real child-process launch acknowledgements', () => {
  it.each(['ENOENT', 'EACCES'])('survives %s and preserves structured failures and manual links in an isolated host', code => {
    const directory = mkdtempSync(join(tmpdir(), 'stereofold-launch-'));
    try {
      const missing = join(directory, 'nonexistent-opener');
      if (code === 'EACCES') writeFileSync(missing, 'not executable', { mode: 0o600 });
      const moduleUrl = new URL('../src/quest-launch.ts', import.meta.url).href;
      // Use Node directly with tsx's loader; the tsx CLI itself binds an IPC socket.
      // An unhandled error still terminates this host, independently of Vitest.
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
        import { attemptWebLaunch, attemptLocalOpen, openLocalInBrowser, launchCompanion } from ${JSON.stringify(moduleUrl)};
        process.on('uncaughtExceptionMonitor', error => console.error('UNHANDLED', error));
        const opener = ${JSON.stringify(missing)};
        const web = await attemptWebLaunch({ link: ${JSON.stringify(webLaunchLink(ADDRESS))}, platform: 'darwin', opener });
        const local = await attemptLocalOpen({ link: 'http://127.0.0.1:52341/detailed#key', platform: 'darwin', opener });
        const report = await launchCompanion({ mode: 'web', companionUrl: ${JSON.stringify(ADDRESS)},
          code: ${JSON.stringify(CODE)}, platform: 'darwin', opener, environment: {} });
        process.env.PATH = ${JSON.stringify(directory)};
        const linux = await openLocalInBrowser('http://127.0.0.1:52341/#key', 'linux');
        await new Promise(resolve => setImmediate(resolve));
        console.log(JSON.stringify({ web, local, linux, report }));
      `], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15_000 });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.signal).toBeNull();
      expect(child.stderr).toBe('');
      const { web, local, linux, report } = JSON.parse(child.stdout);
      for (const outcome of [web, local, report]) {
        expect(outcome).toMatchObject({ opened: false, reason: 'failed', code });
        expect(outcome.detail).toContain(code);
        expect(outcome.detail).toContain(missing);
      }
      expect(linux).toMatchObject({ opened: false, reason: 'failed', code: 'ENOENT', link: 'http://127.0.0.1:52341/#key' });
      expect(linux.detail).toContain('xdg-open');
      expect(linux.message).toContain('open the panel address above yourself');
      expect(web.link).toBe(webLaunchLink(ADDRESS));
      expect(local.link).toBe('http://127.0.0.1:52341/detailed#key');
      expect(report.link).toBe(webLaunchLink(ADDRESS));
      expect(report.message).toContain('Open the link below yourself');
      expect(JSON.stringify(report)).not.toContain(CODE);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('reports started after an actual dispatcher exits successfully', async () => {
    const result = await attemptWebLaunch({ link: webLaunchLink(ADDRESS), platform: 'darwin',
      launch: () => detachedOpener(process.execPath, ['-e', 'process.exit(0)']) });
    expect(result).toEqual({ opened: true, reason: 'started', link: webLaunchLink(ADDRESS) });
  });

  it('reports a failed dispatch when the opener immediately exits with code 3', async () => {
    let exited!: Promise<number | null>;
    const spawnChild: OpenerSpawn = (...args) => {
      const child = spawn(...args);
      exited = new Promise(resolve => child.once('exit', resolve));
      return child;
    };
    const report = await launchCompanion({ mode: 'web', companionUrl: ADDRESS, platform: 'darwin', environment: {},
      launch: () => detachedOpener(process.execPath, ['-e', 'process.exit(3)'], { spawnChild }) });
    expect(report).toMatchObject({ opened: false, reason: 'failed', code: 'EXIT_3',
      detail: 'The opener exited with status 3.', link: webLaunchLink(ADDRESS) });
    expect(report.message).toContain('Could not open');
    expect(report.message).not.toContain('Browser started');
    expect(await exited).toBe(3);
  });

  it('reports a dispatcher terminated by a signal as failed', async () => {
    expect(await detachedOpener(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']))
      .toMatchObject({ reason: 'failed', code: 'SIGTERM', detail: 'The opener was terminated by SIGTERM.' });
  });

  it.each([undefined, 25])('bounds an unanswered opener (timeout override: %s) and retains manual recovery and late error handling', async timeoutMs => {
    vi.useFakeTimers();
    try {
      const child = new ChildProcess();
      const kill = vi.spyOn(child, 'kill');
      const spawnChild = vi.fn<OpenerSpawn>().mockReturnValue(child);
      let settled = false;
      const pending = launchCompanion({ mode: 'web', companionUrl: ADDRESS, code: CODE, platform: 'darwin', environment: {}, opener: process.execPath,
        launch: (command, args) => detachedOpener(command, args, { spawnChild, timeoutMs }) })
        .then(report => { settled = true; return report; });
      expect(spawnChild).toHaveBeenCalledOnce();
      child.emit('spawn'); // A running dispatcher is not a successful handoff.
      const deadline = timeoutMs ?? 3_000;
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const report = await pending;
      expect(report).toMatchObject({ opened: false, reason: 'attempted', link: webLaunchLink(ADDRESS),
        detail: `The opener gave no answer within ${deadline} ms.` });
      expect(report.message).toContain(report.detail);
      expect(report.message).toContain('open the link below yourself');
      expect(report.message).toContain('enter the pairing code once on the headset');
      expect(JSON.stringify(report)).not.toContain(CODE);
      expect(() => child.emit('error', new Error('late opener error'))).not.toThrow();
      child.emit('exit', 0, null);
      expect(await pending).toBe(report);
      expect(kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['exit', 'error', 'throw'])('clears the acknowledgement timer after %s', async event => {
    vi.useFakeTimers();
    try {
      const child = new ChildProcess();
      const spawnChild = vi.fn<OpenerSpawn>().mockImplementation(() => {
        if (event === 'throw') throw new Error('synchronous failure');
        return child;
      });
      const pending = detachedOpener(process.execPath, [], { spawnChild, timeoutMs: 25 });
      expect(spawnChild).toHaveBeenCalledOnce();
      if (event === 'exit') child.emit('exit', 0, null);
      if (event === 'error') child.emit('error', new Error('asynchronous failure'));
      expect(await pending).toMatchObject({ reason: event === 'exit' ? 'started' : 'failed' });
      expect(vi.getTimerCount()).toBe(0);
      if (event !== 'throw') expect(() => child.emit('error', new Error('late error'))).not.toThrow();
    } finally { vi.useRealTimers(); }
  });

  it('awaits the launcher and distinguishes a dispatch-only acknowledgement', async () => {
    let finish!: (outcome: { reason: 'started' }) => void;
    const launch = () => new Promise<{ reason: 'started' }>(resolve => { finish = resolve; });
    let settled = false;
    const pending = attemptWebLaunch({ link: webLaunchLink(ADDRESS), platform: 'darwin', launch })
      .then(result => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish({ reason: 'started' });
    expect(await pending).toMatchObject({ opened: true, reason: 'started' });
    const attempted = await launchCompanion({ mode: 'web', companionUrl: ADDRESS, platform: 'darwin',
      environment: {}, launch: () => {} });
    expect(attempted).toMatchObject({ opened: false, reason: 'attempted', link: webLaunchLink(ADDRESS) });
    expect(attempted.message).toContain('Launch attempted');
    expect(attempted.message).not.toContain('Browser started');
  });
});
