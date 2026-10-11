/**
 * One command from a terminal to a molecule on a Meta Quest.
 *
 * `pnpm --dir plugin run quest 1CRN` checks the machine, starts the standalone
 * host, opens the desktop panel that does the rendering and saving, waits for a
 * saved scene, opens private Wi-Fi sharing, and prints the address, pairing
 * code, fingerprint and expiry for the person wearing the headset.
 *
 * This script owns none of that behaviour itself. It spawns
 * `scripts/serve-inspection.ts` unchanged and talks to that host's loopback
 * `/agent` endpoint, the same endpoint `scripts/inspection-agent.ts` posts to.
 * The panel bearer printed by the host stays inside this process: it is passed
 * to the browser and never written to this command's own output.
 */
import { shareMaxLifetimeMs, type PairingFailure } from '../src/inspection-lan.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { describeBuildContent, formatDoctor, runDoctor, type DoctorReport } from './setup-doctor.js';
import { formatBuildIdentities } from '../src/build-identity.js';
import { pttLaunchEnabled } from '../src/ptt-launch-options.js';
import { pushToTalkFromEnv } from '../src/push-to-talk.js';
import { pushToTalkTranscriberFromEnv } from '../src/push-to-talk-transcribe.js';
import { openOnQuest } from './quest-open-on-device.js';
import { describePanelWait, panelWaitMs, PANEL_SAVE_WAIT } from './panel-wait.js';
import { chooseBrowser, formatBrowserChoice, formatWebLaunch, openLocalInBrowser, resolveBrowser, webLaunchLink } from './quest-web-launch.js';
import { WEB_LAUNCH_STEPS, attemptWebLaunch, closeChromeRendererTabs, copyAppleLinkToClipboard, sweepDeadRendererTabs } from '../src/quest-launch.js';
import { redactTokens, requestRoute } from './report-redaction.js';
import { startSceneSocketRelay, defaultSocket } from './scene-socket-relay.js';
import { sceneServicePath, sceneCallTimeoutMs, SCENE_HOST_START_TIMEOUT_MS, SCENE_SOCKET_ENV } from '../src/scene-service.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pluginRequire = createRequire(resolve(pluginRoot, 'package.json'));

/**
 * Off, or on with the one-time pairing code in the link, or on without it for a
 * headset this Mac already remembers.
 */
export type LaunchMode = 'off' | 'code' | 'no-code';

export type QuestOptions = {
  source: string;
  statePath: string;
  lessonPath?: string;
  /**
   * The prepared density map this run draws, when its lesson is
   * a volume lesson. The positional source stays the coordinates the session
   * opens on; this is the separate hashed asset the headset page is given.
   */
  densityPath?: string;
  assemblyId?: string;
  tourId?: string;
  /**
   * The wearer asked for the lesson's own tour, so start it as
   * soon as the headset pairs.
   *
   * A lesson carries a tour, and this host used to push it the moment a Quest
   * appeared. A device test found the consequence: put the
   * headset on for the go-to demo and five scenes play themselves at a person
   * who has not asked for anything. Nothing in the headset asked for that, so
   * nothing starts one unless this flag or `--tour` says to.
   */
  playTour: boolean;
  headless: boolean;
  allowStaleBuild: boolean;
  pushToTalk: boolean;
  remember: boolean;
  shareHours?: number;
  webLaunch: LaunchMode;
  /** The wearer named the Web Launch variant, so a remembered headset does not change it. */
  webLaunchPinned: boolean;
  openOnQuest: LaunchMode;
  /**
   * The wearer is on Apple Vision Pro. Meta Web Launch cannot reach it, so the
   * one-time link goes to this Mac's clipboard instead, for Universal Clipboard.
   */
  visionPro: boolean;
  /** The application `open -a` hands links to, or undefined for this Mac's default browser. */
  browser?: string;
  lanHost?: string;
  lanPort: number;
  /**
   * How big the structure is, when the caller knows.
   *
   * `quest-demo.ts` reads it from `plugin/demos/index.json` and passes it
   * through, so the waits below can scale with the coordinate count instead of
   * using one deadline written for a 13,121-site structure.
   */
  atomSites?: number;
  /** An explicit override for the first-saved-scene wait, in milliseconds. */
  panelTimeoutMs?: number;
  help?: true;
};

export const usage = `Usage: pnpm --dir plugin run quest [1CRN | /absolute/structure.cif] [options]

  --lesson <absolute lesson.json>   load an authored lesson; needs a local mmCIF source
  --assembly <assembly id>          build a biological assembly the entry declares, e.g. 1
  --tour <tour id>                  start this tour once the headset pairs
  --play-tour                       start the lesson's own tour once the headset
                                    pairs (without it no tour plays by itself)
  --headless                        render the desktop panel in headless Chromium
  --no-ptt                          do not record the headset microphone (on by default)
  --ptt                             record it; overrides STEREOFOLD_PTT_TRANSCRIBE, which
                                    this run also honours (0/off/no/false turn it off)
  --no-web-launch                   do not open a Meta Web Launch link (on by default)
  --vision-pro                      the wearer uses Apple Vision Pro: copy the one-time
                                    link to this Mac's clipboard for Safari there
                                    (Universal Clipboard), instead of Meta Web Launch
  --browser <application>           which browser opens the links, as open -a names it,
                                    e.g. "Google Chrome" (default: this Mac's default browser,
                                    or STEREOFOLD_BROWSER)
  --web-launch[=code|=no-code]      pin the Web Launch variant instead of choosing it
  --open-on-quest[=no-code]         open the address on a Quest connected over adb
  --share-hours <hours>             hard stop after 0.5–24 hours (default 8; or STEREOFOLD_SHARE_MAX_HOURS)
  --no-remember                     never hand a paired headset a 30-day device key
  --allow-stale-build               run anyway when dist only looks older than src
  --state <absolute path>           control file (default ~/.stereofold/quest-share.json)
  --density <absolute .map>         a prepared CCP4/MRC density map for a volume
                                    lesson, served to the headset on its own
                                    hashed route (demo runs pass this)
  --lan-host <private IPv4>         pick one assigned address
  --lan-port <port>                 default 8443
  --atom-sites <n>                  how many atom sites this structure has, so the
                                    wait for the panel's first saved scene can scale
                                    (demo runs pass this from plugin/demos/index.json)
  --panel-timeout <seconds>         override that wait outright (10-600)
  --help

  If Quest Browser will not let you past the certificate warning, see
  docs/headset-walkthrough.md. The LAN port serves HTTPS with this Mac's
  certificate, so an "adb reverse" forward does not avoid the warning; the
  private Wi-Fi address is the supported route.`;

