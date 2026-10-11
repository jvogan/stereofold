import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  questHostEnv, formatWearerBlock, isDesktopReady, isPdbId, pairedClientIds, parseHostAddress, parseQuestArgs,
  pollUntil, preflightProblems, pushToTalkFromEnvironment, redactAddress, headlessFailureText, renderHeadlessPanel, selectLessonTour, selectPanel, tourToStartOnPairing,
  launcherVoiceGuidance, shareEnded, stopOwnedHost, visionProHandoff,
  type InspectionState, type QuestOptions,
} from '../scripts/quest-share.js';
import type { DoctorReport } from '../scripts/setup-doctor.js';
import { describePanelWait, panelWaitMs, PANEL_READY_WAIT, PANEL_SAVE_WAIT } from '../scripts/panel-wait.js';

const home = '/home/tester';
// Synthetic RFC1918 interface fixture for private-LAN preflight reports.
const SYNTHETIC_LAN_IP = '192.168.3.4';

it('reports a headless renderer error after a successful handshake and redacts capabilities', async () => {
  const token = 'b'.repeat(64), handlers = new Map<string, Function>();
  let canvasWaited = false;
  const frame = { waitForFunction: async () => {}, locator: (selector: string) => ({
    getAttribute: async () => 'error',
    textContent: async () => `WebGL failed at http://127.0.0.1:1234/?code=12345678#${token}`,
    waitFor: async () => { if (selector === '.stage canvas') canvasWaited = true; },
  }) };
  const page = { on: (event: string, fn: Function) => handlers.set(event, fn), off: (event: string) => handlers.delete(event),
    setDefaultTimeout() {}, goto: async () => handlers.get('pageerror')?.(Error(`renderer ${token}`)),
    waitForFunction: async () => {}, frames: () => [frame], mainFrame: () => page };
  await expect(renderHeadlessPanel(page, `http://127.0.0.1:1234/#${token}`)).rejects.toThrow(/inspection startup:.*startup error.*WebGL failed/);
  expect(canvasWaited).toBe(false);
  expect(handlers.size).toBe(0);
  const safe = headlessFailureText(`failed http://127.0.0.1:1234/?code=12345678#${token} bearer ${token}`);
  expect(safe).not.toContain(token); expect(safe).not.toContain('12345678');
});

it('reports the renderer stage and visible status when headless rendering times out', async () => {
  const frame = { waitForFunction: async () => { throw Error('Timeout 120000ms exceeded'); },
    locator: () => ({ textContent: async () => 'Loading the structure has stalled.' }) };
  const page = { on() {}, off() {}, setDefaultTimeout() {}, goto: async () => {}, waitForFunction: async () => {},
    frames: () => [frame], mainFrame: () => page };
  await expect(renderHeadlessPanel(page, 'http://127.0.0.1:1234/')).rejects.toThrow(/inspection startup:.*Timeout.*Loading the structure has stalled/);
});
// An explicit empty environment, so these assertions are about the flags and
// not about whatever the shell running the suite happens to export.
const parse = (line: string, env: NodeJS.ProcessEnv = {}): QuestOptions => parseQuestArgs(line ? line.split(' ') : [], home, env);

