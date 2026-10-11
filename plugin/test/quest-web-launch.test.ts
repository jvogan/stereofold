import { describe, expect, it, vi } from 'vitest';
import { parseQuestArgs } from '../scripts/quest-share.js';
import { preferredWebLaunch, rememberedDeviceCount, recoverableWebLaunch } from '../scripts/quest-share.js';
import {
  BROWSER_ENV, WEB_LAUNCH_BASE, chooseBrowser, formatBrowserChoice, formatWebLaunch, openInBrowser, openLocalInBrowser,
  questTargetUrl, resolveBrowser, webLaunchLink,
} from '../scripts/quest-web-launch.js';
import { detachedOpener, type OpenerSpawn } from '../src/quest-launch.js';
import { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markHostOpenedUrl } from '../src/renderer-tab.js';

const ADDRESS = 'https://192.168.77.24:8443/';
const CODE = '12345678';

/** Read the target back out of the link the way Meta's page would. */
function target(link: string): string {
  expect(link.startsWith(WEB_LAUNCH_BASE)).toBe(true);
  return decodeURIComponent(link.slice(WEB_LAUNCH_BASE.length));
}

describe('the Meta Web Launch link', () => {
  it('carries the private address and the one-time code in a fragment', () => {
    expect(questTargetUrl(ADDRESS, CODE)).toBe(`${ADDRESS}#pair=${CODE}`);
    expect(target(webLaunchLink(ADDRESS, CODE))).toBe(`${ADDRESS}#pair=${CODE}`);
  });

  it('omits the fragment when no code is given', () => {
    expect(questTargetUrl(ADDRESS)).toBe(ADDRESS);
    const link = webLaunchLink(ADDRESS);
    expect(link).not.toContain('pair');
    expect(target(link)).toBe(ADDRESS);
  });

  it('percent-encodes the whole target so the fragment survives as one query value', () => {
    const link = webLaunchLink(ADDRESS, CODE);
    // A raw '#' or ':' here would make Meta's page read a fragment or a second
    // scheme of its own instead of the address it is supposed to open.
    expect(link.slice(WEB_LAUNCH_BASE.length)).not.toMatch(/[#:/?&]/);
    expect(link).toContain('%23pair%3D');
  });

  it('refuses anything that is not the printed https address', () => {
    expect(() => questTargetUrl('http://192.168.77.24:8443/')).toThrow('https://');
    expect(() => questTargetUrl('file:///etc/passwd')).toThrow('https://');
    expect(() => questTargetUrl('https://user:pass@192.168.77.24:8443/')).toThrow('no query or fragment');
    expect(() => questTargetUrl(`${ADDRESS}?token=abc`)).toThrow('no query or fragment');
    expect(() => questTargetUrl(`${ADDRESS}#${'a'.repeat(64)}`)).toThrow('no query or fragment');
    expect(() => questTargetUrl('')).toThrow('companion address');
    expect(() => questTargetUrl('not a url')).toThrow('companion address');
  });

  it('refuses a code that is not the eight digits this run printed', () => {
    expect(() => questTargetUrl(ADDRESS, '1234567')).toThrow('eight-digit');
    expect(() => questTargetUrl(ADDRESS, 'abcdefgh')).toThrow('eight-digit');
    expect(() => questTargetUrl(ADDRESS, '12345678\n#x')).toThrow('eight-digit');
  });

  it('prints the link and its one caveat, and never the code on its own line', () => {
    const link = webLaunchLink(ADDRESS, CODE);
    const withCode = formatWebLaunch(link, true);
    expect(withCode).toContain(link);
    expect(withCode).toContain('expires in ten');
    expect(withCode).toContain('only works on this Wi-Fi');
    // The code appears once and only inside the link, never announced on a
    // line of its own that a screen share or a scroll-back would carry.
    expect(withCode.split(CODE)).toHaveLength(2);
    expect(withCode.split('\n').filter(line => line.includes(CODE))).toEqual([`    ${link}`]);
    expect(formatWebLaunch(webLaunchLink(ADDRESS), false)).toContain('already be remembered');
  });

  it('opens only the Web Launch link, and only on macOS', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const launch = (command: string, args: readonly string[]) => { calls.push({ command, args: [...args] }); return { reason: 'started' as const }; };
    const link = webLaunchLink(ADDRESS, CODE);
    expect((await openInBrowser(link, 'darwin', launch)).message).toContain('browser started');
    expect(calls).toEqual([{ command: 'open', args: [link] }]);
    expect((await openInBrowser(link, 'linux', launch)).message).toContain('open the link above');
    expect(calls).toHaveLength(1);
    await expect(openInBrowser(ADDRESS, 'darwin', launch)).rejects.toThrow('Only the Meta Web Launch link');
  });

  it('reports a browser that will not start rather than failing the run', async () => {
    const report = await openInBrowser(webLaunchLink(ADDRESS), 'darwin', () => { throw Error('spawn open ENOENT'); });
    expect(report.message).toContain('could not open your browser');
  });
});

describe('the flags that choose a route to the headset', () => {
  const parse = (...args: string[]) => parseQuestArgs(['1CRN', ...args], '/home/tester');

  it('opens Web Launch by default and leaves adb to the caller', () => {
    expect(parse().webLaunch).toBe('code');
    expect(parse().webLaunchPinned).toBe(false);
    expect(parse('--no-web-launch').webLaunch).toBe('off');
    expect(parse().openOnQuest).toBe('off');
    // Headless renders for a test, not for a wearer, so no browser is wanted.
    expect(parse('--headless').webLaunch).toBe('off');
    expect(parse('--headless', '--web-launch').webLaunch).toBe('code');
  });

  it('carries the code unless the caller opts out', () => {
    expect(parse('--web-launch').webLaunch).toBe('code');
    expect(parse('--web-launch=code').webLaunch).toBe('code');
    expect(parse('--web-launch=no-code').webLaunch).toBe('no-code');
    expect(parse('--open-on-quest').openOnQuest).toBe('code');
    expect(parse('--open-on-quest=no-code').openOnQuest).toBe('no-code');
  });

  it('pins the variant only when the caller names one', () => {
    expect(parse('--web-launch').webLaunchPinned).toBe(false);
    expect(parse('--web-launch=code').webLaunchPinned).toBe(true);
    expect(parse('--web-launch=no-code').webLaunchPinned).toBe(true);
    expect(parse('--no-web-launch').webLaunchPinned).toBe(true);
  });

  it('names a mistyped variant rather than treating it as a value', () => {
    expect(() => parse('--web-launch=nocode')).toThrow('Unknown option');
    expect(() => parse('--open-on-quest=yes')).toThrow('Unknown option');
  });
});

describe('which browser gets the link', () => {
  const installed = (path: string) => path === '/Applications/Google Chrome.app';

  it('takes the default browser when nothing names one', () => {
    expect(resolveBrowser({})).toBeUndefined();
    expect(resolveBrowser({ [BROWSER_ENV]: '   ' })).toBeUndefined();
    expect(chooseBrowser({ environment: {}, exists: installed })).toEqual({});
    expect(formatBrowserChoice({})).toMatch(/--browser "Google Chrome"/);
  });

  it('reads the flag first and the environment second', () => {
    expect(resolveBrowser({ [BROWSER_ENV]: 'Safari' })).toBe('Safari');
    expect(resolveBrowser({ [BROWSER_ENV]: 'Safari' }, 'Google Chrome')).toBe('Google Chrome');
    expect(chooseBrowser({ explicit: 'Google Chrome', environment: {}, home: '/home/tester', exists: installed }))
      .toEqual({ name: 'Google Chrome' });
  });

  it('refuses a name no application could carry', () => {
    expect(() => resolveBrowser({}, 'Chrome\nSafari')).toThrow(BROWSER_ENV);
    expect(() => resolveBrowser({}, 'x'.repeat(201))).toThrow(BROWSER_ENV);
  });

  // `open -a` is spawned detached, so a missing application fails out of sight
  // and the wearer waits at a page that never opened.
  it('falls back to the default browser when the named one is not installed', () => {
    const choice = chooseBrowser({ explicit: 'Firefox', environment: {}, home: '/home/tester', exists: installed });
    expect(choice).toEqual({ missing: 'Firefox' });
    expect(formatBrowserChoice(choice)).toMatch(/Firefox is not installed/);
  });

  it('passes the application to open, and says which one it used', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const launch = (command: string, args: readonly string[]) => { calls.push({ command, args }); return { reason: 'started' as const }; };
    const link = webLaunchLink(ADDRESS, CODE);
    expect((await openInBrowser(link, 'darwin', launch, 'Google Chrome')).message).toContain('browser started · Google Chrome');
    expect(calls[0]).toEqual({ command: 'open', args: ['-a', 'Google Chrome', link] });
    expect((await openInBrowser(link, 'darwin', launch)).message).toContain('browser started');
    expect(calls[1]).toEqual({ command: 'open', args: [link] });
  });

  it('opens the desktop panel in the same browser', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const launch = (command: string, args: readonly string[]) => { calls.push({ command, args }); return { reason: 'started' as const }; };
    const panel = 'http://127.0.0.1:53913/#0123456789abcdef';
    const marked = markHostOpenedUrl(panel);
    expect(marked).toContain('hostOpened=1');
    expect(marked).toContain('#0123456789abcdef');
    expect((await openLocalInBrowser(panel, 'darwin', launch, 'Google Chrome')).message).toContain('it is the renderer');
    expect(calls[0]).toEqual({ command: 'open', args: ['-a', 'Google Chrome', marked] });
    expect((await openLocalInBrowser(panel, 'linux', launch)).message).toContain('it is the renderer');
    expect(calls[1]).toEqual({ command: 'xdg-open', args: [marked] });
    // The panel address is the only loopback page this opens.
    await expect(openLocalInBrowser('https://example.com/', 'darwin', launch)).rejects.toThrow('loopback address');
  });

  it('preserves the original Linux URL rules', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const launch = (command: string, args: readonly string[]) => { calls.push({ command, args }); };
    const link = 'https://example.com/panel#key';
    expect(await openLocalInBrowser(link, 'linux', launch)).toMatchObject({ link, opened: false, reason: 'attempted' });
    expect(calls).toEqual([{ command: 'xdg-open', args: [markHostOpenedUrl(link)] }]);
  });
});