const pdbPattern = /^[a-z0-9]{4}$/i;
const coordinatePattern = /\.(?:cif|mmcif)$/i;

/** Accept the same sources the standalone host accepts, and refuse the rest here rather than in a child process. */
export function isPdbId(source: string): boolean { return pdbPattern.test(source); }

/**
 * `STEREOFOLD_PTT_TRANSCRIBE` as an answer to "does this run record the wearer?".
 *
 * Every other host on this machine already turns headset voice on with that
 * variable — the Codex and Claude Science MCP servers have no command line to
 * pass `--ptt` on — and the launcher was the one place it meant nothing, so an
 * operator who had exported it for the day still got a run whose microphone
 * setting came from somewhere else. It reads the same way here as it does in
 * `push-to-talk-transcribe.ts`: `0`, `off`, `no` and `false` mean off, any
 * other non-empty value means on.
 *
 * Undefined, not a default, when the variable is unset or blank: the flags and
 * then `--headless` still decide, and a flag always wins over the environment.
 */
export function pushToTalkFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const setting = env.STEREOFOLD_PTT_TRANSCRIBE?.trim().toLowerCase();
  if (!setting) return undefined;
  return !['0', 'off', 'no', 'false'].includes(setting);
}

export function parseQuestArgs(args: string[], home: string = homedir(), env: NodeJS.ProcessEnv = process.env): QuestOptions {
  const positional: string[] = [];
  let lessonPath: string | undefined, tourId: string | undefined, statePath: string | undefined, lanHost: string | undefined, assemblyId: string | undefined, densityPath: string | undefined;
  let browser: string | undefined;
  let shareHoursRaw = env.STEREOFOLD_SHARE_MAX_HOURS;
  let headless = false, allowStaleBuild = false, remember = true, lanPort = 8443, playTour = false;
  let atomSites: number | undefined, panelTimeoutMs: number | undefined;
  // Undefined until a flag says otherwise: the defaults are decided once, at the
  // end, from whether this run is rendering for a wearer or for a test.
  let webLaunch: LaunchMode | undefined;
  let webLaunchPinned = false, openOnDevice: LaunchMode = 'off', visionPro = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { source: '1CRN', statePath: resolve(home, '.stereofold/quest-share.json'), playTour: false, headless: false, allowStaleBuild: false, pushToTalk: false, remember: true, webLaunch: 'off', webLaunchPinned: true, openOnQuest: 'off', visionPro: false, lanPort: 8443, help: true };
    if (argument === '--play-tour') { playTour = true; continue; }
    if (argument === '--headless') { headless = true; continue; }
    if (argument === '--ptt' || argument === '--no-ptt') continue;
    if (argument === '--no-web-launch') { webLaunch = 'off'; webLaunchPinned = true; continue; }
    if (argument === '--vision-pro') { visionPro = true; continue; }
    if (argument === '--allow-stale-build') { allowStaleBuild = true; continue; }
    if (argument === '--no-remember') { remember = false; continue; }
    // Both routes carry the code, because the whole point is that nobody types
    // on the headset. Naming the variant pins it; a bare --web-launch leaves the
    // choice to whether this Mac already remembers a headset.
    if (argument === '--web-launch') { webLaunch = 'code'; continue; }
    if (argument === '--web-launch=code') { webLaunch = 'code'; webLaunchPinned = true; continue; }
    if (argument === '--web-launch=no-code') { webLaunch = 'no-code'; webLaunchPinned = true; continue; }
    if (argument === '--open-on-quest' || argument === '--open-on-quest=code') { openOnDevice = 'code'; continue; }
    if (argument === '--open-on-quest=no-code') { openOnDevice = 'no-code'; continue; }
    if (argument.startsWith('-')) {
      // Name the wrong flag before complaining about its value, or a typo reads
      // as a missing argument.
      if (!['--lesson', '--assembly', '--density', '--tour', '--state', '--lan-host', '--lan-port', '--browser', '--atom-sites', '--panel-timeout', '--share-hours'].includes(argument)) throw Error(`Unknown option: ${argument}`);
      const value = args[++index];
      if (!value || value.startsWith('-')) throw Error(`${argument} needs a value.`);
      if (argument === '--lesson') {
        if (!isAbsolute(value) || !/\.json$/i.test(value)) throw Error('--lesson must be an absolute path to a lesson JSON file.');
        lessonPath = resolve(value); continue;
      }
      if (argument === '--density') {
        if (!isAbsolute(value) || !/\.(?:map|ccp4|mrc)$/i.test(value)) throw Error('--density must be an absolute .map/.ccp4/.mrc path.');
        densityPath = resolve(value); continue;
      }
      if (argument === '--assembly') {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw Error('--assembly must be an assembly identifier the entry declares, such as 1.');
        assemblyId = value; continue;
      }
      if (argument === '--tour') {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(value)) throw Error('--tour must be a tour ID such as fold-detective.');
        tourId = value; continue;
      }
      if (argument === '--state') {
        if (!isAbsolute(value)) throw Error('--state must be an absolute path.');
        statePath = resolve(value); continue;
      }
      if (argument === '--share-hours') { shareHoursRaw = value; continue; }
      if (argument === '--browser') { browser = resolveBrowser({}, value); continue; }
      if (argument === '--lan-host') { lanHost = value; continue; }
      if (argument === '--lan-port') {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) throw Error('--lan-port must be an integer from 1024 through 65535.');
        lanPort = parsed; continue;
      }
      if (argument === '--atom-sites') {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5_000_000) throw Error('--atom-sites must be an integer from 1 through 5000000.');
        atomSites = parsed; continue;
      }
      if (argument === '--panel-timeout') {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 10 || parsed > 600) throw Error('--panel-timeout must be a whole number of seconds from 10 through 600.');
        panelTimeoutMs = parsed * 1_000; continue;
      }
    }
    positional.push(argument);
  }
  if (positional.length > 1) throw Error('Supply one structure: a four-character PDB ID or one absolute .cif/.mmcif path.');
  const source = positional[0] ?? '1CRN';
  if (!isPdbId(source) && !(isAbsolute(source) && coordinatePattern.test(source)))
    throw Error('Supply a four-character PDB ID such as 1CRN, or an absolute .cif/.mmcif path.');
  if (lessonPath && isPdbId(source))
    throw Error('A lesson needs local coordinates. Download the entry first (curl -fsSL https://files.rcsb.org/download/<ID>.cif -o /absolute/path.cif) and pass that path.');
  if (lessonPath && tourId) throw Error('Pass --lesson or --tour, not both; the lesson supplies its own tour.');
  // --play-tour names no tour of its own: it starts the one the lesson carries.
  if (playTour && !lessonPath) throw Error('--play-tour needs --lesson: it starts the tour that lesson carries. Name a tour with --tour instead.');
  // The assembly rides with the lesson because only inspect_lesson carries it.
  if (assemblyId && !lessonPath) throw Error('--assembly needs --lesson: the assembly is opened with the lesson that describes it.');
  // The map is meaningless without the lesson that names its contour and its
  // digest, and the host refuses it on any lesson that is not a volume lesson.
  if (densityPath && !lessonPath) throw Error('--density needs --lesson: the lesson is what names the map, its digest and its contour.');
  // Web Launch and the cable both reach a Quest only.
  if (visionPro && (webLaunch === 'code' || webLaunch === 'no-code' || openOnDevice !== 'off'))
    throw Error('--vision-pro sends the link by clipboard; drop --web-launch and --open-on-quest, which reach a Quest only.');
  // "Put the headset on and get going" is the default, so the microphone and the
  // Web Launch link are on unless this run says otherwise. A headless run renders
  // for a test rather than for a wearer, so it opts out of both.
  return { source: isPdbId(source) ? source : resolve(source), statePath: statePath ?? resolve(home, '.stereofold/quest-share.json'),
    shareHours: shareMaxLifetimeMs(shareHoursRaw ?? '') / 3_600_000,
    lessonPath, densityPath, assemblyId, tourId, playTour, headless, allowStaleBuild, pushToTalk: pttLaunchEnabled(args, env, !headless), remember,
    webLaunch: webLaunch ?? (headless || visionPro ? 'off' : 'code'), webLaunchPinned, openOnQuest: openOnDevice, visionPro, browser, lanHost, lanPort,
    ...(atomSites === undefined ? {} : { atomSites }), ...(panelTimeoutMs === undefined ? {} : { panelTimeoutMs }) };
}