describe('quest-share argument parsing', () => {
  it('defaults to 1CRN and the private control file', () => {
    const options = parse('');
    expect(options.source).toBe('1CRN');
    expect(options.statePath).toBe('/home/tester/.stereofold/quest-share.json');
    expect(options.headless).toBe(false);
    expect(options.lanPort).toBe(8443);
  });

  it('accepts a PDB ID and an absolute coordinate path', () => {
    expect(parse('4HHB').source).toBe('4HHB');
    expect(parse('/data/model.mmcif').source).toBe('/data/model.mmcif');
  });

  it('refuses sources the standalone host would refuse', () => {
    expect(() => parse('1CR')).toThrow(/four-character PDB ID/);
    expect(() => parse('relative.cif')).toThrow(/absolute/);
    expect(() => parse('/data/model.pdb')).toThrow(/\.cif/);
    expect(() => parse('1CRN 4HHB')).toThrow(/one structure/);
  });

  it('reads the flags', () => {
    const options = parse('/data/model.cif --lesson /data/lesson.json --headless --lan-host 192.168.77.9 --lan-port 9443 --state /data/control.json');
    expect(options).toMatchObject({
      source: '/data/model.cif', lessonPath: '/data/lesson.json', headless: true,
      lanHost: '192.168.77.9', lanPort: 9443, statePath: '/data/control.json',
    });
    expect(parse('/data/model.cif --lesson /data/lesson.json --assembly 1').assemblyId).toBe('1');
    expect(parse('/data/model.cif --lesson /data/lesson.json').assemblyId).toBeUndefined();
    expect(parse('1CRN --tour fold-detective').tourId).toBe('fold-detective');
    expect(parse('/data/model.cif --lesson /data/lesson.json --play-tour').playTour).toBe(true);
    expect(parse('/data/model.cif --lesson /data/lesson.json').playTour).toBe(false);
    expect(parse('1CRN --allow-stale-build').allowStaleBuild).toBe(true);
    expect(parse('1CRN').allowStaleBuild).toBe(false);
    expect(parse('--help').help).toBe(true);
  });

  it('rejects flag values the route cannot honour', () => {
    expect(() => parse('1CRN --lesson /data/lesson.json')).toThrow(/local coordinates/);
    expect(() => parse('/data/model.cif --lesson /data/lesson.json --tour fold-detective')).toThrow(/not both/);
    expect(() => parse('/data/model.cif --lesson lesson.json')).toThrow(/absolute path to a lesson JSON/);
    // The assembly is opened with the lesson that describes it, so it cannot
    // travel on its own; inspect and inspect_file take no assembly.
    expect(() => parse('/data/model.cif --assembly 1')).toThrow(/needs --lesson/);
    expect(() => parse('/data/model.cif --lesson /data/lesson.json --assembly ../1')).toThrow(/assembly identifier/);
    expect(() => parse('1CRN --lan-port 80')).toThrow(/1024 through 65535/);
    expect(() => parse('1CRN --tour ../etc/passwd')).toThrow(/tour ID/);
    expect(() => parse('1CRN --state relative.json')).toThrow(/absolute/);
    expect(() => parse('1CRN --wat')).toThrow(/Unknown option/);
    expect(() => parse('1CRN --tour')).toThrow(/needs a value/);
    // --play-tour starts the tour a lesson carries, so it needs one.
    expect(() => parse('1CRN --play-tour')).toThrow(/needs --lesson/);
  });

  it('knows a PDB ID from a path', () => {
    expect(isPdbId('1crn')).toBe(true);
    expect(isPdbId('/data/1crn.cif')).toBe(false);
  });
});

const healthy: DoctorReport = {
  ready: true, prerequisitesReady: true,
  node: { check: 'ok', version: '26.7.0', required: '22+' },
  openssl: { check: 'ok', version: 'OpenSSL 3.5.0' },
  build: { state: 'fresh', files: [], heuristic: false, stamps: { viewer: 'a'.repeat(64), inspector: 'b'.repeat(64) },
    content: { state: 'fresh', hash: 'c'.repeat(64) }, mtime: 'fresh' },
  lan: { check: 'ok', addresses: [{ interface: 'en0', address: SYNTHETIC_LAN_IP }] },
  port: { state: 'available', port: 8443 },
  controlFile: { state: 'not-provided' },
};

