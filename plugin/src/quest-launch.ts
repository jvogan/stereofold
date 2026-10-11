/**
 * Put the companion page on the headset from the host, with nothing typed on
 * the headset.
 *
 * Two routes live here, and both are convenience over the address the wearer
 * could always type by hand:
 *
 *   Meta Web Launch — `https://www.oculus.com/open_url/?url=<encoded target>`
 *   is Meta's own page for pushing a link to a headset signed in to the same
 *   Meta account. No cable, no adb, no developer mode: the wearer sees the page
 *   appear and presses Open once.
 *
 *   adb — a VIEW intent over a debugging connection the headset has already
 *   authorized to this Mac. It needs developer mode and a cable, and opens the
 *   page without any desktop browser at all.
 *
 * What travels, and where
 * ----------------------
 * The target is the private address of this Mac, and it is useless off this
 * Wi-Fi. When the one-time pairing code is included it rides in the target's
 * fragment, so Meta's page receives the whole target as a query parameter of
 * its own URL. The code is therefore seen by Meta, expires in ten minutes, is
 * spent on first use, and opens nothing from outside this network. Omitting it
 * relies on the device key a remembered headset already holds.
 *
 * This module lives in `src` rather than `scripts` because the MCP server
 * bundle needs it: `open_companion` and `manage_companion` launch from inside
 * the server, which is how a host with no terminal reaches the headset.
 * Everything here is either pure or takes its side effect as a parameter.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  chromeCloseTabsByUrlScript, chromeListRendererTabUrlsScript, isHostOpenedRendererTabUrl, isMacRendererTabUrl, markHostOpenedUrl,
  parseChromeTabList, rendererTabOrigin, selectStaleRendererTabs,
} from './renderer-tab.js';
import { QUEST_SERIAL_CONFIG_KEY, readLocalConfig, type LocalConfig } from './local-helper-config.js';
import { guardianDialogShowing, readHeadsetState, type HeadsetShell, type HeadsetState } from './quest-device-state.js';
import { resolveQuestConnection, type QuestConnectionDiagnostic } from './quest-connection.js';

export const QUEST_SERIAL_ENV = 'STEREOFOLD_QUEST_SERIAL';
export { QUEST_SERIAL_CONFIG_KEY };
export const WEB_LAUNCH_BASE = 'https://www.oculus.com/open_url/?url=';
const CODE_PATTERN = /^\d{8}$/;
/**
 * Quest Browser. Verified on an attached Quest 2 on
 * `pm list packages` lists `com.oculus.browser` next to
 * `org.mozilla.vrbrowser`, and `pm resolve-activity -a android.intent.action.VIEW`
 * answers `com.oculus.browser/.OculusLauncherActivity`. Meta does not publish
 * the name, so the adb route falls back to an unrestricted intent when a device
 * does not have it.
 */
export const QUEST_BROWSER_PACKAGE = 'com.oculus.browser';
/** Android package names, as `am -p` accepts them. */
const ANDROID_PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

/**
 * The Claude Science daemon runs this server with a stripped PATH, so `open`
 * as a bare name resolves to nothing. macOS has kept it at this exact path
 * since it existed, and an absolute path is the only form that works in both
 * a terminal and a daemon.
 */
export const MAC_OPEN = '/usr/bin/open';
export const MAC_PBCOPY = '/usr/bin/pbcopy';
/** Absolute path of a stand-in for `open`, so a test can prove the launch without one. */
export const OPENER_ENV = 'STEREOFOLD_OPENER';
/**
 * Which browser gets the link, named the way `open -a` names an application:
 * `Google Chrome`, `Safari`, `Microsoft Edge`, or an absolute path to a bundle.
 *
 * This exists because Web Launch only reaches the headset from a browser signed
 * in to the same Meta account, and the Mac's default browser is often not the
 * one holding that session.
 */
export const BROWSER_ENV = 'STEREOFOLD_BROWSER';

/** A dispatch acknowledgement is not evidence that a browser or page is ready. */
export type OpenerOutcome =
  | { reason: 'attempted'; detail?: string }
  | { reason: 'started' }
  | { reason: 'failed'; code?: string; detail: string };
/** Legacy dispatch-only launchers return void and are reported as attempted. */
export type Opener = (command: string, args: readonly string[]) => OpenerOutcome | void | Promise<OpenerOutcome | void>;

export function launchFailure(error: unknown): Extract<OpenerOutcome, { reason: 'failed' }> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return { reason: 'failed', ...(typeof code === 'string' ? { code } : {}),
    detail: error instanceof Error ? error.message : String(error) };
}

/**
 * The address to open on the headset.
 *
 * The companion address must be a plain HTTPS origin with nothing after the
 * host: a query or fragment already on it would either be dropped here or ride
 * to Meta unnoticed. The code, when given, is the only thing this adds.
 */