/** Pass the selected ceiling to the child host, including an explicit flag override. */
export function questHostEnv(options: Pick<QuestOptions, 'shareHours'>, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, ...(options.shareHours === undefined ? {} : { STEREOFOLD_SHARE_MAX_HOURS: String(options.shareHours) }) };
}

/**
 * Turn the doctor report into the reasons this run cannot start. Empty means go.
 * The port check is the one that matters most in practice: another agent's host
 * already owns 8443 more often than anything else here fails.
 */
export function preflightProblems(report: DoctorReport, allowStaleBuild = false): string[] {
  const problems: string[] = [];
  if (report.node.check !== 'ok') problems.push(`Node ${report.node.version} is older than ${report.node.required}.`);
  if (report.openssl.check !== 'ok') problems.push('openssl is unavailable, and the private Wi-Fi certificate needs it.');
  if (report.build.state === 'missing') problems.push(`plugin/dist is incomplete (${report.build.files.join(', ')}). Run: pnpm install --frozen-lockfile && pnpm run build`);
  // Staleness now leads with the build's recorded source hash, so a second
  // checkout no longer trips it on modification times alone. It stays waivable
  // because a checkout somebody else is editing can still be stale and fine.
  // Missing files are never waived this way.
  if (report.build.state === 'stale' && !allowStaleBuild) {
    problems.push(`plugin/dist does not match plugin/src (${describeBuildContent(report.build.content)}). `
      + 'Run: pnpm run build, or pass --allow-stale-build to run the existing one anyway.');
  }
  if (report.lan.addresses.length === 0) problems.push('This Mac has no assigned private IPv4 address. Join the Wi-Fi the Quest is on, then retry.');
  if (report.port.state === 'listening') problems.push(`TCP ${report.port.port} already has a listening process. Stop that session, or pass --lan-port with a free port.`);
  if (report.port.state === 'unknown') problems.push(`TCP ${report.port.port} occupancy could not be determined; lsof was missing, denied, or timed out twice.`);
  return problems;
}

export type HostAddress = { origin: string; address: string };