describe('the microphone setting every other host already had', () => {
  it('reads STEREOFOLD_PTT_TRANSCRIBE the way the transcriber reads it', () => {
    expect(pushToTalkFromEnvironment({})).toBeUndefined();
    expect(pushToTalkFromEnvironment({ STEREOFOLD_PTT_TRANSCRIBE: '  ' })).toBeUndefined();
    expect(pushToTalkFromEnvironment({ STEREOFOLD_PTT_TRANSCRIBE: '1' })).toBe(true);
    expect(pushToTalkFromEnvironment({ STEREOFOLD_PTT_TRANSCRIBE: 'whisper' })).toBe(true);
    for (const setting of ['0', 'off', 'no', 'FALSE']) {
      expect(pushToTalkFromEnvironment({ STEREOFOLD_PTT_TRANSCRIBE: setting }), setting).toBe(false);
    }
  });

  it('lets the environment turn the microphone on for a headless run, and off for a wearer', () => {
    // The Codex and Claude Science MCP servers have no command line to pass
    // --ptt on, so this variable is how headset voice is turned on everywhere
    // else on this machine. The launcher was the one place it meant nothing.
    expect(parse('1CRN --headless', { STEREOFOLD_PTT_TRANSCRIBE: '1' }).pushToTalk).toBe(true);
    expect(parse('1CRN', { STEREOFOLD_PTT_TRANSCRIBE: '0' }).pushToTalk).toBe(false);
  });

  it('gives the flag the last word in both directions', () => {
    expect(parse('1CRN --no-ptt', { STEREOFOLD_PTT_TRANSCRIBE: '1' }).pushToTalk).toBe(false);
    expect(parse('1CRN --ptt', { STEREOFOLD_PTT_TRANSCRIBE: '0' }).pushToTalk).toBe(true);
  });

  it('leaves the old default alone when the variable is unset', () => {
    expect(parse('1CRN').pushToTalk).toBe(true);
    expect(parse('1CRN --headless').pushToTalk).toBe(false);
  });
});

describe('quest-share preflight', () => {
  it('passes a healthy machine', () => {
    expect(preflightProblems(healthy)).toEqual([]);
  });

  it('names each blocking condition', () => {
    expect(preflightProblems({ ...healthy, port: { state: 'listening', port: 8443 } })[0]).toMatch(/TCP 8443 already/);
    expect(preflightProblems({ ...healthy, port: { state: 'unknown', port: 8443 } })[0]).toMatch(/could not be determined; lsof was missing, denied, or timed out twice/);
    expect(preflightProblems({ ...healthy, lan: { check: 'warning', addresses: [] } })[0]).toMatch(/no assigned private IPv4/);
    expect(preflightProblems({ ...healthy, build: { ...healthy.build, state: 'missing', files: ['server.mjs'], mtime: 'not-checked',
      content: { state: 'unknown', reason: 'runtime files are missing, so nothing was compared' } } })[0]).toMatch(/server\.mjs.*pnpm run build/s);
    expect(preflightProblems({ ...healthy, build: { ...healthy.build, state: 'stale',
      content: { state: 'stale', hash: 'd'.repeat(64), recorded: 'e'.repeat(64) } } })[0]).toMatch(/does not match plugin\/src \(stale \(d{12}\)\)/);
    expect(preflightProblems({ ...healthy, node: { check: 'error', version: '20.0.0', required: '22+' } })[0]).toMatch(/older than 22/);
    expect(preflightProblems({ ...healthy, openssl: { check: 'error' } })[0]).toMatch(/openssl/);
  });

  it('waives only a stale build, and only when asked', () => {
    const stale: DoctorReport = { ...healthy, build: { ...healthy.build, state: 'stale',
      content: { state: 'stale', hash: 'd'.repeat(64), recorded: 'e'.repeat(64) } } };
    expect(preflightProblems(stale, true)).toEqual([]);
    expect(preflightProblems(stale, false)).toHaveLength(1);
    // A dist that is not there at all is not a freshness question.
    expect(preflightProblems({ ...healthy, build: { ...healthy.build, state: 'missing', files: ['inspector.html'], mtime: 'not-checked',
      content: { state: 'unknown', reason: 'runtime files are missing, so nothing was compared' } } }, true)).toHaveLength(1);
  });

  it('reports every problem at once rather than the first', () => {
    expect(preflightProblems({ ...healthy, lan: { check: 'warning', addresses: [] }, port: { state: 'listening', port: 8443 } })).toHaveLength(2);
  });
});

describe('quest-share host address', () => {
  const bearer = 'a'.repeat(64);

  it('reads the address the host prints', () => {
    expect(parseHostAddress(`Open the real Stereofold inspector: http://127.0.0.1:53913/#${bearer}`))
      .toEqual({ origin: 'http://127.0.0.1:53913', address: `http://127.0.0.1:53913/#${bearer}` });
  });

  it('ignores the other lines the host prints', () => {
    expect(parseHostAddress('The part after # is this page’s key.')).toBeUndefined();
    expect(parseHostAddress('Open the real Stereofold inspector: http://127.0.0.1:53913')).toBeUndefined();
  });

  it('never lets the panel bearer reach the terminal', () => {
    const redacted = redactAddress(`http://127.0.0.1:53913/#${bearer}`);
    expect(redacted).not.toContain(bearer);
    expect(redacted).toBe('http://127.0.0.1:53913/#<panel key, not shown>');
  });
});