export function questTargetUrl(companionUrl: string, code?: string): string {
  let parsed: URL;
  try { parsed = new URL(companionUrl); } catch { throw Error('Web Launch needs the printed https:// companion address.'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw Error('Web Launch needs the printed https:// companion address, with no query or fragment.');
  if (code !== undefined && !CODE_PATTERN.test(code)) throw Error('Web Launch needs the eight-digit pairing code this run printed.');
  return `${parsed.origin}${parsed.pathname === '/' ? '/' : parsed.pathname}${code ? `#pair=${code}` : ''}`;
}

/**
 * The one link to click on the Mac. The whole target is percent-encoded,
 * fragment included, so Meta's page reads it as one query value rather than as
 * a fragment of its own.
 */
export function webLaunchLink(companionUrl: string, code?: string, launchId?: string): string {
  const target = questTargetUrl(companionUrl, code);
  if (launchId !== undefined && !/^[a-f0-9]{32}$/.test(launchId)) throw Error('Invalid Web Launch attempt.');
  return `${WEB_LAUNCH_BASE}${encodeURIComponent(target + (launchId ? `${code ? '&' : '#'}launch=${launchId}` : ''))}`;
}

/** Which program opens a URL on this desktop, and the one way to override it. */
export function resolveOpener(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment[OPENER_ENV]?.trim();
  if (!override) return MAC_OPEN;
  if (!isAbsolute(override)) throw Error(`${OPENER_ENV} must be an absolute path to a program that opens a URL.`);
  return override;
}

/* --------------------------------------------------------------- browser */

/**
 * Where macOS keeps an application bundle. An absolute setting is taken as
 * written; a bare name is looked for in the three folders a browser installs
 * itself into.
 */
export function browserBundlePaths(name: string, home: string = homedir()): string[] {
  if (isAbsolute(name)) return [name];
  const bundle = name.toLowerCase().endsWith('.app') ? name : `${name}.app`;
  return ['/Applications', '/System/Applications', ...(isAbsolute(home) ? [join(home, 'Applications')] : [])].map(folder => join(folder, bundle));
}

function defaultPresent(path: string) { try { accessSync(path, constants.F_OK); return true; } catch { return false; } }

/**
 * The application name to pass `open -a`, or undefined for the Mac's default
 * browser. A control character or an absurd length is refused here rather than
 * handed to `open`, which would otherwise report it as a missing application.
 */
export function resolveBrowser(environment: NodeJS.ProcessEnv = process.env, explicit?: string): string | undefined {
  const name = (explicit ?? environment[BROWSER_ENV] ?? '').trim();
  if (!name) return undefined;
  // eslint-disable-next-line no-control-regex
  if (name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) throw Error(`${BROWSER_ENV} must be an application name such as "Google Chrome".`);
  return name;
}

/** What a browser choice came to: the name used, and the name asked for when it is not installed. */
export type BrowserChoice = { name?: string; missing?: string };

/**
 * Which browser this launch will use.
 *
 * A named browser that is not installed falls back to the default rather than
 * being handed to `open -a`, because the launch is detached: `open` would fail
 * out of sight and the wearer would be left waiting at a page that never
 * opened. The caller prints `missing` so the fallback is never silent.
 */
export function chooseBrowser({ explicit, environment = process.env, home = homedir(), exists = defaultPresent }:
  { explicit?: string; environment?: NodeJS.ProcessEnv; home?: string; exists?: (path: string) => boolean } = {}): BrowserChoice {
  const name = resolveBrowser(environment, explicit);
  if (!name) return {};
  return browserBundlePaths(name, home).some(path => exists(path)) ? { name } : { missing: name };
}

/** `open -a "Google Chrome" <link>`, or plain `open <link>` for the default browser. */
export function openArgs(link: string, browser?: string): string[] {
  return browser ? ['-a', browser, link] : [link];
}

/** Only the spawn signature used by the detached opener. */
export type OpenerSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/**
 * Wait at most three seconds for the URL dispatcher to exit successfully, not
 * for the browser it opens. Spawning the dispatcher alone proves no delivery.
 * A dispatcher still running at the deadline is attempted (opened: false); it
 * is left running, with the manual link available. Inject child and timeout for tests.
 */
export function detachedOpener(command: string, args: readonly string[],
  { spawnChild = spawn, timeoutMs = 3_000 }: { spawnChild?: OpenerSpawn; timeoutMs?: number } = {}): Promise<OpenerOutcome> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (outcome: OpenerOutcome) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(outcome);
    };
    // Keep the timer referenced so even a short-lived host returns the fallback.
    const timer = setTimeout(() => finish({ reason: 'attempted', detail: `The opener gave no answer within ${timeoutMs} ms.` }), timeoutMs);
    try {
      const child = spawnChild(command, [...args], { stdio: 'ignore', detached: true });
      // Keep the handler after exit or timeout: a late error must stay handled.
      // Both listeners are installed before unref, including for a missing program.
      child.on('error', error => finish(launchFailure(error)));
      child.once('exit', (code, signal) => finish(code === 0 && !signal
        ? { reason: 'started' }
        : { reason: 'failed', code: signal ?? (code === null ? 'UNKNOWN_EXIT' : `EXIT_${code}`),
          detail: signal ? `The opener was terminated by ${signal}.` : `The opener exited with status ${code ?? 'unknown'}.` }));
      child.unref();
    } catch (error) { finish(launchFailure(error)); }
  });
}

/** `opened` is a compatibility alias for an accepted dispatch, not page readiness. */
export type LaunchAttempt = { opened: boolean; link: string } &
  (OpenerOutcome | { reason: 'not-macos' });
export type BrowserLaunchReport = LaunchAttempt & { message: string };

async function attemptOpen(link: string, command: string, args: readonly string[], launch: Opener): Promise<LaunchAttempt> {
  try {
    const outcome = await launch(command, args) ?? { reason: 'attempted' as const };
    return { ...outcome, opened: outcome.reason === 'started', link };
  } catch (error) { return { ...launchFailure(error), opened: false, link }; }
}

/**
 * The single place a Web Launch link reaches the desktop. Refusing anything
 * but the Meta link keeps this from becoming a general "open a URL" primitive
 * that a request field could steer.
 */
export async function attemptWebLaunch({ link, platform = process.platform, opener = MAC_OPEN, launch = detachedOpener, browser }:
  { link: string; platform?: string; opener?: string; launch?: Opener; browser?: string }): Promise<LaunchAttempt> {
  if (!link.startsWith(WEB_LAUNCH_BASE)) throw Error('Only the Meta Web Launch link is opened for you.');
  if (platform !== 'darwin') return { opened: false, reason: 'not-macos', link };
  return attemptOpen(link, opener, openArgs(link, browser), launch);
}

/**
 * A loopback address this Mac is serving itself: `http://127.0.0.1:<port>/...`
 * or the `localhost` spelling of the same, with a port and no credentials.
 * The test is on the written address alone. A name that merely resolves to a
 * loopback address today is refused, because resolution is not part of the
 * text and is not the caller's to promise.
 */
export function isLocalCompanionLink(link: string): boolean {
  let parsed: URL;
  try { parsed = new URL(link); } catch { return false; }
  return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    && parsed.port !== '' && !parsed.username && !parsed.password;
}

/**
 * The sibling of attemptWebLaunch for a page this Mac serves to itself, so a
 * host that cannot follow a link can still put the detailed view on screen.
 *
 * The page key rides in the fragment, so it reaches the browser on an argument
 * list every process on this Mac can read. That is the same reach the address
 * already has as printed text in the result, it expires with the companion
 * link, and it opens nothing off this Mac. Refusing every other address keeps
 * this from becoming a general "open a URL" primitive a request field could
 * steer.
 */
