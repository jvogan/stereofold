import { describe, expect, it, vi } from 'vitest';
import { adbCandidates, findAdb, hasPackage, openOnQuest, parseAdbDevices, QUEST_BROWSER_PACKAGE, selectDevice,
  viewIntentArgs, type RunResult, type Runner } from '../scripts/quest-open-on-device.js';
import { GUARDIAN_AFTER_LAUNCH_MESSAGE, GUARDIAN_BLOCKED_MESSAGE, GUARDIAN_DURING_LAUNCH_MESSAGE, type LaunchTabHygiene } from '../src/quest-launch.js';
import { BROWSER_START, CLEAR_DUMP, fakeQuestAdb, GUARDIAN_DUMP, powerDump, SOCKET_COUNT, STALE_GUARDIAN_DUMP,
  type FakeHeadset } from './helpers/fake-quest-adb.js';

const ADDRESS = 'https://192.168.77.24:8443/';

/** A fake adb: records every call and answers from a scripted list. */
function spawner(...results: RunResult[]) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const queue = [...results];
  return { calls, run: async (command: string, args: readonly string[]) => { calls.push({ command, args: [...args] }); return queue.shift() ?? { code: -1, stdout: '', stderr: 'no scripted result' }; } };
}

const devices = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const ok: RunResult = { code: 0, stdout: 'Starting: Intent { act=android.intent.action.VIEW dat=https://192.168.77.24:8443/ }', stderr: '' };
/**
 * What `pm list packages com.oculus.browser` answers. A Quest 2 with Quest
 * Browser prints the one line; a device without it prints nothing and exits 0.
 */
const packages = (installed: boolean): RunResult => ({ code: 0, stdout: installed ? `package:${QUEST_BROWSER_PACKAGE}\n` : '', stderr: '' });
const PACKAGE_QUERY = ['shell', 'pm', 'list', 'packages', QUEST_BROWSER_PACKAGE];