/** The host prints exactly one line carrying the panel bearer, in the URL fragment. */
export function parseHostAddress(line: string): HostAddress | undefined {
  const match = /(http:\/\/127\.0\.0\.1:(\d{1,5})\/#[a-f0-9]{64})\s*$/.exec(line);
  return match ? { origin: `http://127.0.0.1:${match[2]}`, address: match[1] } : undefined;
}

/** Anything this command prints about the panel address goes through here. */
export function redactAddress(address: string): string {
  return address.replace(/#[a-f0-9]{64}/, '#<panel key, not shown>');
}

/** Browser diagnostics must never echo a page capability or URL query. */
export function headlessFailureText(value: unknown): string {
  return redactTokens(String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, requestRoute))
    .replace(/\s+/g, ' ').slice(0, 500);
}

/** Distinguish a connected bridge from a renderer that actually finished. */
export async function renderHeadlessPanel(page: any, address: string): Promise<void> {
  const errors: string[] = [];
  const remember = (kind: string, value: unknown) => {
    errors.push(`${kind}: ${headlessFailureText(value)}`);
    if (errors.length > 4) errors.shift();
  };
  const onConsole = (message: any) => { if (message.type() === 'error') remember('console', message.text()); };
  const onError = (error: Error) => remember('page', error.message);
  page.on('console', onConsole); page.on('pageerror', onError);
  let phase = 'host bridge', frame: any;
  try {
    page.setDefaultTimeout(120_000);
    await page.goto(address);
    await page.waitForFunction(() => Boolean((globalThis as any).__host?.connected), null, { timeout: 120_000 });
    phase = 'inspection startup';
    frame = page.frames().find((candidate: any) => candidate !== page.mainFrame());
    if (!frame) throw Error('The inspector iframe never appeared.');
    await frame.waitForFunction(() => ['true', 'error'].includes(document.body.dataset.ready ?? ''), null, { timeout: 120_000 });
    if (await frame.locator('body').getAttribute('data-ready') === 'error') throw Error('The inspector reported a startup error.');
    phase = 'rendered canvas';
    await frame.locator('.stage canvas').waitFor({ state: 'visible' });
  } catch (error) {
    const status = await (frame ?? page).locator(frame ? '#status' : '#host-status')
      .textContent({ timeout: 1_000 }).catch(() => '');
    const detail = [headlessFailureText((error as Error).message), headlessFailureText(status), ...errors].filter(Boolean).join(' | ');
    throw Error(`Headless panel failed during ${phase}: ${detail}`);
  } finally {
    page.off('console', onConsole); page.off('pageerror', onError);
  }
}

export type Panel = { panelId: string; surface: string; availability: string; current?: boolean };

/** Prefer the current panel of that surface, and fall back to any ready one. */
export function selectPanel(panels: Panel[] | undefined, surface: string): Panel | undefined {
  const ready = (panels ?? []).filter(panel => panel.surface === surface && panel.availability === 'ready');
  return ready.find(panel => panel.current) ?? ready[0];
}

export type InspectionState = {
  hasScene?: boolean; serverEpoch?: string; sourceToken?: string; stateRevision?: number; inspectionRevision?: number;
  panels?: Panel[]; tours?: { id: string }[]; command?: { commandId: string; status: string };
};

export function isDesktopReady(state: InspectionState | undefined): boolean {
  return Boolean(state?.hasScene) && Boolean(selectPanel(state?.panels, 'desktop'));
}

/** An authored lesson joins the bundled catalogue as lesson-<the lesson's id>. */
export function selectLessonTour(tours: { id: string }[] | undefined): string | undefined {
  return (tours ?? []).map(tour => tour.id).find(id => id.startsWith('lesson-'));
}

/**
 * Which tour, if any, this host pushes when a headset pairs.
 *
 * The rule is that a tour plays because a person asked for one. `--tour` names
 * one outright; `--play-tour` asks for the tour the lesson carries. A plain
 * `--lesson` run, which is every shipped demo including telomerase, starts
 * nothing: the wearer arrives in the scene and the spoken "play the tour" is
 * what begins it.
 *
 * Before this, a lesson's own tour was pushed on pairing, so putting the
 * headset on for the go-to demo played five scenes at somebody who
 * had asked for nothing.
 */
export function tourToStartOnPairing(
  options: Pick<QuestOptions, 'tourId' | 'lessonPath' | 'playTour'>,
  tours: { id: string }[] | undefined,
): string | undefined {
  if (options.tourId) return options.tourId;
  if (!options.lessonPath || !options.playTour) return undefined;
  return selectLessonTour(tours);
}

/** How many headsets this Mac already remembers, from a manage_companion status. */
export function rememberedDeviceCount(status: { rememberedDevices?: unknown[] } | undefined): number {
  return Array.isArray(status?.rememberedDevices) ? status.rememberedDevices.length : 0;
}

/**
 * Which Web Launch variant to use.
 *
 * The pairing code is the one secret that leaves this network: Meta's page
 * receives it as a query value. A headset this Mac already remembers holds a
 * device key instead, so on every run after the first the code has nothing to
 * do and is left out. Naming the variant on the command line pins it.
 */
export function preferredWebLaunch(mode: LaunchMode, pinned: boolean, rememberedDevices: number): LaunchMode {
  return mode === 'code' && !pinned && rememberedDevices > 0 ? 'no-code' : mode;
}

export type LanStatus = { clients?: { id: string; deviceId?: string }[]; pairingFailure?: PairingFailure };
export function pairedClientIds(status: { lan?: LanStatus; companion?: LanStatus } | undefined): string[] {
  return ((status?.lan ?? status?.companion)?.clients ?? []).map(client => client.id);
}

/** One initial send and at most one recovery, authorized only by this page's failure. */
export function recoverableWebLaunch({ companion, mode, send, freshCode, recovered }:
  { companion: Companion; mode: LaunchMode; send: (link: string) => boolean | Promise<boolean>;
    freshCode: (launchId: string) => Promise<string | undefined>; recovered: () => void }) {
  let sent = false, settled = false;
  return {
    async start() {
      if (sent || mode === 'off') return;
      sent = true;
      if (!await send(webLaunchLink(companion.url ?? '', mode === 'code' ? companion.pairingCode : undefined, companion.launchId))) settled = true;
    },
    async observe(status: LanStatus | undefined) {
      if (!sent || settled) return;
      // The answering client selects itself by redeeming its own device ID/key.
      if (status?.clients?.length) { settled = true; return; }
      const report = status?.pairingFailure;
      if (mode !== 'no-code' || !companion.launchId || report?.launchId !== companion.launchId
        || !['device_key_missing', 'device_not_remembered'].includes(report.failure)) return;
      // Consume before awaiting: concurrent polls and a repeated page report cannot double-send.
      settled = true;
      const code = await freshCode(companion.launchId);
      if (!code) return;
      if (await send(webLaunchLink(companion.url ?? '', code))) recovered();
    },
  };
}

export type PollOptions = { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
  /**
   * Say the wait is still running, roughly this often.
   *
   * A two-minute silent wait and a hung run look identical from outside, and
   * the `tip` host sat through the whole of one before printing a
   * timeout. Called with whole seconds waited and the whole-second deadline.
   */
  progress?: (waitedSeconds: number, timeoutSeconds: number) => void; progressEveryMs?: number };
const realSleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

/**
 * Poll a reader until the predicate holds. Used for the saved scene, the
 * rendered receipt, and the first paired headset, so the retry behaviour is
 * written once and can be tested with fakes.
 */
export async function pollUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean, description: string, options: PollOptions = {}): Promise<T> {
  const { timeoutMs = 90_000, intervalMs = 2_000, sleep = realSleep, now = Date.now, progress, progressEveryMs = 30_000 } = options;
  const started = now(), deadline = started + timeoutMs;
  let announced = started;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (ready(last)) return last;
    if (now() >= deadline) throw Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${description}.`);
    if (progress && now() - announced >= progressEveryMs) {
      announced = now();
      progress(Math.round((announced - started) / 1_000), Math.round(timeoutMs / 1_000));
    }
    await sleep(intervalMs);
  }
}

export type Companion = {
  url?: string; fingerprint?: string; pairingCode?: string; launchId?: string;
  pairingExpiresAt?: string; sessionExpiresAt?: string; sessionMaxExpiresAt?: string;
};

function clockAndMinutes(iso: string | undefined, now: Date): string {
  if (!iso) return 'unknown';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'unknown';
  const minutes = Math.max(0, Math.round((at.getTime() - now.getTime()) / 60_000));
  return `${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${minutes} min)`;
}

/** Local connection details for manual pairing; never copy into narration or logs. */
export function formatWearerBlock(companion: Companion, now: Date = new Date(), remember = true): string {
  return [
    '',
    '  Connection details on this Mac (the headset must use the same Wi-Fi):',
    '',
    `    Address        ${companion.url ?? 'unavailable'}`,
    `    Pairing code   ${companion.pairingCode ?? 'unavailable'}`,
    `    Fingerprint    ${companion.fingerprint ?? 'unavailable'}`,
    `    Code expires   ${clockAndMinutes(companion.pairingExpiresAt, now)}`,
    `    Idle expiry    ${clockAndMinutes(companion.sessionExpiresAt, now)}`,
    `  Sharing renews while the headset is in use; hard stop at ${clockAndMinutes(companion.sessionMaxExpiresAt, now)}.`,
    '',
    '  On Quest, open the launch notification or the address above.',
    '  On Vision Pro, open the address above in Safari and type the pairing code.',
    '  Accept the certificate for this address if asked, then tap Enter VR.',
    '  Explore with the headset controls or text commands. Tours are optional.',
    remember
      ? '  This headset is remembered for up to 30 days, subject to the configured idle expiry.'
      : '  Remembered headsets are off for this run; launch links carry the pairing code.',
    '',
  ].join('\n');
}

/**
 * Put the one-time link on this Mac's clipboard for Safari on Vision Pro, and
 * say what the wearer does next. The link travels through the clipboard's
 * stdin, never through arguments or this terminal.
 */
export async function visionProHandoff(companion: Companion,
  copy: (url: string, code: string) => Promise<boolean> = copyAppleLinkToClipboard): Promise<string> {
  const copied = companion.url && companion.pairingCode ? await copy(companion.url, companion.pairingCode) : false;
  return [
    copied
      ? '  Vision Pro: the one-time link is on this Mac’s clipboard. With Universal Clipboard on, paste it into Safari’s address bar on Vision Pro and open it.'
      : '  Vision Pro: open the address above in Safari on Vision Pro and type the pairing code.',
    '  If Safari says “This Connection Is Not Private,” tap Show Details, then visit this website.',
    '  Tap Enter VR, then Allow when Safari asks to launch the immersive experience.',
  ].join('\n');
}

export function launcherVoiceGuidance(pushToTalk: boolean): string {
  return pushToTalk
    ? 'Microphone capture is enabled. Voice still needs a successful test press, reply audio and an assistant actively listening; text and manual controls remain available.'
    : 'Microphone capture is off for this run. Use text and headset controls; enable --ptt when you want to check voice.';
}

/** Only an explicit closed-share receipt ends this launcher, not a failed read. */
export function shareEnded(status: unknown): boolean {
  return Boolean(status && typeof status === 'object' && (status as {lan?:unknown}).lan === null);
}

/** Reap this launcher's host and, on POSIX, only its newly created process group. */
export async function stopOwnedHost(host: ChildProcess, processGroup = false, graceMs = 5_000): Promise<void> {
  const exited = () => host.exitCode !== null || host.signalCode !== null;
  const send = (signal: NodeJS.Signals) => {
    try {
      if (processGroup && host.pid) process.kill(-host.pid, signal);
      else if (!exited()) host.kill(signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const wait = (timeout: number) => new Promise<void>(done => {
    if (exited()) { done(); return; }
    const finish = () => { clearTimeout(timer); host.off('exit', finish); done(); };
    const timer = setTimeout(finish, timeout);
    host.once('exit', finish);
  });
  send('SIGTERM');
  await wait(graceMs);
  // A host that exited can still have left a descendant in its owned group.
  // ESRCH means the entire group has already gone, which is normal success.
  send('SIGKILL');
  await wait(1_000);
}

type Control = { origin: string; token: string; sessionId: string };

async function readControl(path: string): Promise<Control> {
  const control = JSON.parse(await readFile(path, 'utf8')) as Control;
  const origin = new URL(control.origin);
  if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:') throw Error('Local control requires loopback.');
  return control;
}

/** The same POST `scripts/inspection-agent.ts` makes, kept in-process so a poll is not a process spawn. */
async function agentCall(control: Control, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await fetch(`${control.origin}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${control.token}` },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(sceneCallTimeoutMs(name,args)+5_000),
  });
  const body = await response.json() as any;
  if (!response.ok) throw Error(body?.error ?? `${name} failed`);
  return body;
}

const binding = (state: InspectionState) => ({
  serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
  baseStateRevision: state.stateRevision, baseInspectionRevision: state.inspectionRevision,
});

async function readState(control: Control, args: Record<string, unknown> = {}): Promise<InspectionState> {
  return (await agentCall(control, 'get_inspection_state', args)).structuredContent as InspectionState;
}

function say(message: string) { process.stdout.write(`${message}\n`); }
/** Piped stdout is asynchronous, so exiting without draining it drops the last lines. */
const flush = () => new Promise<void>(done => { process.stdout.write('', () => done()); });

async function main(options: QuestOptions, bundled = false): Promise<void> {
  say('Stereofold · checking this machine');
  const report = await runDoctor({ root: pluginRoot, port: options.lanPort, controlFile: undefined });
  const problems = preflightProblems(report, options.allowStaleBuild);
  if (problems.length > 0) {
    say(formatDoctor(report));
    say('');
    for (const problem of problems) say(`  - ${problem}`);
    throw Error('Not ready to share.');
  }
  if (report.build.state === 'stale') {
    say(`  warning · plugin/dist does not match plugin/src (${describeBuildContent(report.build.content)}); running it anyway`);
  }
  say(`  ready · ${report.lan.addresses.map(entry => `${entry.interface} ${entry.address}`).join(', ')} · TCP ${options.lanPort} free`);
  // Which bytes this run serves. Codex runs its own installed copy of `dist/`
  // and this host runs the checkout's, so the two can be different builds of
  // the same plugin with nothing on screen saying so. This line is the same
  // number a mounted panel reports in `diagnostics.viewerBuild`.
  say(`  build · ${formatBuildIdentities(report.build.stamps)}`);
  // Which browser gets both the panel and the Meta page. Web Launch only reaches
  // the headset from a browser signed in to the same Meta account, and the Mac's
  // default is often not the one holding that session.
  const browserChoice = chooseBrowser({ explicit: options.browser });
  say(formatBrowserChoice(browserChoice));
  // Say what a grip press will do before the headset can press one, and name
  // what is missing when this Mac cannot transcribe.
  if (options.pushToTalk) {
    say(`  ${pushToTalkTranscriberFromEnv(process.env).describe()}`);
    if (process.env.STEREOFOLD_PTT_DOWN || process.env.STEREOFOLD_PTT_UP)
      say(`  ${pushToTalkFromEnv({ ...process.env, STEREOFOLD_PTT_ENABLED: '1' }).describe()}`);
  }

  // A control file left behind by a killed host names a dead port; remove it so
  // a failed start cannot be mistaken for a live session.
  await mkdir(dirname(options.statePath), { recursive: true, mode: 0o700 });
  await rm(options.statePath, { force: true });

  const hostProcessGroup = process.platform !== 'win32';
  const host: ChildProcess = spawn(process.execPath, [
    ...(bundled ? [resolve(pluginRoot, 'dist/serve-inspection.mjs')]
      : ['--import', 'tsx', resolve(pluginRoot, 'scripts/serve-inspection.ts')]),
    options.source, options.statePath, ...(options.lessonPath ? [options.lessonPath] : []),
    ...(options.densityPath ? ['--density', options.densityPath] : []),
    ...(options.assemblyId ? ['--assembly', options.assemblyId] : []),
    ...(options.pushToTalk ? ['--ptt'] : ['--no-ptt']), ...(options.remember ? [] : ['--no-remember']),
  ], { cwd: pluginRoot, env: questHostEnv(options), detached: hostProcessGroup, stdio: ['ignore', 'pipe', 'pipe'] });

  let browser: { close(): Promise<void> } | undefined;
  let stopRelay: (() => Promise<void>) | undefined;
  let stopping = false;
  let panelOrigin: string | undefined;
  /**
   * Every exit after the host is spawned goes through here, including a thrown
   * error partway through the route. Leaving the host behind would hold the
   * session and the private listener open with nothing driving them.
   */
  const stop = async (code: number, reason?: string) => {
    if (stopping) return;
    stopping = true;
    say('');
    if (reason) say(reason);
    say('Stopping. The session and the private Wi-Fi listener close with it.');
    // The outer `tsx` launcher may force-exit this process shortly after a
    // signal. Start terminating the detached host group before any browser
    // cleanup can use up that window and strand the private LAN listener.
    const hostStop = stopOwnedHost(host, hostProcessGroup).catch(() => undefined);
    // A hung browser close must not keep the host alive. The host's SIGTERM
    // also closes this origin's tab; doing it here covers a host already gone.
    try {
      await Promise.race([
        Promise.all([
          browser?.close(),
          panelOrigin ? closeChromeRendererTabs({ origin: panelOrigin }) : undefined,
        ]),
        realSleep(5_000),
      ]);
    } catch { /* the tab is going away regardless */ }
    await hostStop;
    await stopRelay?.().catch(() => undefined);
    await rm(options.statePath, { force: true }).catch(() => undefined);
    await flush();
    process.exit(code);
  };
  process.on('SIGINT', () => void stop(0));
  process.on('SIGTERM', () => void stop(0));

  // Run from an agent, this command is usually a grandchild of whatever gets
  // signalled, and a signal sent to the wrapper alone never reaches here. Being
  // reparented to init is the reliable sign that nobody is driving any more.
  const orphanWatch = setInterval(() => { if (process.ppid === 1) void stop(0, 'The process that started this command is gone.'); }, 2_000);
  orphanWatch.unref();

  let hostErrors = '';
  host.stderr?.on('data', chunk => { hostErrors = (hostErrors + String(chunk)).slice(-4000); });
  host.on('exit', code => {
    if (stopping) return;
    void stop(code ?? 1, `The standalone host exited (${code ?? 'signal'}). ${hostErrors.trim()}`.trim());
  });
  host.on('error', error => { if (!stopping) void stop(1, `The standalone host could not start: ${headlessFailureText(error.message)}`); });

  try {
    say(`Starting the host on ${isPdbId(options.source) ? options.source.toUpperCase() : options.source}`);
    const lines = createInterface({ input: host.stdout! });
    const address = await new Promise<HostAddress>((done, fail) => {
      const timer = setTimeout(() => fail(Error(`The host did not print its address within ${SCENE_HOST_START_TIMEOUT_MS/1000}s.`)), SCENE_HOST_START_TIMEOUT_MS);
      lines.on('line', line => {
        const parsed = parseHostAddress(line);
        if (!parsed) return;
        clearTimeout(timer);
        done(parsed);
      });
      lines.on('close', () => { clearTimeout(timer); fail(Error(`The host stopped before printing its address. ${hostErrors.trim()}`)); });
    });
    lines.on('line', () => undefined);
    say(`  panel at ${redactAddress(address.address)}`);
    panelOrigin = address.origin;

    if (options.headless) {
      // The same waits the manual drive used: the outer page's host bridge, then
      // the inspector iframe's own ready flag and canvas.
      // Playwright is a dev dependency, so the bundled host finds it only in a
      // clone that has run pnpm install.
      let chromium;
      try { ({ chromium } = pluginRequire('playwright')); }
      catch { throw Error('--headless needs Playwright: run pnpm install in this clone, or leave --headless off to draw the panel in your browser.'); }
      // Playwright installs its own SIGINT/SIGTERM/SIGHUP handlers that close
      // the browser and exit the process. That races this command's own
      // shutdown and wins, so Ctrl-C left the standalone host orphaned and
      // still holding the LAN port. Shutdown belongs to `stop` alone.
      const launched = await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
      browser = launched;
      const page = await launched.newPage({ viewport: { width: 1400, height: 900 } });
      await renderHeadlessPanel(page, address.address);
      say('  headless panel rendered');
    } else {
      // Leftover renderer tabs from a SIGKILL'd host still run Mol*. Sweep
      // those whose origin no longer answers, then open this run's tab.
      try { await sweepDeadRendererTabs({ liveOrigin: address.origin }); } catch { /* listing Chrome is best-effort */ }
      say((await openLocalInBrowser(address.address, process.platform, undefined, browserChoice.name)).message);
    }

    const control = await pollUntil(() => readControl(options.statePath).then(value => value, () => undefined),
      value => value != null, 'the host control file', { timeoutMs: 20_000, intervalMs: 500 }) as Control;

    // This deadline is a function of the structure, not a constant.
    //
    // A flat 120 s was written for 13,121 atom sites. The
    // microtubule `tip` stage (43,066 sites) exceeded it and the host exited
    // before the headset was ever asked to do anything; the same stage then
    // passed a full seven-step hardware drive on the next start. `--panel-timeout`
    // overrides it outright; otherwise the size scales it, and 120 s stays the floor.
    const panelTimeoutMs = options.panelTimeoutMs ?? panelWaitMs(options.atomSites, PANEL_SAVE_WAIT);
    say(`Waiting for the panel to render and save · ${options.panelTimeoutMs === undefined
      ? describePanelWait(options.atomSites, PANEL_SAVE_WAIT) : `${Math.round(panelTimeoutMs / 1_000)}s (--panel-timeout)`}`);
    // The host is still loading Mol* and the coordinates here, so a read can
    // fail transiently. Only the deadline ends this wait.
    const saved = await pollUntil(() => readState(control).catch(() => undefined), isDesktopReady, 'the panel to save a scene',
      { timeoutMs: panelTimeoutMs, progress: (waited, limit) => say(`  still loading · ${waited}s of ${limit}s`) }) as InspectionState;
    say('  scene saved');
    say(`  ${launcherVoiceGuidance(options.pushToTalk)}`);

    say('Opening private Wi-Fi sharing');
    const shareRequest = {
      ...binding(saved), connection: 'lan', launch: 'none',
      ...(options.lanHost ? { lanHost: options.lanHost } : {}),
      ...(options.lanPort !== 8443 ? { lanPort: options.lanPort } : {}),
    };
    // open_companion answers sharePending instead of outliving an MCP tool
    // deadline; the same request picks up the same unfinished share.
    let opened = await agentCall(control, 'open_companion', shareRequest);
    for (let tries = 0; opened.structuredContent?.sharePending && tries < 12; tries += 1) {
      say('  still starting the share');
      opened = await agentCall(control, 'open_companion', shareRequest);
    }
    const companion: Companion = opened.structuredContent?.companion ?? {};
    if (bundled) {
      const socketPath=process.env[SCENE_SOCKET_ENV]||defaultSocket;
      stopRelay = await startSceneSocketRelay(sceneServicePath(), socketPath);
      say(`  scene relay · ${socketPath}`);
    }
    say(formatWearerBlock(companion, new Date(), options.remember));
    // A headless run renders for a test, so it leaves this Mac's clipboard alone.
    if (options.visionPro && !options.headless) say(await visionProHandoff(companion));
    // Web Launch first: it needs no cable and no developer mode, so it is the
    // route that works on an untouched headset.
    let webRecovery: ReturnType<typeof recoverableWebLaunch> | undefined;
    if (options.webLaunch !== 'off') {
      // A status read here is an optimisation, not a requirement: it only
      // decides whether the code is worth putting in the link.
      let remembered = 0;
      try {
        // Read state again rather than reusing the pre-companion binding: an
        // epoch this run has already moved past would only fail the status.
        const current = await readState(control);
        const status = await agentCall(control, 'manage_companion', { serverEpoch: current.serverEpoch, sourceToken: current.sourceToken, action: 'status' });
        remembered = rememberedDeviceCount(status.structuredContent);
      } catch { /* fall back to the coded link, which pairs an unknown headset too */ }
      // Older hosts have no failure-report channel, so keep their first launch coded.
      const mode = preferredWebLaunch(options.webLaunch, options.webLaunchPinned, companion.launchId ? remembered : 0);
      try {
        const link = webLaunchLink(companion.url ?? '', mode === 'code' ? companion.pairingCode : undefined, companion.launchId);
        say(formatWebLaunch(link, mode === 'code'));
        say(mode === 'no-code'
          ? `  variant · no-code · this Mac remembers ${remembered} headset${remembered === 1 ? '' : 's'}, so the pairing code stays on this network`
          : '  variant · code · the link carries this run’s one-time pairing code to Meta');
        // The headless run is a test, not a person at a screen; opening a
        // browser there would put a Meta page in front of nobody.
        if (!options.headless) {
          let initial = true;
          webRecovery = recoverableWebLaunch({ companion, mode,
            send: async next => {
              const attempt = await attemptWebLaunch({ link: next, opener: 'open', browser: browserChoice.name });
              if (!attempt.opened) {
                say(attempt.reason === 'attempted'
                  ? 'Launch attempted for Meta Web Launch; open the link below yourself if no browser appears.'
                  : `Could not open Meta Web Launch on this Mac${attempt.reason === 'failed' ? ` (${attempt.detail})` : ''}; open the link below yourself.`);
                say(next);
                return false;
              }
              if (initial) say(`Browser started for Meta Web Launch on the Mac. ${WEB_LAUNCH_STEPS}`);
              initial = false;
              return true;
            },
            freshCode: async launchId => {
              const current = await readState(control);
              const result = await agentCall(control, 'manage_companion', { serverEpoch: current.serverEpoch,
                sourceToken: current.sourceToken, action: 'recover-pairing', launchId });
              return result.structuredContent?.pairingCode;
            },
            recovered: () => say('This headset needs pairing; sent a fresh code in a new notification. Tap it again to remember this headset.'),
          });
          await webRecovery.start();
        }
      } catch (error) { say(`  ${(error as Error).message}`); }
    }
    if (options.openOnQuest !== 'off') {
      // A missing adb or headset is a hint, never a failure: the address is
      // already printed and the wearer can open it themselves.
      try {
        const target = companion.url ?? '';
        const withCode = options.openOnQuest === 'code' && companion.pairingCode ? `${target}#pair=${companion.pairingCode}` : target;
        say((await openOnQuest({ url: withCode })).message);
      } catch (error) { say(`  ${(error as Error).message}`); }
    }

    // A tour starts because somebody asked for one, never because
    // a headset appeared. `--tour` names one outright and `--play-tour` asks
    // for the lesson's own; a plain lesson run leaves the wearer in the scene
    // and waits to be spoken to. See `QuestOptions.playTour`.
    const wantedTour = tourToStartOnPairing(options, saved.tours);
    const lessonTour = options.lessonPath && !options.tourId ? selectLessonTour(saved.tours) : undefined;
    if (options.lessonPath && options.playTour && !wantedTour) say('  note: no lesson tour appeared in this session; check the lesson JSON.');
    if (wantedTour) say(`  ${wantedTour} starts in the headset as soon as it pairs. Only one panel runs a tour at a time.`);
    else if (lessonTour) say(`  no tour plays by itself. Say "play the tour" in the headset, or restart with --play-tour.`);
    say('Ctrl-C stops sharing and closes the session.');

    let known = new Set<string>();
    let started = false;
    for (;;) {
      await realSleep(3_000);
      if (stopping) return;
      let status, current: InspectionState;
      try {
        // manage_companion takes only sessionId, serverEpoch and sourceToken.
        // The revision pair belongs to the mutating calls, not to this one.
        current = await readState(control);
        status = await agentCall(control, 'manage_companion', { serverEpoch: current.serverEpoch, sourceToken: current.sourceToken, action: 'status' });
      } catch { continue; }
      if (shareEnded(status.structuredContent)) {
        await stop(0, 'Private Wi-Fi sharing has closed or expired. Closing this launcher and its renderer.');
        return;
      }
      try { await webRecovery?.observe(status.structuredContent?.lan); }
      catch { say('Could not recover headset pairing from the Mac; restart this launch to try again.'); }
      const clients = pairedClientIds(status.structuredContent);
      const fresh = clients.filter(id => !known.has(id));
      known = new Set(clients);
      if (fresh.length > 0) say(`A headset paired at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. ${clients.length} client${clients.length === 1 ? '' : 's'} connected.`);
      if (!wantedTour || started || clients.length === 0) continue;
      const panel = selectPanel(current.panels, 'companion');
      if (!panel) continue;
      started = true;
      const commandId = `quest-share-tour-${Date.now()}`;
      await agentCall(control, 'control_tour', { ...binding(current), panelId: panel.panelId, commandId, action: 'start', tourId: wantedTour });
      try {
        await pollUntil(() => readState(control, { commandId }), state => state.command?.status === 'rendered', `the ${wantedTour} tour to render`, { timeoutMs: 45_000 });
        say(`  ${wantedTour} is running in the headset.`);
      } catch (error) { say(`  ${wantedTour} was queued but not confirmed: ${(error as Error).message}`); }
    }
  } catch (error) { await stop(1, (error as Error).message); }
}

if (process.argv[1] && basename(process.argv[1]).startsWith('quest-share')
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseQuestArgs(process.argv.slice(2));
    if (options.help) say(usage);
    else await main(options);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}

export async function runBundledHeadsetHost(args: string[]): Promise<void> {
  const options = parseQuestArgs(args);
  if (options.help) say(usage.replace('pnpm --dir plugin run quest', `${process.execPath} ${resolve(pluginRoot, 'dist/headset-host.mjs')}`));
  else await main(options, true);
}