export async function attemptLocalOpen({ link, platform = process.platform, opener = MAC_OPEN, launch = detachedOpener, browser }:
  { link: string; platform?: string; opener?: string; launch?: Opener; browser?: string }): Promise<LaunchAttempt> {
  if (!isLocalCompanionLink(link)) throw Error('Only a loopback address this Mac is serving is opened for you.');
  if (platform !== 'darwin') return { opened: false, reason: 'not-macos', link };
  return attemptOpen(link, opener, openArgs(link, browser), launch);
}

/**
 * Hand the link to a browser from a terminal, where `open` resolves on PATH.
 * Failure is a hint, never an error: the link is already printed and can be
 * pasted anywhere.
 */
export async function openInBrowser(link: string, platform: string = process.platform, launch: Opener = detachedOpener, browser?: string): Promise<BrowserLaunchReport> {
  const attempt = await attemptWebLaunch({ link, platform, opener: 'open', launch, ...(browser ? { browser } : {}) });
  const message = attempt.reason === 'started'
    ? `  browser started${browser ? ` · ${browser}` : ''} · sign in to the same Meta account, then press Open.`
    : attempt.reason === 'attempted'
    ? `  launch attempted${attempt.detail ? ` (${attempt.detail})` : ''} · open the link above if no browser appears; sign in to the same Meta account, then press Open.`
    : attempt.reason === 'not-macos'
    ? '  open the link above in the browser signed in to your Meta account.'
    : `  could not open your browser (${attempt.detail}); open the link above yourself.`;
  return { ...attempt, message };
}

/** Open the terminal's desktop renderer, retaining the original copyable address. */
export async function openLocalInBrowser(link: string, platform: string = process.platform, launch: Opener = detachedOpener, browser?: string): Promise<BrowserLaunchReport> {
  const marked = markHostOpenedUrl(link);
  const attempt = platform === 'darwin'
    ? await attemptLocalOpen({ link: marked, platform, opener: 'open', launch, ...(browser ? { browser } : {}) })
    : await attemptOpen(marked, 'xdg-open', [marked], launch);
  const message = attempt.reason === 'started'
    ? `  browser started${browser ? ` · ${browser}` : ''} · leave that tab visible, it is the renderer`
    : attempt.reason === 'attempted'
    ? `  launch attempted${attempt.detail ? ` (${attempt.detail})` : ''} · open the panel address above if no browser appears; leave that tab visible, it is the renderer`
    : `  could not open your browser (${attempt.reason === 'failed' ? attempt.detail : 'unsupported platform'}); open the panel address above yourself.`;
  return { ...attempt, link, message };
}

/* ---------------------------------------------------------- closing Chrome */

/** Absolute like `MAC_OPEN`, so a stripped PATH can still ask Chrome to close a tab. */
export const OSASCRIPT = '/usr/bin/osascript';

export type OriginProbe = (origin: string) => Promise<boolean>;

/**
 * Is this loopback origin still serving? Any HTTP answer, including 403, means
 * a process is bound there. Connection refused is a dead host. Refuses anything
 * that is not loopback so a probe can never leave this Mac.
 */