describe('opening the companion address on a connected Quest', () => {
  it('builds the exact VIEW intent and refuses an address carrying a secret', () => {
    expect(viewIntentArgs(ADDRESS)).toEqual(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', ADDRESS]);
    // A session token in the fragment or query would end up on a command line
    // every process on this Mac can read.
    expect(() => viewIntentArgs(`${ADDRESS}#${'a'.repeat(64)}`)).toThrow('only a #pair=<code> fragment');
    expect(() => viewIntentArgs(`${ADDRESS}?token=abc`)).toThrow('no query string');
    expect(() => viewIntentArgs('http://192.168.77.24:8443/')).toThrow('https://');
    expect(() => viewIntentArgs('https://user:pass@192.168.77.24:8443/')).toThrow('https://');
    expect(() => viewIntentArgs('not a url')).toThrow('companion address');
  });

  it('allows only the one-time pairing code in the fragment', () => {
    // adb runs over a debugging connection the headset already authorized to
    // this Mac, so a one-time code that expires in ten minutes may ride along.
    expect(viewIntentArgs(`${ADDRESS}#pair=12345678`).at(-1)).toBe(`${ADDRESS}#pair=12345678`);
    expect(() => viewIntentArgs(`${ADDRESS}#pair=1234567`)).toThrow('only a #pair=<code> fragment');
    expect(() => viewIntentArgs(`${ADDRESS}#pair=123456789`)).toThrow('only a #pair=<code> fragment');
    expect(() => viewIntentArgs(`${ADDRESS}#pair=abcdefgh`)).toThrow('only a #pair=<code> fragment');
    expect(() => viewIntentArgs(`${ADDRESS}#pair=12345678&token=abc`)).toThrow('only a #pair=<code> fragment');
    expect(() => viewIntentArgs(`${ADDRESS}?pair=12345678`)).toThrow('no query string');
  });

  it('reads adb devices, ignoring the header and daemon lines', () => {
    expect(parseAdbDevices('* daemon not running; starting now\nList of devices attached\n1WMHH000X00000\tdevice\n\n')).toEqual([{ serial: '1WMHH000X00000', state: 'device' }]);
    expect(parseAdbDevices('List of devices attached\nA\tdevice\nB\toffline\nC\tunauthorized\n')).toEqual([
      { serial: 'A', state: 'device' }, { serial: 'B', state: 'offline' }, { serial: 'C', state: 'unauthorized' }]);
    expect(parseAdbDevices('')).toEqual([]);
  });

  it('opens only when exactly one device is in state device', () => {
    expect(selectDevice([{ serial: 'A', state: 'device' }]).device?.serial).toBe('A');
    expect(selectDevice([{ serial: 'A', state: 'device' }, { serial: 'B', state: 'device' }]).problem).toContain('2 connected devices');
    expect(selectDevice([{ serial: 'A', state: 'offline' }]).problem).toContain('no connected device');
    expect(selectDevice([{ serial: 'A', state: 'unauthorized' }]).problem).toContain('authorized this Mac');
    expect(selectDevice([]).problem).toContain('no connected device');
  });

  it('looks for adb on PATH first, then Homebrew and the Android SDK', () => {
    const environment = { PATH: '/usr/bin:relative/bin:/opt/homebrew/bin' } as NodeJS.ProcessEnv;
    expect(adbCandidates(environment, '/home/tester')).toEqual([
      '/usr/bin/adb', '/opt/homebrew/bin/adb', '/usr/local/bin/adb', '/home/tester/Library/Android/sdk/platform-tools/adb']);
    expect(findAdb({ environment, home: '/home/tester', executable: path => path === '/home/tester/Library/Android/sdk/platform-tools/adb' }))
      .toBe('/home/tester/Library/Android/sdk/platform-tools/adb');
    expect(findAdb({ environment, home: '/home/tester', executable: () => false })).toBeUndefined();
  });

  it('wakes a sleeping headset before the intent, because Quest Browser drops one sent while it sleeps', async () => {
    const fake = fakeQuestAdb({ power: [powerDump({ display: 'Asleep' }), powerDump({ display: 'Awake', wokeMsAgo: 200 })] });
    const result = await openOnQuest({ url: ADDRESS, adb: '/opt/homebrew/bin/adb', run: fake.run, recheckMs: 0, settleMs: 0, wakeMs: 50 });
    expect(result.opened).toBe(true);
    const asked = fake.asked();
    expect(asked).toContain('shell input keyevent KEYCODE_WAKEUP');
    expect(asked.indexOf('shell input keyevent KEYCODE_WAKEUP')).toBeLessThan(asked.findIndex(line => line.startsWith('shell am start')));
    expect(result.headset?.display).toBe('Awake');
  });

  it('sends nothing to a headset that stays asleep, and says what to do', async () => {
    const fake = fakeQuestAdb({ power: powerDump({ display: 'Asleep' }) });
    const result = await openOnQuest({ url: ADDRESS, adb: '/opt/homebrew/bin/adb', run: fake.run, recheckMs: 0, settleMs: 0, wakeMs: 30 });
    expect(result).toMatchObject({ opened: false, blocked: 'asleep' });
    expect(result.message).toContain('asleep and did not wake');
    expect(result.message).toContain('power button');
    expect(fake.asked().some(line => line.startsWith('shell am start'))).toBe(false);
  });

  it('gives the boundary answer, not the asleep one, when the boundary screen comes up during the wake', async () => {
    const fake = fakeQuestAdb({ power: powerDump({ display: 'Asleep' }), activities: [CLEAR_DUMP, GUARDIAN_DUMP] });
    const result = await openOnQuest({ url: ADDRESS, adb: '/opt/homebrew/bin/adb', run: fake.run, recheckMs: 0, settleMs: 0, wakeMs: 30 });
    expect(fake.asked()).toContain('shell input keyevent KEYCODE_WAKEUP');
    expect(result).toEqual({ opened: false, blocked: 'guardian-dialog', headset: { guardianDialog: true }, message: `  ${GUARDIAN_BLOCKED_MESSAGE}` });
    expect(fake.asked().some(line => line.startsWith('shell am start'))).toBe(false);
  });

  it('does not press the wake key on a headset that is already awake', async () => {
    const fake = fakeQuestAdb();
    await openOnQuest({ url: ADDRESS, adb: '/opt/homebrew/bin/adb', run: fake.run, recheckMs: 0, settleMs: 0 });
    expect(fake.asked()).not.toContain('shell input keyevent KEYCODE_WAKEUP');
  });

  it('reads the headset, sends the intent, reads it again, and reports the serial it opened on', async () => {
    const fake = fakeQuestAdb({ devices: 'List of devices attached\n1WMHH000X00000\tdevice\n' });
    const result = await openOnQuest({ url: ADDRESS, adb: '/opt/homebrew/bin/adb', run: fake.run, recheckMs: 0 });
    expect(result.opened).toBe(true);
    expect(result.message).toContain('1WMHH000X00000');
    const pinned = (...args: string[]) => ({ command: '/opt/homebrew/bin/adb', args: ['-s', '1WMHH000X00000', ...args] });
    expect(fake.calls).toEqual([
      { command: '/opt/homebrew/bin/adb', args: ['devices'] },
      pinned('shell', 'dumpsys', 'activity', 'activities'),
      pinned('shell', 'dumpsys', 'power'),
      pinned('shell', 'pidof', QUEST_BROWSER_PACKAGE),
      pinned(...PACKAGE_QUERY),
      pinned('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-p', QUEST_BROWSER_PACKAGE, '-d', ADDRESS),
      pinned('shell', 'dumpsys', 'activity', 'activities')]);
  });

  it('names Quest Browser only when the headset has it', async () => {
    // This Quest 2 carries org.mozilla.vrbrowser as well, so an unrestricted
    // VIEW intent can raise a chooser the wearer has to answer inside the
    // headset, or land the companion page in a browser holding none of its
    // grants. A device without Quest Browser keeps the old unrestricted intent
    // rather than failing the launch.
    const absent = fakeQuestAdb({ devices: 'List of devices attached\nA\tdevice\n', packages: false });
    const opened = await openOnQuest({ url: ADDRESS, adb: '/opt/homebrew/bin/adb', run: absent.run, recheckMs: 0 });
    expect(opened.opened).toBe(true);
    expect(absent.calls.find(call => call.args.includes('am'))?.args)
      .toEqual(['-s', 'A', 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', ADDRESS]);

    // A query that cannot run is read as "not installed", never as a reason to
    // give up on opening the page.
    const broken = fakeQuestAdb({ devices: 'List of devices attached\nA\tdevice\n', packages: { code: 1, stdout: '', stderr: 'device offline' } });
    const still = await openOnQuest({ url: ADDRESS, adb: '/opt/homebrew/bin/adb', run: broken.run, recheckMs: 0 });
    expect(still.opened).toBe(true);
    expect(broken.calls.find(call => call.args.includes('am'))?.args).not.toContain('-p');
  });

  it('reads pm list packages as an exact match, and rejects a package name that is not one', async () => {
    // `pm list packages` matches on substring, so a look-alike is not an answer.
    const run = async (_command: string, _args: readonly string[]) => ({ code: 0, stdout: 'package:com.oculus.browser.debug\npackage:org.mozilla.vrbrowser\n', stderr: '' });
    expect(await hasPackage(run, '/opt/homebrew/bin/adb', QUEST_BROWSER_PACKAGE)).toBe(false);
    expect(await hasPackage(async () => packages(true), '/opt/homebrew/bin/adb', QUEST_BROWSER_PACKAGE)).toBe(true);
    expect(await hasPackage(async () => { throw Error('adb died'); }, '/opt/homebrew/bin/adb', QUEST_BROWSER_PACKAGE)).toBe(false);
    // Nothing but a package name may reach the command line.
    expect(() => viewIntentArgs(ADDRESS, { browserPackage: 'com.oculus.browser; rm -rf /' })).toThrow('plain Android package name');
    expect(() => viewIntentArgs(ADDRESS, { browserPackage: '-e' })).toThrow('plain Android package name');
  });

  it('prints one hint and starts nothing when adb is missing, idle, or fails', async () => {
    const missing = spawner();
    const noAdb = await openOnQuest({ url: ADDRESS, run: missing.run, find: () => undefined });
    expect(noAdb.opened).toBe(false);
    expect(noAdb.message).toContain('adb is not installed');
    expect(missing.calls).toEqual([]);

    const idle = spawner(devices('List of devices attached\n'));
    const none = await openOnQuest({ url: ADDRESS, adb: '/opt/homebrew/bin/adb', run: idle.run });
    expect(none.opened).toBe(false);
    expect(none.message).toContain('Quest Browser');
    expect(idle.calls).toHaveLength(1);

    const broken = spawner({ code: 1, stdout: '', stderr: 'adb: no devices/emulators found' });
    const failed = await openOnQuest({ url: ADDRESS, adb: '/opt/homebrew/bin/adb', run: broken.run });
    expect(failed.opened).toBe(false);
    expect(failed.message).toContain('no devices/emulators found');

    // `am start` reports a rejected intent on stdout with exit status 0.
    const rejected = fakeQuestAdb({ devices: 'List of devices attached\nA\tdevice\n', intent: { code: 0, stdout: 'Error: Activity not started', stderr: '' } });
    const refused = await openOnQuest({ url: ADDRESS, adb: '/opt/homebrew/bin/adb', run: rejected.run, recheckMs: 0 });
    expect(refused.opened).toBe(false);
    expect(refused.message).toContain('Activity not started');
  });

  it('refuses to run anything for an address that carries a capability', async () => {
    const fake = spawner(devices('List of devices attached\nA\tdevice\n'), ok);
    await expect(openOnQuest({ url: `${ADDRESS}#${'a'.repeat(64)}`, adb: '/opt/homebrew/bin/adb', run: fake.run })).rejects.toThrow('only a #pair=<code> fragment');
    expect(fake.calls).toEqual([]);
  });
});


describe('configured Quest selection', () => {
  it('uses diagnostic target fallbacks for USB plus Wi-Fi without guessing physical identity', async () => {
    const wireless='192.168.77.9:5555',usb='USB-QUEST';
    for(const environment of [{STEREOFOLD_ADB_SERIAL:wireless},{ANDROID_SERIAL:wireless}]) {
      const fake=fakeQuestAdb({devices:`${usb}\tdevice\n${wireless}\tdevice\n`});
      const opened=await openOnQuest({url:ADDRESS,adb:'/opt/tools/adb',run:fake.run,environment,config:{},recheckMs:0});
      expect(opened.opened).toBe(true);
      expect(fake.calls.slice(1).every(call=>call.args[0]==='-s' && call.args[1]===wireless)).toBe(true);
    }
    const missing=fakeQuestAdb({devices:`${usb}\tdevice\n`});
    expect((await openOnQuest({url:ADDRESS,adb:'/opt/tools/adb',run:missing.run,
      environment:{STEREOFOLD_ADB_SERIAL:wireless},config:{},recheckMs:0})).opened).toBe(false);
    expect(missing.calls).toHaveLength(1);
  });

  it('keeps launch environment and local config precedence over diagnostic fallbacks', async () => {
    const environments=[{STEREOFOLD_QUEST_SERIAL:'USB-QUEST',STEREOFOLD_ADB_SERIAL:'192.168.77.9:5555'},
      {STEREOFOLD_ADB_SERIAL:'192.168.77.9:5555',ANDROID_SERIAL:'missing'}];
    for(const environment of environments) {
      const fake=fakeQuestAdb({devices:'USB-QUEST\tdevice\n192.168.77.9:5555\tdevice\n'});
      const opened=await openOnQuest({url:ADDRESS,adb:'/opt/tools/adb',run:fake.run,
        environment,config:{questSerial:'USB-QUEST'},recheckMs:0});
      expect(opened.opened).toBe(true);
      expect(fake.calls.slice(1).every(call=>call.args[0]==='-s' && call.args[1]==='USB-QUEST')).toBe(true);
    }
  });

  it('uses the environment before config and pins package queries and launches', async () => {
    for (const [environment, expected] of [[{ STEREOFOLD_QUEST_SERIAL: 'FAKEQUEST00001' }, 'FAKEQUEST00001'], [{}, 'FAKEQUEST00002']] as const) {
      const fake = fakeQuestAdb({ devices: 'FAKEQUEST00001\tdevice\nFAKEQUEST00002\tdevice\n' });
      const result = await openOnQuest({ url: ADDRESS, adb: '/opt/tools/adb', run: fake.run,
        environment, config: { questSerial: 'FAKEQUEST00002' }, recheckMs: 0 });
      expect(result.opened).toBe(true);
      // Every headset read, the package query and the intent go to the one headset chosen.
      expect(fake.calls.slice(1).map(call => call.args.slice(0, 2)))
        .toEqual(Array(6).fill(['-s', expected]));
    }
  });

  it('does not switch to another headset when the configured device is unavailable', async () => {
    for (const stdout of ['FAKEQUEST00002\tdevice\n', 'FAKEQUEST00001\tunauthorized\nFAKEQUEST00002\tdevice\n']) {
      const fake = spawner(devices(stdout));
      const result = await openOnQuest({ url: ADDRESS, adb: '/opt/tools/adb', run: fake.run,
        environment: {}, config: { questSerial: 'FAKEQUEST00001' } });
      expect(result.opened).toBe(false);
      expect(fake.calls).toHaveLength(1);
    }
  });
});

const ADB = '/opt/homebrew/bin/adb';
const ONE_HEADSET = 'List of devices attached\nA\tdevice\n';

/**
 * Meta's boundary screen, read before and after the intent. Once a launch
 * behind "Finding position in room" reported "launch attempted" while
 * no page opened.
 */
describe('Meta\'s boundary screen in front of Quest Browser', () => {
  it('sends nothing, touches no tab and says what a person has to do when the screen is up', async () => {
    const tabs = { before: vi.fn(), restored: vi.fn() };
    const fake = fakeQuestAdb({ devices: ONE_HEADSET, activities: GUARDIAN_DUMP });
    const result = await openOnQuest({ url: `${ADDRESS}#pair=12345678`, adb: ADB, run: fake.run, tabs, recheckMs: 0 });
    expect(result).toMatchObject({ opened: false, blocked: 'guardian-dialog', headset: { guardianDialog: true } });
    expect(result.message).toContain('"Finding position in room"');
    expect(result.message).toContain('sent nothing');
    expect(result.message).toContain('launch again');
    expect(fake.asked()).toEqual(['devices', 'shell dumpsys activity activities']);
    expect(tabs.before).not.toHaveBeenCalled();
    expect(tabs.restored).not.toHaveBeenCalled();
  });

  it('reports the screen when it comes up after the intent went out', async () => {
    const fake = fakeQuestAdb({ devices: ONE_HEADSET, activities: [CLEAR_DUMP, GUARDIAN_DUMP] });
    const result = await openOnQuest({ url: ADDRESS, adb: ADB, run: fake.run, recheckMs: 0 });
    expect(result).toMatchObject({ opened: false, blocked: 'guardian-dialog' });
    expect(result.message).toBe(`  ${GUARDIAN_AFTER_LAUNCH_MESSAGE}`);
    expect(result.message).toContain('after the launch was sent');
    expect(fake.asked().filter(said => said.startsWith('shell am start'))).toHaveLength(1);
    expect(fake.asked().at(-1)).toBe('shell dumpsys activity activities');
  });

  it('launches when the screen is gone, left only in history, or unreadable', async () => {
    for (const activities of [CLEAR_DUMP, STALE_GUARDIAN_DUMP, 'ACTIVITY MANAGER ACTIVITIES\n(nothing)\n',
      { code: 1, stdout: '', stderr: 'error: device offline' }]) {
      const fake = fakeQuestAdb({ devices: ONE_HEADSET, activities });
      const result = await openOnQuest({ url: ADDRESS, adb: ADB, run: fake.run, recheckMs: 0 });
      expect(result.opened, JSON.stringify(activities).slice(0, 60)).toBe(true);
      expect(result.blocked).toBeUndefined();
    }
  });

  it('waits the given time before reading the screen again', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeQuestAdb({ devices: ONE_HEADSET });
      const pending = openOnQuest({ url: ADDRESS, adb: ADB, run: fake.run, recheckMs: 1_500 });
      await vi.advanceTimersByTimeAsync(1_499);
      expect(fake.asked().at(-1)).toMatch(/^shell am start/);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).opened).toBe(true);
      expect(fake.asked().at(-1)).toBe('shell dumpsys activity activities');
    } finally { vi.useRealTimers(); }
  });

  it('watches a headset that woke seconds ago and sends nothing when the screen comes up', async () => {
    vi.useFakeTimers();
    try {
      // The screen came up about 6 s after the wake; the first read, 1 s after it, was clear.
      const fake = fakeQuestAdb({ devices: ONE_HEADSET, power: powerDump({ wokeMsAgo: 1_000 }),
        activities: [CLEAR_DUMP, CLEAR_DUMP, CLEAR_DUMP, CLEAR_DUMP, CLEAR_DUMP, GUARDIAN_DUMP] });
      const pending = openOnQuest({ url: ADDRESS, adb: ADB, run: fake.run, recheckMs: 0 });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;
      expect(result).toMatchObject({ opened: false, blocked: 'guardian-dialog', headset: { guardianDialog: true, wokeMsAgo: 1_000 } });
      expect(result.message).toContain('sent nothing');
      expect(result.message).toContain('For orientation-only use, choose "Continue without tracking" if offered.');
      expect(result.message).toContain('For room tracking, let the headset find an open, lit part of the room.');
      expect(fake.asked().filter(said => said === 'shell dumpsys activity activities')).toHaveLength(6);
      expect(fake.asked().some(said => said.startsWith('shell am start'))).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('launches once the settle window after a wake passes with the screen clear', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeQuestAdb({ devices: ONE_HEADSET, power: powerDump({ wokeMsAgo: 3_000 }) });
      const pending = openOnQuest({ url: ADDRESS, adb: ADB, run: fake.run, recheckMs: 0 });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fake.asked().some(said => said.startsWith('shell am start'))).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).opened).toBe(true);
      // One read before the wait, five during it, one after the intent.
      expect(fake.asked().filter(said => said === 'shell dumpsys activity activities')).toHaveLength(7);
    } finally { vi.useRealTimers(); }
  });

  it('adds no wait for a headset awake past the settle window, or silent about its wake', async () => {
    // A sleeping headset is woken first, and its fresh wake is then watched by design.
    for (const power of [powerDump({ wokeMsAgo: 60_000 }), powerDump()]) {
      const fake = fakeQuestAdb({ devices: ONE_HEADSET, power });
      const result = await openOnQuest({ url: ADDRESS, adb: ADB, run: fake.run, recheckMs: 0 });
      expect(result.opened).toBe(true);
      expect(fake.asked().filter(said => said === 'shell dumpsys activity activities')).toHaveLength(2);
    }
  });

  it('tells a wearer already in the headset to tap Enter VR, and anyone else to put it on first', async () => {
    const worn = await openOnQuest({ url: ADDRESS, adb: ADB, recheckMs: 0,
      run: fakeQuestAdb({ devices: ONE_HEADSET, power: powerDump({ worn: true }) }).run });
    expect(worn.message).toContain('tap Enter VR in the headset');
    expect(worn.headset).toEqual({ guardianDialog: false, display: 'Awake', worn: true, browserRunning: true });
    const woken = await openOnQuest({ url: ADDRESS, adb: ADB, recheckMs: 0, settleMs: 0, wakeMs: 50,
      run: fakeQuestAdb({ devices: ONE_HEADSET, power: [powerDump({ display: 'Asleep' }), powerDump()] }).run });
    expect(woken.message).toContain('put the headset on, then tap Enter VR');
    expect(woken.headset).toMatchObject({ display: 'Awake', worn: false });
  });
});