describe('quest-share state reading', () => {
  const desktop = { panelId: 'd1', surface: 'desktop', availability: 'ready', current: true };
  const companion = { panelId: 'c1', surface: 'companion', availability: 'ready', current: true };

  it('waits for both a saved scene and a ready desktop panel', () => {
    expect(isDesktopReady({ hasScene: false, panels: [desktop] })).toBe(false);
    expect(isDesktopReady({ hasScene: true, panels: [] })).toBe(false);
    expect(isDesktopReady({ hasScene: true, panels: [{ ...desktop, availability: 'loading' }] })).toBe(false);
    expect(isDesktopReady({ hasScene: true, panels: [desktop] })).toBe(true);
    expect(isDesktopReady(undefined)).toBe(false);
  });

  it('picks the current panel of a surface, and falls back to any ready one', () => {
    expect(selectPanel([desktop, companion], 'companion')?.panelId).toBe('c1');
    // After a headset pairs, the desktop entry can go current:false while still ready.
    expect(selectPanel([{ ...desktop, current: false }], 'desktop')?.panelId).toBe('d1');
    expect(selectPanel([{ ...companion, availability: 'stale' }], 'companion')).toBeUndefined();
    expect(selectPanel(undefined, 'desktop')).toBeUndefined();
  });

  it('finds the authored lesson tour among the bundled ten', () => {
    expect(selectLessonTour([{ id: 'fold-detective' }, { id: 'lesson-generic-own-molecule' }])).toBe('lesson-generic-own-molecule');
    expect(selectLessonTour([{ id: 'fold-detective' }])).toBeUndefined();
  });

  // The headset is a place a person arrives, not a player that
  // starts itself. Only an explicit request pushes a tour when a Quest pairs.
  it('starts no tour on pairing unless the run asked for one', () => {
    const tours = [{ id: 'fold-detective' }, { id: 'lesson-telomerase-haca' }];
    // The shipped telomerase demo: a lesson, no tour flag, so nothing plays.
    expect(tourToStartOnPairing({ lessonPath: '/demos/telomerase.json', playTour: false }, tours)).toBeUndefined();
    expect(tourToStartOnPairing({ lessonPath: '/demos/telomerase.json', playTour: true }, tours)).toBe('lesson-telomerase-haca');
    // A named tour is a deliberate request whether or not a lesson is playing.
    expect(tourToStartOnPairing({ tourId: 'fold-detective', playTour: false }, tours)).toBe('fold-detective');
    // Asking for a lesson tour the session never registered pushes nothing.
    expect(tourToStartOnPairing({ lessonPath: '/demos/telomerase.json', playTour: true }, [{ id: 'fold-detective' }])).toBeUndefined();
    expect(tourToStartOnPairing({ playTour: false }, tours)).toBeUndefined();
  });

  it('reads paired clients from either shape the server returns', () => {
    expect(pairedClientIds({ lan: { clients: [{ id: 'one' }, { id: 'two' }] } })).toEqual(['one', 'two']);
    expect(pairedClientIds({ companion: { clients: [{ id: 'one' }] } })).toEqual(['one']);
    expect(pairedClientIds({ lan: { clients: [] } })).toEqual([]);
    expect(pairedClientIds(undefined)).toEqual([]);
  });
});