describe('the variant a repeat run uses', () => {
  it('drops the code once this Mac remembers a headset', () => {
    expect(preferredWebLaunch('code', false, 0)).toBe('code');
    expect(preferredWebLaunch('code', false, 1)).toBe('no-code');
    expect(preferredWebLaunch('off', false, 1)).toBe('off');
  });

  it('leaves a named variant alone', () => {
    expect(preferredWebLaunch('code', true, 2)).toBe('code');
    expect(preferredWebLaunch('no-code', true, 0)).toBe('no-code');
  });

  it('reads the remembered list off a manage_companion status', () => {
    expect(rememberedDeviceCount({ rememberedDevices: [{ id: 'a' }, { id: 'b' }] })).toBe(2);
    expect(rememberedDeviceCount({ rememberedDevices: [] })).toBe(0);
    expect(rememberedDeviceCount({})).toBe(0);
    expect(rememberedDeviceCount(undefined)).toBe(0);
  });
});


describe('terminal recovery after an asynchronous spawn failure', () => {
  it.each(['web', 'local-mac', 'local-linux'].flatMap(route => ['ENOENT', 'EACCES'].map(code => ({ route, code }))))
  ('keeps the $route link and manual instructions after real $code', async ({ route, code }) => {
    const directory = mkdtempSync(join(tmpdir(), 'stereofold-terminal-launch-'));
    try {
      // Inject only the executable selection; detachedOpener really calls spawn.
      const openerPath = join(directory, 'test-opener');
      if (code === 'EACCES') writeFileSync(openerPath, 'not executable', { mode: 0o600 });
      const launch = (_command: string, args: readonly string[]) => detachedOpener(openerPath, args);
      const link = route === 'web' ? webLaunchLink(ADDRESS) : 'http://127.0.0.1:53913/#key';
      const report = route === 'web' ? await openInBrowser(link, 'darwin', launch)
        : await openLocalInBrowser(link, route === 'local-mac' ? 'darwin' : 'linux', launch);
      await new Promise(resolve => setImmediate(resolve));
      // Vitest also reports any uncaught error as a failed run. The isolated
      // host regression in quest-launch.test.ts checks exit status and stderr.
      expect(report).toMatchObject({ opened: false, reason: 'failed', code, link });
      expect(report.message).toContain('could not open your browser');
      expect(report.message).toContain('yourself');
      expect(report.message).not.toContain('browser started');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['web', 'local-mac', 'local-linux'])('keeps the %s link and manual instructions after an unanswered opener', async route => {
    vi.useFakeTimers();
    try {
      const child = new ChildProcess();
      const spawnChild = vi.fn<OpenerSpawn>().mockReturnValue(child);
      const launch = (_command: string, args: readonly string[]) => detachedOpener(process.execPath, args, { spawnChild, timeoutMs: 25 });
      const link = route === 'web' ? webLaunchLink(ADDRESS) : 'http://127.0.0.1:53913/#key';
      const pending = route === 'web' ? openInBrowser(link, 'darwin', launch)
        : openLocalInBrowser(link, route === 'local-mac' ? 'darwin' : 'linux', launch);
      expect(spawnChild).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(25);
      expect(vi.getTimerCount()).toBe(0);
      const report = await pending;
      expect(report).toMatchObject({ opened: false, reason: 'attempted', link, detail: 'The opener gave no answer within 25 ms.' });
      expect(report.message).toContain('The opener gave no answer within 25 ms.');
      expect(report.message).toContain(route === 'web' ? 'open the link above' : 'open the panel address above');
      expect(report.message).not.toContain('browser started');
      expect(() => child.emit('error', new Error('late error'))).not.toThrow();
    } finally { vi.useRealTimers(); }
  });
});


describe('asynchronous Web Launch recovery', () => {
  it('waits for the recovery spawn and never announces a failed resend', async () => {
    const launchId = 'a'.repeat(32);
    let finish!: (started: boolean) => void;
    let sends = 0, announcements = 0;
    const controller = recoverableWebLaunch({
      companion: { url: ADDRESS, launchId }, mode: 'no-code',
      send: () => ++sends === 1 ? Promise.resolve(true) : new Promise<boolean>(resolve => { finish = resolve; }),
      freshCode: async () => CODE, recovered: () => { announcements++; },
    });
    await controller.start();
    const recovery = controller.observe({ pairingFailure: { launchId, failure: 'device_key_missing' } });
    await Promise.resolve();
    expect(sends).toBe(2);
    expect(announcements).toBe(0);
    finish(false);
    await recovery;
    expect(announcements).toBe(0);
  });
});