const hygiene = (over: Partial<LaunchTabHygiene> = {}): LaunchTabHygiene => ({ probed: true, launch: true, closed: [], tabs: [],
  strip: { enumerated: true, stranded: 0, closed: 0 }, note: 'Quest Browser had no viewer tab open, so this launch opened the first one.', ...over });

describe('the tab steps around the intent', () => {
  it('sweeps before the intent, on the adb and serial the launch chose', async () => {
    const fake = fakeQuestAdb({ devices: ONE_HEADSET });
    let askedBefore: string[] = [];
    const before = vi.fn(async () => { askedBefore = fake.asked(); return hygiene(); });
    const result = await openOnQuest({ url: ADDRESS, adb: ADB, run: fake.run, tabs: { before }, recheckMs: 0 });
    expect(before).toHaveBeenCalledWith({ adb: ADB, serial: 'A', run: fake.run });
    expect(askedBefore.some(said => said.startsWith('shell am start'))).toBe(false);
    expect(result.tabHygiene?.note).toContain('opened the first one');
    expect(result.message).toContain('launch attempted on A');
    expect(result.message).toContain('opened the first one');
  });

  it('keeps a live tab and sends no intent', async () => {
    const fake = fakeQuestAdb({ devices: ONE_HEADSET });
    const kept = hygiene({ launch: false, keep: '71', note: 'The live viewer tab 71 (menu) was already the only one; no new tab was opened.' });
    const result = await openOnQuest({ url: ADDRESS, adb: ADB, run: fake.run, tabs: { before: async () => kept }, recheckMs: 0 });
    expect(result).toMatchObject({ opened: true, tabHygiene: { keep: '71' } });
    expect(result.message).toContain('The wearer is already on the page.');
    expect(fake.asked().some(said => said.startsWith('shell am start'))).toBe(false);
  });

  it('sweeps after the intent instead when Quest Browser was not running', async () => {
    const fake = fakeQuestAdb({ devices: ONE_HEADSET, browserPid: null, socket: '1\n' });
    let askedRestored: string[] = [];
    const before = vi.fn(async () => hygiene());
    const restored = vi.fn(async () => { askedRestored = fake.asked();
      return hygiene({ keep: '12', closed: ['9', '10'], note: 'Quest Browser was not running, so this launch started it.' }); });
    const result = await openOnQuest({ url: ADDRESS, adb: ADB, run: fake.run, tabs: { before, restored }, recheckMs: 0 });
    expect(before).not.toHaveBeenCalled();
    expect(restored).toHaveBeenCalledTimes(1);
    expect(askedRestored.filter(said => said === VIEW)).toHaveLength(1);
    expect(result).toMatchObject({ opened: true, headset: { browserRunning: false }, tabHygiene: { keep: '12', closed: ['9', '10'] } });
    expect(result.message).toContain('Quest Browser was not running');
  });

  it('leaves the reopened tabs alone when the screen came up after the intent', async () => {
    const restored = vi.fn(async () => hygiene());
    const fake = fakeQuestAdb({ devices: ONE_HEADSET, browserPid: null, socket: '1\n', activities: [CLEAR_DUMP, GUARDIAN_DUMP] });
    const result = await openOnQuest({ url: ADDRESS, adb: ADB, run: fake.run, tabs: { before: async () => hygiene(), restored }, recheckMs: 0 });
    expect(result.blocked).toBe('guardian-dialog');
    expect(result.message).toBe(`  ${GUARDIAN_DURING_LAUNCH_MESSAGE}`);
    expect(fake.asked().filter(said => said === VIEW)).toHaveLength(1);
    expect(restored).not.toHaveBeenCalled();
  });
});