describe('quest-share polling', () => {
  const fakeClock = () => {
    let time = 0;
    return { now: () => time, sleep: async (ms: number) => { time += ms; } };
  };

  it('returns the first value that satisfies the predicate', async () => {
    const responses: InspectionState[] = [{ hasScene: false }, { hasScene: false }, { hasScene: true, panels: [{ panelId: 'd1', surface: 'desktop', availability: 'ready', current: true }] }];
    let calls = 0;
    const clock = fakeClock();
    const result = await pollUntil(async () => responses[calls++], isDesktopReady, 'a scene', { ...clock, timeoutMs: 30_000, intervalMs: 2_000 });
    expect(result.hasScene).toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up at the deadline and names what it waited for', async () => {
    const clock = fakeClock();
    let calls = 0;
    await expect(pollUntil(async () => { calls++; return { hasScene: false }; }, isDesktopReady, 'a saved scene', { ...clock, timeoutMs: 10_000, intervalMs: 2_000 }))
      .rejects.toThrow(/Timed out after 10s waiting for a saved scene/);
    expect(calls).toBe(6);
  });

  it('does not sleep when the first read already satisfies it', async () => {
    let slept = 0;
    const value = await pollUntil(async () => 'done', () => true, 'nothing', { sleep: async () => { slept++; } });
    expect(value).toBe('done');
    expect(slept).toBe(0);
  });

  it('says the wait is still running every thirty seconds rather than going silent', async () => {
    const clock = fakeClock();
    const said: string[] = [];
    await expect(pollUntil(async () => ({ hasScene: false }), isDesktopReady, 'a saved scene',
      { ...clock, timeoutMs: 100_000, intervalMs: 2_000, progress: (waited, limit) => said.push(`${waited}/${limit}`) }))
      .rejects.toThrow(/Timed out after 100s/);
    expect(said).toEqual(['30/100', '60/100', '90/100']);
  });

  it('stays silent when nobody asked for progress', async () => {
    const clock = fakeClock();
    await expect(pollUntil(async () => ({ hasScene: false }), isDesktopReady, 'a saved scene',
      { ...clock, timeoutMs: 100_000, intervalMs: 2_000 })).rejects.toThrow();
  });
});

describe('the wait scales with the structure', () => {
  it('keeps the old deadline as a floor and stretches it for a heavy stage', () => {
    // What the flat 120 s was written for, and what it met.
    expect(panelWaitMs(13_121, PANEL_SAVE_WAIT)).toBe(146_000);
    expect(panelWaitMs(40_908, PANEL_SAVE_WAIT)).toBe(202_000);
    // 3JAK: this is the one that timed out under the flat 120 s deadline.
    expect(panelWaitMs(43_066, PANEL_SAVE_WAIT)).toBe(206_000);
    expect(panelWaitMs(43_066, PANEL_SAVE_WAIT)).toBeGreaterThan(120_000);
    // Not knowing the size is a reason to use the old deadline, not to shorten it.
    for (const unknown of [undefined, null, 0, -5, Number.NaN, '40908']) {
      expect(panelWaitMs(unknown, PANEL_SAVE_WAIT)).toBe(120_000);
    }
    // The cap bounds a wrong count; nothing hangs on a typo.
    expect(panelWaitMs(5_000_000, PANEL_SAVE_WAIT)).toBe(PANEL_SAVE_WAIT.capMs);
  });

  it('gives the headset panel a shorter base and its own cap', () => {
    expect(panelWaitMs(6_818, PANEL_READY_WAIT)).toBe(44_000);
    expect(panelWaitMs(40_908, PANEL_READY_WAIT)).toBe(112_000);
    expect(panelWaitMs(177_268, PANEL_READY_WAIT)).toBe(PANEL_READY_WAIT.capMs);
    expect(panelWaitMs(undefined, PANEL_READY_WAIT)).toBe(30_000);
  });

  it('says out loud what it is waiting for and why', () => {
    expect(describePanelWait(40_908, PANEL_SAVE_WAIT)).toBe('202s for 40,908 atom sites');
    expect(describePanelWait(undefined, PANEL_SAVE_WAIT)).toBe('120s (no atom-site count was given, so this is the base wait)');
    expect(describePanelWait(177_268, PANEL_READY_WAIT)).toBe('180s for 177,268 atom sites, at the cap');
  });

  it('takes the count and an outright override from the command line', () => {
    expect(parse('1CRN --atom-sites 40908').atomSites).toBe(40_908);
    expect(parse('1CRN --panel-timeout 240').panelTimeoutMs).toBe(240_000);
    expect(parse('1CRN').atomSites).toBeUndefined();
    expect(parse('1CRN').panelTimeoutMs).toBeUndefined();
    expect(() => parse('1CRN --atom-sites 0')).toThrow(/--atom-sites must be an integer/);
    expect(() => parse('1CRN --atom-sites nine')).toThrow(/--atom-sites must be an integer/);
    expect(() => parse('1CRN --panel-timeout 5')).toThrow(/--panel-timeout must be a whole number of seconds/);
    expect(() => parse('1CRN --panel-timeout 900')).toThrow(/--panel-timeout must be a whole number of seconds/);
  });
});