export function probeLoopbackOrigin(origin: string, get: typeof httpGet = httpGet): Promise<boolean> {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return Promise.resolve(false); }
  if (parsed.protocol !== 'http:' || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')
    || parsed.port === '' || parsed.username || parsed.password)
    return Promise.resolve(false);
  return new Promise(resolve => {
    const request = get({ host: parsed.hostname, port: Number(parsed.port), path: '/', timeout: 400 }, response => {
      response.resume();
      resolve(true);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

async function listedRendererTabUrls(run: Runner): Promise<string[]> {
  try {
    const listed = await run(OSASCRIPT, ['-e', chromeListRendererTabUrlsScript()]);
    if (listed.code !== 0) return [];
    return parseChromeTabList(listed.stdout).filter(isHostOpenedRendererTabUrl);
  } catch { return []; }
}

async function closeListedTabs(urls: readonly string[], run: Runner): Promise<string[]> {
  if (urls.length === 0) return [];
  try {
    const closed = await run(OSASCRIPT, ['-e', chromeCloseTabsByUrlScript(urls)]);
    return closed.code === 0 ? [...urls] : [];
  } catch { return []; }
}

/**
 * Close the renderer tabs this host opened, by origin. SIGTERM/SIGINT land here.
 * Failure is a hint, never an error: the page also closes itself once heartbeats fail.
 */
export async function closeChromeRendererTabs({ origin, platform = process.platform, run = defaultRunner }:
  { origin: string; platform?: string; run?: Runner }): Promise<{ closed: string[] }> {
  if (platform !== 'darwin') return { closed: [] };
  let live: string;
  try { live = new URL(origin).origin; } catch { return { closed: [] }; }
  if (!isMacRendererTabUrl(`${live}/`)) return { closed: [] };
  const urls = (await listedRendererTabUrls(run)).filter(url => rendererTabOrigin(url) === live);
  return { closed: await closeListedTabs(urls, run) };
}

/**
 * On a new host start: close leftover renderer tabs whose origin no longer
 * answers. A still-live origin is left alone so two standalone hosts on this
 * Mac do not steal each other's tab. Probe is injected so a test never talks
 * to Chrome or binds a port.
 */
export async function sweepDeadRendererTabs({ platform = process.platform, run = defaultRunner, probe = probeLoopbackOrigin, liveOrigin }:
  { platform?: string; run?: Runner; probe?: OriginProbe; liveOrigin?: string } = {}): Promise<{ closed: string[] }> {
  if (platform !== 'darwin') return { closed: [] };
  const urls = await listedRendererTabUrls(run);
  const origins = [...new Set(urls.map(rendererTabOrigin).filter((value): value is string => Boolean(value)))];
  const live = new Set<string>(liveOrigin ? [liveOrigin] : []);
  for (const origin of origins) {
    if (live.has(origin)) continue;
    if (await probe(origin)) live.add(origin);
  }
  const stale = selectStaleRendererTabs({ urls, liveOrigins: live });
  return { closed: await closeListedTabs(stale, run) };
}

/* ------------------------------------------------------------------- adb */

export type AdbDevice = { serial: string; state: string };
export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (command: string, args: readonly string[]) => Promise<RunResult>;
export type OpenResult = { opened: boolean; message: string;
  /** Set when Meta's boundary screen stopped the launch, before the intent or after it, or the headset stayed asleep. */
  blocked?: 'guardian-dialog' | 'asleep';
  /** What the headset answered before the intent. */
  headset?: HeadsetState;
  tabHygiene?: LaunchTabHygiene };

/** The headset a launch chose, so a caller reaches it with the same adb and serial. */
export type QuestDevice = { adb: string; serial: string; run: Runner };

/**
 * What a launch does with the tabs Quest Browser already has. The caller owns
 * the debugger; the launch owns the order, so neither step runs while the
 * boundary screen is up.
 */
export type LaunchTabs = {
  /** Before the intent, with Quest Browser running: may keep a live tab instead of launching. */
  before: (device: QuestDevice) => Promise<LaunchTabHygiene>;
  /** After an intent that started Quest Browser cold, which reopens its last session's tabs. */
  restored?: (device: QuestDevice) => Promise<LaunchTabHygiene>;
};

/**
 * How long the headset gets to raise its boundary screen after the intent
 * before it is read again. The intent returns once Android accepts it, before
 * Quest Browser has come forward.
 */
export const GUARDIAN_RECHECK_MS = 1_500;
/**
 * How long after a wake the boundary screen may still come up. An unworn
 * Quest 2 facing a blank wall at close range raised it about 6 s after waking,
 * and a read taken just after the wake had found the screen clear.
 */
export const WAKE_SETTLE_MS = 8_000;
const WAKE_SETTLE_POLL_MS = 1_000;
/**
 * How long a sleeping headset gets to report `Awake` after the wake key. An
 * unworn Quest 2 on a desk read `Awake` within 0.5 s (2026-09-28).
 */
export const WAKE_WAIT_MS = 3_000;
const WAKE_POLL_MS = 250;
/** Why nothing was sent to a headset that stayed asleep. */
export const ASLEEP_MESSAGE = 'The headset is asleep and did not wake, and Quest Browser drops a page sent to a '
  + 'sleeping headset, so this Mac sent nothing. Press the headset\'s power button or put it on, then ask to launch again.';
const GUARDIAN_FIX = 'Clear the dialog in the headset. For orientation-only use, choose "Continue without tracking" '
  + 'if offered. For room tracking, let the headset find an open, lit part of the room. Then launch again.';
/** Why nothing was sent, in words the agent can repeat to the wearer. */
export const GUARDIAN_BLOCKED_MESSAGE = 'Meta\'s "Finding position in room" screen is up on the headset, and Quest Browser '
  + `cannot open a page behind it, so this Mac sent nothing. ${GUARDIAN_FIX}`;
/** The same screen, seen only once the intent had gone out. */
export const GUARDIAN_AFTER_LAUNCH_MESSAGE = 'Meta\'s "Finding position in room" screen came up on the headset after the '
  + `launch was sent, and Quest Browser does not receive the page behind it. ${GUARDIAN_FIX}`;

const RUN_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Where a Mac keeps adb when it is not on PATH: Homebrew, and the Android SDK Meta's own setup installs. */
export function extraAdbPaths(home: string = homedir()): string[] {
  return ['/opt/homebrew/bin/adb', '/usr/local/bin/adb', ...(isAbsolute(home) ? [join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb')] : [])];
}

/** Shared executable discovery: explicit settings, PATH, then platform locations. */
export function adbCandidates(environment: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const named = ['STEREOFOLD_ADB_BIN', 'STEREOFOLD_ADB', 'ADB']
    .map(key=>environment[key]?.trim()).filter((value):value is string=>Boolean(value && isAbsolute(value)));
  const fromPath = (environment.PATH ?? '').split(delimiter).filter(entry => isAbsolute(entry)).map(entry => join(entry, 'adb'));
  return [...new Set([...named, ...fromPath, ...extraAdbPaths(home)])];
}

/**
 * The first candidate this Mac can execute, or undefined when adb is not
 * installed. The absolute fallbacks matter most under a daemon with no PATH,
 * where the candidate list is otherwise empty.
 */
export function findAdb({ environment = process.env, home = homedir(), executable = defaultExecutable }:
  { environment?: NodeJS.ProcessEnv; home?: string; executable?: (path: string) => boolean } = {}): string | undefined {
  return adbCandidates(environment, home).find(candidate => executable(candidate));
}

function defaultExecutable(path: string) { try { accessSync(path, constants.X_OK); return true; } catch { return false; } }

/** Read `adb devices`. The header line, blank lines and daemon chatter are dropped. */
export function parseAdbDevices(stdout: string): AdbDevice[] {
  return String(stdout ?? '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !/^(?:List of devices|\*|adb server|daemon )/i.test(line))
    .map(line => /^(\S+)\s+(\S+)/.exec(line)).filter((match): match is RegExpExecArray => match !== null)
    .map(match => ({ serial: match[1], state: match[2] }));
}

/**
 * The exact intent this opens. The address must be a plain HTTPS origin, with
 * one exception: a `#pair=<eight digits>` fragment carrying this run's one-time
 * pairing code, so the wearer never has to type it.
 *
 * That exception is safe here and nowhere else. adb speaks over a debugging
 * connection the headset has already authorized to this Mac, and reaching that
 * connection at all means already holding the Mac. The code is one-time, spent
 * on first use, expires in ten minutes and works only on this Wi-Fi. Nothing
 * else is allowed through: no query string, no session token, no other
 * fragment, because those would put a durable capability on a command line
 * every process on the Mac can read.
 *
 * `browserPackage` names the app the intent must land in. Without it Android
 * resolves the default VIEW handler, and a headset carrying a second browser
 * (this Quest 2 has `org.mozilla.vrbrowser` alongside Quest Browser) can put a
 * chooser in front of the wearer, or open the companion page in a browser with
 * none of its grants. It is omitted when the package is not installed, which
 * leaves the previous behaviour rather than failing the launch.
 */
export function viewIntentArgs(url: string, { browserPackage }: { browserPackage?: string } = {}): string[] {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw Error('Opening on the headset needs the printed https:// companion address.'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search)
    throw Error('Opening on the headset needs the printed https:// companion address, with no query string.');
  if (parsed.hash && !/^#pair=\d{8}$/.test(parsed.hash))
    throw Error('Opening on the headset allows only a #pair=<code> fragment on the companion address.');
  if (browserPackage !== undefined && !ANDROID_PACKAGE_PATTERN.test(browserPackage))
    throw Error('Opening on the headset needs a plain Android package name.');
  return ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
    ...(browserPackage ? ['-p', browserPackage] : []), '-d', parsed.href];
}

/**
 * Ask the device whether one package is installed, without starting anything.
 *
 * `pm list packages <name>` matches on substring, so the answer is only trusted
 * when a line is exactly `package:<name>`. A failed query answers "not
 * installed": the intent then goes out unrestricted, which is what it did
 * before this check existed.
 */
export async function hasPackage(run: Runner, command: string, name: string): Promise<boolean> {
  try {
    const listed = await run(command, ['shell', 'pm', 'list', 'packages', name]);
    if (listed.code !== 0) return false;
    return String(listed.stdout ?? '').split(/\r?\n/).map(line => line.trim()).includes(`package:${name}`);
  } catch { return false; }
}

/** Which single device this can open on, or the one-line reason it cannot. */
export function selectDevice(devices: AdbDevice[], serial?: string): { device?: AdbDevice; problem?: string } {
  if (serial) {
    const selected = devices.find(device => device.serial === serial);
    if (!selected) return { problem: 'the configured Quest serial is not attached; check STEREOFOLD_QUEST_SERIAL or questSerial in the local config' };
    if (selected.state !== 'device') return { problem: `the configured Quest is ${selected.state}; authorize and connect it before opening` };
    return { device: selected };
  }
  const ready = devices.filter(device => device.state === 'device');
  if (ready.length === 1) return { device: ready[0] };
  const unauthorized = devices.filter(device => device.state === 'unauthorized');
  if (ready.length === 0 && unauthorized.length > 0) return { problem: 'a connected device has not authorized this Mac yet; accept the prompt in the headset' };
  if (ready.length === 0) return { problem: 'adb lists no connected device in state "device"' };
  return { problem: `adb lists ${ready.length} connected devices; connect one headset` };
}

export const defaultRunner: Runner = (command, args) => new Promise<RunResult>(resolve => {
  const child = spawn(command, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: RUN_TIMEOUT_MS });
  let stdout = '', stderr = '';
  child.stdout?.on('data', chunk => { stdout = (stdout + String(chunk)).slice(0, MAX_OUTPUT_BYTES); });
  child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, MAX_OUTPUT_BYTES); });
  child.once('error', error => resolve({ code: -1, stdout, stderr: (error as Error).message }));
  child.once('close', code => resolve({ code: code ?? -1, stdout, stderr }));
});

function firstLine(text: string) { return String(text ?? '').split(/\r?\n/).map(line => line.trim()).find(line => line) ?? ''; }

const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/**
 * Whether the boundary screen comes up before the settle window after the
 * last wake has passed. The top activity is read once a second until then. A
 * headset that has been awake longer than the window, or that did not report
 * its last wake, is not read again, so the launch waits no longer than before.
 */
async function boundaryScreenAfterWake(shell: HeadsetShell, headset: HeadsetState, settleMs: number): Promise<boolean> {
  if (headset.display !== 'Awake' || headset.wokeMsAgo === undefined) return false;
  const settled = Date.now() + settleMs - headset.wokeMsAgo;
  while (Date.now() < settled) {
    await pause(Math.min(WAKE_SETTLE_POLL_MS, settled - Date.now()));
    if (await guardianDialogShowing(shell) === true) return true;
  }
  return false;
}

/**
 * Press the wake key and read the headset until it says `Awake`, for at most
 * `waitMs`. The last reading is returned either way, so a headset that stayed
 * asleep reads as asleep.
 */
async function wakeHeadset(shell: HeadsetShell, headset: HeadsetState, waitMs: number): Promise<HeadsetState> {
  await shell(['input', 'keyevent', 'KEYCODE_WAKEUP']);
  const until = Date.now() + waitMs;
  let read = headset;
  do {
    await pause(Math.min(WAKE_POLL_MS, Math.max(0, until - Date.now())));
    read = await readHeadsetState(shell, QUEST_BROWSER_PACKAGE);
  } while (read.display !== 'Awake' && read.guardianDialog !== true && Date.now() < until);
  return read;
}

/**
 * The step after an adb launch, as the launch message words it. The server
 * removes it when the headset shows a certificate warning, because the page
 * has not loaded and Enter VR is not there yet.
 */
export function enterVrStep(worn?: boolean): string {
  return worn ? 'tap Enter VR in the headset' : 'put the headset on, then tap Enter VR';
}

/**
 * Try once to open the address on a single connected headset. Every path
 * returns one line to print; the caller continues either way.
 *
 * The headset is read before the intent and again after it, because an intent
 * behind Meta's boundary screen never reaches Quest Browser and adb still
 * answers that it started. A headset that woke less than `settleMs` ago is
 * watched until that much time has passed since the wake, because the screen
 * can come up seconds after a read that found it clear. The tab steps run only
 * once that screen is known not to be up, so a launch that cannot land closes
 * nothing.
 */
export async function openOnQuest({ url, adb, run = defaultRunner, environment = process.env, config,
  find = () => findAdb({ environment }), tabs, recheckMs = GUARDIAN_RECHECK_MS, settleMs = WAKE_SETTLE_MS, wakeMs = WAKE_WAIT_MS }:
  { url: string; adb?: string; run?: Runner; find?: () => string | undefined;
    environment?: NodeJS.ProcessEnv; config?: LocalConfig; tabs?: LaunchTabs; recheckMs?: number;
    settleMs?: number; wakeMs?: number }): Promise<OpenResult> {
  // Validate the address before anything is spawned; the package is added below.
  viewIntentArgs(url);
  const command = adb ?? find();
  if (!command) return { opened: false, message: '  adb is not installed, so this Mac cannot open the page for you; open the address in Quest Browser.' };
  const listed = await run(command, ['devices']);
  if (listed.code !== 0) return { opened: false, message: `  adb could not list devices (${firstLine(listed.stderr) || `exit ${listed.code}`}); open the address in Quest Browser.` };
  const serial = environment[QUEST_SERIAL_ENV]?.trim()
    || (config ?? readLocalConfig({ env: environment }))[QUEST_SERIAL_CONFIG_KEY]?.trim()
    || environment.STEREOFOLD_ADB_SERIAL?.trim() || environment.ANDROID_SERIAL?.trim();
  const { device, problem } = selectDevice(parseAdbDevices(listed.stdout), serial);
  if (!device) return { opened: false, message: `  ${problem}; open the address in Quest Browser.` };
  const selectedRun: Runner = (binary, args) => run(binary, ['-s', device.serial, ...args]);
  const shell = (args: readonly string[]) => selectedRun(command, ['shell', ...args]);
  let headset = await readHeadsetState(shell, QUEST_BROWSER_PACKAGE);
  // Quest Browser drops a VIEW intent that reaches a sleeping headset, and adb
  // still reports that it started (2026-09-28, Quest 2 on a desk): the wearer
  // then puts the headset on to no page. Wake it first; the boundary-screen
  // watch below then covers the seconds after that wake.
  if (headset.display && headset.display !== 'Awake' && headset.guardianDialog !== true) {
    headset = await wakeHeadset(shell, headset, wakeMs);
    if (headset.display !== 'Awake') return { opened: false, blocked: 'asleep', headset, message: `  ${ASLEEP_MESSAGE}` };
  }
  if (headset.guardianDialog === true)
    return { opened: false, blocked: 'guardian-dialog', headset, message: `  ${GUARDIAN_BLOCKED_MESSAGE}` };
  if (await boundaryScreenAfterWake(shell, headset, settleMs))
    return { opened: false, blocked: 'guardian-dialog', headset: { ...headset, guardianDialog: true },
      message: `  ${GUARDIAN_BLOCKED_MESSAGE}` };
  const chosen: QuestDevice = { adb: command, serial: device.serial, run };
  // A browser that is not running has no debugger to ask yet, and the intent
  // is what starts it, so its tabs are swept after the intent instead.
  const coldStart = headset.browserRunning === false;
  const before = tabs && !coldStart ? await tabs.before(chosen) : undefined;
  if (before && !before.launch && before.keep)
    return { opened: true, headset, tabHygiene: before, message: `  ${before.note} The wearer is already on the page.` };
  // Name Quest Browser when the headset has it, so the wearer never meets a
  // chooser and the page always lands in the browser holding its grants.
  const installed = await hasPackage(selectedRun, command, QUEST_BROWSER_PACKAGE);
  const args = viewIntentArgs(url, installed ? { browserPackage: QUEST_BROWSER_PACKAGE } : {});
  const started = await selectedRun(command, args);
  // `am start` reports a failed intent on stdout with exit status 0, so the
  // output has to be read as well as the status.
  if (started.code !== 0 || /^Error|Exception/im.test(`${started.stdout}\n${started.stderr}`))
    return { opened: false, headset, ...(before ? { tabHygiene: before } : {}),
      message: `  adb could not open the page on ${device.serial} (${firstLine(started.stderr) || firstLine(started.stdout) || `exit ${started.code}`}); open the address in Quest Browser.` };
  if (recheckMs > 0) await pause(recheckMs);
  if (await guardianDialogShowing(shell) === true)
    return { opened: false, blocked: 'guardian-dialog', headset, ...(before ? { tabHygiene: before } : {}),
      message: `  ${GUARDIAN_AFTER_LAUNCH_MESSAGE}` };
  const hygiene = coldStart && tabs?.restored ? await tabs.restored(chosen) : before;
  // adb acknowledged the intent; it does not confirm a loaded headset page.
  const next = enterVrStep(headset.worn);
  return { opened: true, headset, ...(hygiene ? { tabHygiene: hygiene } : {}),
    message: `  launch attempted on ${device.serial} · ${next}.${hygiene ? ` ${hygiene.note}` : ''}` };
}

/* ------------------------------------------------ the one call the server makes */

export type LaunchMode = 'auto' | 'web' | 'adb';
export type HeadsetTarget = 'auto' | 'meta' | 'apple';
export type HeadsetLaunchRoute = 'meta-web' | 'adb' | 'safari' | 'manual';
/**
 * What one launch did, in words the calling agent can read aloud. `link` is
 * always the code-free Web Launch link, so a result carrying it does not repeat
 * a pairing code the result already states once.
 */
export type LaunchReport = { mode: LaunchMode; opened: boolean; message: string; link?: string;
  route?: HeadsetLaunchRoute;
  /** Failure of this optional debugging route is not overall headset reachability. */
  debugging?: { available: false; detail: string; hint?: string; stage?: QuestConnectionDiagnostic['stage']; kind?: QuestConnectionDiagnostic['kind'] };
  target?: 'apple'; address?: string; instruction?: string; handoff?: 'clipboard' | 'manual';
  reason?: LaunchAttempt['reason']; code?: string; detail?: string; tabHygiene?: LaunchTabHygiene;
  blocked?: OpenResult['blocked']; headset?: HeadsetState };

/**
 * What a launch did with the tabs Quest Browser already had.
 *
 * `probed: false` is the honest case for a Mac with no debugging cable: no tab
 * was identified, none was closed, and older viewer tabs may still be open.
 * The tool text says that rather than implying a clean launch.
 */
export type LaunchTabHygiene = {
  /** Whether the debugger answered at all. False means nothing was closed. */
  probed: boolean;
  /** Whether the VIEW intent was still needed after the sweep. */
  launch: boolean;
  /** The tab that was kept: the live viewer, or after a cold start the tab the intent opened. */
  keep?: string;
  /** Tab ids that were actually closed. */
  closed: string[];
  /** Every candidate tab and how live it was. */
  tabs: { id: string; liveness: string }[];
  /**
   * The wearer's tab strip, which is not the page list.
   *
   * Quest Browser discards the renderer of every tab that is not in front and
   * keeps the strip entry, so `/json/list` under-reports the strip — eleven
   * entries against two listed pages. `enumerated` false means
   * this build would not say, and `stranded` minus `closed` is what the wearer
   * is still looking at.
   */
  strip: { enumerated: boolean; stranded: number; closed: number; reason?: string };
  /** One sentence for the agent to read out. */
  note: string;
};

/** Explicit route or fallback. A missing developer tool cannot identify a headset. */
export function headsetLaunchRoute({ mode, target = 'meta', environment = process.env, find }:
  { mode: LaunchMode; target?: HeadsetTarget; environment?: NodeJS.ProcessEnv; find?: () => string | undefined }): HeadsetLaunchRoute {
  if (target === 'apple') return 'safari';
  if (mode === 'web') return 'meta-web';
  if (mode === 'adb') return 'adb';
  if (target === 'meta') return 'meta-web';
  return 'manual';
}

export type ResolvedHeadsetLaunch = { route: HeadsetLaunchRoute; environment: NodeJS.ProcessEnv; adb?: string; verifiedSerial?: string; issue?: string; diagnostic?: QuestConnectionDiagnostic };

/** Prefer one verified, authorized Quest; reconnect only a remembered endpoint. */
export async function resolveHeadsetLaunch({ mode, target = 'meta', environment = process.env, find, run = defaultRunner }:
  { mode: LaunchMode; target?: HeadsetTarget; environment?: NodeJS.ProcessEnv; find?: () => string | undefined; run?: Runner }): Promise<ResolvedHeadsetLaunch> {
  const route = headsetLaunchRoute({ mode, target });
  if (target === 'apple' || mode === 'web') return { route, environment };
  const adb = find ? find() : findAdb({ environment });
  if (adb) {
    const connection = await resolveQuestConnection({ adb, run, environment });
    if (connection.serial) return { route: 'adb', adb, verifiedSerial: connection.serial, environment: { ...environment, [QUEST_SERIAL_ENV]: connection.serial } };
    const messages = {
      unauthorized: 'The headset has not authorized this Mac. Accept its debugging prompt, or use Meta Web Launch or Manual pairing.',
      ambiguous: 'More than one Quest is available. Select the intended headset in local setup, or use Meta Web Launch.',
      'not-quest': 'The available device could not be verified as a Quest. No page was sent to it.',
      'configured-unavailable': 'The selected Quest debugging transport is unavailable or its identity changed. No page was sent to another device.',
      'invalid-endpoint': 'The saved Quest address is not a private Wi-Fi endpoint. Use Meta Web Launch or Manual pairing.',
      failed: 'Quest debugging discovery or its identity check did not complete. This does not establish whether the headset is on or its browser is reachable. Meta Web Launch and Manual pairing remain available.',
      unavailable: 'No authorized Quest debugging connection was verified over USB or remembered Wi-Fi. This does not establish whether the headset is on or its browser is reachable. Use Meta Web Launch or Manual pairing.',
      ready: 'The Quest connection could not be verified.',
    };
    return { route, environment, adb, issue: messages[connection.reason],...(connection.diagnostic?{diagnostic:connection.diagnostic}:{}) };
  }
  return { route, environment, issue: 'This host could not find an adb executable. Use Meta Web Launch or Manual pairing; developer setup is optional.' };
}

/** Send the one-time link through stdin so it never appears in process arguments or diagnostics. */
export function copyAppleLinkToClipboard(companionUrl: string, code: string,
  { platform = process.platform, spawnChild = spawn, timeoutMs = 3_000 }:
  { platform?: string; spawnChild?: OpenerSpawn; timeoutMs?: number } = {}): Promise<boolean> {
  const link = questTargetUrl(companionUrl, code);
  if (platform !== 'darwin') return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (copied: boolean, stopChild = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopChild) { try { child?.kill(); } catch { /* The manual pairing fallback still applies. */ } }
      resolve(copied);
    };
    const timer = setTimeout(() => finish(false, true), timeoutMs);
    try {
      child = spawnChild(MAC_PBCOPY, [], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', () => finish(false));
      child.once('close', status => finish(status === 0));
      child.stdin?.once('error', () => finish(false, true));
      child.stdin?.end(link);
    } catch { finish(false, true); }
  });
}

/**
 * What the person does after a Web Launch, in the order it happens.
 *
 * The agent relays this once and then reads the wearer's state instead of
 * asking, so it has to hold every step a new user meets. An earlier version
 * named two of the steps the README gives: it left out the macOS network prompt, the headset notification, Quest
 * Browser's certificate warning and Enter VR.
 */
export const WEB_LAUNCH_STEPS = '1. On Meta’s page, click Open once; that browser must be signed in to the headset’s Meta account. '
  + '2. If macOS asks whether node may accept incoming network connections, click Allow. '
  + '3. Put the headset on and select the Web Launch notification. '
  + '4. If Quest Browser says “Your connection is not private”, select Advanced, then Proceed. '
  + '5. Tap Enter VR.';

const SAFARI_CERTIFICATE_STEP ='If Safari shows “This Connection Is Not Private,” open its details, choose the option to visit this website, and confirm for this Mac’s address.';
/**
 * The Vision Pro steps after the certificate. The agent relays
 * this result once, as it does the Web Launch steps, so it has to end where
 * the wearer does: Safari asks before it opens an immersive experience, and
 * the page waits for that answer.
 */
const SAFARI_ENTRY_STEP = 'Then tap Enter VR, and choose Allow when Safari asks whether the page may launch an immersive experience.';

async function safariLaunch(mode: LaunchMode, companionUrl: string, code: string | undefined,
  handoff: 'clipboard' | 'manual', platform: string, clipboardSpawn: OpenerSpawn): Promise<LaunchReport> {
  const address = questTargetUrl(companionUrl);
  const copied = handoff === 'clipboard' && code !== undefined
    ? await copyAppleLinkToClipboard(companionUrl, code, { platform, spawnChild: clipboardSpawn }) : false;
  const instruction = copied
    ? 'The one-time link is on this Mac’s clipboard. With Universal Clipboard enabled, paste it into Safari’s address bar on Vision Pro and open it. The link expires with the pairing code.'
    : 'Open this address in Safari on Vision Pro, then enter the pairing code shown in the companion result. The code expires in ten minutes.';
  return { mode, opened: false, target: 'apple', address, instruction, handoff: copied ? 'clipboard' : 'manual',
    message: `${address} ${instruction} ${SAFARI_CERTIFICATE_STEP} ${SAFARI_ENTRY_STEP}` };
}

export async function launchCompanion({ mode, companionUrl, code, platform = process.platform, environment = process.env,
  opener, launch, run, find, browser, target = 'meta', appleHandoff, clipboardSpawn = spawn, tabs, recheckMs, resolved }: {
    mode: LaunchMode; companionUrl: string; code?: string; platform?: string; environment?: NodeJS.ProcessEnv;
    opener?: string; launch?: Opener; run?: Runner; find?: () => string | undefined; browser?: BrowserChoice; target?: HeadsetTarget;
    appleHandoff?: 'clipboard' | 'manual'; clipboardSpawn?: OpenerSpawn;
    /** Used by the adb route only. */
    tabs?: LaunchTabs; recheckMs?: number;
    resolved?: ResolvedHeadsetLaunch;
  }): Promise<LaunchReport> {
  // Reject invalid destinations before any device discovery or reconnection.
  questTargetUrl(companionUrl, code);
  const prepared: ResolvedHeadsetLaunch = resolved ?? (target === 'apple' || mode === 'web'
    ? { route: headsetLaunchRoute({ mode, target }), environment }
    : await resolveHeadsetLaunch({ mode, target, environment, find, run }));
  const { route } = prepared;
  environment = prepared.environment;
  const diagnostic=prepared.diagnostic;
  const debugging=prepared.issue?{available:false as const,detail:diagnostic?.detail??prepared.issue,
    ...(diagnostic?{hint:diagnostic.hint,stage:diagnostic.stage,kind:diagnostic.kind}:{})}:undefined;
  const discoveryText=[prepared.issue,diagnostic?.detail,diagnostic?.hint].filter(Boolean).join(' ');
  const withDiscovery=(report:LaunchReport):LaunchReport=>prepared.issue
    ?{...report,debugging,message:`${discoveryText} ${report.message}`}:report;
  if (route === 'manual') {
    const address = questTargetUrl(companionUrl);
    const instruction = 'On the same Wi-Fi, open this address in your headset browser and enter the pairing code from this connection, then choose Enter VR. No developer setup is required. For Meta Quest, choose Open on Quest to send the link through Meta.';
    return withDiscovery({ mode, route, opened: false, address, handoff: 'manual', instruction, message: `${address} ${instruction}` });
  }
  if (route === 'safari') return { ...await safariLaunch(mode, companionUrl, code,
    appleHandoff ?? (target === 'apple' && mode === 'auto' ? 'clipboard' : 'manual'), platform, clipboardSpawn), route };
  if (route === 'adb' && !prepared.verifiedSerial)
    return { mode, route, opened: false, reason: 'failed',...(debugging?{debugging}:{}),
      message: discoveryText || 'No authorized Quest debugging connection was verified. Use Meta Web Launch or Manual pairing.' };
  if (route === 'meta-web') {
    // A host with no terminal reaches this, so the browser choice comes from the
    // environment it was started with unless the caller already made one.
    const chosen = browser ?? chooseBrowser({ environment });
    const attempt = await attemptWebLaunch({ link: webLaunchLink(companionUrl, code), platform, opener: opener ?? resolveOpener(environment), launch,
      ...(chosen.name ? { browser: chosen.name } : {}) });
    const link = webLaunchLink(companionUrl);
    const where = chosen.name ? `in ${chosen.name}` : chosen.missing
      ? `in your Mac's default browser (${BROWSER_ENV} names ${chosen.missing}, which is not installed)` : 'in your Mac browser';
    if (attempt.reason === 'started') return withDiscovery({ mode, route, opened: true, reason: attempt.reason, link, message:
      `The Mac accepted the Web Launch link ${where}; headset delivery is not confirmed. ${WEB_LAUNCH_STEPS} If Meta shows sign-in or account setup instead of Open, use the headset’s existing account there or use Manual pairing in Stereofold. The link carries this run’s pairing code to Meta, which expires in ten minutes and works only on this Wi-Fi.` });
    if (attempt.reason === 'attempted') return withDiscovery({ ...attempt, mode, route, link, message:
      `Launch attempted ${where}.${attempt.detail ? ` ${attempt.detail}` : ''} If no browser appears, open the link below yourself, click Open, then enter the pairing code once on the headset.` });
    if (attempt.reason === 'not-macos') return withDiscovery({ mode, route, opened: false, reason: attempt.reason, link, message:
      'Web Launch can open a browser only on macOS. Open the link below in a browser signed in to the same Meta account, click Open, then enter the pairing code once on the headset.' });
    return withDiscovery({ ...attempt, mode, route, link, message:
      `Could not open your Mac browser (${attempt.detail}). Open the link below yourself in a browser signed in to the same Meta account, then enter the pairing code once on the headset.` });
  }
  const outcome = await openOnQuest({ url: questTargetUrl(companionUrl, code), environment, find: () => prepared.adb, ...(run ? { run } : {}),
    ...(tabs ? { tabs } : {}), ...(recheckMs === undefined ? {} : { recheckMs }) });
  // A kept tab is a page already up, not an intent Android merely accepted.
  const kept = outcome.tabHygiene !== undefined && !outcome.tabHygiene.launch && outcome.tabHygiene.keep !== undefined;
  return { mode, route, opened: outcome.opened, reason: kept ? 'started' : outcome.opened ? 'attempted' : 'failed',
    message: outcome.message.trim().replace(/^adb is not installed,/, 'adb is not installed on this Mac,'),
    ...(outcome.blocked ? { blocked: outcome.blocked } : {}), ...(outcome.headset ? { headset: outcome.headset } : {}),
    ...(outcome.tabHygiene ? { tabHygiene: outcome.tabHygiene } : {}) };
}