const VIEW = `shell am start -a android.intent.action.VIEW -p ${QUEST_BROWSER_PACKAGE} -d ${ADDRESS}`;
const ACTIVITIES = 'shell dumpsys activity activities';
/** One read of the headset: boundary screen, power, browser process. */
const STATE = [ACTIVITIES, 'shell dumpsys power', `shell pidof ${QUEST_BROWSER_PACKAGE}`];
const READS = ['devices', ...STATE];
const PACKAGES = PACKAGE_QUERY.join(' ');
const COLD_NOTE = 'Quest Browser was not running, so this launch started it. It reopened no other tab on this share.';
/** What a cold start with tab steps runs when nothing is started before the link. */
const OLD_COLD_TRAIL = [...READS, PACKAGES, VIEW, ACTIVITIES, 'tabs.restored'];
const COLD_HEADSET = { guardianDialog: false, display: 'Awake', worn: false, browserRunning: false };
const launched = (note: string) => `  launch attempted on A · put the headset on, then tap Enter VR. ${note}`;
/** What a cold start whose link landed answers when nothing is started before the link. */
const COLD_RESULT = { opened: true, headset: COLD_HEADSET, tabHygiene: hygiene({ note: COLD_NOTE }), message: launched(COLD_NOTE) };

/** One launch on a fake headset, with every adb command and tab step recorded in the order they ran. */
function launchTrail(headset: FakeHeadset, wrap?: (run: Runner) => Runner) {
  const fake = fakeQuestAdb({ devices: ONE_HEADSET, ...headset });
  const marks: Array<[number, string]> = [];
  const step = (name: string, result: LaunchTabHygiene) => vi.fn(async () => { marks.push([fake.calls.length, name]); return result; });
  const tabs = { before: step('tabs.before', hygiene()), restored: step('tabs.restored', hygiene({ note: COLD_NOTE })) };
  const trail = () => {
    const said = fake.asked();
    return said.flatMap((line, index) => [...marks.filter(([at]) => at === index).map(([, name]) => name), line])
      .concat(marks.filter(([at]) => at === said.length).map(([, name]) => name));
  };
  const launch = (withTabs = true) => openOnQuest({ url: ADDRESS, adb: ADB, run: wrap ? wrap(fake.run) : fake.run,
    ...(withTabs ? { tabs } : {}), recheckMs: 0 });
  return { fake, tabs, trail, launch };
}
const links = (trail: string[]) => trail.filter(said => said.startsWith('shell am start -a android.intent.action.VIEW'));