describe('quest-share wearer block', () => {
  const now = new Date('2026-09-09T20:38:52.000Z');
  // Reserved hostname, dummy fingerprint and code; no captured pairing details.
  const companion = {
    url: 'https://headset.test:8443/',
    host: 'headset.test',
    port: 8443,
    fingerprint: Array(32).fill('AB').join(':'),
    pairingCode: '12345678',
    pairingExpiresAt: '2026-09-09T20:48:52.574Z',
    sessionExpiresAt: '2026-09-09T21:08:52.574Z',
  };

  it('carries manual pairing details without requiring a launch notification or an unrequested tour', () => {
    const block = formatWearerBlock(companion, now);
    expect(block).toContain('https://headset.test:8443/');
    expect(block).toContain('12345678');
    expect(block).toContain(companion.fingerprint);
    expect(block).toContain('(10 min)');
    expect(block).toContain('(30 min)');
    expect(block).toContain('open the launch notification or the address above');
    // Vision Pro has no launch notification: Safari and the typed code are its whole route.
    expect(block).toContain('On Vision Pro, open the address above in Safari and type the pairing code.');
    expect(block).toContain('(the headset must use the same Wi-Fi)');
    expect(block).toContain('then tap Enter VR');
    expect(block).toContain('Tours are optional');
    expect(block).not.toContain('Start tour');
  });

  it('says unavailable rather than printing undefined', () => {
    const block = formatWearerBlock({}, now);
    expect(block).not.toContain('undefined');
    expect(block).toContain('Pairing code   unavailable');
    expect(block).toContain('Code expires   unknown');
  });

  it('never reports a negative time remaining', () => {
    expect(formatWearerBlock(companion, new Date('2026-09-09T22:00:00.000Z'))).toContain('(0 min)');
  });

  it('hands Vision Pro the link by clipboard, and prints neither the link nor the code', async () => {
    const copies: Array<[string, string]> = [];
    const said = await visionProHandoff(companion, async (url, code) => { copies.push([url, code]); return true; });
    expect(copies).toEqual([[companion.url, '12345678']]);
    expect(said).toContain('the one-time link is on this Mac’s clipboard');
    expect(said).toContain('Show Details');
    expect(said).not.toContain('12345678');
    expect(said).not.toContain('headset.test');
  });

  it('falls back to the typed code when the clipboard is unavailable', async () => {
    const said = await visionProHandoff(companion, async () => false);
    expect(said).toContain('type the pairing code');
    expect(await visionProHandoff({}, async () => { throw Error('no copy without a code'); })).toContain('type the pairing code');
  });
});

describe('--vision-pro', () => {
  it('turns off Meta Web Launch, which cannot reach Vision Pro', () => {
    expect(parse('4HHB --vision-pro')).toMatchObject({ visionPro: true, webLaunch: 'off' });
    expect(parse('4HHB')).toMatchObject({ visionPro: false, webLaunch: 'code' });
  });

  it('refuses the Quest-only launch flags beside it', () => {
    expect(() => parse('4HHB --vision-pro --web-launch')).toThrow(/Quest only/);
    expect(() => parse('4HHB --vision-pro --open-on-quest')).toThrow(/Quest only/);
    expect(parse('4HHB --vision-pro --no-web-launch').visionPro).toBe(true);
  });
});

it('distinguishes enabled capture from proven voice readiness', () => {
  expect(launcherVoiceGuidance(false)).toContain('Microphone capture is off');
  expect(launcherVoiceGuidance(false)).toContain('text and headset controls');
  expect(launcherVoiceGuidance(true)).toContain('still needs a successful test press');
  expect(launcherVoiceGuidance(true)).toContain('assistant actively listening');
});