/**
 * The trail with the start and its socket reads taken out, after checking
 * that the link went out right after the wait, with no headset read between.
 */
function withoutStart(trail: string[]) {
  const at = trail.indexOf(BROWSER_START);
  let end = at + 1;
  while (trail[end] === SOCKET_COUNT) end += 1;
  expect(trail[end]).toBe(VIEW);
  return [...trail.slice(0, at), ...trail.slice(end)];
}

/**
 * On a Quest 2, Quest Browser started by the link drops it and opens no tab.
 * A link sent once the browser's debugger is up opens at once.
 * A cold start therefore starts the browser with no link and waits for its
 * debugger first, and then goes on exactly as a cold start always has: the
 * link once, then the sweep of the tabs the browser reopened.
 */
describe('a launch on a headset whose Quest Browser is not running', () => {
  it('starts the browser with no link, waits for its debugger, then sends the link once and sweeps after it', async () => {
    vi.useFakeTimers();
    try {
      const { tabs, trail, launch } = launchTrail({ browserPid: null, socket: ['0\n', '0\n', '1\n'] });
      const pending = launch();
      await vi.advanceTimersByTimeAsync(499);
      expect(links(trail())).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(trail()).toEqual([...READS, PACKAGES, BROWSER_START, SOCKET_COUNT, SOCKET_COUNT, SOCKET_COUNT,
        VIEW, ACTIVITIES, 'tabs.restored']);
      expect(withoutStart(trail())).toEqual(OLD_COLD_TRAIL);
      expect(tabs.before).not.toHaveBeenCalled();
      expect(tabs.restored).toHaveBeenCalledTimes(1);
      expect(result).toEqual(COLD_RESULT);
    } finally { vi.useRealTimers(); }
  });

  it('still sends the link once to a headset whose display reads asleep after the wait, with the ordinary cold-start answer', async () => {
    // Awake on the read before the start, asleep on any read after it.
    const { tabs, trail, launch } = launchTrail({ browserPid: null, socket: '1\n', power: [powerDump(), powerDump({ display: 'Asleep' })] });
    const result = await launch();
    expect(trail()).toEqual([...READS, PACKAGES, BROWSER_START, SOCKET_COUNT, VIEW, ACTIVITIES, 'tabs.restored']);
    expect(withoutStart(trail())).toEqual(OLD_COLD_TRAIL);
    expect(tabs.before).not.toHaveBeenCalled();
    expect(tabs.restored).toHaveBeenCalledTimes(1);
    expect(result).toEqual(COLD_RESULT);
  });

  it('catches a boundary screen that came up during the wait with the check after the link, and sweeps nothing', async () => {
    // Clear on the read before the start, up on any read after it.
    const { tabs, trail, launch } = launchTrail({ browserPid: null, socket: '1\n', activities: [CLEAR_DUMP, GUARDIAN_DUMP] });
    const result = await launch();
    expect(trail()).toEqual([...READS, PACKAGES, BROWSER_START, SOCKET_COUNT, VIEW, ACTIVITIES]);
    expect(tabs.before).not.toHaveBeenCalled();
    expect(tabs.restored).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: false, blocked: 'guardian-dialog', headset: COLD_HEADSET, message: `  ${GUARDIAN_DURING_LAUNCH_MESSAGE}` });
    expect(result.message).toContain('during the launch');
    expect(result.message).not.toContain('after the launch was sent');
  });

  it('sends the link as before when the start fails or throws', async () => {
    const throwing = (run: Runner): Runner => async (command, args) => {
      const answered = await run(command, args);
      if (args.includes('-n')) throw Error('spawn EAGAIN');
      return answered;
    };
    const cases: Array<[string, FakeHeadset, ((run: Runner) => Runner)?]> = [
      ['reported an error', { launcher: { code: 0, stdout: 'Error: Activity class {com.oculus.browser/com.oculus.browser.OculusLauncherActivity} does not exist.', stderr: '' } }],
      ['exited non-zero', { launcher: { code: 1, stdout: '', stderr: 'error: closed' } }],
      ['threw', {}, throwing],
    ];
    for (const [label, headset, wrap] of cases) {
      const { tabs, trail, launch } = launchTrail({ browserPid: null, socket: '1\n', ...headset }, wrap);
      const result = await launch();
      expect(trail(), label).toEqual([...READS, PACKAGES, BROWSER_START, VIEW, ACTIVITIES, 'tabs.restored']);
      expect(withoutStart(trail()), label).toEqual(OLD_COLD_TRAIL);
      expect(tabs.before, label).not.toHaveBeenCalled();
      expect(result, label).toEqual(COLD_RESULT);
    }
  });

  it('keeps waiting when grep exits with an error, even with a number on stdout', async () => {
    vi.useFakeTimers();
    try {
      const { tabs, trail, launch } = launchTrail({ browserPid: null,
        socket: [{ code: 2, stdout: '1\n', stderr: 'grep: /proc/net/unix: I/O error' }, '1\n'] });
      const pending = launch();
      await vi.advanceTimersByTimeAsync(249);
      expect(links(trail())).toEqual([]);
      expect(trail().filter(said => said === SOCKET_COUNT)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(trail()).toEqual([...READS, PACKAGES, BROWSER_START, SOCKET_COUNT, SOCKET_COUNT, VIEW, ACTIVITIES, 'tabs.restored']);
      expect(tabs.before).not.toHaveBeenCalled();
      expect(result).toEqual(COLD_RESULT);
    } finally { vi.useRealTimers(); }
  });

  it('keeps waiting through answers that do not show the debugger up, and sends the link only once one does', async () => {
    vi.useFakeTimers();
    try {
      const { tabs, trail, launch } = launchTrail({ browserPid: null, socket: [{ code: 1, stdout: '', stderr: '' },
        { code: 1, stdout: '0\n', stderr: '' }, Error('adb: device offline'), '1\n'] });
      const pending = launch();
      await vi.advanceTimersByTimeAsync(749);
      expect(links(trail())).toEqual([]);
      expect(trail().filter(said => said === SOCKET_COUNT)).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(trail()).toEqual([...READS, PACKAGES, BROWSER_START, SOCKET_COUNT, SOCKET_COUNT, SOCKET_COUNT, SOCKET_COUNT,
        VIEW, ACTIVITIES, 'tabs.restored']);
      expect(tabs.before).not.toHaveBeenCalled();
      expect(tabs.restored).toHaveBeenCalledTimes(1);
      expect(result).toEqual(COLD_RESULT);
    } finally { vi.useRealTimers(); }
  });

  it('keeps reading when every read is rejected, then sends the link once at ten seconds and sweeps after it', async () => {
    vi.useFakeTimers();
    try {
      const { tabs, trail, launch } = launchTrail({ browserPid: null, socket: Error('adb: device offline') });
      const pending = launch();
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(links(trail())).toEqual([]);
      expect(trail().filter(said => said === SOCKET_COUNT).length).toBeGreaterThan(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const result = await pending;
      expect(withoutStart(trail())).toEqual(OLD_COLD_TRAIL);
      expect(links(trail())).toEqual([VIEW]);
      expect(tabs.before).not.toHaveBeenCalled();
      expect(tabs.restored).toHaveBeenCalledTimes(1);
      expect(result).toEqual(COLD_RESULT);
    } finally { vi.useRealTimers(); }
  });

  it('sends the link as before, once, when the debugger does not come up within ten seconds', async () => {
    const hanging = (run: Runner): Runner => async (command, args) => {
      const answered = await run(command, args);
      return args.includes('grep') ? new Promise<RunResult>(() => {}) : answered;
    };
    const cases: Array<[string, FakeHeadset, ((run: Runner) => Runner)?]> = [
      ['never listed', { socket: '0\n' }],
      ['read never answers', { socket: '0\n' }, hanging],
      ['read cannot run', { socket: { code: 2, stdout: '', stderr: 'grep: /proc/net/unix: Permission denied' } }],
    ];
    vi.useFakeTimers();
    try {
      for (const [label, headset, wrap] of cases) {
        const { tabs, trail, launch } = launchTrail({ browserPid: null, ...headset }, wrap);
        const pending = launch();
        let settled = false;
        void pending.then(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(links(trail()), label).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(settled, label).toBe(true);
        const result = await pending;
        expect(withoutStart(trail()), label).toEqual(OLD_COLD_TRAIL);
        expect(links(trail()), label).toEqual([VIEW]);
        expect(tabs.before, label).not.toHaveBeenCalled();
        expect(result, label).toEqual(COLD_RESULT);
      }
    } finally { vi.useRealTimers(); }
  });

  it('ends the wait by its limit when the wall clock is set back during it', async () => {
    vi.useFakeTimers();
    try {
      const { trail, launch } = launchTrail({ browserPid: null, socket: '0\n' });
      const pending = launch();
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1_000);
      vi.setSystemTime(Date.now() - 60_000);
      await vi.advanceTimersByTimeAsync(8_999);
      expect(links(trail())).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await pending).toEqual(COLD_RESULT);
      expect(links(trail())).toEqual([VIEW]);
    } finally { vi.useRealTimers(); }
  });

  it('starts nothing first without Quest Browser or without tab steps, and nothing for a running browser', async () => {
    const missing = launchTrail({ browserPid: null, packages: false, socket: '1\n' });
    await missing.launch();
    expect(missing.trail()).toEqual([...READS, PACKAGES, `shell am start -a android.intent.action.VIEW -d ${ADDRESS}`, ACTIVITIES, 'tabs.restored']);

    const bare = launchTrail({ browserPid: null, socket: '1\n' });
    expect((await bare.launch(false)).message).toBe('  launch attempted on A · put the headset on, then tap Enter VR.');
    expect(bare.trail()).toEqual([...READS, PACKAGES, VIEW, ACTIVITIES]);

    const running = launchTrail({ socket: '1\n' });
    const result = await running.launch();
    expect(running.trail()).toEqual([...READS, 'tabs.before', PACKAGES, VIEW, ACTIVITIES]);
    expect(running.tabs.restored).not.toHaveBeenCalled();
    expect(result).toEqual({ opened: true, headset: { ...COLD_HEADSET, browserRunning: true }, tabHygiene: hygiene(), message: launched(hygiene().note) });
  });
});