it('stops only after an explicit closed or expired LAN share', () => {
  expect(shareEnded({lan:null})).toBe(true);
  expect(shareEnded({lan:null,lanExpiredAt:123})).toBe(true);
  for (const value of [undefined,null,{}, {lan:{clients:[]}}, {lan:{clients:[{id:'paired'}]}}])
    expect(shareEnded(value)).toBe(false);
});

it.skipIf(process.platform === 'win32')('terminates an owned host that ignores SIGTERM and its descendant without a browser', async () => {
  const childCode = "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)";
  const parentCode = `process.on('SIGTERM',()=>{});const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>process.stdout.write(String(child.pid)));setInterval(()=>{},1000)`;
  const host = spawn(process.execPath, ['-e',parentCode], {detached:true,stdio:['ignore','pipe','ignore']});
  let descendant: number | undefined;
  try {
    const [chunk] = await once(host.stdout!, 'data'); descendant = Number(String(chunk));
    expect(Number.isSafeInteger(descendant)).toBe(true);
    await stopOwnedHost(host,true,40);
    expect(host.signalCode).toBe('SIGKILL');
    // Reaping an orphaned descendant is asynchronous; wait only for this PID.
    await pollUntil(async () => {
      try {process.kill(descendant!,0);return false;} catch(error) {return (error as NodeJS.ErrnoException).code==='ESRCH';}
    }, value=>value, 'owned descendant to exit', {timeoutMs:2000,intervalMs:20});
  } finally {
    try {if(host.pid)process.kill(-host.pid,'SIGKILL');} catch {}
  }
});

it('honors the voice environment in both headless and wearer launches, with flags winning',()=>{
  for(const headless of [[],['--headless']]) {
    expect(parseQuestArgs(headless,home,{STEREOFOLD_PTT_TRANSCRIBE:'1'}).pushToTalk).toBe(true);
    expect(parseQuestArgs(headless,home,{STEREOFOLD_PTT_TRANSCRIBE:'0'}).pushToTalk).toBe(false);
    expect(parseQuestArgs([...headless,'--no-ptt'],home,{STEREOFOLD_PTT_TRANSCRIBE:'1'}).pushToTalk).toBe(false);
    expect(parseQuestArgs([...headless,'--ptt'],home,{STEREOFOLD_PTT_TRANSCRIBE:'0'}).pushToTalk).toBe(true);
  }
});


it('preserves explicit headset transports when launching the standalone host', () => {
  const selected=parse('');
  const environment={STEREOFOLD_QUEST_SERIAL:'192.168.77.9:5555',STEREOFOLD_ADB_SERIAL:'192.168.77.9:5555',ANDROID_SERIAL:'USB-QUEST'};
  expect(questHostEnv(selected,environment)).toMatchObject(environment);
});

it('share-hours preserves the default and passes an explicit ceiling to the host', () => {
  expect(parse('').shareHours).toBe(8);
  expect(parse('', {STEREOFOLD_SHARE_MAX_HOURS:'3'}).shareHours).toBe(3);
  const selected=parse('--share-hours 6', {STEREOFOLD_SHARE_MAX_HOURS:'8'});
  expect(selected.shareHours).toBe(6);
  expect(questHostEnv(selected, {STEREOFOLD_SHARE_MAX_HOURS:'8',KEEP:'yes'}))
    .toEqual({STEREOFOLD_SHARE_MAX_HOURS:'6',KEEP:'yes'});
  for(const value of ['0', '.4', '25', 'NaN', 'Infinity', 'six'])
    expect(()=>parse(`--share-hours ${value}`)).toThrow(/share-hours.*0.5 through 24/);
  expect(()=>parse('--share-hours')).toThrow(/needs a value/);
  expect(parse('--share-hours .5').shareHours).toBe(.5);
  expect(parse('--share-hours 24').shareHours).toBe(24);
});

it('prints activity renewal and the hard stop separately from inactivity expiry', () => {
  const stop='2026-09-09T22:38:52.000Z';
  const block=formatWearerBlock({sessionMaxExpiresAt:stop},new Date('2026-09-09T20:38:52.000Z'));
  expect(block).toContain('Sharing renews while the headset is in use; hard stop at');
  expect(block).toContain(new Date(stop).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));
  expect(block).not.toContain('Sharing ends');
});
