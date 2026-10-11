/**
 * headset-drive.ts -- run the whole headset experience with nobody wearing the
 * headset, photograph every step, and say pass or fail.
 *
 * On a real Quest 2 an agent can enter immersive-ar, walk a lesson, spin and
 * stop the structure, drive the in-VR menu and leave, without a controller and
 * without a human. This script is that sequence plus the checks, so a full run
 * is one command.
 *
 *   pnpm exec tsx scripts/headset-drive.ts ~/.stereofold/quest-share.json \
 *     --out /tmp/drive
 *   # Press live spatial-menu rows by their ids (these are optional steps):
 *   # --steps open,enter,menu:menu,menu:move,exit
 *
 * Two things it will not do.
 *
 * It refuses when the proximity sensor says the headset is on someone's face.
 * That check is not negotiable and has no flag, because every input this script
 * sends lands in a wearer's eyes.
 *
 * It also refuses when an immersive session is already presenting, because the
 * usual reason for one is that a person is in it. `--resume-session` says the
 * operator has checked and the session is abandoned -- a headset set down
 * without exiting leaves its session rendering to an empty room.
 *
 * The presenting signal comes from `get_inspection_state`, never from the
 * page's diagnostics ring. The ring holds 200 entries and an immersive session
 * fills it with frame-cost records in about three minutes, which pushes
 * `session-start` out and makes every diagnostics-derived reader report "not
 * presenting" while the headset is presenting. That false negative is in the
 * unsafe direction, so this script does not consult that source at all.
 *
 * Three input routes, each used for what only it can do:
 *
 * - The agent CLI's tools (`control_tour`, `update_inspection`,
 *   `open_companion`, `read_headset_log`, `capture_headset_view`) for anything
 *   the protocol already exposes.
 * - The Chrome DevTools bridge for page gestures the protocol has no tool for.
 *   `Input.dispatchMouseEvent` on the Enter VR button is a trusted gesture in
 *   Quest Browser 150, which is the only reason unattended entry works at all.
 * - `__stereofoldVoice.say(...)` and `__stereofoldMenu.press(...)` over that
 *   same bridge for in-VR actions whose runners are closure-scoped. `say` is
 *   not awaited, and `press` returns as soon as it queues the toolbar action;
 *   the work settles after the CDP call. `menu:<id>` names a current row
 *   (`menu:menu`, `menu:move`).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SHARE_ENDED_STARTUP_FAILURE } from '../src/companion-startup.js';
import { isPageRoute } from '../src/inspection-page-route.js';
import { classifyPanelAvailability } from '../src/inspection-contract.js';
// @ts-ignore Shared page parser; invalid recognized knobs are silently dropped.
import { parseRenderBudgetOverrides } from '../../lab/browser-roundtrip/xr-render-budget.mjs';

import { ffmpegBinCandidates, PTT_MAX_CHUNKS, PTT_MAX_CHUNK_BASE64 } from '../src/push-to-talk-transcribe.js';

import {
  CdpSession, devtoolsPort, evaluateParameters, formatConsoleEvent, formatTarget,
  isStereofoldTarget, nodeDevtoolsTransport, pageTargets, parseTargets, pickStereofoldTarget, readEvaluateResult, redactUrl, targetOrigin,
  type CdpEvent, type ConsoleLine, type DevtoolsTarget, type DevtoolsTransport,
} from '../src/headset-devtools.js';
// Which of the open Quest Browser tabs is the live viewer.
import { chooseLiveTab, describeTab, probeTabs, type TabReading } from '../src/headset-tabs.js';
import { detectGuardianDialog, GUARDIAN_DIALOG_ACTIVITY } from '../src/quest-device-state.js';
import { findAdb, pickAdbSerial } from '../src/headset-view-device.js';
import { formatReadiness, readinessBlockingSentences, type Readiness } from '../src/inspection-contract.js';
// The headset's own phase records are what a grow is waited on.
import { describeSwapTimeline, SWAP_TRACE_KIND, type SwapPhaseRecord } from '../src/source-swap-trace.js';
import { fillAgentArguments, isReceiptPending, needsInspectionState, shouldWaitOutBlur, PANEL_BLUR_POLL_MS } from './agent-arguments.js';
import { agentText, callLocalAgent, readControlState, waitForHostRequested, type AgentResult, type ControlState } from './local-agent.js';
import { describePanelWait, panelWaitMs, PANEL_READY_WAIT, type PanelLoad } from './panel-wait.js';
// A ring entry printed in a failure is printed without its tokens.
import { redactTokens } from './report-redaction.js';
import {
  COMMAND_IN_FLIGHT, PANEL_BETWEEN_BEATS, CHANGE_STILL_RENDERING, isCommandInFlight,
  IN_FLIGHT_ATTEMPTS, inFlightAttempts,
} from '../src/command-in-flight.js';

export {
  COMMAND_IN_FLIGHT, PANEL_BETWEEN_BEATS, CHANGE_STILL_RENDERING, isCommandInFlight,
  IN_FLIGHT_ATTEMPTS, inFlightAttempts,
};

// --------------------------------------------------------------- the plan

/** Every step this script knows how to drive, in the order a full pass runs them. */
export const DRIVE_STEPS = ['open', 'enter', 'return', 'tour', 'grow', 'spin', 'stop', 'quality', 'voice', 'ask', 'molstar', 'exit'] as const;
export type DriveStep = (typeof DRIVE_STEPS)[number] | `menu:${string}` | `aim:${string}`;

/**
 * What a bare run drives.
 *
 * `grow` is the one step that does not apply to every session: it steps a
 * staged demo one tier at a time, and a session playing an ordinary lesson has
 * no tier to grow from. Leaving it out of the default keeps a pass against
 * CRISPR from failing on a step that was never about it; `--steps
 * open,enter,tour,grow` is how a microtubule pass asks for it.
 */
/**
 * `grow` is opt-in because it is the heavy one. `return` is opt-in because the
 * default run reaches Mol* through `molstar`, which already comes home; a run
 * that needs only the way back asks for it by name, which is the case the
 * operator hits when a previous run left the headset on `/detailed`.
 */
export const DEFAULT_DRIVE_STEPS: readonly DriveStep[] = DRIVE_STEPS.filter(step => step !== 'grow' && step !== 'return');

/** The headset classes `grow_structure` knows, which is what decides the tier ceiling. */
export const DEVICE_CLASSES = ['quest2', 'quest3', 'quest-pro', 'vision-pro', 'hand-only', 'unknown'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export interface DriveOptions {
  sharePath: string;
  steps: DriveStep[];
  outDir: string;
  resumeSession: boolean;
  /** Open-step URL replacement, followed by the optional query. */
  url?: string;
  query?: string;
  settleSeconds: number;
  /**
   * How many atom sites the running stage has, when the caller
   * knows. `plugin/demos/index.json` carries the counts; nothing the host
   * reports does. It scales the wait after `enter` for the headset panel to
   * come back, and it is optional: without it that wait is its base.
   */
  atomSites?: number;
  /** The paired headset's class, or undefined to let the host assume the smallest budget. */
  device?: DeviceClass;
  /** Wait a bounded time for a host that is still writing its control file. */
  waitForHost?: boolean;
}

export class DriveUsageError extends Error {}

const DEFAULT_SETTLE_SECONDS = 4;

/**
 * Parse argv. The share path is positional because it is the one argument that
 * is always required and never has a sensible default: it names the live
 * session, and pointing a driver at the wrong session is worse than not running.
 */
export function parseDriveArguments(argv: readonly string[]): DriveOptions {
  const rest = [...argv];
  let sharePath: string | undefined;
  let steps: DriveStep[] = [...DEFAULT_DRIVE_STEPS];
  let outDir: string | undefined;
  let resumeSession = false;
  let settleSeconds = DEFAULT_SETTLE_SECONDS;
  let atomSites: number | undefined;
  let device: DeviceClass | undefined;
  let waitForHost = waitForHostRequested([], process.env);
  let url: string | undefined;
  let query: string | undefined;

  while (rest.length) {
    const argument = rest.shift() as string;
    if (argument === '--resume-session') { resumeSession = true; continue; }
    if (argument === '--wait-for-host') { waitForHost = true; continue; }
    if (argument === '--url') { url = requireValue('--url', rest.shift()); validateDriveUrl(url); continue; }
    if (argument === '--query') { query = requireValue('--query', rest.shift()); validateDriveQuery(query); continue; }
    if (argument === '--steps') { steps = parseSteps(requireValue('--steps', rest.shift())); continue; }
    if (argument === '--out') { outDir = requireValue('--out', rest.shift()); continue; }
    if (argument === '--settle') { settleSeconds = parseSettle(requireValue('--settle', rest.shift())); continue; }
    if (argument === '--atom-sites') { atomSites = parseAtomSites(requireValue('--atom-sites', rest.shift())); continue; }
    if (argument === '--device') { device = parseDevice(requireValue('--device', rest.shift())); continue; }
    if (argument.startsWith('--')) throw new DriveUsageError(`Unknown option ${argument}.`);
    if (sharePath) throw new DriveUsageError('Pass one share path, not two.');
    sharePath = argument;
  }

  if (!sharePath) throw new DriveUsageError('Pass the share state path, for example ~/.stereofold/quest-share.json.');
  if (!outDir) throw new DriveUsageError('Pass --out <directory> for the captures and report.json.');
  return { sharePath, steps, outDir, resumeSession, settleSeconds, ...(url === undefined ? {} : { url }), ...(query === undefined ? {} : { query }), ...(atomSites === undefined ? {} : { atomSites }), ...(device ? { device } : {}), ...(waitForHost ? { waitForHost } : {}) };
}

function validateDriveUrl(value: string): void {
  try {
    const parsed = new URL(value);
    if (!/^https?:\/\//i.test(value) || /[\s\\]/u.test(value)
      || !parsed.hostname || parsed.username || parsed.password || /%(?![a-f0-9]{2})/iu.test(value)) throw new Error();
  } catch { throw new DriveUsageError('--url needs an absolute HTTP(S) URL without credentials.'); }
}

function validateDriveQuery(value: string): void {
  const message = '--query accepts only a single xrRenderBudget=<value> with page-parser-accepted knobs; use --url for other URL or query forms.';
  if (!isPageRoute(`/viewer?${value}`, '/viewer')) throw new DriveUsageError(message);
  const raw = decodeURIComponent(value.slice(value.indexOf('=') + 1));
  if (parseRenderBudgetOverrides(raw).enabled === false) return;
  for (const pair of raw.split(/[,;]/u)) {
    const parsed = parseRenderBudgetOverrides(pair);
    // Unknown keys and known keys with rejected values must both fail. Check
    // each pair independently so a valid knob cannot hide an ignored one.
    if (parsed.unknown.length || Object.keys(parsed).length <= 2) throw new DriveUsageError(message);
  }
}

/** Compose without touching the browser; retain pairing fragments and default spelling. */
export function composeDriveUrl(derivedUrl: string, options: Pick<DriveOptions, 'url' | 'query'> = {}): string {
  const base = options.url ?? derivedUrl;
  if (options.url !== undefined) validateDriveUrl(base);
  if (options.query === undefined) return base;
  validateDriveQuery(options.query);
  const marker = base.indexOf('#');
  const address = marker < 0 ? base : base.slice(0, marker);
  const fragment = marker < 0 ? '' : base.slice(marker);
  // URLSearchParams.get reads the first duplicate. Refuse ambiguous A/B identities.
  const existing = new URL(base).searchParams;
  const added = new URLSearchParams(options.query);
  const keys = [...added.keys()];
  if (keys.some(key => existing.has(key)) || new Set(keys).size !== keys.length) {
    throw new DriveUsageError('--query repeats a key; accepted form is a single xrRenderBudget=<value>; use --url to replace existing values.');
  }
  const separator = /[?&]$/u.test(address) ? '' : address.includes('?') ? '&' : '?';
  const effectiveUrl = `${address}${separator}${options.query}${fragment}`;
  validateDriveQuery(new URL(effectiveUrl).search.slice(1));
  return effectiveUrl;
}

export const DRIVE_USAGE = `Usage: headset-drive.ts <share-state> --out <directory> [options]
  --steps <steps>       Comma-separated steps; default: ${DEFAULT_DRIVE_STEPS.join(',')}
                       Also accepts grow, return, menu:<id>, aim:<id> and aim:miss.
                       return brings a headset left on /detailed back to the
                       viewer through the page's own Back control, then enters VR.
                       menu:<id> presses a row through the page hook; aim:<id>
                       aims a SIMULATED CONTROLLER POSE at the drawn row and
                       lets the toolbar's own hit test decide. Neither is a
                       wearer. Both fail unless the row's outcome is verified.
  --out <directory>     Captures and report.json destination.
  --resume-session     Resume an abandoned immersive session.
                       Not needed for --steps exit on its own.
  --wait-for-host       Wait up to 20s for a host that is still starting
                       (same as STEREOFOLD_WAIT_FOR_HOST=1).
  --settle <seconds>    Settle delay, 0–60; default: 4.
  --atom-sites <count>  Atom sites, 1–5000000, for size-aware waits.
  --device <class>      ${DEVICE_CLASSES.join(', ')}
                       A headset serial belongs in STEREOFOLD_ADB_SERIAL, not here.
  --url <absolute-url>  Replace the open-step URL; HTTP(S) only.
                       Escape hatch for other URL or query forms.
  --query "xrRenderBudget=<value>"
                       Append one page-parser-accepted budget before the fragment.
                       Applied after --url; no other query keys or duplicates.
  --help               Print this help without contacting the headset.

Overrides navigate the paired tab, including an already-open tab.
Other steps ignore URL flags. Default open performs no extra navigation.
Logs and report.json evidenceIdentity.effectiveUrl record the effective URL.
Pairing fragments and credential query values are redacted in evidence.

xrRenderBudget accepts off, or comma/semicolon-separated key:value pairs:
  scale: (0,2]; pick: (0,1]; foveation, rough: [0,1]; fps: positive or off.
  quality, surface: auto, highest, higher, high, medium, low, lower,
                    lowest, custom; surface also accepts off.
  gloss, palette, light, marking, postfx, cost, molstarPanel, msaa: on/off.
  hover: on/off or 0–60 frames per second.
  governor: on/off/observe; governorFloor: (0,1].
  on aliases: 1,true,yes,enabled; off aliases: 0,false,no,disabled.
  Key aliases (canonical=aliases):
    scale=framebufferscale; fps=framerate,targetframerate;
    quality=representationquality; surface=surfacequality;
    gloss=surfacematerial; rough=roughness; palette=surfacepalette;
    light=lighting; pick=pickscale; hover=interaction;
    postfx=postprocessing; cost=framecost; molstarPanel=molstar.
  Example: --steps open,enter,exit --query "xrRenderBudget=scale:0.5"
  Scale is applied when entering a new immersive session.
`;

function requireValue(flag: string, value: string | undefined): string {
  // An option that swallows the next flag as its value fails far from here, so
  // a missing value is caught at the flag rather than at the step that uses it.
  if (value === undefined || value.startsWith('--')) throw new DriveUsageError(`${flag} needs a value.`);
  return value;
}

function parseSteps(value: string): DriveStep[] {
  const names = value.split(',').map(name => name.trim()).filter(Boolean);
  if (!names.length) throw new DriveUsageError('--steps needs at least one step.');
  const unknown = names.filter(name => !(DRIVE_STEPS as readonly string[]).includes(name)
    && !/^menu:[a-z][a-z0-9-]*$/u.test(name) && !/^aim:[a-z][a-z0-9-]*$/u.test(name));
  if (unknown.length) throw new DriveUsageError(`Unknown step ${unknown[0]}. Known steps: ${DRIVE_STEPS.join(', ')}, menu:<id>, aim:<id>, aim:miss.`);
  return names as DriveStep[];
}

/**
 * What a Quest serial looks like: a long run of upper-case letters and digits
 * carrying at least one of each, which is the shape adb prints and nothing in
 * `DEVICE_CLASSES` resembles. Used only to pick a better sentence, never to
 * accept the value.
 */
export function looksLikeAdbSerial(value: string): boolean {
  return /^[A-Z0-9]{8,32}$/u.test(value) && /[A-Z]/u.test(value) && /[0-9]/u.test(value);
}

/**
 * `--device` names a headset class, not a headset.
 *
 * The class is what `grow_structure` reads to decide the tier ceiling, so it
 * is a property of the model rather than of the unit, and passing the serial
 * adb prints — the obvious thing to reach for when two Quests are on the
 * bench — bought a list of six class names and no hint of where the serial was
 * supposed to go. It goes in `STEREOFOLD_ADB_SERIAL`, which is where every
 * other command on this machine reads it from, so the refusal says that
 * instead of leaving the operator to find it.
 *
 * The value is still refused either way. Mapping a serial to a class over adb
 * was the alternative and it is worse: it makes argument parsing spawn a
 * process, fail differently when the cable is out, and answer differently on
 * two machines for the same command line.
 */
function parseDevice(value: string): DeviceClass {
  if (!(DEVICE_CLASSES as readonly string[]).includes(value)) {
    throw new DriveUsageError(looksLikeAdbSerial(value)
      ? `${value} looks like a headset serial. --device takes a class: use --device quest2, `
        + `and put the serial in STEREOFOLD_ADB_SERIAL. Known classes: ${DEVICE_CLASSES.join(', ')}.`
      : `Unknown device class ${value}. Known classes: ${DEVICE_CLASSES.join(', ')}.`);
  }
  return value as DeviceClass;
}

function parseSettle(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new DriveUsageError('--settle takes 0 to 60 seconds.');
  return seconds;
}

function parseAtomSites(value: string): number {
  const sites = Number(value);
  if (!Number.isInteger(sites) || sites < 1 || sites > 5_000_000) throw new DriveUsageError('--atom-sites takes a whole number from 1 to 5000000.');
  return sites;
}

// --------------------------------------------------------------- the gate

/** What the device and the live session look like just before the first input. */
export interface DriveGate {
  /** dumpsys power's mProximityPositive: true means something is against the sensor. */
  proximityPositive: boolean | null;
  /** get_inspection_state -> panels[].xrStartup.presenting. */
  presenting: boolean | null;
  /** When this gate reading was taken, for a step report and postmortem. */
  readAt: string;
}

export type DriveRefusal = { run: false; reason: string } | { run: true; reason?: undefined; note?: string };

/**
 * Whether this run is nothing but the way out.
 *
 * The presenting-session refusal exists because a session that is up usually
 * has a person in it, and a driver that walks a tour through somebody's face
 * is the failure it prevents. A run whose only step is `exit` cannot do that:
 * it ends the session, which is the one thing that is safe to do to a session
 * somebody else started, and is what the operator reaches for precisely when
 * they did not start it from here. Asking them to pass `--resume-session`
 * before they are allowed to close something taught them to keep the flag on
 * their command line, where it would also waive the refusal for a real tour.
 *
 * Proximity is untouched. A headset on a face is not exited either.
 */
export function isExitOnlyRun(steps: readonly DriveStep[] | undefined): boolean {
  return Array.isArray(steps) && steps.length === 1 && steps[0] === 'exit';
}

/**
 * The whole safety decision, as a pure function, so the refusal is tested
 * rather than trusted. Proximity always wins: a worn headset is never driven,
 * flag or no flag.
 */
export function decideDriveRefusal(gate: DriveGate, options: Pick<DriveOptions, 'resumeSession'> & { steps?: readonly DriveStep[] }): DriveRefusal {
  if (gate.proximityPositive) {
    return { run: false, reason: 'The proximity sensor reads positive, so the headset is on a face. Refusing to send input.' };
  }
  if (gate.proximityPositive !== false) {
    return { run: false, reason: 'The proximity sensor could not be read, so refusing to send input.' };
  }
  if (gate.presenting === null) {
    return { run: false, reason: 'The session state could not be read, so refusing to send input.' };
  }
  if (gate.presenting && !options.resumeSession) {
    if (!isExitOnlyRun(options.steps)) {
      return { run: false, reason: 'An immersive session is already presenting. Confirm nobody is wearing the headset, then pass --resume-session.' };
    }
    return { run: true, note: 'A session is presenting and this run is only exit, so it is resumed without --resume-session.' };
  }
  return { run: true };
}

// ------------------------------------------------------------ tracking loss

/**
 * What a Quest that has lost 6DoF looks like from this Mac.
 *
 * A headset face down on a desk in a dark room loses 6DoF. The Quest raises its
 * own "Finding position in room" modal, which sits outside the browser, and
 * `requestSession` cannot succeed through it. The agent side sees only
 * `errorName: "Error"` with `reloadRequired: true`; the cause is legible only
 * in a wearer-view capture.
 * The other shape is a session that is nominally presenting while the page's
 * own frame-rate estimate has fallen to zero, which is the compositor holding
 * frames the headset will not draw.
 *
 * Neither is a page bug and neither is fixable from here, so the driver says so
 * in one line and stops rather than blind-tapping a system dialog on an
 * unattended headset.
 */
export const TRACKING_LOSS_ADVICE =
  'The Quest has lost positional tracking and is showing its own "Finding position in room" dialog, '
  + 'which sits outside the browser: no page click and no reload can dismiss it. '
  + 'Stand the headset upright facing a lit, textured wall, or pick it up once, then run again.';

/**
 * A presenting session whose visibility is `hidden` is behind a Quest system
 * dialog. Measured: after the headset is moved to another room, entering
 * immersive-ar raises "Confirm boundary" (GuardianDialogActivity); the page
 * keeps presenting with sessionVisibility hidden and focus false, every tour
 * command is parked, and the tour step waits its full minute.
 * `adb shell input keyevent` does not reach that dialog; a person does.
 */
export const HIDDEN_SESSION_ADVICE =
  'The session is presenting but hidden behind a Quest system dialog (usually "Confirm boundary" after the '
  + 'headset was moved), which sits outside the browser and takes a controller press. '
  + 'Put the headset on, press Confirm, set it back down, then run again with --resume-session.';

export function detectHiddenSession(startup: { presenting?: boolean; sessionVisibility?: string | null } | null | undefined): boolean {
  return classifyPanelAvailability(startup) === 'hidden-session';
}

// Without the dialog check `open` could only spend its whole 90 s behind that
// screen and then report that no page had appeared. The shipped launch reads
// the same screen, so both share one definition.
export { GUARDIAN_DIALOG_ACTIVITY, detectGuardianDialog };

/** What a person has to do, since nothing on this side can dismiss it. */
export const GUARDIAN_DIALOG_ADVICE =
  'Quest shows Meta\'s "Finding position in room" dialog, which sits outside the browser: '
  + 'wear the headset, press "Continue without tracking", or light the room, then run again.';

/** What the activity dump said about the dialog, kept for `report.json`. */
export interface GuardianDialogState {
  /** `null` where the dump could not be read: unreadable is never proof of a clear headset. */
  showing: boolean | null;
  /** Set only when the dialog is up, so the report names what was matched. */
  activity?: string;
  readAt: string;
  reason?: string;
}

type AdbShellArguments = string[] | [...string[], { signal: AbortSignal }];

type ActivityDumpHost = {
  adbShell(...args: AdbShellArguments): Promise<{ code: number; stdout: Buffer; stderr: string }>;
};

/**
 * Ask the headset whether the dialog is up. Read-only: one dump, no input.
 *
 * A dump that cannot be read, or that carries no `topResumedActivity=` line to
 * read, answers `null` rather than `false`. This gates a fast failure, so the
 * only answer allowed to shorten a wait is one that actually saw the dialog.
 */
export async function readGuardianDialog(host: ActivityDumpHost, timeoutMs = 3_000): Promise<GuardianDialogState> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dump: { code: number; stdout: Buffer; stderr: string };
  try {
    // Abort kills the adb child; the race also bounds a runner that never settles.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('adb timed out'));
        controller.abort();
      }, timeoutMs);
    });
    dump = await Promise.race([
      host.adbShell('dumpsys', 'activity', 'activities', { signal: controller.signal }),
      timeout,
    ]);
  } catch {
    return { showing: null, readAt: nowIso(), ...(controller.signal.aborted ? { reason: 'adb timed out' } : {}) };
  } finally {
    clearTimeout(timer);
  }
  const text = dump.stdout.toString('utf8');
  if (dump.code !== 0 || !text.includes('topResumedActivity=')) return { showing: null, readAt: nowIso() };
  if (!detectGuardianDialog(text)) return { showing: false, readAt: nowIso() };
  return { showing: true, activity: GUARDIAN_DIALOG_ACTIVITY, readAt: nowIso() };
}

export interface TrackingSignals {
  xrStartup?: { errorName?: string | null; reloadRequired?: boolean; presenting?: boolean; phase?: string } | null;
  /** The page's own rolling estimate, from the `frame-rate` diagnostic. */
  framesPerSecond?: number | null;
}

export function detectTrackingLoss(signals: TrackingSignals): { lost: boolean; reason?: string } {
  const startup = signals.xrStartup;
  if (startup?.reloadRequired === true && startup.errorName === 'Error') {
    return { lost: true, reason: `Entry failed with a bare Error and the page asked for a reload (phase ${startup.phase ?? 'unknown'}).` };
  }
  if (startup?.presenting === true && signals.framesPerSecond === 0) {
    return { lost: true, reason: 'The session reports presenting while the page measured 0 frames per second.' };
  }
  return { lost: false };
}

// ---------------------------------------------------------- step contents

/** The agent commands a step sends, in order. Empty where the step is a page gesture. */
export function stepCommands(step: DriveStep): Array<{ tool: string; arguments: Record<string, unknown> }> {
  switch (step) {
    // The tour's chapter count is read live rather than assumed; `tourPlan`
    // turns it into the rest of the actions.
    case 'tour': return [{ tool: 'control_tour', arguments: { action: 'start' } }]; // tourId is read live from the panel
    case 'spin': return [{ tool: 'update_inspection', arguments: { change: { kind: 'motion', patch: { state: 'spin' } } } }];
    case 'stop': return [{ tool: 'update_inspection', arguments: { change: { kind: 'motion', patch: { state: 'stop' } } } }];
    // Best first, then back to balanced, so the run leaves the wearer's render
    // budget where it found it. `best` inside a running session raises detail
    // now and framebuffer scale only on the next entry, which the receipt says.
    case 'quality': return [
      { tool: 'update_inspection', arguments: { change: { kind: 'render-quality', patch: { level: 'best' } } } },
      { tool: 'update_inspection', arguments: { change: { kind: 'render-quality', patch: { level: 'balanced' } } } },
    ];
    // Entry, exit, the menu and the Mol* handoff are page gestures, not agent
    // tools: entry needs a real click for WebXR's user activation rule, the
    // exit button is only in the page, and the toolbar has no protocol hook.
    case 'open': case 'enter': case 'return': case 'exit': case 'voice': case 'molstar': return [];
    default: return [];
  }
}

/**
 * Walking a lesson is one play and then a next per remaining chapter.
 *
 * `play` is still first. `control_tour` `next` and `back` were silent no-ops on
 * an inactive tour: both answered `queued` and moved nothing, so pressing tour
 * appeared to do nothing at all. They now start the lesson instead, so a plan
 * that opened with `next` would work — but it would open the lesson with a
 * scene change rather than the announced start the wearer expects, so the plan
 * keeps saying what it means. A tour with no chapters plans nothing rather than
 * playing into an empty catalog.
 */
export function tourPlan(total: number): Array<'start' | 'next'> {
  if (!Number.isInteger(total) || total <= 0) return [];
  // `start` (with the lesson id) opens at scene 1; `play` resumes wherever the
  // lesson last stopped. Measured: with the lesson parked at scene 6, `play`
  // resumed it there and the driver waited a full minute for scene 1.
  return ['start', ...Array.from({ length: total - 1 }, () => 'next' as const)];
}

/**
 * The four phrases the voice step speaks, chosen to cover four different
 * subsystems: passthrough, the render budget, motion on, motion off. All four
 * are in the fixed grammar, so a miss is a regression rather than a typo.
 */
export const VOICE_PHRASES = Object.freeze(['show the room', 'better quality', 'spin it', 'stop']);
/** `voice` calls the page hook directly; it is not a microphone capture. */
export const INJECTED_TRANSCRIPT_ORIGIN = 'injected-transcript' as const;

/**
 * The row that opens the expanded grid, and the label it carries while the
 * menu is still collapsed.
 *
 * The same id serves both directions — `Menu` expands, `Close` collapses — so
 * the label is the only thing in the hook's public rows that says which state
 * the menu is in. That is why the label is matched and not just the id.
 */
export const MENU_EXPAND_ROW = 'menu';
const MENU_EXPAND_LABEL = 'Menu';

/**
 * Whether a missing row is one the expanded grid would have.
 *
 * Most of the toolbar is not on the compact panel. `Sequence`, the appearance
 * presets, the nudges and the scale rows all live behind `Menu`, so
 * `--steps menu:sequence` on a collapsed menu failed with "Unknown menu row
 * sequence" and a list of the five rows that happened to be showing — which
 * reads as "this build has no sequence row" rather than "press Menu first".
 * An operator who has to know the panel's collapse state before naming a row
 * is being asked to drive the menu rather than the session.
 *
 * So a row that is absent while the collapsed menu is showing is worth one
 * press of `Menu` and one more look. Two rules keep that from hiding anything:
 * `menu:menu` never expands on its own behalf, because that step IS the toggle
 * and an operator asking for it wants exactly one press; and a row still
 * absent after the grid is open fails, naming every row that is open, rather
 * than pressing anything else.
 */
export function menuExpansionPlan(wanted: string, rows: readonly { id: string; label: string; active: boolean }[]):
{ expand: boolean; reason: string } {
  if (rows.some(row => row.id === wanted)) return { expand: false, reason: 'the row is already showing' };
  if (wanted === MENU_EXPAND_ROW) return { expand: false, reason: 'menu:menu is the expand row itself' };
  const expander = rows.find(row => row.id === MENU_EXPAND_ROW);
  if (!expander) return { expand: false, reason: 'this menu has no Menu row to expand' };
  if (expander.label !== MENU_EXPAND_LABEL) return { expand: false, reason: 'the menu is already expanded' };
  if (!expander.active) return { expand: false, reason: 'the Menu row is not pressable right now' };
  return { expand: true, reason: `${wanted} is not on the collapsed menu, so Menu was pressed first` };
}

/** The CDP action and evidence names for one dynamic spatial-menu step. */
export function menuStepArguments(step: DriveStep): { id: string; captureName: string; expression: string } {
  const match = /^menu:([a-z][a-z0-9-]*)$/u.exec(step);
  if (!match) throw new DriveUsageError(`A menu step must be menu:<id>, not ${step}.`);
  const id = match[1]!;
  return {
    id,
    captureName: `menu-${id}`,
    // Deliberately no async function and no await. The toolbar action chain
    // settles on XR frames after this CDP call has returned.
    //
    // The row is looked for before it is pressed, so an absent one comes back
    // as an answer this script can act on. The hook throws on an unknown id,
    // and a thrown page exception carries no rows, which is what left the
    // driver unable to tell "no such row in this build" from "that row is
    // behind Menu".
    //
    // `before` is read in the same tick as the press, from the page, so the
    // reading the outcome is compared against cannot have drifted between a
    // separate CDP round trip and the press itself.
    expression: `(() => { const menu = globalThis.__stereofoldMenu;
      if (!menu || typeof menu.rows !== 'function' || typeof menu.press !== 'function') return { status: 'no-hook', rows: [] };
      const rows = menu.rows();
      const state = typeof menu.state === 'function' ? menu.state() : null;
      const before = { rows: rows, state: state };
      if (!rows.some(row => row && row.id === ${JSON.stringify(id)})) return { status: 'absent', rows, before };
      const pressed = menu.press(${JSON.stringify(id)});
      return { status: pressed === false ? 'inactive' : 'pressed', rows, before }; })()`,
  };
}

/** Read the rows and the drawn state without touching either. */
export const OBSERVE_MENU_EXPRESSION = `(() => { const menu = globalThis.__stereofoldMenu;
  if (!menu || typeof menu.rows !== 'function') return { status: 'no-hook', rows: [], state: null };
  return { status: 'ok', rows: menu.rows(), state: typeof menu.state === 'function' ? menu.state() : null }; })()`;

/**
 * The CDP action for one aimed step.
 *
 * `aim:<id>` does NOT call `press`. It hands the row id to `__stereofoldAim`,
 * which builds a target ray from a simulated controller pose and pushes it
 * through the toolbar's own hit test, hover ranking and select handlers. What
 * that adds over `menu:<id>` is targeting: whether a controller pointed at the
 * row would have reached it at all.
 *
 * `aim:miss` aims at a point on the same panel that the hit test must reject,
 * and fails if anything fires. A build whose row rectangles have drifted off
 * the plates passes every row aim and fails this one.
 *
 * It is a POSE. There is no hand, no tracking and no person, and the step log
 * and the report both say so.
 */
export function aimStepArguments(step: DriveStep): { id: string; captureName: string; expression: string } {
  const match = /^aim:([a-z][a-z0-9-]*)$/u.exec(step);
  if (!match) throw new DriveUsageError(`An aim step must be aim:<id> or aim:miss, not ${step}.`);
  const id = match[1]!;
  return {
    id,
    captureName: `aim-${id}`,
    expression: `(() => { const aim = globalThis.__stereofoldAim, menu = globalThis.__stereofoldMenu;
      if (!aim || typeof aim.at !== 'function' || typeof aim.miss !== 'function') return { status: 'no-hook', rows: [] };
      const rows = menu && typeof menu.rows === 'function' ? menu.rows() : [];
      const before = { rows: rows, state: menu && typeof menu.state === 'function' ? menu.state() : null };
      const result = ${JSON.stringify(id)} === 'miss' ? aim.miss() : aim.at(${JSON.stringify(id)});
      return { status: 'aimed', rows: rows, before: before, result: result }; })()`,
  };
}

// ------------------------------- what a pressed row has to change

/**
 * The gap this table closes.
 *
 * `menu:<id>` reported `pressed` the moment `__stereofoldMenu.press` returned.
 * That is the hook saying it handed the row's action to the toolbar chain, and
 * nothing more: an action that threw, an action the queue dropped, and an
 * action that rendered are all `pressed`. A row-by-row walkthrough was
 * built on that word, which is why a menu walk could pass while the wearer saw
 * nothing move.
 *
 * So every row now names the thing that must be different afterwards, in terms
 * the page can be asked for: the rows and labels the menu draws, the reduced
 * scene state behind `__stereofoldMenu.state()`, or a diagnostic the action
 * writes. A row whose reading does not change inside the bound FAILS, and the
 * step prints what was expected beside what the page reported.
 */
export type MenuRows = ReadonlyArray<{ id: string; label: string; active: boolean }>;

export interface MenuObservation {
  rows: MenuRows;
  /** The reduced drawn state, or null when the page exposes no reader. */
  state: Record<string, unknown> | null;
}

export interface RowExpectation {
  /** What must be true afterwards, in the language of what a wearer notices. */
  expected: string;
  /** The reading the expectation is about. Polled; `undefined` means unreadable. */
  read?: (observation: MenuObservation) => unknown;
  /** Default: the reading must differ from the one taken before the press. */
  holds?: (before: unknown, after: unknown) => boolean;
  /**
   * For a row whose outcome leaves no trace in drawn state — a re-seat moves
   * the panel, it does not change it — the diagnostic the action writes.
   */
  diagnostic?: (entries: readonly DiagnosticRecord[]) => boolean;
  /**
   * Whether this row is allowed to take the page with it.
   *
   * The Mol* row ends the immersive session, so its own success looks exactly
   * like the page having gone away. Every other row's reading must come from a
   * page that answered: a dropped debugger connection would otherwise read as
   * "the state changed" for any expectation that only asks whether it did.
   */
  endsTheSession?: true;
}

const sameReading = (first: unknown, second: unknown) =>
  JSON.stringify(first ?? null) === JSON.stringify(second ?? null);

const field = (value: unknown, ...keys: readonly string[]): unknown => keys.reduce<unknown>(
  (current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);

const rowLabel = (observation: MenuObservation, id: string) =>
  observation.rows.find(row => row.id === id)?.label ?? null;
const rowIds = (observation: MenuObservation) => observation.rows.map(row => row.id).join(',');
const numeric = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const changes = (expected: string, read: (observation: MenuObservation) => unknown): RowExpectation =>
  ({ expected, read });
const becomes = (expected: string, read: (observation: MenuObservation) => unknown, want: unknown): RowExpectation =>
  ({ expected, read, holds: (_before, after) => sameReading(after, want) });
const moves = (expected: string, read: (observation: MenuObservation) => unknown, direction: 1 | -1): RowExpectation =>
  ({ expected, read, holds: (before, after) => {
    const first = numeric(before), second = numeric(after);
    return first !== undefined && second !== undefined && (direction > 0 ? second > first : second < first);
  } });

const placement = (observation: MenuObservation) =>
  [field(observation.state, 'placement', 'translation'), field(observation.state, 'placement', 'rotation')];
const tourPosition = (observation: MenuObservation) => [field(observation.state, 'tour', 'step'),
  field(observation.state, 'tour', 'active'), field(observation.state, 'tour', 'canBack'),
  field(observation.state, 'tour', 'canNext')];

/**
 * A diagnostic that the toolbar put the panel somewhere new.
 *
 * The layout record was the only proof this expectation had, and it
 * is written by `viewer.mjs` from `onMenuPlaced`, which does nothing at all
 * unless component name plates are wanted or already drawn. A plain scene has
 * none, so on the Quest 2 both `aim:move` and `menu:move`
 * re-seated the column and left nothing to read: each reported "the outcome
 * never arrived" after 12.4 s.
 * The expectation itself was wrong, not the row.
 *
 * The toolbar's own commit now writes a `seat-commit` receipt beside the panel
 * it drew, whether or not there are labels, and that is the first reading here.
 * The layout record stays as the second: a build that still writes only that
 * one is proof too, and the plate re-solve is what a labelled scene sees.
 */
export function menuWasReseated(entries: readonly DiagnosticRecord[]): boolean {
  return entries.some(entry => (entry.kind === 'toolbar'
      && entry.detail?.phase === 'seat-commit' && entry.detail?.reseated === true)
    || (entry.kind === 'component-label-layout'
      && ['seat', 'reseat'].includes(String(entry.detail?.menuReason ?? ''))));
}
/** A diagnostic that the structure was put back on its entry seat. */
export function structureWasReseated(entries: readonly DiagnosticRecord[]): boolean {
  return entries.some(entry => entry.kind === 'xr-button' && entry.detail?.action === 'recenter-structure');
}

const NUDGE_AXES = Object.freeze({ x: 'left and right', y: 'up and down', z: 'nearer and further' });

export const MENU_ROW_EXPECTATIONS: Readonly<Record<string, RowExpectation>> = Object.freeze({
  talk: changes('the Talk row reports a new microphone state',
    observation => [rowLabel(observation, 'talk'), field(observation.state, 'voice', 'state')]),
  tour: changes('the lesson starts, pauses or resumes',
    observation => [field(observation.state, 'tour', 'active'), field(observation.state, 'tour', 'autoplay'), rowLabel(observation, 'tour')]),
  tours: changes('the lesson chooser opens, or the chosen lesson changes',
    observation => [field(observation.state, 'tour', 'menuOpen'), field(observation.state, 'tour', 'selectedId'), rowIds(observation)]),
  next: changes('the lesson moves to another chapter', tourPosition),
  back: changes('the lesson moves to another chapter', tourPosition),
  done: changes('the lesson ends and its transport rows leave the menu',
    observation => [field(observation.state, 'tour', 'active'), field(observation.state, 'tour', 'selectedId'), rowIds(observation)]),
  page: changes('the caption turns to another page',
    observation => [field(observation.state, 'tour', 'bodyPageIndex'), rowLabel(observation, 'page')]),
  /**
   * The source description's own paging row, the one row an earlier run added
   * and this table had no entry for.
   *
   * On the Quest 2 six presses turned the page on the display —
   * `Pg 1/6` through `Pg 6/6` and back to `Pg 1/6`, each with a new line on
   * the plate — and every one reported "this script has no expectation for the
   * row description-page, so its outcome was not checked"
   * The shape is the lesson
   * `page` row above: the index the page publishes, joined with the label the
   * wearer reads. `readout.descriptionPageIndex` is the plate's own counter,
   * now carried out through the menu hook, and a build that publishes no
   * readout answers `undefined` on it and still holds on the label — which is
   * what the six presses moved — rather than passing unverified.
   */
  'description-page': changes('the source description turns to another page',
    observation => [field(observation.state, 'readout', 'descriptionPageIndex'),
      rowLabel(observation, 'description-page')]),
  menu: changes('the grid folds or unfolds',
    observation => [rowLabel(observation, 'menu'), observation.rows.length]),
  mode: changes('the nudge rows switch between moving and turning',
    observation => rowLabel(observation, 'mode')),
  move: { expected: 'the menu is re-seated in front of the wearer', diagnostic: menuWasReseated },
  reset: { expected: 'the structure is put back on its entry seat', diagnostic: structureWasReseated },
  fit: { expected: 'the structure is re-seated to fill the wearer’s view', diagnostic: structureWasReseated },
  room: changes('the wearer’s own room comes in or goes away',
    observation => [field(observation.state, 'passthrough'), rowLabel(observation, 'room')]),
  molstar: { expected: 'the immersive session hands off to the flat viewer, so no menu is drawn any more',
    read: observation => observation.rows.length, holds: (_before, after) => after === 0, endsTheSession: true },
  /**
   * The residue browser, which was the one row this
   * table had no entry for and so reported
   * "no expectation for the row sequence, so its outcome was not checked".
   *
   * Pressing it dispatches `{ kind: 'sequence', op: 'open' }`, and the page
   * already publishes the answer: `sequenceNavigation.snapshot()` rides on
   * `getSpatialState` and `menuHookState` keeps its `open` flag. Opening also
   * replaces the whole top-level row set with the browser's own rows
   * (`spatial-toolbar-content.mjs`, the `sequence?.open` early return), so both
   * halves are checked. A build whose page exposes no sequence reading answers
   * `undefined` here and the row FAILS rather than passing unverified, which is
   * the same rule every other row is held to.
   */
  sequence: { expected: 'the residue sequence browser opens and takes the menu over',
    read: observation => [field(observation.state, 'sequence', 'open'), rowIds(observation)],
    holds: (before, after) => Array.isArray(after) && after[0] === true && !sameReading(before, after) },
  above: changes('the structure moves overhead', observation => field(observation.state, 'placement', 'translation')),
  reach: changes('the structure moves within reach', observation => field(observation.state, 'placement', 'translation')),
  motion: changes('the spin starts or stops', observation => field(observation.state, 'motion', 'paused')),
  quality: changes('the render quality steps to the next level',
    observation => [field(observation.state, 'renderQuality'), rowLabel(observation, 'quality')]),
  'scale-up': moves('the structure gets bigger', observation => field(observation.state, 'placement', 'scale'), 1),
  'scale-down': moves('the structure gets smaller', observation => field(observation.state, 'placement', 'scale'), -1),
  ...Object.fromEntries(Object.entries(NUDGE_AXES).flatMap(([axis, words]) => [
    [`${axis}-up`, changes(`the structure moves or turns ${words}`, placement)],
    [`${axis}-down`, changes(`the structure moves or turns ${words}`, placement)],
  ])),
  ...Object.fromEntries((['cartoon', 'ball-and-stick', 'molecular-surface'] as const).map(preset => [
    `appearance-${preset}`,
    becomes(`the molecule is drawn as ${preset.replace(/-/gu, ' ')}`,
      observation => field(observation.state, 'appearance', 'representation'), preset),
  ])),
  ...Object.fromEntries((['chain-id', 'element-symbol'] as const).map(preset => [
    `appearance-${preset}`,
    becomes(`the molecule is coloured by ${preset.replace(/-/gu, ' ')}`,
      observation => field(observation.state, 'appearance', 'color'), preset),
  ])),
  'appearance-opacity-down': moves('the molecule becomes more see-through',
    observation => field(observation.state, 'appearance', 'opacity'), -1),
  'appearance-opacity-up': moves('the molecule becomes more solid',
    observation => field(observation.state, 'appearance', 'opacity'), 1),
});

/**
 * A row this build draws but this table has no expectation for.
 *
 * Refusing to verify is not the same as verifying nothing: the step says so in
 * its own log line and counts as unverified rather than silently passing, so a
 * row added later cannot slip back into "pressed means worked".
 */
/**
 * One rule for every row the sequence browser draws.
 *
 * `sequence` above covers the top-level row that OPENS the browser. Everything
 * inside it — `sequence-next`, `sequence-previous`, `sequence-detail-<key>`,
 * `sequence-chain-2`, `sequence-goto` — is generated per page, so it can never
 * be listed here, and until now a driver step naming one got "no expectation
 * for the row, so its outcome was not checked". The rows all share one prefix
 * and one proof: the browser's own reading has to move. `sequence.open`,
 * `sequence.index` and the row ids together cover a page turn, a chain tab, a
 * sub-page and the close, and a build whose page publishes no sequence reading
 * answers `undefined` and FAILS, which is the rule every other row is held to.
 *
 * added the two readings after
 * `index`. A `menu:sequence-find-up` press moves one digit of the Find pad and
 * nothing else: the pad stays on the same sub-page, the row ids are identical,
 * `open` is still true, and this expectation therefore called a press that
 * worked a press that changed nothing. `sequence.find` is the pad's own reading
 * and `sequence.page` is the page number the browser publishes — `index` is the
 * name the driver asked for and no build has ever published, so it is kept and
 * joined rather than swapped, and a page that publishes neither still answers
 * `undefined` on `open` and FAILS.
 *
 * D30's two readings were written here and never arrived. The page
 * hook's own reducer (`spatial-menu-hook.mjs`, `menuHookState`) published
 * `{open, index}` and dropped the rest, so on the Quest 2 all
 * ten Find-pad presses read `[true, null, null, null, <row ids>]` before and
 * after and timed out UNVERIFIED at 12.5 s while the pad worked on the display
 * The hook publishes the browser's
 * fields now, and `chain` joins the list so a chain tab — which the sentence
 * above already promises — is an outcome rather than another identical
 * reading: a tab press changes the chain and the page and leaves every row id
 * where it was.
 */
export const SEQUENCE_SUBROW_PREFIX = 'sequence-';
export const SEQUENCE_SUBROW_EXPECTATION: RowExpectation = {
  expected: 'the sequence browser answers on its own rows: the page, the chain, the sub-page or the Find value it shows changes',
  read: observation => [field(observation.state, 'sequence', 'open'), field(observation.state, 'sequence', 'index'),
    field(observation.state, 'sequence', 'page'), field(observation.state, 'sequence', 'chain'),
    field(observation.state, 'sequence', 'find'), rowIds(observation)],
  holds: (before, after) => Array.isArray(after) && after[0] !== undefined && !sameReading(before, after),
};

export function rowExpectation(id: string): RowExpectation | undefined {
  if (Object.prototype.hasOwnProperty.call(MENU_ROW_EXPECTATIONS, id)) return MENU_ROW_EXPECTATIONS[id];
  return id.startsWith(SEQUENCE_SUBROW_PREFIX) ? SEQUENCE_SUBROW_EXPECTATION : undefined;
}

/** Whether one row's expectation is satisfied by what the page reported. */
export function expectationHeld(expectation: RowExpectation, before: MenuObservation, after: MenuObservation,
  entries: readonly DiagnosticRecord[]): boolean {
  if (expectation.diagnostic) return expectation.diagnostic(entries);
  if (!expectation.read) return false;
  const first = expectation.read(before), second = expectation.read(after);
  return expectation.holds ? expectation.holds(first, second) : !sameReading(first, second);
}

/** What the step log prints for a reading, short enough to sit on one line. */
export function describeReading(value: unknown): string {
  const text = JSON.stringify(value ?? null);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/**
 * How a step reached the menu. Printed per step and counted in the summary, so
 * a reader never has to assume which of the two a row was driven with.
 */
export const DRIVE_METHOD_PRESS = 'hook-press';
export const DRIVE_METHOD_RAY = 'synthetic-ray';
export const DRIVE_METHOD_PHRASE = 'hook-phrase';
export const SYNTHETIC_METHODS: readonly string[] = Object.freeze([DRIVE_METHOD_PRESS, DRIVE_METHOD_RAY, DRIVE_METHOD_PHRASE]);
/** Printed whenever any step drove the page through a hook. */
export const SYNTHETIC_INPUT_SENTENCE = 'synthetic input: no wearer';
/** The aim step that must press nothing. */
export const DRIVE_AIM_MISS = 'miss';

/** How long a row's outcome is waited for before the step fails. */
export const VERIFY_TIMEOUT_MS = 12_000;
export const VERIFY_POLL_MS = 500;

// ------------------------------------------------- the conversation turns

/**
 * The `ask` step: a conversation, not a grammar check.
 *
 * `voice` above proves the fixed phrase table. It does not prove the thing the
 * product is sold on, because `__stereofoldVoice.say` hands a finished string
 * straight to the command handler: no microphone, no recorder, no transcriber,
 * and no agent. Every failure between the wearer's mouth and the phrase table
 * is invisible to it.
 *
 * So this step starts one hop earlier, at the only place a test can start
 * without a person breathing into a headset: real audio. Each turn is spoken
 * by `say`, converted to the 16 kHz mono WAV the transcriber wants, and posted
 * to `push_to_talk_audio` -- the same host route the headset's own recorder
 * posts to. From there the run is the product's: the Mac assembles the chunks,
 * decodes them, transcribes them locally, and files the text on the queue that
 * `listen_voice` serves to an agent.
 *
 * Each of the three turns proves a different half of the loop:
 *
 * - an unscripted question, which no phrase table can answer, proving the
 *   speech reaches an agent and the agent's sentence reaches the wearer's eyes
 *   and ears;
 * - "show me", proving an answer can become a scene the wearer sees change;
 * - "continue the lesson", proving the tour resumes from where it was parked
 *   rather than restarting.
 *
 * One honest limit, stated here because it is easy to overclaim: the reasoning
 * hop is this script. A real agent reads `listen_voice` and decides what to
 * say; here the decision is canned and only the transport around it is under
 * test. What that buys is still most of the chain -- recorder route,
 * assembly, decode, transcription, queue, reply synthesis, delivery, caption
 * and audible clip -- and every one of those has broken at least once.
 */
export type AskTurn = {
  /** What is spoken into the microphone route. */
  said: string;
  /** The canned agent sentence this script answers with. */
  reply: string;
  /**
   * What the agent does about it, named on the turn rather than derived from
   * its position. The three actions are not interchangeable -- one of them
   * resumes the lesson -- and an index-keyed switch would silently swap them
   * the first time somebody reorders this table.
   */
  act: 'answer' | 'show' | 'resume';
  /** One line for the report, in the language of what a wearer would notice. */
  proves: string;
};

export const ASK_TURNS: readonly AskTurn[] = Object.freeze([
  Object.freeze({
    said: 'what does the guide RNA do here',
    reply: 'The guide RNA finds the matching DNA and holds Cas9 on it.',
    act: 'answer' as const,
    proves: 'an unscripted question reaches an agent and its answer reaches the wearer',
  }),
  Object.freeze({
    said: 'show me',
    reply: 'Showing you the guide RNA now.',
    act: 'show' as const,
    proves: 'an answer can change the scene the wearer is looking at',
  }),
  Object.freeze({
    said: 'continue the lesson',
    reply: 'Picking the lesson back up.',
    act: 'resume' as const,
    proves: 'the tour resumes from where it was parked',
  }),
]);

/**
 * How much of what was said has to come back for the transcript to count.
 *
 * All of it, and the reason is arithmetic rather than strictness. This loop
 * speaks four content words -- "what guide RNA here" -- and a threshold of
 * three quarters passes a transcript that lost exactly one of them. The one it
 * is cheapest to lose is `RNA`, which is the only word in the sentence that
 * makes it a question about this molecule: "what does the guide do here"
 * scores 0.75 and would have been reported as heard correctly.
 *
 * Punctuation, casing and filler are still forgiven, because they are dropped
 * before the comparison rather than scored. What is not forgiven is a missing
 * content word, on synthesized speech that this machine measured at a clean
 * 1.00 on all three turns. A real microphone in a real room is a different
 * measurement and wants its own, looser check; this one is about whether the
 * right audio arrived at all.
 */
export const TRANSCRIPT_MATCH_THRESHOLD = 1;

/**
 * How many words the transcriber may add before the transcript stops being the
 * sentence that was spoken.
 *
 * Overlap alone never penalised extra words, so a transcript that contained
 * everything asked plus a leaked prompt scored a perfect 1.00 -- and the
 * whisper route is primed with a prompt full of exactly these nouns
 * (`WHISPER_INITIAL_PROMPT`), so a leak is the shape a false pass here would
 * take. A couple of spare words is ordinary; a sentence's worth is not.
 */
export const TRANSCRIPT_EXTRA_ALLOWANCE = 3;

/** Words to ignore when comparing: they carry no evidence either way. */
const TRANSCRIPT_NOISE: ReadonlySet<string> = new Set(['a', 'an', 'the', 'is', 'are', 'to', 'of', 'do', 'does', 'did']);

function transcriptWords(text: string): string[] {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/gu, ' ').split(/\s+/u)
    .filter(word => word && !TRANSCRIPT_NOISE.has(word));
}

export type TranscriptMatch = { ok: boolean; score: number; heard: string; missing: string[]; extra: string[] };

/**
 * Did the Mac hear what was spoken?
 *
 * Content-word equality in both directions, for the two reasons above.
 * `missing` and `extra` are reported separately because they are different
 * failures: an utterance that lost a word sounds like a transcriber problem,
 * an utterance that came back as somebody else's sentence sounds like a queue
 * problem, and an utterance that came back with a prompt attached to it sounds
 * like a decode that heard silence -- and the three want different fixes.
 */
export function transcriptMatches(heard: string, asked: string): TranscriptMatch {
  const wanted = transcriptWords(asked);
  const said = transcriptWords(heard);
  const got = new Set(said);
  if (!wanted.length) return { ok: false, score: 0, heard: String(heard ?? ''), missing: [], extra: [] };
  const missing = wanted.filter(word => !got.has(word));
  const asking = new Set(wanted);
  const extra = [...new Set(said.filter(word => !asking.has(word)))];
  const score = (wanted.length - missing.length) / wanted.length;
  return {
    ok: score >= TRANSCRIPT_MATCH_THRESHOLD && extra.length <= TRANSCRIPT_EXTRA_ALLOWANCE,
    score, heard: String(heard ?? ''), missing, extra,
  };
}

/**
 * Split a recording into the base64 chunks `push_to_talk_audio` accepts.
 *
 * The route's own ceiling is on the encoded string, not the bytes, so the raw
 * slice is sized from the base64 limit rather than guessed at: 3 raw bytes
 * become 4 encoded ones, and a slice chosen on a multiple of 3 never carries
 * interior padding. A press this script sends is a couple of seconds of 16 kHz
 * mono, so this almost always returns one chunk -- but the headset sends many,
 * and a route that only ever sees one chunk from its test is a route whose
 * assembly and ordering are untested.
 */
export function chunkAudioBase64(audio: Uint8Array, maxBase64 = PTT_MAX_CHUNK_BASE64): string[] {
  const rawPerChunk = Math.max(3, Math.floor(maxBase64 / 4) * 3);
  const buffer = Buffer.from(audio);
  if (!buffer.byteLength) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += rawPerChunk) {
    chunks.push(buffer.subarray(offset, offset + rawPerChunk).toString('base64'));
  }
  if (chunks.length > PTT_MAX_CHUNKS) throw Error(`A ${buffer.byteLength} byte recording needs ${chunks.length} chunks, past the route's ${PTT_MAX_CHUNKS}.`);
  return chunks;
}

/**
 * The container and codec Quest Browser's MediaRecorder actually produces.
 *
 * `containerExtension` accepts `audio/wav` and the transcriber decodes it
 * happily, which is why the first version of this step sent one. That made the
 * step pass on a host that could not decode a single real press: Opus is what
 * arrives from the headset, and an Opus stream ffmpeg cannot open fails here
 * and nowhere else.
 */
export const HEADSET_PRESS_MIME = 'audio/webm;codecs=opus';

/**
 * How many chunks one press is split into, at minimum.
 *
 * The headset's recorder emits a timeslice about once a second and closes the
 * utterance with a bare `final: true` carrying no audio. A two-second WAV fits
 * in a single chunk under the route's 320 KiB ceiling, so the step used to
 * send exactly one, with `final` set on the chunk that still carried data --
 * a shape the headset never sends, exercising neither `assembleChunks`'s
 * ordering nor its bare-final branch. Three is the smallest count that has a
 * first, a middle and a last.
 */
export const PRESS_CHUNK_MINIMUM = 3;

/**
 * Split one press the way the headset's recorder splits it.
 *
 * The size is chosen from the recording rather than from the route's ceiling,
 * so a short press still arrives as several chunks. Each chunk stays a
 * multiple of three raw bytes, so no interior chunk carries base64 padding and
 * the host's concatenation decodes.
 */
export function pressChunks(audio: Uint8Array, minimum = PRESS_CHUNK_MINIMUM, maxBase64 = PTT_MAX_CHUNK_BASE64): string[] {
  const bytes = Buffer.from(audio).byteLength;
  if (!bytes) return [];
  const wanted = Math.max(1, Math.floor(minimum));
  const rawPerChunk = Math.max(3, Math.ceil(Math.ceil(bytes / wanted) / 3) * 3);
  return chunkAudioBase64(audio, Math.min(maxBase64, (rawPerChunk / 3) * 4));
}

export type ReplyReceipts = { received: DiagnosticRecord[]; played: DiagnosticRecord[]; failed: DiagnosticRecord[]; silent: DiagnosticRecord[] };

/**
 * A clip record that means sound, as opposed to one that means `start(0)` was
 * called.
 *
 * Chromium records a started buffer source whether or not its AudioContext was
 * ever resumed, and an unattended Quest with no wearer is exactly where a
 * context stays `suspended`: the page draws the caption, starts the clip into
 * a stopped context and nothing is heard. `reply-audio.mjs` writes the context
 * state on the record for that reason, and this refuses anything else.
 *
 * The element fallback has no context of its own to read. There `play()`
 * resolving is the browser's own statement that the element began playing, and
 * the record carries `started: true` only after that promise resolved, so it
 * is the same claim by a different route.
 */
export function clipReachedOutput(entry: DiagnosticRecord): boolean {
  const detail = entry.detail ?? {};
  if (detail.contextState === 'running') return true;
  return detail.via === 'element' && detail.started === true;
}

/**
 * What the page says it did with an agent's reply.
 *
 * Three separate readings because they fail separately, and each one has been
 * hit in practice. `reply-received` is the caption arriving at all; `reply-audio-play`
 * is the clip actually reaching the output; `reply-audio-error` and
 * `speech-failed` are the silent lesson -- a caption stands, the wearer reads
 * it, and nobody says a word. `delivered: true` from `say_to_headset` proves
 * none of these: it only means a page took the message off the heartbeat.
 *
 * Every record is scoped to the caption queue's own id for this reply, which
 * `say_to_headset` returns and the page copies onto each record it writes.
 * Length and byte count were what this used before, and they are not identity:
 * two answers of the same length credit each other, and a clip record still in
 * flight from the previous turn satisfied "the wearer heard it" for an answer
 * that was never played. Reading the log dry before sending narrows the window
 * but cannot close it, because the earlier turn's record can land inside this
 * one. The id closes it. Length and bytes stay as a second check on the same
 * record.
 *
 * `drawn: false` is a caption that reached a surface which draws none, so it
 * is not counted as read. `silent` is the other half of the same idea for
 * sound: a clip the page started into a suspended AudioContext is a record
 * with no audio behind it, and it is kept apart from `played` rather than
 * discarded, so the caller can say which of the two happened.
 */
export function replyReceipts(entries: readonly DiagnosticRecord[], reply?: { chars?: number; audioBytes?: number; captionId?: string }): ReplyReceipts {
  const mine = (entry: DiagnosticRecord) => reply?.captionId === undefined || entry.detail?.captionId === reply.captionId;
  const clips = entries.filter(entry => entry.kind === 'reply-audio-play' && mine(entry)
    && (reply?.audioBytes === undefined || entry.detail?.bytes === reply.audioBytes));
  return {
    received: entries.filter(entry => entry.kind === 'reply-received' && entry.detail?.empty !== true
      && entry.detail?.drawn !== false && mine(entry)
      && (reply?.chars === undefined || entry.detail?.chars === reply.chars)),
    played: clips.filter(clipReachedOutput),
    silent: clips.filter(entry => !clipReachedOutput(entry)),
    // A speech failure carries no caption id -- it is the page's own voice
    // giving up, not this clip -- so it is scoped by the window the caller
    // read dry instead. `reply-audio-error` does carry one.
    failed: [...entries.filter(entry => entry.kind === 'reply-audio-error' && mine(entry)), ...speechFailures(entries)],
  };
}

/**
 * Where a lesson was parked, read off the companion heartbeat.
 *
 * The player keeps more state than the heartbeat carries -- `stopped` is not
 * reported at all -- so a parked lesson that was taken over reads as `active:
 * false` with a real `step`, which is indistinguishable from an idle panel
 * unless a step of zero or more is itself treated as "a lesson is in
 * progress". That is why `step` is captured rather than `active`.
 */
export type TourPark = { selectedId: string; step: number; presenting: boolean; autoplay: boolean; active: boolean };

/**
 * What has to happen before there is a real lesson to interrupt.
 *
 * `open`: nothing is playing, so `--steps ask` on its own has nothing to
 * continue and the lesson has to be started first.
 *
 * `back`: the lesson is sitting on its final chapter, which is where a
 * preceding full `tour` walk leaves it. Resuming the last chapter is the one
 * case where `play` can run the lesson off its end and move `step` by itself,
 * so the verdict would depend on how long the conversation took. Stepping back
 * one chapter removes that, and costs nothing a wearer would notice.
 *
 * `none`: already parked somewhere in the middle, which is the interesting case
 * anyway -- a wearer interrupts a lesson because something caught their eye.
 *
 * There is no fourth answer for "a lesson is up but still autoplaying". The
 * pause is sent before this is consulted and again by the park loop if the
 * first one did not land, so every state ends at the same place: a lesson
 * sitting still on a chapter, or a sentence saying it would not sit still.
 */
export function planPark(tour: Record<string, any> | undefined): 'open' | 'back' | 'none' {
  const step = Number(tour?.step);
  const total = Number(tour?.total ?? 0);
  // No live chapter is "open", whatever `total` says. A panel that reports no
  // tour at all -- stopped, or a companion that has not sent one yet -- used to
  // fall to `none`, and `none` waits 30 s for a chapter that is never coming
  // and dies on a timeout. `stepAsk` takes the lesson id from the session
  // catalog when the panel has none, and says so plainly if there is no lesson.
  if (!(step >= 0)) return 'open';
  if (total > 1 && step >= total - 1) return 'back';
  return 'none';
}

/** A lesson sitting still on a real chapter: the state `ask` interrupts. */
export function tourParked(tour: Record<string, any> | undefined): boolean {
  return tour?.navigating === false && Number(tour?.step) >= 0 && tour?.autoplay === false;
}

/**
 * The wearer-facing plate that means the Mac stopped sharing.
 *
 * Taken from the words the page itself shows (`companion-startup.ts`), so the
 * two cannot drift; only the opening clause is matched, because the rest of
 * that sentence is advice and advice gets reworded.
 */
export const SHARE_ENDED_ON_PAGE = /Sharing from your Mac has ended/i;

/** How many `pause` commands the park is willing to spend before it gives up. */
export const PARK_PAUSE_ATTEMPTS = 3;
/** How long each of them is given to show up on the heartbeat. */
export const PARK_WAIT_MS = 10_000;
/**
 * What a lesson that will not stop is worth saying.
 *
 * The old failure here was `waitForPanel`'s own words -- "Timed out after 30 s
 * waiting for the lesson to park on its chapter" -- which names the wait and
 * not the thing that went wrong. A dropped `pause` is the usual cause (a panel
 * answering `unsaved`, a receipt that never came back), and it is worth
 * retrying before it is worth reporting.
 */
export const PARK_REFUSED_ADVICE = `The lesson would not stop: after ${PARK_PAUSE_ATTEMPTS} pause commands the companion still reports it running, `
  + 'so "continue the lesson" could not be told apart from a command that was dropped.';

export function parkedTour(panel: Record<string, any> | undefined): TourPark | undefined {
  const tour = panel?.tour;
  const step = Number(tour?.step);
  const selectedId = String(tour?.selectedId ?? '');
  if (!selectedId || !Number.isFinite(step) || step < 0) return undefined;
  return {
    selectedId, step, presenting: panel?.xrStartup?.presenting === true,
    // Both flags are recorded because `tourResumed` needs to know which of them
    // was false before the resume: that is the only difference between a play
    // that worked and a play that was dropped on the floor.
    autoplay: tour?.autoplay === true, active: tour?.active === true,
  };
}

/**
 * The change `play` makes that nothing else makes, given how the lesson sits
 * right now.
 *
 * A paused lesson is `active: true, autoplay: false`; `play` turns autoplay
 * back on. A lesson that was taken over -- by the wearer grabbing the
 * structure, or by any committed inspection change, which is how
 * `notifyMutation` treats an agent's focus command (tour-player.ts:996) -- is
 * `active: false` with its chapter kept; `play` rejoins it, which turns active
 * back on and leaves autoplay alone. So the edge depends on the state at the
 * moment `play` is sent, not on the state at the park: asserting the wrong one
 * passes a `play` that did nothing (the original bug) or fails a rejoin that
 * worked (the bug that replaced it, because the "show me" turn stops the
 * lesson between the park and the resume).
 *
 * `undefined` means there is no edge: both flags are already true, so a
 * successful resume is indistinguishable from a command that never arrived.
 */
export function resumeEdge(tour: { active: boolean; autoplay: boolean } | undefined): 'autoplay' | 'active' | undefined {
  if (!tour) return undefined;
  if (!tour.active) return 'active';
  if (!tour.autoplay) return 'autoplay';
  return undefined;
}

/**
 * Did "continue the lesson" pick the lesson back up where it was parked?
 *
 * Resume is an equality check, not an advance. `play` resumes the chapter the
 * wearer was looking at when they interrupted -- on a paused lesson the scene
 * is already on screen and `play` only restarts its dwell; on a taken-over one
 * `play` rejoins and restores that chapter's captured scene. Either way the
 * chapter index is the one that was parked. A step that moved is not a
 * successful resume: it means the lesson ran on while the wearer was talking,
 * and they missed it.
 *
 * The lesson id is checked alongside the index because `start` also produces a
 * plausible-looking `step`, at chapter zero of whatever lesson it opened. The
 * failure this guards against is a "continue" that silently restarts, which
 * costs the wearer the whole lesson over again.
 *
 * `presenting` is in the comparison because the point of the interruption is
 * that it happens inside the headset. A resume that worked because the session
 * ended and came back is not the thing being tested.
 *
 * Equality alone is not enough, and that was this check's worst bug. Every
 * equality here -- same lesson, same chapter, not navigating -- is already
 * true the instant the lesson is paused, and `active` stays true through a
 * pause too. So a `play` the panel dropped on the floor matched on the first
 * poll and the step reported a working conversation loop.
 *
 * What is required instead is the state a wearer would call continuing: the
 * lesson active AND autoplay running again, on the chapter they left. A
 * rejoin that restores the chapter without arming autoplay is half a resume --
 * the scene comes back and the lesson never moves again -- so `resumeLesson`
 * finishes the job rather than this accepting it.
 */
export function tourResumed(parked: TourPark | undefined, panel: Record<string, any> | undefined): { ok: boolean; reason?: string } {
  if (!parked) return { ok: false, reason: 'no lesson was parked, so there was nothing to continue' };
  if (!resumeEdge(parked)) {
    return { ok: false, reason: 'the lesson was still running when the conversation started, so a play that did nothing would look the same as one that worked' };
  }
  const tour = panel?.tour;
  const step = Number(tour?.step);
  if (!Number.isFinite(step)) return { ok: false, reason: 'the panel reported no tour step afterwards' };
  if (String(tour?.selectedId ?? '') !== parked.selectedId) {
    return { ok: false, reason: `it opened a different lesson (${String(tour?.selectedId ?? 'none')}) instead of continuing ${parked.selectedId}` };
  }
  if (step !== parked.step) {
    return { ok: false, reason: step < parked.step
      ? `it restarted at chapter ${step + 1} instead of continuing chapter ${parked.step + 1}`
      : `it skipped ahead to chapter ${step + 1}, so the wearer missed chapter ${parked.step + 1} while they were talking` };
  }
  if (tour?.navigating !== false) return { ok: false, reason: 'the lesson is still navigating, so it has not settled on the parked chapter' };
  if (tour?.active !== true) return { ok: false, reason: 'the lesson never rejoined the chapter the wearer left it on' };
  if (tour?.autoplay !== true) {
    return { ok: false, reason: 'the chapter is back on screen but the lesson is not running again, so it would sit on that scene for good' };
  }
  if (parked.presenting && panel?.xrStartup?.presenting !== true) {
    return { ok: false, reason: 'the headset session ended somewhere in the conversation, so this was not an in-headset resume' };
  }
  return { ok: true };
}

// ------------------------------------------------------------- the report

export type DiagnosticRecord = { seq?: number; sequence?: number; at?: number; kind: string; detail?: Record<string, unknown> };
/** Flat transition entries travel through the existing diagnostics fetch/ring. */
export type TransitionDiagnosticRecord = DiagnosticRecord & { kind: 'transition'; detail: {
  id: number; operation: string; phase: 'start' | 'first-frame' | 'old-removed' | 'complete' | 'failed';
  startedAtMs: number; firstFrameAtMs: number | null; oldRemovedAtMs: number | null;
  worstFrameMs: number | null; maxCallbackMs: number | null; maxFrameGapMs: number | null;
  elapsedMs: number; frames: number; reportedFrameRate: number | null;
} };

export function transitionRecords(entries: readonly DiagnosticRecord[]): TransitionDiagnosticRecord[] {
  return entries.filter((entry): entry is TransitionDiagnosticRecord => entry.kind === 'transition'
    && typeof entry.detail?.operation === 'string'
    && ['start', 'first-frame', 'old-removed', 'complete', 'failed'].includes(String(entry.detail?.phase))
    && ['id', 'startedAtMs', 'elapsedMs', 'frames'].every(key => typeof entry.detail?.[key] === 'number' && Number.isFinite(entry.detail[key]))
    && ['firstFrameAtMs', 'oldRemovedAtMs', 'worstFrameMs', 'maxCallbackMs', 'maxFrameGapMs', 'reportedFrameRate']
      .every(key => entry.detail?.[key] === null || (typeof entry.detail?.[key] === 'number' && Number.isFinite(entry.detail[key]))));
}
export type FailedResponse = { at: string; url: string; status?: number; errorText?: string };

/** The part of the headset ring this run actually managed to inspect. */
export interface RingSummary {
  /** The stable source, even when the page carrying the ring navigates. */
  identity: 'headset-diagnostics';
  entriesRead: number;
  evicted: boolean;
  /** The Mac-side cursor, not the page-local sequence, survives navigation. */
  cursor: number;
}

export interface StepResult {
  step: DriveStep;
  ok: boolean;
  failure?: string;
  /**
   * How this step reached the page, or null for a step that drove nothing
   * through a hook. `hook-press` hands a row's action to the toolbar chain;
   * `synthetic-ray` aims a simulated controller pose through the real hit
   * test; `hook-phrase` hands a finished sentence to the command handler.
   */
  method: string | null;
  /**
   * Whether this step proved its own outcome. A step that only proved dispatch
   * is `false`, never `true`, whatever its exit status says.
   */
  verified: boolean | null;
  outcome?: 'refused';
  /** One sentence a person can read without opening the evidence. */
  detail: string;
  startedAt: string;
  endedAt: string;
  evidence: Record<string, unknown>;
  consoleErrors: ConsoleLine[];
  failedResponses: FailedResponse[];
}

export interface DriveReport {
  startedAt: string;
  endedAt: string;
  ok: boolean;
  failures: string[];
  gate: DriveGate;
  options: DriveOptions;
  steps: StepResult[];
  /** How the driven steps were reached, and how many proved their outcome. */
  drive: DriveSummary;
  ring: RingSummary;
  evidenceIdentity: { effectiveUrl: string | null };
}

/**
 * The honest tally, printed at the end of a run and carried in report.json.
 *
 * `verified` counted an outcome. `dispatchedOnly` reached the page and proved
 * only that the call returned, which is what every menu step used to be worth.
 * `failed` is a step that was driven and did not pass. `syntheticInput` is set
 * whenever any step went through a page hook rather than a person, and the
 * printed summary says so in words.
 */
export interface DriveSummary {
  driven: number;
  verified: number;
  dispatchedOnly: number;
  failed: number;
  syntheticInput: boolean;
  methods: string[];
}

/** The end-of-run tally, in the words a reader of the log needs. */
export function formatDriveSummary(drive: DriveSummary): string[] {
  if (drive.driven === 0) return ['No step drove the in-headset menu.'];
  const lines = [`${drive.driven} driven step${drive.driven === 1 ? '' : 's'}: `
    + `${drive.verified} verified, ${drive.dispatchedOnly} dispatched-only, ${drive.failed} failed`
    + ` (${drive.methods.join(', ')}).`];
  if (drive.dispatchedOnly > 0) {
    lines.push(`${drive.dispatchedOnly} step${drive.dispatchedOnly === 1 ? '' : 's'} proved only that the call `
      + 'returned. Dispatch is not success.');
  }
  if (drive.syntheticInput) lines.push(`${SYNTHETIC_INPUT_SENTENCE}. `
    + 'An aimed step simulates a controller pose through the real hit test; it does not test reach, comfort or legibility.');
  return lines;
}

export function summarizeDrive(steps: readonly StepResult[]): DriveSummary {
  const driven = steps.filter(step => step.method !== null);
  return {
    driven: driven.length,
    verified: driven.filter(step => step.ok && step.verified === true).length,
    dispatchedOnly: driven.filter(step => step.ok && step.verified !== true).length,
    failed: driven.filter(step => !step.ok).length,
    syntheticInput: driven.some(step => SYNTHETIC_METHODS.includes(step.method ?? '')),
    methods: [...new Set(driven.map(step => step.method ?? ''))].filter(Boolean).sort(),
  };
}

/**
 * Every spoken line that did not make it, from a page of diagnostics.
 *
 * A refused narration is recorded rather than thrown, because the scene did
 * draw and its caption did appear; only the audio is missing. That is the right
 * call for a wearer and the wrong one for an unattended run, which exists to
 * catch exactly this. A storm of 409s is what these look like on the wire.
 */
/** A tour record for a spoken line: the player files narration under kind `tour`. */
export function isNarrationRecord(entry: DiagnosticRecord): boolean {
  return entry.kind === 'tour' && (entry.detail as { action?: unknown } | undefined)?.action === 'narration';
}

/**
 * What the open step does with the tabs Quest Browser already has.
 *
 * Measured: an `am start -a VIEW` intent opens a NEW tab every time, it never
 * focuses an existing one. Each run leaves one more /viewer tab behind,
 * frozen, and one of them can hold the immersive session: the runtime then
 * refuses every new session ("still running in the background") and the driver
 * reads a panel whose `presenting: true` came from a tab nobody can see. So the
 * intent is sent only when no Stereofold tab exists; otherwise the newest is
 * brought to the front over the debugger and, unless a session is being
 * resumed, the older duplicates are closed.
 *
 * `expectedOrigin` is the share's own origin, and nothing outside it is ever
 * touched. This plan closes tabs, and a path test alone would put any page the
 * wearer left open on some other site — `https://unrelated.example/viewer` —
 * on the close list. When the host cannot say what it serves, the plan still
 * drives (refusing to drive at all is worse) but it closes nothing: matching
 * then falls back to path *and* title, which is a guess, and a guess is not
 * grounds for shutting a tab that may be the wearer's own.
 */
export function planOpen(targets: readonly DevtoolsTarget[], resumeSession: boolean, panelPresent = true,
  expectedOrigin?: string): { launch: boolean; close: string[] } {
  const stereofold = targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl
    && isStereofoldTarget(target, expectedOrigin));
  if (!stereofold.length) return { launch: true, close: [] };
  // Never `/json/activate` a tab. Measured: activating the presenting tab
  // pushes the immersive view behind the 2D browser window and leaves the
  // Quest shell in a multi-window layout where the flat browser panel stays
  // on top of every later session, across force-stops. The
  // newest tab is the visible one; nothing needs bringing forward.
  if (resumeSession) return { launch: false, close: [] };
  // No companion panel on the host means the share window has closed behind
  // the tab (measured: the page sits on "WAITING FOR STRUCTURE" and a reload
  // does not help). Only `open_companion` reopens the share, and it
  // opens a fresh tab, so every old one goes first.
  if (!panelPresent) return { launch: true, close: expectedOrigin === undefined ? [] : stereofold.map(target => target.id) };
  if (expectedOrigin === undefined) return { launch: false, close: [] };
  const newest = pickStereofoldTarget(stereofold, undefined, expectedOrigin)!;
  const others = stereofold.filter(target => target.id !== newest.id).map(target => target.id);
  return { launch: false, close: others };
}

export function speechFailures(entries: readonly DiagnosticRecord[]): DiagnosticRecord[] {
  return entries.filter(entry => entry.kind === 'speech-failed');
}

export function describeSpeechFailure(entry: DiagnosticRecord): string {
  const detail = entry.detail ?? {};
  const status = typeof detail.status === 'number' ? ` HTTP ${detail.status}` : '';
  return `${String(detail.route ?? 'speech')}${status}: ${String(detail.reason ?? 'no reason recorded')}`;
}

/** Roll the per-step results into the answer a caller's exit code is built from. */
export function summarizeRun(steps: readonly StepResult[]): { ok: boolean; failures: string[] } {
  const failures = steps.filter(step => !step.ok).map(step => `${step.step}: ${step.detail}`);
  return { ok: failures.length === 0, failures };
}

export function buildReport(input: {
  startedAt: string; endedAt: string; gate: DriveGate; options: DriveOptions; steps: readonly StepResult[]; ring?: RingSummary; effectiveUrl?: string;
}): DriveReport {
  const { ok, failures } = summarizeRun(input.steps);
  const stepRings = input.steps.map(step => step.evidence.ring).filter((ring): ring is Partial<RingSummary> =>
    Boolean(ring && typeof ring === 'object'));
  const ring = input.ring ?? {
    identity: 'headset-diagnostics' as const,
    entriesRead: stepRings.reduce((total, value) => total + (typeof value.entriesRead === 'number' ? value.entriesRead : 0), 0),
    evicted: stepRings.some(value => value.evicted === true),
    cursor: typeof stepRings.at(-1)?.cursor === 'number' ? stepRings.at(-1)!.cursor! : 0,
  };
  return { drive: summarizeDrive(input.steps),
    startedAt: input.startedAt, endedAt: input.endedAt, gate: input.gate, options: { ...input.options,
      ...(input.options.url === undefined ? {} : { url: redactUrl(input.options.url) }),
      ...(input.options.query === undefined ? {} : { query: redactUrl(`?${input.options.query}`).slice(1) }) },
    evidenceIdentity: { effectiveUrl: input.effectiveUrl === undefined ? null : redactUrl(input.effectiveUrl) },
    steps: [...input.steps], ok, failures, ring };
}

// --------------------------------------------------------------- plumbing

/**
 * Wait, and keep the process alive while waiting.
 *
 * Deliberately not `unref`ed. Every wait here is the whole job -- a page
 * opening on the headset, a tour chapter landing -- and an unref'd timer is the
 * only pending work between two agent calls, so Node finds an empty event loop
 * and exits 0 with no output at all. That is indistinguishable from a pass.
 */
const settle = (seconds: number) => new Promise<void>(resolve => { setTimeout(resolve, seconds * 1000); });
const nowIso = () => new Date().toISOString();

/** Add a run-local ordinal so two captures can never address the same file. */
export function captureFileName(name: string, index: number): string {
  return `${name}-${String(Math.max(1, Math.floor(index))).padStart(3, '0')}.png`;
}

/** How long a *known* share origin stands before it is asked for again. */
const ORIGIN_RECHECK_MS = 10_000;

/**
 * Whether the remembered share origin may be used without asking the host again.
 *
 * Only a known origin is ever remembered. "Not sharing yet" and "the status
 * call threw" used to be cached for the same ten seconds, and that is the
 * window the cold `open` runs in: the first status arrives before
 * `open_companion` has opened anything, so the whole plan — which tabs are
 * ours, which are closed, which one the debugger attaches to — ran on the
 * path-only rule, the one the origin guard was added to replace. An unknown
 * origin is worth nothing to cache: re-asking costs one local tool call, and
 * the answer changes the moment the share opens.
 */
export function originCacheHolds(origin: string | undefined, checkedAt: number, now = Date.now()): boolean {
  return origin !== undefined && now - checkedAt < ORIGIN_RECHECK_MS;
}

/**
 * Say what is being waited for, while it is being waited for.
 *
 * A step here can legitimately take minutes -- a page opening on the headset, a
 * six chapter lesson -- and an operator watching a silent terminal cannot tell
 * a slow run from a wedged one. These go to stderr so `report.json` and the
 * pass/fail lines on stdout stay machine-readable.
 */
const progress = (message: string) => { console.error(`${new Date().toISOString().slice(11, 19)}  ${message}`); };

const run = (command: string, args: readonly string[], signal?: AbortSignal) => new Promise<{ code: number; stdout: Buffer; stderr: string }>(resolve => {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'],
    ...(signal ? { signal, killSignal: 'SIGKILL' as const } : {}) });
  const out: Buffer[] = []; let stderr = '';
  child.stdout.on('data', chunk => out.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.on('error', error => resolve({ code: -1, stdout: Buffer.concat(out), stderr: String(error) }));
  child.on('close', code => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr }));
});

class StepFailure extends Error {
  constructor(message: string, readonly evidence: Record<string, unknown> = {}) { super(message); }
}

function isGateFailure(error: unknown): error is StepFailure {
  return error instanceof StepFailure && Boolean(error.evidence.gate);
}

type GateReadHost = {
  adbShell(...args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }>;
  inspectionState(): Promise<Record<string, any>>;
};

/** Agent calls that can send input or change the headset's visible state. */
const HEADSET_MUTATING_TOOLS = new Set([
  'open_companion', 'open_detailed_view', 'update_inspection', 'focus_selection',
  'emphasize', 'control_tour', 'navigate_experience', 'acknowledge_experience_step',
  'replace_inspection_source', 'push_to_talk_audio', 'say_to_headset', 'speak_to_headset',
  'grow_structure', 'continue_session', 'switch_assistant', 'undo_last_change',
  'capture_headset_view',
]);

const STOPPED_WORN = 'stopped: the headset is being worn';
const STOPPED_PROXIMITY_UNREADABLE = 'stopped: the proximity gate could not be read';
/**
 * How long one tab is given to say what it is.
 *
 * A foreground Quest Browser tab answered a `Runtime.evaluate` in 1.4 ms
 * median; a frozen one never answers. Two seconds is
 * therefore generous for a live page and short enough that twenty dead tabs
 * cost forty seconds rather than the full ten-second CDP timeout each.
 */
const TAB_PROBE_MS = 2_000;
/** How many times the whole candidate list is asked before "none is live" is believed. */
const TAB_PROBE_ROUNDS = 3;
/** Seconds between probe rounds, for a tab that was opened a moment ago. */
const TAB_PROBE_GAP_SECONDS = 3;

const STOPPED_SESSION_UNREADABLE = 'stopped: the headset session state could not be read';

/** Keep debugger forwarding and every shell gate on the same named headset. */
export function driveAdbArguments(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const serial = pickAdbSerial([], env).named;
  return serial ? ['-s', serial, ...args] : [...args];
}

/** Everything the steps share: one agent binding, one debugger bridge, one adb. */
export class Driver {
  session?: CdpSession;
  sessionTargetId?: string;
  effectiveUrl?: string;
  private openTargetId?: string;
  lines: ConsoleLine[] = [];
  responses: FailedResponse[] = [];
  /** Mac-side ring cursor; deliberately not reset when the CDP page navigates. */
  diagnosticCursor = 0;
  private diagnosticsRead = 0;
  private diagnosticDropped = 0;
  private captureIndex = 0;
  /** Retain notes even when a multi-capture step keeps only the final path. */
  captureNotes: Array<{ path: string; via: string; note: string }> = [];
  private menuCommandIds?: Set<string>;
  private menuVerificationStartedAt?: number;
  /** `listen_voice`'s own cursor, so a turn never reads the turn before it. */
  voiceCursor = 0;
  /**
   * How big the structure in the headset is RIGHT NOW.
   *
   * `options.atomSites` is what the run was told at the start; a `grow` step
   * replaces the coordinates under it, so every later size-aware wait has to ask
   * this instead. A fixed 30 s `exit` wait after growing to the wall (40,908
   * sites) failed on a session that ended about a minute later.
   */
  currentAtomSites?: number;
  /**
   * How many triangles the headset is holding RIGHT NOW.
   *
   * A density tier reports 0 atom sites, honestly, so `currentAtomSites` cannot
   * describe it and must not be made to: faking an atom number for a mesh would
   * put a made-up count in every record and every printed line. This
   * is the mesh's own count, set only when a volume tier lands.
   */
  currentTriangles?: number;
  private shareOrigin?: string;
  private shareOriginCheckedAt = 0;
  private originWarned = false;
  constructor(
    readonly state: ControlState,
    readonly adb: string,
    readonly port: number,
    readonly transport: DevtoolsTransport,
    readonly options: DriveOptions,
    private readonly adbEnvironment: NodeJS.ProcessEnv = process.env,
  ) {}

  async adbShell(...args: AdbShellArguments) {
    const options = args.at(-1);
    return await run(this.adb, driveAdbArguments(['shell', ...[...args].filter((arg): arg is string => typeof arg === 'string')], this.adbEnvironment),
      typeof options === 'object' ? options.signal : undefined);
  }

  /** Fail closed immediately before a headset write. */
  async assertProximitySafe(): Promise<DriveGate> {
    return await assertProximitySafe(this);
  }

  /**
   * The origin the headset is actually meant to be on.
   *
   * Everything this driver does to a tab — attaching a debugger, reading the
   * page, closing it as a stale duplicate — is scoped to this. The host knows
   * it: `manage_companion action="status"` returns the LAN companion's own
   * `https://<host>:<port>/`. Nothing else does, so it is asked rather than
   * guessed, and a host that is not sharing leaves it unknown, which falls
   * back to the older path-only rule instead of stopping the run.
   *
   * Re-asked, not cached forever: the share can be reopened mid-run on a
   * different address, and a negative answer means only "not sharing yet".
   */
  async expectedOrigin(): Promise<string | undefined> {
    // A known origin ages: a share reopened mid-run can land on another port.
    // An unknown one is not cached at all -- see `originCacheHolds`.
    if (originCacheHolds(this.shareOrigin, this.shareOriginCheckedAt)) return this.shareOrigin;
    try {
      const answer = await this.agent('manage_companion', { action: 'status' });
      const lan = ((answer.structuredContent ?? {}) as { lan?: { url?: string } | null }).lan;
      const origin = lan?.url ? new URL(lan.url).origin : undefined;
      if (origin && origin !== this.shareOrigin) progress(`tabs are scoped to the share origin ${origin}`);
      if (!origin && !this.originWarned) {
        this.originWarned = true;
        progress('the host reports no LAN share, so tabs are matched by path and title, and none are closed, until it does');
      }
      this.shareOrigin = origin;
      // Stamped only for a real answer, so the next call re-asks after a
      // negative instead of standing on it for ten seconds.
      this.shareOriginCheckedAt = origin === undefined ? 0 : Date.now();
    } catch (error) {
      // An error is not an answer. Clearing the stamp keeps a transport blip
      // from freezing the guard open for the rest of the step.
      this.shareOrigin = undefined;
      this.shareOriginCheckedAt = 0;
      if (!this.originWarned) {
        this.originWarned = true;
        progress(`could not read the share origin (${error instanceof Error ? error.message : String(error)}); matching tabs by path and title, and closing none`);
      }
    }
    return this.shareOrigin;
  }

  /**
   * Drop a remembered origin, because something just changed where the share is.
   *
   * `open_companion` can reopen the share on a different port, and the answer
   * cached a moment earlier then names a listener nobody is on.
   */
  forgetShareOrigin() { this.shareOrigin = undefined; this.shareOriginCheckedAt = 0; }

  /** The newest tab on the share origin, or the older path-only guess. */
  async stereofoldTarget(): Promise<DevtoolsTarget | undefined> {
    if (this.openTargetId) return (await this.targets()).find(target => target.id === this.openTargetId);
    const origin = await this.expectedOrigin();
    return pickStereofoldTarget(await this.targets(), undefined, origin);
  }

  /**
   * Drive the tab the PAGE says is live, not the newest one.
   *
   * The Quest had twenty-one identical `/viewer` tabs open and
   * exactly one of them held the immersive session. Picking by tab id chose a
   * frozen one, and the run spent three recovery steps on a document nobody
   * could see while the live page rendered correctly beside it.
   *
   * So each candidate is asked. Quest Browser freezes every tab that is not
   * the visible one, and a frozen tab completes the debugger handshake and
   * then answers nothing at all, so silence is the reading rather than a
   * fault. A tab that answers but has no spatial menu yet is still live — that
   * is a page in the middle of booting — and only ranks below one that draws
   * the menu or is presenting.
   *
   * Nothing is probed when there is only one candidate: the answer cannot
   * change anything and the connection is not worth spending. When no
   * candidate answers, this fails with the whole tab list rather than driving
   * a dead tab.
   */
  async chooseLiveTarget({ rounds = TAB_PROBE_ROUNDS, wait = settle, fallback }:
    { rounds?: number; wait?: (seconds: number) => Promise<void>; fallback?: DevtoolsTarget } = {}): Promise<DevtoolsTarget> {
    const origin = await this.expectedOrigin();
    // A debugger that will not list its tabs is not grounds for refusing to
    // drive: the caller already found a page, and comparing tabs is an
    // improvement on that answer, never a precondition for it.
    let listed: DevtoolsTarget[];
    try { listed = await this.targets(); }
    catch (error) {
      if (!fallback) throw error;
      progress(`tabs: the debugger would not list its tabs (${error instanceof Error ? error.message : String(error)}); `
        + `driving tab ${fallback.id}, which is the one this run already found`);
      return fallback;
    }
    const candidates = pageTargets(listed).filter(target => isStereofoldTarget(target, origin)
      && (origin === undefined || targetOrigin(target.url) === origin));
    if (!candidates.length) {
      if (fallback) {
        progress(`tabs: the debugger lists no Stereofold page; driving tab ${fallback.id}, which is the one this run already found`);
        return fallback;
      }
      throw new StepFailure(`The debugger on 127.0.0.1:${this.port} lists no Stereofold page.`,
        { tabs: listed.map(formatTarget) });
    }
    if (candidates.length === 1) {
      this.openTargetId = candidates[0]!.id;
      progress(`tabs: one viewer tab is open (${candidates[0]!.id}); driving it`);
      return candidates[0]!;
    }
    progress(`tabs: ${candidates.length} viewer tabs are open on this share; asking each page which one is live`);
    let readings: TabReading[] = [];
    let choice = chooseLiveTab(readings);
    const attempts = Math.max(1, rounds);
    for (let round = 1; round <= attempts; round += 1) {
      readings = await probeTabs(this.transport, { port: this.port,
        ...(origin === undefined ? {} : { expectedOrigin: origin }), probeMs: TAB_PROBE_MS });
      choice = chooseLiveTab(readings);
      if (choice.chosen) break;
      // A tab opened a moment ago has a page but not yet a document that
      // answers, so one quiet round is "not yet" rather than "dead".
      if (round < attempts) {
        progress(`tabs: no tab answered on round ${round}; asking again`);
        await wait(TAB_PROBE_GAP_SECONDS);
      }
    }
    if (!choice.chosen) {
      throw new StepFailure(`${choice.reason} Relaunch over the cable to leave exactly one tab: `
        + 'manage_companion action="launch" launch="adb" now closes the stale ones.', { tabs: readings.map(describeTab) });
    }
    progress(`tabs: ${choice.reason}`);
    for (const rejected of choice.rejected) progress(`tabs: not tab ${rejected.id} — ${rejected.reason}`);
    const chosen = candidates.find(target => target.id === choice.chosen!.id);
    if (!chosen?.webSocketDebuggerUrl) {
      throw new StepFailure('The tab that answered no longer lists a debugger socket.', { tabs: readings.map(describeTab) });
    }
    this.openTargetId = chosen.id;
    // The cached session may be bound to a tab this just rejected.
    if (this.sessionTargetId !== chosen.id) { this.session?.close(); this.session = undefined; this.sessionTargetId = undefined; }
    return chosen;
  }

  /** One agent tool call, with the binding fields filled the way the CLI fills them. */
  async agent(name: string, args: Record<string, unknown> = {}): Promise<AgentResult> {
    let sent = args;
    if (needsInspectionState(name, args)) {
      let waitedMs = 0;
      for (;;) {
        const reading = await callLocalAgent(this.state, 'get_inspection_state');
        const chosen = fillAgentArguments(name, args, reading.structuredContent ?? {});
        if (!shouldWaitOutBlur({ blurred: chosen.blurred === true, waitedMs })) {
          if (chosen.blurred === true) throw new StepFailure(`No panel took ${name}: the companion stayed busy for ${(waitedMs / 1000).toFixed(1)} s.`);
          sent = chosen.arguments; break;
        }
        await settle(PANEL_BLUR_POLL_MS / 1000);
        waitedMs += PANEL_BLUR_POLL_MS;
      }
    }
    // The read above may wait through a render. Check again after that wait and
    // immediately before the tool that changes the headset.
    if (HEADSET_MUTATING_TOOLS.has(name)) await this.assertProximitySafe();
    return await callLocalAgent(this.state, name, sent);
  }

  async inspectionState(options: { includeExperienceCatalog?: boolean } = {}): Promise<Record<string, any>> {
    return ((await callLocalAgent(this.state, 'get_inspection_state', options)).structuredContent ?? {}) as Record<string, any>;
  }

  /**
   * The map this session is drawing, when it is drawing one.
   *
   * `get_inspection_state` carries a `density` block for a map session and
   * nothing at all for an atomic one (`inspection-server.ts`), so this is how
   * the driver knows a density tier without being told. `triangles`
   * rides along only when the tier was grown into from the demo index; a
   * session opened straight onto the filament lesson has the bytes and no
   * count, which is why the expected count has a constant of its own.
   */
  async densitySession(): Promise<{ bytes: number; triangles?: number } | undefined> {
    const density = (await this.inspectionState()).density as { bytes?: unknown; triangles?: unknown } | undefined;
    const bytes = typeof density?.bytes === 'number' && Number.isFinite(density.bytes) && density.bytes > 0 ? density.bytes : 0;
    if (!bytes) return undefined;
    const triangles = density?.triangles;
    return { bytes, ...(typeof triangles === 'number' && Number.isFinite(triangles) && triangles > 0 ? { triangles } : {}) };
  }

  /** The companion panel, which is the headset. A desktop panel is never driven here. */
  async companionPanel(): Promise<Record<string, any> | undefined> {
    // The page id is the strongest identity available: two remembered devices
    // may both be current, and presenting is not permission to choose one.
    const pagePanelId = await this.evaluate('document.body?.dataset?.panelId || null').catch(() => undefined);
    return companionPanelOf(await this.inspectionState(), typeof pagePanelId === 'string' ? pagePanelId : undefined);
  }

  /** Poll the companion panel until `accept` likes it, or say what it looked like instead. */
  async waitForPanel(what: string, accept: (panel: Record<string, any> | undefined) => boolean, timeoutMs = 30_000): Promise<Record<string, any> | undefined> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    let announced = 0;
    let last: Record<string, any> | undefined;
    for (;;) {
      last = await this.companionPanel();
      if (accept(last)) return last;
      const elapsed = Math.floor((Date.now() - started) / 10_000);
      if (elapsed > announced) {
        announced = elapsed;
        progress(`still waiting for ${what} (panel ${last?.availability ?? 'absent'}, presenting ${String(last?.xrStartup?.presenting)})`);
      }
      if (Date.now() >= deadline) {
        throw new StepFailure(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}.`,
          { lastPanel: last ? { availability: last.availability, xrStartup: last.xrStartup, tour: last.tour } : null });
      }
      await settle(1);
    }
  }

  /** Diagnostics the headset has reported since the last read. */
  async newDiagnostics(kind?: string): Promise<DiagnosticRecord[]> {
    const page = await this.readDiagnosticsPage(kind);
    return page.entries;
  }

  private async readDiagnosticsPage(kind?: string): Promise<{ entries: DiagnosticRecord[]; more: boolean }> {
    const answer = await this.agent('read_headset_log', { sinceSequence: this.diagnosticCursor, limit: 500, ...(kind ? { kind } : {}) });
    const structured = (answer.structuredContent ?? {}) as {
      entries?: DiagnosticRecord[]; cursor?: number; more?: boolean; summary?: { dropped?: number };
    };
    const entries = structured.entries ?? [];
    this.diagnosticsRead += entries.length;
    if (typeof structured.summary?.dropped === 'number' && Number.isFinite(structured.summary.dropped)) {
      this.diagnosticDropped = Math.max(this.diagnosticDropped, structured.summary.dropped);
    }
    // Only an unfiltered read may move the cursor; a `kind` read would skip
    // every other entry past it and lose the speech failures this run exists
    // to catch.
    if (!kind) {
      const cursor = typeof structured.cursor === 'number' ? structured.cursor : entries.at(-1)?.sequence;
      if (typeof cursor === 'number') this.diagnosticCursor = Math.max(this.diagnosticCursor, cursor);
    }
    return { entries, more: structured.more === true };
  }

  /** Follow the Mac-side cursor until the ring returns an empty page. */
  async drainDiagnostics(): Promise<DiagnosticRecord[]> {
    const drained: DiagnosticRecord[] = [];
    for (;;) {
      const page = await this.readDiagnosticsPage();
      // An empty page is the only stable end condition: a full page may have
      // more waiting, or a new entry may have arrived between reads.
      if (page.entries.length === 0) return drained;
      drained.push(...page.entries);
    }
  }

  ringMark(): { entriesRead: number } {
    return { entriesRead: this.diagnosticsRead };
  }

  ringSummarySince(mark: { entriesRead: number }): RingSummary {
    return {
      identity: 'headset-diagnostics',
      entriesRead: Math.max(0, this.diagnosticsRead - mark.entriesRead),
      evicted: this.diagnosticDropped > 0,
      cursor: this.diagnosticCursor,
    };
  }

  /** The page's latest frame-rate estimate, or null when it has reported none. */
  latestFps(entries: readonly DiagnosticRecord[]): number | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.kind === 'frame-rate' && typeof entry.detail?.fps === 'number') return entry.detail.fps as number;
    }
    return null;
  }

  // ---------------------------------------------------------- the bridge

  async targets(): Promise<DevtoolsTarget[]> {
    return parseTargets(await this.transport.fetch(this.port, '/json'));
  }

  /** Close one tab; `/json/close/<id>` answers "Target is closing". */
  async closeTarget(id: string): Promise<string> {
    await this.assertProximitySafe();
    const answer = (await this.transport.fetch(this.port, `/json/close/${encodeURIComponent(id)}`)).trim();
    if (this.sessionTargetId === id) { this.session?.close(); this.session = undefined; this.sessionTargetId = undefined; }
    return answer;
  }

  /**
   * Attach to the tab the wearer is looking at, reusing the open connection.
   *
   * The target changes under this script twice: when `open_companion` brings up
   * the page, and when "Open in Mol*" sends the same tab to `/detailed`. A
   * cached session on a navigated tab answers nothing at all, so the target id
   * is re-checked on every use rather than trusted.
   */
  async page(): Promise<{ session: CdpSession; target: DevtoolsTarget }> {
    const target = await this.stereofoldTarget();
    if (!target?.webSocketDebuggerUrl) throw new StepFailure(`The debugger on 127.0.0.1:${this.port} lists no Stereofold page.`);
    if (this.session && this.sessionTargetId === target.id) return { session: this.session, target };
    this.session?.close();
    const session = await this.transport.open(this.port, target.webSocketDebuggerUrl);
    session.on(event => this.collect(event));
    await session.send('Runtime.enable');
    await session.send('Log.enable');
    await session.send('Network.enable');
    this.session = session; this.sessionTargetId = target.id;
    return { session, target };
  }

  private collect(event: CdpEvent) {
    const line = formatConsoleEvent(event);
    if (line) { this.lines.push(line); return; }
    if (event.method === 'Network.responseReceived') {
      const response = (event.params.response ?? {}) as { status?: number; url?: string };
      if (typeof response.status === 'number' && response.status >= 400) {
        this.responses.push({ at: nowIso(), url: redactUrl(String(response.url ?? '')), status: response.status });
      }
      return;
    }
    if (event.method === 'Network.loadingFailed') {
      const text = String(event.params.errorText ?? 'failed');
      // A cancelled request is the page moving on, not a fault.
      if (text === 'net::ERR_ABORTED') return;
      this.responses.push({ at: nowIso(), url: '<request>', errorText: text });
    }
  }

  /** Console errors seen since the marker, so a step owns only its own noise. */
  errorsSince(marker: number): ConsoleLine[] { return this.lines.slice(marker).filter(line => line.level === 'error'); }
  responsesSince(marker: number): FailedResponse[] { return this.responses.slice(marker); }

  async evaluate(expression: string, { awaitPromise = false } = {}): Promise<unknown> {
    const { session } = await this.page();
    const outcome = readEvaluateResult(await session.send('Runtime.evaluate', evaluateParameters(expression, { awaitPromise })));
    if (!outcome.ok) throw new StepFailure(`The page threw: ${outcome.reason}`);
    return outcome.value;
  }

  /** Evaluate a page action only after the latest proximity reading. */
  async evaluateForAction(expression: string, { awaitPromise = false } = {}): Promise<unknown> {
    const { session } = await this.page();
    await this.assertProximitySafe();
    const outcome = readEvaluateResult(await session.send('Runtime.evaluate', evaluateParameters(expression, { awaitPromise })));
    if (!outcome.ok) throw new StepFailure(`The page threw: ${outcome.reason}`);
    return outcome.value;
  }

  /**
   * A real pointer gesture, which is the whole reason entry works unattended.
   *
   * `Input.dispatchMouseEvent` satisfies WebXR's user-activation requirement in
   * Quest Browser 150 (`trustedClick: true`, measured); an untrusted
   * `element.click()` does not, though it is enough to *end* a session. This is
   * the one place in this repository that sends the headset input, and it is
   * guarded by the proximity gate above.
   */
  async click(x: number, y: number) {
    const { session } = await this.page();
    await this.assertProximitySafe();
    const common = { x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' };
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common, buttons: 0 });
    await this.assertProximitySafe();
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
    await this.assertProximitySafe();
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common, buttons: 0 });
  }

  /**
   * What the page is telling the wearer, in one string.
   *
   * `document.body.innerText` rather than a structured read: the states worth
   * reporting here are the ones nobody planned for, and the page says them in
   * prose ("The molecular change did not produce a frame within 30 seconds")
   * long before any hook exists to ask.
   */
  async pageStatus(): Promise<string> {
    try { return String(await this.evaluate('(() => (document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 400))()')); }
    catch (error) { return `unreadable (${error instanceof Error ? error.message : String(error)})`; }
  }

  /** Read the selected document; a host panel can outlive its browser tab. */
  async waitForPageReady(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    type Startup = { phase: string; pairing: boolean; pageKeyPresent: boolean; message: string; startupFailure: string | null };
    for (;;) {
      // Only key presence crosses DevTools. Storage may be blocked, in which
      // case inspection-page-key.ts keeps the key in the fragment instead.
      const startup = await this.evaluate(`(() => {
        const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
        let pageKeyPresent = valid(location.hash.slice(1));
        try { pageKeyPresent ||= valid(sessionStorage.getItem('stereo_structure/page-key')); } catch {}
        const body = document.body;
        return {
          phase: body?.dataset.ready === 'true' ? 'ready' : body?.dataset.ready || 'loading',
          pairing: window.__STEREOFOLD_COMPANION__ === true && Boolean(body?.dataset.panelId),
          pageKeyPresent,
          startupFailure: body?.dataset.startupFailure || null,
          message: (document.querySelector('#status')?.textContent || '').trim().slice(0, 400),
        };
      })()`).catch(() => null) as Startup | null;
      if (startup?.phase === 'error') {
        throw new StepFailure(startup.message || 'The viewer could not finish starting.', { pageStartup: startup });
      }
      const panel = await this.companionPanel();
      if (startup?.phase === 'ready' && startup.pairing && startup.pageKeyPresent
        && panel?.surface === 'companion') return { panel, startup };
      if (Date.now() >= deadline) {
        throw new StepFailure(startup?.message || 'The viewer did not reach its ready state.', { pageStartup: startup });
      }
      await settle(1);
    }
  }

  /**
   * Reload the headset tab. The one write in this file that is not a gesture.
   *
   * `headset-devtools.ts` refuses to navigate or reload on purpose, because
   * someone is usually wearing the headset when an agent reads it. This script
   * runs only behind the proximity gate, and a companion page that has not
   * paired holds nothing the wearer would lose.
   */
  /**
   * Send the tab back through the pairing page. A viewer that boots without
   * its page key says "Open the complete companion link from the desktop
   * inspection" and no reload can give it one; the root route pairs again
   * from the remembered device and lands on /viewer with a key, which fixes it
   * in about ten seconds after a headset reboot.
   */
  async repair() {
    const { session, target } = await this.page();
    const origin = new URL(target.url).origin;
    await session.send('Page.enable');
    await this.assertProximitySafe();
    await session.send('Page.navigate', { url: `${origin}/` });
    await settle(6);
    this.session?.close(); this.session = undefined; this.sessionTargetId = undefined;
  }

  /** Exercise the wearer-facing recovery control, falling back to its exact route. */
  async recoverPairing() {
    const button = await this.locate('button', '^Pair again$');
    if (button && !button.disabled) {
      await this.click(button.x, button.y);
      await settle(6);
      this.session?.close(); this.session = undefined; this.sessionTargetId = undefined;
      return;
    }
    await this.repair();
  }

  /** Apply only after pairing, so the pairing redirect cannot discard the query. */
  async applyOpenUrl(derived: DevtoolsTarget, wait = settle): Promise<void> {
    const effectiveUrl = composeDriveUrl(derived.url, this.options);
    this.effectiveUrl = effectiveUrl;
    progress(`open: effective URL ${redactUrl(effectiveUrl)}`);
    if (this.options.url === undefined && this.options.query === undefined) return;
    const { session } = await this.page();
    await session.send('Page.enable');
    await this.assertProximitySafe();
    const result = await session.send('Page.navigate', { url: effectiveUrl }) as { errorText?: string };
    if (result.errorText) throw new StepFailure('The URL override could not load.', { errorText: result.errorText });
    // Keep following this tab if an absolute override changes origin or path.
    this.openTargetId = derived.id;
    await wait(this.options.settleSeconds);
    this.session?.close(); this.session = undefined; this.sessionTargetId = undefined;
  }

  async reload() {
    const { session } = await this.page();
    await session.send('Page.enable');
    await this.assertProximitySafe();
    await session.send('Page.reload', { ignoreCache: false });
    await settle(6);
    // The reload replaces the document; the cached session is bound to a page
    // whose world is gone, so the next read re-attaches.
    this.session?.close(); this.session = undefined; this.sessionTargetId = undefined;
  }

  /** Where a control is, or nothing. `pattern` is matched against the text content. */
  async locate(selector: string, pattern: string): Promise<{ x: number; y: number; disabled: boolean; text: string } | null> {
    const expression = `(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const wanted = nodes.filter(node => new RegExp(${JSON.stringify(pattern)}).test(node.textContent || ''));
      const node = wanted.find(candidate => !candidate.disabled && !candidate.hidden) || wanted[0];
      if (!node) return null;
      const box = node.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return null;
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2),
        disabled: Boolean(node.disabled), text: (node.textContent || '').trim().slice(0, 60) };
    })()`;
    return await this.evaluate(expression) as { x: number; y: number; disabled: boolean; text: string } | null;
  }

  /**
   * Speak one phrase into the page's own voice grammar.
   *
   * Never awaited: `say` resolves behind the serialized dispatch chain, spoken
   * reply included, so an awaited evaluate blows the ten second CDP timeout and
   * reports a failure for an action that ran. The receipt is read afterwards
   * from the `voice-command` diagnostic instead.
   */
  async say(phrase: string) {
    const sent = await this.evaluateForAction(
      `(() => { const voice = globalThis.__stereofoldVoice;
        if (!voice || typeof voice.say !== 'function') return 'no-hook';
        voice.say(${JSON.stringify(phrase)}); return 'sent'; })()`);
    if (sent !== 'sent') throw new StepFailure(`The page exposes no __stereofoldVoice.say hook, so the in-VR menu cannot be driven (${String(sent)}).`);
  }

  /**
   * Read the live rows and the drawn state, pressing nothing.
   *
   * `allowMissing` is for verification only. A vanished hook is the expected
   * outcome of the Mol* row, which ends the immersive session, and a poll that
   * threw there would report the handoff as a failure.
   */
  async observeMenu({ allowMissing = false } = {}): Promise<MenuObservation> {
    const answer = await this.evaluate(OBSERVE_MENU_EXPRESSION) as
      { status?: unknown; rows?: MenuRows; state?: Record<string, unknown> | null };
    if (answer?.status === 'no-hook') {
      if (allowMissing) return { rows: [], state: null };
      throw new StepFailure('The page exposes no __stereofoldMenu hook, so its spatial rows cannot be read.');
    }
    return { rows: answer?.rows ?? [], state: answer?.state ?? null };
  }

  async beginMenuVerification(): Promise<void> {
    await this.drainDiagnostics();
    this.menuCommandIds = undefined;
    try {
      const state = await this.inspectionState();
      this.menuCommandIds = new Set((state.commands ?? []).map((command: { commandId: string }) => command.commandId));
      for (const panel of state.panels ?? []) {
        if (panel.lastCommand?.commandId) this.menuCommandIds.add(panel.lastCommand.commandId);
      }
    } catch { /* Ordinary row verification still works without host receipts. */ }
    this.menuVerificationStartedAt = Date.now();
  }

  async readMenuRefusal(id: string, before: MenuObservation, entries: readonly DiagnosticRecord[]): Promise<MenuRefusal | undefined> {
    // The cursor excludes records already drained; timestamps also exclude a
    // delayed old record. Recheck the window on each poll as draws arrive.
    const now = Date.now();
    entries = entries.filter(entry => entry.at === undefined || (this.menuVerificationStartedAt !== undefined
      && entry.at >= this.menuVerificationStartedAt && entry.at <= now));
    if (!entries.some(entry => (entry.kind === 'outcome' && entry.detail?.status === 'refused' && entry.detail.drawn === true)
      || (entry.kind === 'talk-caption-seat' && entry.detail?.outcome === 'shown'))) return undefined;
    const panelId = await this.evaluate('document.body?.dataset?.panelId || null');
    if (typeof panelId !== 'string' || !panelId) return undefined;
    return renderedMenuRefusal(await this.inspectionState({ includeExperienceCatalog: true }), panelId, id, before, entries, this.menuCommandIds);
  }

  /**
   * Aim a simulated controller pose at one drawn row and let the toolbar's own
   * hit test decide. This never calls `press`, and it is not a wearer.
   */
  async aimMenu(step: DriveStep): Promise<{ id: string; captureName: string; expanded: string | null;
    rows: MenuRows; before: MenuObservation; result: Record<string, unknown> }> {
    const action = aimStepArguments(step);
    type AimAnswer = { status?: unknown; rows?: MenuRows; before?: MenuObservation; result?: Record<string, unknown> };
    let answer = await this.evaluateForAction(action.expression) as AimAnswer;
    if (answer?.status === 'no-hook') {
      throw new StepFailure('The page exposes no __stereofoldAim hook, so its spatial rows cannot be aimed at. '
        + 'This build predates the aimed step; use menu:<id> and say in the report that targeting was not exercised.');
    }
    let expanded: string | null = null;
    // Most rows are behind the grid, exactly as for a pressed step. Aim at
    // Menu once and look again before failing; see `menuExpansionPlan`.
    if (answer?.result?.fired !== true && action.id !== 'miss' && !(answer?.rows ?? []).some(row => row.id === action.id)) {
      const plan = menuExpansionPlan(action.id, answer?.rows ?? []);
      if (plan.expand) {
        progress(`  ${plan.reason}`);
        const opened = await this.evaluateForAction(aimStepArguments(`aim:${MENU_EXPAND_ROW}`).expression) as AimAnswer;
        if (opened?.result?.fired !== true) {
          throw new StepFailure(`The aimed pose could not reach ${action.id}, and Menu did not open either `
            + `(${String(opened?.result?.reason ?? 'no answer')}).`, { rows: answer?.rows ?? [], aim: opened?.result ?? null });
        }
        await settle(2);
        expanded = plan.reason;
        answer = await this.evaluateForAction(action.expression) as AimAnswer;
      }
    }
    const result = answer?.result ?? {};
    return { id: action.id, captureName: action.captureName, expanded,
      rows: answer?.rows ?? [], before: answer?.before ?? { rows: [], state: null }, result };
  }

  /** Read and press one live spatial-menu row without awaiting its XR action chain. */
  async pressMenu(step: DriveStep): Promise<{ id: string; captureName: string; expanded: string | null;
    rows: Array<{ id: string; label: string; active: boolean }>; before: MenuObservation; }> {
    const action = menuStepArguments(step);
    type MenuAnswer = { status?: unknown; rows?: Array<{ id: string; label: string; active: boolean }>;
      before?: MenuObservation };
    let result = await this.evaluateForAction(action.expression) as MenuAnswer;
    if (result?.status === 'no-hook') {
      throw new StepFailure('The page exposes no __stereofoldMenu hook, so its spatial rows cannot be driven.');
    }
    // Most rows live in the expanded grid. One press of Menu and one more look
    // before failing; see `menuExpansionPlan` for why, and why `menu:menu`
    // never takes this path.
    let expanded: string | null = null;
    if (result?.status === 'absent') {
      const plan = menuExpansionPlan(action.id, result.rows ?? []);
      if (plan.expand) {
        progress(`  ${plan.reason}`);
        const opened = await this.evaluateForAction(menuStepArguments(`menu:${MENU_EXPAND_ROW}`).expression) as MenuAnswer;
        if (opened?.status !== 'pressed') {
          throw new StepFailure(`The spatial-menu row ${action.id} is not on the collapsed menu, and Menu did not open (${String(opened?.status ?? 'no answer')}).`,
            { rows: result.rows ?? [] });
        }
        await settle(2);
        expanded = plan.reason;
        result = await this.evaluateForAction(action.expression) as MenuAnswer;
      }
    }
    if (result?.status === 'absent') {
      const rows = result.rows ?? [];
      throw new StepFailure(`The spatial menu has no row ${action.id}${expanded ? ', even with the menu expanded' : ''}. `
        + `Showing now: ${rows.map(row => row.id).join(', ') || '(none)'}.`, { rows, ...(expanded ? { expanded } : {}) });
    }
    if (result?.status === 'inactive') throw new StepFailure(`The spatial-menu row ${action.id} is present but not active.`, { rows: result.rows ?? [] });
    if (result?.status !== 'pressed') throw new StepFailure(`The spatial-menu row ${action.id} did not report a press.`);
    return { id: action.id, captureName: action.captureName, expanded, rows: result.rows ?? [],
      before: result.before ?? { rows: result.rows ?? [], state: null } };
  }

  /**
   * One picture of what the wearer would see: both eyes, passthrough and all.
   *
   * `capture_headset_view` with source `device` is the protocol's own route and
   * is preferred, because it records the capture in the session's bridge log
   * beside everything else. A host with no adb configured answers with a plain
   * explanation rather than a file, and this script has an adb of its own, so
   * `adb exec-out screencap` is the fallback rather than a missing frame.
   */
  async capture(name: string): Promise<{ path: string; via: string; note?: string }> {
    const path = join(this.options.outDir, captureFileName(name, ++this.captureIndex));
    await this.assertProximitySafe();
    try {
      const answer = await this.agent('capture_headset_view', { source: 'device', savePath: path, maxWidth: 1600 });
      const structured = (answer.structuredContent ?? {}) as { savedPath?: string; source?: string };
      if (structured.savedPath) return { path: structured.savedPath, via: `capture_headset_view:${structured.source ?? 'device'}` };
      const direct = await this.screencap(path);
      const shot = { ...direct, note: agentText(answer).slice(0, 160) };
      this.captureNotes.push(shot);
      return shot;
    } catch (error) {
      if (isGateFailure(error)) throw error;
      const direct = await this.screencap(path);
      const shot = { ...direct, note: error instanceof Error ? error.message.slice(0, 160) : String(error) };
      this.captureNotes.push(shot);
      return shot;
    }
  }

  /**
   * Outside a session the Quest display sleeps within seconds and screencap
   * returns black. The proximity broadcast wakes it in under 4 s; inside a
   * session the VR app holds it awake and this is a no-op.
   */
  async wakeDisplay() {
    await this.assertProximitySafe();
    await this.adbShell('am', 'broadcast', '-a', 'com.oculus.vrpowermanager.prox_close');
    await settle(3);
  }

  private async screencap(path: string): Promise<{ path: string; via: string }> {
    await this.assertProximitySafe();
    const shot = await run(this.adb, driveAdbArguments(['exec-out', 'screencap', '-p'], this.adbEnvironment));
    if (shot.code !== 0 || shot.stdout.byteLength < 1024) throw new StepFailure(`adb screencap returned nothing (${shot.stderr.trim().slice(0, 120)}).`);
    await writeFile(path, shot.stdout);
    return { path, via: 'adb screencap' };
  }
}

// ------------------------------------------------------------- the steps

export async function stepOpen(driver: Driver): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  // `launch: "adb"` fires a VIEW intent over the cable. Meta's Web Launch is
  // never used: two sends ten seconds apart is what wedges Quest Browser into
  // the ANR dialog the wearer sees as a periodic dimming.
  const panelPresent = Boolean((await driver.companionPanel())?.surface === 'companion');
  // No debugger answer means Quest Browser is not running (measured after a
  // reboot: "socket hang up"); that is the plain "launch it" case.
  const targets = await driver.targets().catch(error => {
    progress(`open: the debugger did not answer (${error instanceof Error ? error.message : String(error)}); treating the browser as not running`);
    return [] as DevtoolsTarget[];
  });
  // The origin is read before the plan, because the plan closes tabs and a tab
  // on another site is never this driver's to close.
  const origin = await driver.expectedOrigin();
  const plan = planOpen(targets, driver.options.resumeSession, panelPresent, origin);
  if (!panelPresent) progress('open: the host lists no companion panel (share closed?), so the tab is replaced');
  if (origin === undefined && targets.some(target => isStereofoldTarget(target, undefined))) {
    progress('open: the share origin is unknown, so tabs that look like ours are left alone rather than closed');
  }
  for (const id of plan.close) progress(`open: closing stale Stereofold tab ${id} (${await driver.closeTarget(id)})`);
  let said = 'no intent sent; the page was already open';
  if (plan.launch) {
    progress('open: asking the host to put the LAN companion on the headset over the cable');
    const answer = await driver.agent('open_companion', { connection: 'lan', launch: 'adb' });
    said = agentText(answer).slice(0, 200);
    progress(`open: the host said "${said}"`);
    // The share that just opened is the one to scope tabs to, and it may be on
    // a port nothing has asked about yet. Anything remembered from before the
    // call describes a different listener, so the wait loop below re-reads.
    driver.forgetShareOrigin();
  } else {
    progress('open: a Stereofold tab is already up; nothing is brought forward (activating one breaks the shell layout)');
  }
  // A headset parked on Meta's boundary dialog hands the page to nobody, so
  // the wait below can only run out. Ask before spending it, and say which
  // dialog it is: "no page within 90 s" sends whoever reads the run looking at
  // the share, the host and the cable, none of which are the problem.
  let guardianDialog = await readGuardianDialog(driver);
  if (guardianDialog.showing === true) {
    progress('open: the headset is showing Meta\'s boundary dialog, so no wait is spent');
    throw new StepFailure(GUARDIAN_DIALOG_ADVICE, { hostSaid: said, guardianDialog });
  }
  const deadline = Date.now() + 90_000;
  let target: DevtoolsTarget | undefined;
  for (;;) {
    // The debugger socket comes up a few seconds after a cold launch; until
    // then /json hangs up, which is "not yet", not a failure.
    target = await driver.stereofoldTarget().catch(() => undefined);
    if (target?.webSocketDebuggerUrl) break;
    if (Date.now() >= deadline) {
      // The dialog also comes up mid-wait — the headset dozes and re-searches
      // the room — so the same question is asked again before falling back to
      // the timeout, and either answer is written down.
      guardianDialog = await readGuardianDialog(driver);
      if (guardianDialog.showing === true) throw new StepFailure(GUARDIAN_DIALOG_ADVICE, { hostSaid: said, guardianDialog });
      throw new StepFailure('Quest Browser opened no Stereofold page within 90 s.', { hostSaid: said, guardianDialog });
    }
    progress('open: the debugger lists no Stereofold tab yet');
    await settle(2);
  }
  // A tab exists, but on a headset carrying leftovers
  // from earlier launches that is not the same as the right tab. Ask the pages
  // themselves before anything is driven, and pin the one that answers.
  target = await driver.chooseLiveTarget(target ? { fallback: target } : {});
  progress(`open: tab ${target.id} is up; waiting for it to pair with this Mac`);
  // A map session says so, and says how big the map is, before
  // the page has drawn anything. The pairing wait is sized from that rather
  // than from the fixed 45 s an atomic session gets — and never shortened by
  // it, because a map is a reason to wait longer and never a reason to wait
  // less than this step already waited.
  const density = await driver.densitySession().catch(() => undefined);
  const expectedTriangles = density?.triangles ?? DENSITY_EXPECTED_TRIANGLES;
  const densityWait = density ? Math.max(45_000, densityWaitMs(density.bytes, expectedTriangles)) : 45_000;
  if (density) {
    progress(`open: this session draws a map · waiting ${describeDensityWait(density.bytes, expectedTriangles)}`);
  }
  let reloaded = false;
  let ready: Awaited<ReturnType<Driver['waitForPageReady']>>;
  try { ready = await driver.waitForPageReady(densityWait); }
  catch (error) {
    // The page classifies closed shares separately from transient/viewer errors.
    // Reloading cannot reopen a share or supply a missing key.
    if (error instanceof StepFailure) {
      const startup = error.evidence.pageStartup as Awaited<ReturnType<Driver['waitForPageReady']>>['startup'] | null;
      if (startup?.phase === 'error' && (!startup.pageKeyPresent || startup.startupFailure === SHARE_ENDED_STARTUP_FAILURE)) throw error;
    }
    // A VIEW intent brings an already-open tab to the front; it does not reload
    // it. Measured: the headset tab had been wedged on "The
    // molecular change did not produce a frame within 30 seconds" since 07:43,
    // `open_companion` re-focused that same document, and its own "Reload
    // viewer" button did not act. Recovery is still spent only once: an
    // explicitly disconnected authorized page pairs through its root route;
    // other incomplete boots reload and get one second chance.
    const startup = error instanceof StepFailure
      ? error.evidence.pageStartup as { pageKeyPresent?: unknown; message?: unknown } | null
      : null;
    if (needsPairingRecovery(startup)) {
      // A restart invalidates the old document's authorization even when its
      // page key remains in storage. The same-origin root uses the remembered
      // device to issue a fresh page key; it never starts a private relay.
      progress(`open: the paired viewer lost its host connection ("${String(startup?.message).slice(0, 100)}"); pairing again from the root route`);
      await driver.recoverPairing();
    } else {
      progress('open: startup failed or timed out; reloading the tab once.');
      await driver.reload();
    }
    reloaded = true;
    ready = await driver.waitForPageReady(90_000);
  }
  target = await driver.stereofoldTarget() ?? target;
  await driver.applyOpenUrl(target);
  if (driver.options.url !== undefined || driver.options.query !== undefined) {
    ready = await driver.waitForPageReady(densityWait);
  }
  let panel: Record<string, any> | undefined = ready.panel;
  const path = new URL(composeDriveUrl(target.url, driver.options)).pathname;
  // On a map session the panel pairing is only a third of what
  // `open` has to prove. The page has already said whether it meshed the map,
  // whether the swap failed on the way, and what the wearer's status row reads;
  // read that ring and fail HERE with those entries, rather than three steps
  // later with a sentence about something that did not come up.
  let proof: DensityOpenProof | undefined;
  let watched: DensityOpenWatch | undefined;
  if (density) {
    // The page has a whole budget to say these things, and the
    // entries ride a 1 Hz heartbeat, so this reads until the budget is spent
    // rather than judging the instant the panel appeared. `newDiagnostics` is a
    // cursor read, so the entries accumulate across polls; the panel list is
    // re-read with them, because a companion that pairs a second later is a
    // companion. Only a page that says it FAILED cuts the wait short.
    let announced = 0;
    watched = await watchDensityOpen({
      readRing: () => driver.newDiagnostics(),
      readPaired: async () => {
        const live = await driver.companionPanel();
        if (live?.surface === 'companion') panel = live;
        return live?.surface === 'companion';
      },
      expectedTriangles,
      budgetMs: densityWait,
      onPoll: ({ proof: seen, waitedMs }) => {
        const decade = Math.floor(waitedMs / 10_000);
        if (decade > announced) {
          announced = decade;
          progress(`open: still waiting for the map · ${seen.problems[0] ?? 'no problem reported'}`);
        }
      },
    });
    proof = watched.proof;
    if (!proof.ok) {
      throw new StepFailure(`The map session opened but did not draw: ${proof.problems.join(' ')}`,
        { targetPath: path, availability: panel?.availability ?? null, reloaded,
          density: { bytes: density.bytes, expectedTriangles, measuredTriangles: proof.triangles },
          waitedMs: Math.round(watched.waitedMs), polls: watched.polls, pageReportedFailure: watched.lost,
          problems: proof.problems, ring: proof.offending });
    }
    progress(`open: the map is drawn · ${proof.triangles?.toLocaleString()} triangles measured in the headset`
      + ` after ${(watched.waitedMs / 1000).toFixed(1)} s`);
  }
  return {
    detail: 'Companion ready, paired, and holding a page key.',
    evidence: { pageStartup: ready.startup, effectiveUrl: redactUrl(driver.effectiveUrl!), targetPath: path, availability: panel?.availability, reloaded, hostSaid: said, launched: plan.launch, closed: plan.close,
      ...(density ? { density: { bytes: density.bytes, expectedTriangles, measuredTriangles: proof?.triangles ?? null,
        waitMs: densityWait, ...(watched ? { waitedMs: Math.round(watched.waitedMs), polls: watched.polls } : {}) } } : {}) },
  };
}

/**
 * Wait for the viewer's Enter VR button, reloading once if the page wedged on
 * its boot. The wedge reads "The viewer couldn't finish starting … Reload
 * viewer" and its own button does not act; a debugger reload does (measured
 * after Back from Mol* with the display asleep).
 */
async function recoverEntryButton(driver: EnterStepHost): Promise<LocatedControl | null> {
  const wedged = /couldn.t finish starting|Reload viewer|did not produce a frame|This tab needs pairing/i;
  let reloaded = false;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const button = await driver.locate('button', '^Enter VR');
    if (button) return button;
    const said = await driver.pageStatus();
    // The share-ended plate is the one wedge a reload cannot clear: only the
    // Mac reopens a share. Reloading into it, or waiting out the 90 s, spends
    // the run on a door that is shut; the wearer's own page already says so.
    if (SHARE_ENDED_ON_PAGE.test(said)) {
      throw new StepFailure('The headset page says sharing from the Mac has ended, so there is no viewer to enter. Reopen the companion on the Mac and run this again.',
        { pageStatus: said.slice(0, 200) });
    }
    if (!reloaded && wedged.test(said)) {
      await driver.wakeDisplay();
      if (/complete companion link|This tab needs pairing/i.test(said)) {
        progress(`enter: the viewer booted without its page key ("${said.slice(0, 100)}"); pairing again from the root route`);
        await driver.repair();
      } else {
        progress(`enter: the viewer wedged on boot ("${said.slice(0, 120)}"); reloading once`);
        await driver.reload();
      }
      reloaded = true;
      continue;
    }
    await settle(2);
  }
  return null;
}

/**
 * Whether this panel can be sent a command right now.
 *
 * The three fields `choosePanel` (agent-arguments.ts) needs, read from the
 * companion's own heartbeat: it is the headset's panel, it is at the revision
 * the host has saved, and it is not mid-render. Anything else is a "not yet".
 */
export function panelIsCommandable(panel: Record<string, any> | undefined): boolean {
  return panel?.surface === 'companion' && panel.current === true && panel.availability === 'ready';
}

/** The current companion panel for this page, when its device identity is unambiguous. */
export function companionPanelOf(state: Record<string, any> | undefined, pagePanelId?: string): Record<string, any> | undefined {
  const panels = (state?.panels ?? []) as Record<string, any>[];
  const companions = panels.filter(panel => panel.surface === 'companion');
  // Navigation replaces the document and its panel id, but the old heartbeat
  // can remain in this list until its lease expires.
  const current = companions.filter(panel => panel.current === true);
  if (pagePanelId !== undefined) {
    const bound = companions.find(panel => panel.panelId === pagePanelId);
    return bound?.current === true ? bound : undefined;
  }
  if (current.length === 1) return current[0];
  // Multiple current companion panels are multiple devices unless the page id
  // resolved them. Do not drive whichever happened to be listed first.
  return undefined;
}

/** A loaded viewer that still has its key but says its host connection died. */
export function needsPairingRecovery(startup: { pageKeyPresent?: unknown; message?: unknown } | null | undefined): boolean {
  return startup?.pageKeyPresent === true && /disconnected|reconnecting|connection (?:was )?lost/i.test(String(startup.message ?? ''));
}

/**
 * How long a command waits for the panel to be commandable.
 *
 * An autoplaying lesson saves a new scene at every chapter transition, so the
 * companion is `unsaved` for a beat or two each time, and `choosePanel`
 * (agent-arguments.ts:148) refuses on `unsaved` — it will wait out `busy` but
 * not this. Fifteen seconds is longer than a chapter transition and shorter
 * than the shortest dwell measured on hardware (10 s), so a command sent
 * between chapters outlives the save instead of ending the run.
 */
export const TOUR_PANEL_WAIT_MS = 15_000;

/**
 * Wait until `get_inspection_state` shows the headset able to take a command.
 *
 * Returns rather than throws when the bound is spent: the caller still has the
 * host's own refusal to report, and that sentence is more useful than this
 * one's. `waitedMs` and `polls` are what the report carries.
 */
export async function waitForAvailablePanel(host: CommandHost, { timeoutMs = TOUR_PANEL_WAIT_MS, wait = settle,
  note = progress, now = Date.now, what = 'the headset panel' }: {
    timeoutMs?: number; wait?: (seconds: number) => Promise<void>; note?: (message: string) => void;
    now?: () => number; what?: string;
  } = {}): Promise<{ available: boolean; panel?: Record<string, any>; waitedMs: number; polls: number }> {
  const started = now();
  for (let polls = 1; ; polls++) {
    let panel: Record<string, any> | undefined;
    try { panel = companionPanelOf(await host.inspectionState()); } catch { panel = undefined; }
    if (panelIsCommandable(panel)) return { available: true, panel, waitedMs: now() - started, polls };
    if (now() - started >= timeoutMs) return { available: false, panel, waitedMs: now() - started, polls };
    if (polls === 1) note(`waiting for ${what} to be ready for a command (it is ${panel?.availability ?? 'absent'})`);
    await wait(1);
  }
}

/**
 * Wait for the headset to be able to take a command.
 *
 * Entering the session is not the same event as being ready to be driven. The
 * page re-seats the structure for immersion, saves that, and its next beat is
 * what puts the panel back at the host's current revision; until then
 * `choosePanel` sees no current panel and refuses. Measured: the `wall` stage
 * (40,908 atom sites) spent that window loading at 3 fps, the driver's six
 * in-flight retries ran out after twenty-two seconds, and the step failed with
 * "No panel is showing this inspection" — about a working headset with the page
 * open on it.
 *
 * Six retries is a bound on a heartbeat, not on a load. This is a bound on a
 * load, so it is a function of the structure: `--atom-sites` scales it, and
 * without a count it is the base wait. It says what it waited for either way.
 */
async function waitForCommandablePanel(driver: EnterStepHost): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  // `livePanelLoad` rather than `options.atomSites`, because a
  // plan may re-enter after a grow and a re-entry into a density tier is a
  // re-entry into a mesh. With no grow behind it this is exactly what it was.
  const load = livePanelLoad(driver);
  const timeoutMs = panelWaitMs(load, PANEL_READY_WAIT);
  const started = Date.now();
  progress(`enter: waiting for the headset panel to take commands · ${describePanelWait(load, PANEL_READY_WAIT)}`);
  const before = await driver.companionPanel();
  const panel = await driver.waitForPanel('the headset panel to be current and ready for a command', panelIsCommandable, timeoutMs);
  const waitedSeconds = Math.round((Date.now() - started) / 1_000);
  return {
    detail: `The panel was ready for commands after ${waitedSeconds} s.`,
    evidence: {
      waitedSeconds, timeoutSeconds: Math.round(timeoutMs / 1_000),
      atomSites: load.atomSites ?? null, triangles: load.triangles ?? null,
      before: before ? { surface: before.surface, availability: before.availability, current: before.current } : null,
      after: panel ? { surface: panel.surface, availability: panel.availability, current: panel.current } : null,
    },
  };
}

/** How long Enter VR may stay missing or disabled before the enter step gives up. */
export const ENTER_VR_ENABLE_WAIT_MS = 90_000;
/** How often the enter step re-reads the button while it is still disabled. */
export const ENTER_VR_ENABLE_POLL_MS = 250;

export type LocatedControl = { x: number; y: number; disabled: boolean; text: string };

/** What `waitForEnabledEnterButton` needs from the page, so a test can be the session. */
export type EnterVrPage = {
  locate(selector: string, pattern: string): Promise<LocatedControl | null>;
  companionPanel(): Promise<Record<string, any> | undefined>;
  wait?(ms: number): Promise<void>;
  now?(): number;
  note?(message: string): void;
};

/**
 * What the enter step reads and writes, so a test can stand in for the driver.
 *
 * `Driver` satisfies this; the extra fields are the ones `recoverEntryButton`
 * and the post-click wait use, not the 90 s enable poll.
 */
export type EnterStepHost = EnterVrPage & {
  click(x: number, y: number): Promise<void>;
  waitForPanel(what: string, accept: (panel: Record<string, any> | undefined) => boolean, timeoutMs?: number): Promise<Record<string, any> | undefined>;
  newDiagnostics(kind?: string): Promise<DiagnosticRecord[]>;
  latestFps(entries: readonly DiagnosticRecord[]): number | null;
  pageStatus(): Promise<string>;
  wakeDisplay(): Promise<unknown>;
  repair(): Promise<unknown>;
  reload(): Promise<unknown>;
  options: { atomSites?: number };
  currentAtomSites?: number;
  currentTriangles?: number;
  /**
   * Optional, because every earlier test of this step stands in for
   * a page and none of them needed to say which page. A host that can answer
   * both of these gets the return leg for free; one that cannot behaves
   * exactly as it did before.
   */
  stereofoldTarget?: () => Promise<{ url?: string } | undefined>;
  evaluate?: (expression: string, options?: { awaitPromise?: boolean }) => Promise<unknown>;
};

/** One word for the last read: missing, disabled, or enabled. */
export function describeEnterVrState(button: LocatedControl | null): 'missing' | 'disabled' | 'enabled' {
  if (!button) return 'missing';
  return button.disabled ? 'disabled' : 'enabled';
}

/** Read this tab's current session and menu without pressing or redrawing. */
export const OBSERVE_IMMERSIVE_MENU_EXPRESSION = `(() => { const menu = globalThis.__stereofoldMenu;
  let rows = 0, xrStartup = null;
  try { const reading = menu?.rows?.(); rows = Array.isArray(reading) ? reading.length : 0; } catch {}
  try { xrStartup = menu?.xrStartup?.() ?? null; } catch {}
  return { hook: typeof menu?.rows === 'function', rows, xrStartup }; })()`;

type PageXrStartup = { presenting: boolean; sessionVisibility?: string | null; phase?: string | null };

/**
 * The page's startup snapshot outranks panel reports, which can be stale or
 * belong to another tab. Older pages can still prove a live session through
 * menu rows or the panel. Button state cannot disprove that evidence: Done's
 * workspace refresh used to enable Enter VR during a live session.
 */
export function decideAlreadyPresenting({ panelPresenting, spatialRows, pageXrStartup }: {
  button: LocatedControl | null;
  panelPresenting: boolean | null;
  spatialRows: number | null;
  pageXrStartup?: PageXrStartup | null;
}): { already: boolean; source: 'panel' | 'page' | null } {
  if (typeof pageXrStartup?.presenting === 'boolean') {
    return { already: pageXrStartup.presenting, source: pageXrStartup.presenting ? 'page' : null };
  }
  if (typeof spatialRows === 'number' && spatialRows > 0) return { already: true, source: 'page' };
  if (panelPresenting === true) return { already: true, source: 'panel' };
  return { already: false, source: null };
}

/** Older pages and hosts can omit either read; keep the available evidence. */
async function readImmersiveSession(driver: EnterStepHost): Promise<{
  spatialRows: number | null; pageXrStartup: PageXrStartup | null;
}> {
  const unknown = { spatialRows: null, pageXrStartup: null };
  if (typeof driver.evaluate !== 'function') return unknown;
  try {
    const reading = await driver.evaluate(OBSERVE_IMMERSIVE_MENU_EXPRESSION) as
      { hook?: boolean; rows?: number; xrStartup?: PageXrStartup | null } | undefined;
    return {
      spatialRows: reading?.hook === true && typeof reading.rows === 'number' ? reading.rows : null,
      pageXrStartup: typeof reading?.xrStartup?.presenting === 'boolean' ? reading.xrStartup : null,
    };
  } catch { return unknown; }
}

/**
 * Wait until the viewer's Enter VR button is on the page and enabled.
 *
 * Right after the LAN host restarts, the button is in the DOM but disabled
 * while the lesson scene loads. The enter step used to click in that window
 * and fail; a rerun against the same host passed. This is that window: 90 s,
 * polled every 250 ms through `locate` (the same page read the click uses).
 * It logs how long it stood, and if the bound runs out it names the button
 * state rather than saying only that a click failed.
 *
 * A disabled button from tracking loss is not that window. Each disabled poll
 * re-reads the companion panel; if `detectTrackingLoss` says the Quest has
 * lost the room, this fails at once with `TRACKING_LOSS_ADVICE` the way the
 * enter step did before the wait, instead of spending the 90 s bound.
 *
 * Injectable clock and sleep, so the test drives the same loop the run does.
 */
export async function waitForEnabledEnterButton(page: EnterVrPage, {
  timeoutMs = ENTER_VR_ENABLE_WAIT_MS, pollMs = ENTER_VR_ENABLE_POLL_MS,
  wait = page.wait ?? ((ms: number) => settle(ms / 1000)),
  now = page.now ?? Date.now,
  note = page.note ?? progress,
}: {
  timeoutMs?: number; pollMs?: number; wait?: (ms: number) => Promise<void>;
  now?: () => number; note?: (message: string) => void;
} = {}): Promise<{ button: LocatedControl; waitedMs: number; polls: number }> {
  const started = now();
  let last: LocatedControl | null = null;
  for (let polls = 1; ; polls++) {
    last = await page.locate('button', '^Enter VR');
    const waitedMs = Math.max(0, now() - started);
    if (last && !last.disabled) {
      note(`enter: waited ${Math.round(waitedMs)} ms for Enter VR to enable`);
      return { button: last, waitedMs, polls };
    }
    if (last?.disabled) {
      const panel = await page.companionPanel();
      const loss = detectTrackingLoss({ xrStartup: panel?.xrStartup ?? null });
      if (loss.lost) {
        throw new StepFailure(
          `Enter VR is disabled. ${loss.reason} ${TRACKING_LOSS_ADVICE}`,
          { xrStartup: panel?.xrStartup ?? null, trackingLoss: true },
        );
      }
    }
    if (waitedMs >= timeoutMs) {
      const state = describeEnterVrState(last);
      throw new StepFailure(
        `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for Enter VR to enable (button is ${state}).`,
        { button: last, waitedMs, polls, state },
      );
    }
    if (polls === 1) note(`enter: waiting for Enter VR to enable (it is ${describeEnterVrState(last)})`);
    await wait(pollMs);
  }
}

/** Just enough of a page for `waitForPath` and the return leg to read where it is. */
export type PathReadingHost = { stereofoldTarget(): Promise<{ url?: string } | undefined> };

/**
 * What the return leg needs, so a test can be a page sitting on `/detailed`.
 *
 * It is the enter step's host plus the two reads the enter step never needed:
 * which page this tab is on, and what the page says about the re-entry hint.
 */
export type ReturnStepHost = EnterStepHost & PathReadingHost & {
  evaluate(expression: string, options?: { awaitPromise?: boolean }): Promise<unknown>;
};

/** The path this tab is on, or '' where the debugger named no page. */
export async function currentHeadsetPath(host: PathReadingHost): Promise<string> {
  let target: { url?: string } | undefined;
  try { target = await host.stereofoldTarget(); } catch { return ''; }
  try { return new URL(target?.url ?? '').pathname; } catch { return ''; }
}

/** Whether this tab is parked in the full Mol* viewer rather than on the viewer page. */
export function isDetailedViewPath(path: string): boolean { return path.startsWith('/detailed'); }

export const RETURN_BACK_LINK_WAIT_MS = 30_000;
export const RETURN_PATH_WAIT_MS = 60_000;

/**
 * The way back.
 *
 * After `aim:molstar` the wearer's tab is on `/detailed`, which is the stock
 * Mol* viewer and has no Enter VR button on it at all. `--steps enter` read
 * that page, found no button and failed with "The page shows no Enter VR
 * button" — true, and useless: the page it was describing was never going to
 * have one. `open_detailed_view` could not help either, because it answered
 * with an address on the Mac's own loopback. The only route back was the
 * page's own "Back to headset view" link, clicked by hand through the
 * debugger, which is exactly the position the operator was in.
 *
 * So the back leg is a step of its own and a precondition of `enter`, rather
 * than something only the Mol* round trip knows how to do. It refuses to
 * claim anything it did not see: the link has to be there, the tab has to
 * actually land on the viewer, and the viewer has to offer entry again.
 *
 * A tab that is not on `/detailed` is left exactly where it is. The return leg
 * is a way out of one specific room, not a navigation of its own.
 */
export async function returnFromDetailedView(host: ReturnStepHost, {
  backWaitMs = RETURN_BACK_LINK_WAIT_MS, pathWaitMs = RETURN_PATH_WAIT_MS,
  note = progress,
}: { backWaitMs?: number; pathWaitMs?: number; note?: (message: string) => void } = {}):
Promise<{ left: boolean; from: string; to?: string; reentryHint?: string; entry?: LocatedControl }> {
  const from = await currentHeadsetPath(host);
  if (!isDetailedViewPath(from)) return { left: false, from };
  note(`return: the headset tab is on ${from}; taking the page's own way back to the viewer`);
  // The session ended when the handoff happened, so the display is asleep
  // within seconds and a sleeping display draws nothing to click.
  await host.wakeDisplay();
  // The link is unhidden by the page's bootstrap once the page key is in
  // storage, a beat after the URL changes.
  let back: LocatedControl | null = null;
  const deadline = Date.now() + backWaitMs;
  for (;;) {
    back = await host.locate('a', 'Back to headset view');
    if (back || Date.now() >= deadline) break;
    await settle(1);
  }
  if (!back) {
    throw new StepFailure('The detailed view shows no "Back to headset view" link, so there is no way back into VR from this page. '
      + 'Call recall_headset from the Mac, which leaves the same navigation for the page to take, and follow detailedRecallReceipt to "returned".',
      { detailedPath: from, pageSaid: (await host.pageStatus()).slice(0, 200) });
  }
  await host.click(back.x, back.y);
  // The LAN share lands the headset on /viewer; /companion is the older route.
  const to = await waitForPath(host, ['/viewer', '/companion'], pathWaitMs);
  // With nobody wearing it the display is asleep again by now, and a viewer
  // boot that finds no frames wedges on "did not produce a frame".
  await host.wakeDisplay();
  const entry = await recoverEntryButton(host);
  if (!entry) {
    throw new StepFailure('Back landed on the viewer but it never showed Enter VR again, so the wearer would be stuck on a flat page.',
      { from, to, pageSaid: (await host.pageStatus()).slice(0, 200) });
  }
  // Read the hint rather than assuming it armed; it expires.
  let reentryHint: string | undefined;
  try { reentryHint = String(await host.evaluate('(() => document.body.dataset.reenterXr || "none")()')); }
  catch { reentryHint = undefined; }
  note(`return: back on ${to} with Enter VR offered again (re-entry hint ${reentryHint ?? 'unreadable'})`);
  return { left: true, from, to, entry, ...(reentryHint === undefined ? {} : { reentryHint }) };
}

/**
 * The whole way home: off the Mol* page, then into VR.
 *
 * `stepEnter` does the second half, so entry is proved by exactly the same
 * reads on this route as on every other one — a presenting panel and a
 * commandable panel, never a click that landed.
 */
export async function stepReturn(driver: ReturnStepHost): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  const back = await returnFromDetailedView(driver);
  const entered = await stepEnter(driver);
  return {
    detail: back.left
      ? `Left the full Mol* viewer through its Back control and landed on ${back.to}. ${entered.detail}`
      : `The headset tab was already on ${back.from || 'no page the debugger could name'}, so there was nothing to come back from. ${entered.detail}`,
    evidence: { returnLeg: { left: back.left, from: back.from, ...(back.to ? { to: back.to } : {}),
      ...(back.reentryHint ? { reentryHint: back.reentryHint } : {}) }, ...entered.evidence },
  };
}

/**
 * The return leg, run only where the host can say which page it is on and only
 * where that page is the Mol* viewer. Everything else is a no-op.
 */
async function enterAfterLeavingDetailedView(driver: EnterStepHost):
Promise<{ left: boolean; from: string; to?: string; reentryHint?: string } | undefined> {
  if (typeof driver.stereofoldTarget !== 'function' || typeof driver.evaluate !== 'function') return undefined;
  const host = driver as ReturnStepHost;
  const leg = await returnFromDetailedView(host);
  if (!leg.left) return undefined;
  return { left: true, from: leg.from, ...(leg.to ? { to: leg.to } : {}), ...(leg.reentryHint ? { reentryHint: leg.reentryHint } : {}) };
}

export async function stepEnter(driver: EnterStepHost): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  // `--steps enter` against a tab parked on
  // `/detailed` used to fail "The page shows no Enter VR button." The stock
  // Mol* viewer has no such button and never will, so the honest answer is not
  // a better message — it is to take the page's own way back first and then
  // enter, which is what an operator had to do by hand.
  const detour = await enterAfterLeavingDetailedView(driver);
  const before = await driver.companionPanel();
  const { spatialRows, pageXrStartup } = await readImmersiveSession(driver);
  let button = await driver.locate('button', '^Enter VR');
  const presenting = decideAlreadyPresenting({ button,
    panelPresenting: typeof before?.xrStartup?.presenting === 'boolean' ? before.xrStartup.presenting : null,
    spatialRows, pageXrStartup });
  if (presenting.already) {
    const startup = pageXrStartup ? { ...before?.xrStartup, ...pageXrStartup,
      sessionVisibility: pageXrStartup.sessionVisibility ?? before?.xrStartup?.sessionVisibility } : before?.xrStartup;
    if (detectHiddenSession(startup)) throw new StepFailure(HIDDEN_SESSION_ADVICE, { xrStartup: startup ?? null, hiddenSession: true });
    // A session that was already up may still be mid-load; the next step sends
    // a command either way, so the same wait applies.
    const ready = await waitForCommandablePanel(driver);
    const said = presenting.source === 'page'
      ? pageXrStartup?.presenting ? 'the page reports a live immersive session'
        : `the page's immersive menu is running (${spatialRows} rows)`
      : 'the companion panel reports an immersive session';
    return { detail: `Already presenting; entry not re-sent because ${said}. ${ready.detail}`,
      evidence: { method: 'already-presenting', verified: true, presentingSource: presenting.source,
        ...(spatialRows === null ? {} : { spatialRows }),
        ...(pageXrStartup ? { pageXrStartup } : {}),
        buttonState: describeEnterVrState(button),
        ...(button && !button.disabled ? { pageDefect: 'Enter VR is enabled while an immersive session is presenting.' } : {}),
        xrStartup: before?.xrStartup ?? null, panelReady: ready.evidence, ...(detour ? { returnLeg: detour } : {}) } };
  }
  if (!button) button = await recoverEntryButton(driver);
  if (!button) {
    throw new StepFailure('The page shows no Enter VR button.',
      { xrStartup: before?.xrStartup ?? null, ...(detour ? { returnLeg: detour } : {}) });
  }
  // The first locate can catch the button while the lesson is still loading
  // after a host restart; wait for enable before the click, then click that
  // reading so a disabled press is not sent.
  const armed = await waitForEnabledEnterButton(driver);
  button = armed.button;
  await driver.click(button.x, button.y);
  try {
    const panel = await waitForPresentingPanel(driver, 'the immersive session to start');
    let startup = panel?.xrStartup ?? {};
    if (detectHiddenSession(startup)) {
      // A boundary prompt can be transient; give the runtime a few seconds
      // before declaring the run needs a person.
      const shown = await driver.waitForPanel('the session to become visible',
        candidate => candidate?.xrStartup?.presenting === true && candidate.xrStartup.sessionVisibility !== 'hidden', 8_000).catch(() => null);
      if (!shown) throw new StepFailure(HIDDEN_SESSION_ADVICE, { xrStartup: startup, hiddenSession: true });
      startup = shown.xrStartup ?? startup;
    }
    const ready = await waitForCommandablePanel(driver);
    return {
      detail: (detour ? `Came back from ${detour.from} to ${detour.to} through the page's Back control, then entered. ` : '')
        + `Presenting ${startup.mode ?? 'an XR session'}${startup.blendMode ? ` with ${startup.blendMode}` : ''}, `
        + `trusted click ${String(startup.trustedClick)}. ${ready.detail}`,
      evidence: { xrStartup: startup, clickedAt: `${button.x},${button.y}`, panelReady: ready.evidence,
        ...(detour ? { returnLeg: detour } : {}) },
    };
  } catch (error) {
    if (isGateFailure(error)) throw error;
    const panel = await driver.companionPanel();
    const loss = detectTrackingLoss({ xrStartup: panel?.xrStartup ?? null, framesPerSecond: driver.latestFps(await driver.newDiagnostics()) });
    if (loss.lost) throw new StepFailure(`${loss.reason} ${TRACKING_LOSS_ADVICE}`, { xrStartup: panel?.xrStartup ?? null, trackingLoss: true });
    throw error;
  }
}

/**
 * A `scene … shown` record off the tour player's ring, or nothing.
 *
 * Shape measured off a live ring: kind `tour`, detail
 * `{action: 'scene', step, total, active, autoplay, xr, outcome: 'shown',
 * title, dwellMs}`. `outcome` is checked because a scene the player could not
 * show is not a chapter the wearer saw; a record without one is taken at face
 * value so an older page still reads.
 */
export function tourSceneShown(entry: DiagnosticRecord): { step: number; dwellMs?: number; title?: string; total?: number } | undefined {
  if (entry.kind !== 'tour') return undefined;
  const detail = (entry.detail ?? {}) as Record<string, unknown>;
  if (detail.action !== 'scene') return undefined;
  if (detail.outcome !== undefined && detail.outcome !== 'shown') return undefined;
  const step = Number(detail.step);
  if (!Number.isInteger(step) || step < 0) return undefined;
  const number = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : undefined);
  return { step, dwellMs: number(detail.dwellMs), total: number(detail.total), title: typeof detail.title === 'string' ? detail.title : undefined };
}

/** Whether the lesson is running itself: the panel says so, and every scene record repeats it. */
export function tourIsAutoplaying(tour: Record<string, any> | undefined): boolean {
  return tour?.autoplay === true;
}

/** The dwell a chapter is given when the player reported none. Longest measured on hardware was 12 s. */
export const TOUR_DEFAULT_DWELL_MS = 12_000;
/**
 * How long past a chapter's own dwell the watcher waits before it nudges.
 *
 * The dwell is the player's timer, not a deadline: narration, a scene rebuild
 * and one 1 Hz heartbeat all land inside the gap between two chapters. Eight
 * seconds is longer than all three together on a Quest 2 and still well short
 * of a wearer noticing a lesson has stopped.
 */
export const TOUR_STALL_MARGIN_MS = 8_000;
/**
 * How long the watcher keeps reading after the last chapter is on screen.
 *
 * The player writes the scene record and then narrates it: the narration
 * arrives several ring entries later. Stopping on the last scene
 * counts one line short and, worse, misses a refused line on the final chapter
 * — the one a wearer remembers. Ends early as soon as that line is filed.
 */
export const TOUR_TAIL_MS = 6_000;
/** How long the lesson is given to say it is running itself before the manual plan is used. */
export const TOUR_AUTOPLAY_CONFIRM_MS = 5_000;

export type TourWatchHost = CommandHost & {
  newDiagnostics(kind?: string): Promise<DiagnosticRecord[]>;
  capture(name: string): Promise<{ path: string; via: string; note?: string }>;
};

export type TourWatch = {
  chapters: Array<Record<string, unknown>>;
  narrations: Array<Record<string, unknown>>;
  failures: string[];
  nudges: Array<Record<string, unknown>>;
};

/**
 * Walk an autoplaying lesson by watching it, not by pushing it.
 *
 * A lesson started by an agent runs itself: each chapter narrates, dwells, and
 * advances. The driver's old plan — `start`, then one `next` per remaining
 * chapter — raced the player. On real hardware the very first `next` was
 * refused with "No panel is ready for a command right now (companion
 * unsaved)", because the page was busy saving the scene the lesson had just
 * advanced to on its own.
 *
 * The ring is the cure: `read_headset_log` needs no panel (it is not in
 * `TOOLS_NEEDING_PANEL`), so it can be read while the panel is unsaved — the
 * exact window in which a command cannot be sent. The loop is:
 *
 *  1. read new diagnostics; every `scene … shown` for a step not seen before is
 *     a chapter: capture `tour-0N.png` then and there, and record its dwell,
 *     its title and how long it waited;
 *  2. file narration and speech failures against the step the record names;
 *  3. if nothing has been shown for the current chapter's `dwellMs` plus
 *     `stallMargin`, the lesson has stalled — send exactly one `next`, which
 *     waits for the panel to be commandable first and treats "unsaved" as a
 *     retry, and restart the clock;
 *  4. stop at `total` chapters; a stall that survives `maxNudges` nudges fails
 *     the step and says which chapter it died on.
 *
 * No command is sent at all while the lesson keeps its own time.
 */
export async function watchAutoplayedTour(host: TourWatchHost, { total, wait = settle, note = progress, now = Date.now,
  stallMarginMs = TOUR_STALL_MARGIN_MS, defaultDwellMs = TOUR_DEFAULT_DWELL_MS, waitAvailableMs = TOUR_PANEL_WAIT_MS,
  maxNudges = Math.max(2, total), tailMs = TOUR_TAIL_MS, capture = true }: {
    total: number; wait?: (seconds: number) => Promise<void>; note?: (message: string) => void; now?: () => number;
    stallMarginMs?: number; defaultDwellMs?: number; waitAvailableMs?: number; maxNudges?: number; tailMs?: number;
    capture?: boolean;
  }): Promise<TourWatch> {
  const chapters: Array<Record<string, unknown>> = [];
  const narrations: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  const nudges: Array<Record<string, unknown>> = [];
  const seen = new Set<number>();
  let since = now();
  let dwellMs = defaultDwellMs;
  let nudged = false;
  // The tour player records everything under kind `tour` with an `action`; a
  // spoken line is `action: 'narration'` (measured: six chapters narrated, and
  // a filter on kind `narration` counted none of them).
  const fileSpoken = (entry: DiagnosticRecord) => {
    const step = Number((entry.detail as { step?: unknown } | undefined)?.step);
    narrations.push({ chapter: Number.isInteger(step) ? step + 1 : chapters.length, ...entry.detail });
  };
  while (chapters.length < total) {
    const entries = await host.newDiagnostics();
    for (const entry of entries) {
      if (isNarrationRecord(entry)) { fileSpoken(entry); continue; }
      // Past the last chapter the rest of this batch is still read, because the
      // final chapter's spoken line can arrive in it.
      if (chapters.length >= total) continue;
      const scene = tourSceneShown(entry);
      if (!scene || seen.has(scene.step)) continue;
      seen.add(scene.step);
      // Photographed here rather than after the loop: this is the only moment
      // the chapter is certainly the one on the wearer's plate.
      const shot = capture ? await host.capture(`tour-${String(scene.step + 1).padStart(2, '0')}`) : undefined;
      chapters.push({
        chapter: scene.step + 1, step: scene.step, title: scene.title ?? null,
        dwellMs: scene.dwellMs ?? defaultDwellMs, waitedMs: now() - since, nudged, shownAt: entry.at ?? null,
        ...(shot ? { capture: shot.path, via: shot.via } : {}),
      });
      since = now();
      dwellMs = scene.dwellMs ?? defaultDwellMs;
      nudged = false;
    }
    for (const entry of speechFailures(entries)) failures.push(`chapter ${chapters.length || 1}: ${describeSpeechFailure(entry)}`);
    if (chapters.length >= total) break;
    if (now() - since >= dwellMs + stallMarginMs) {
      const waited = Math.round((now() - since) / 1_000);
      if (nudges.length >= maxNudges) {
        throw new StepFailure(`The lesson stopped after ${chapters.length} of ${total} chapters: nothing was shown for ${waited} s`
          + ` and ${nudges.length} next command${nudges.length === 1 ? '' : 's'} did not move it.`,
          { chapters, narrations, nudges });
      }
      note(`tour: chapter ${chapters.length} has sat for ${waited} s (dwell ${Math.round(dwellMs / 1_000)} s); sending one next`);
      const sent = await sendTourCommand(host, 'next', {}, { label: `tour-next-${nudges.length + 1}`, wait, note, now, waitAvailableMs });
      nudges.push({ afterChapter: chapters.length, waitedSeconds: waited, commandId: sent.commandId, receipt: sent.receipt.status });
      since = now();
      nudged = true;
    }
    await wait(1);
  }
  // The last chapter's spoken line is written after its scene record, so the
  // ring is read a little past the end rather than closed on the last scene.
  const tailUntil = now() + tailMs;
  while (now() < tailUntil && !narrations.some(line => Number(line.chapter) === chapters.length)) {
    await wait(1);
    const entries = await host.newDiagnostics();
    for (const entry of entries.filter(isNarrationRecord)) fileSpoken(entry);
    for (const entry of speechFailures(entries)) failures.push(`chapter ${chapters.length}: ${describeSpeechFailure(entry)}`);
  }
  return { chapters, narrations, failures, nudges };
}

async function stepTour(driver: Driver): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  const panel = await driver.companionPanel();
  const total = Number(panel?.tour?.total ?? 0);
  const plan = tourPlan(total);
  if (!plan.length) throw new StepFailure('The panel reports no tour chapters, so there is nothing to walk.', { tour: panel?.tour ?? null });

  // Everything from here is measured from the start of the lesson, so the ring
  // is drained first: leftovers from an earlier step would be filed as this
  // lesson's narration.
  await driver.newDiagnostics();
  await sendTourCommand(driver, 'start', { tourId: String(panel?.tour?.selectedId ?? '') },
    { label: 'tour-start', wait: settle, waitAvailableMs: TOUR_PANEL_WAIT_MS });
  let started = await driver.waitForPanel(`tour chapter 1 of ${total}`,
    candidate => candidate?.tour?.active === true && Number(candidate.tour.step) >= 0, 60_000);
  // The player arms autoplay on its own beat, which can be a heartbeat after it
  // reports the lesson active. Reading the flag once, in that gap, would put
  // the driver back on the plan that races an autoplaying lesson, so the flag
  // is given a few seconds to appear before the manual path is taken.
  if (!tourIsAutoplaying(started?.tour)) {
    started = await driver.waitForPanel('the lesson to say whether it runs itself',
      candidate => tourIsAutoplaying(candidate?.tour), TOUR_AUTOPLAY_CONFIRM_MS).catch(() => started);
  }

  if (tourIsAutoplaying(started?.tour)) {
    const watch = await watchAutoplayedTour(driver, { total });
    if (watch.failures.length) throw new StepFailure(speechVerdict(watch.failures),
      { total, autoplay: true, chapters: watch.chapters, narrations: watch.narrations, nudges: watch.nudges });
    const nudged = watch.nudges.length ? ` ${watch.nudges.length} stall${watch.nudges.length === 1 ? '' : 's'} nudged.` : '';
    return {
      detail: `Watched ${watch.chapters.length} autoplayed chapter${watch.chapters.length === 1 ? '' : 's'}; `
        + `${watch.narrations.length} narrated line${watch.narrations.length === 1 ? '' : 's'}, none refused.${nudged}`,
      evidence: { total, autoplay: true, chapters: watch.chapters, narrations: watch.narrations, nudges: watch.nudges },
    };
  }

  // autoplay: false — a lesson that waits to be driven, which is what a paused
  // lesson does. The sends outlive a saving panel.
  const chapters: Array<Record<string, unknown>> = [];
  const narrations: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  for (const [index] of plan.entries()) {
    if (index > 0) {
      await sendTourCommand(driver, 'next', {}, { label: `tour-next-${index}`, waitAvailableMs: TOUR_PANEL_WAIT_MS });
    }
    const landed = await driver.waitForPanel(`tour chapter ${index + 1} of ${total}`,
      candidate => candidate?.tour?.active === true && candidate.tour.navigating === false && Number(candidate.tour.step) === index, 60_000);
    await settle(driver.options.settleSeconds);
    const entries = await driver.newDiagnostics();
    for (const entry of entries.filter(isNarrationRecord)) narrations.push({ chapter: index, ...entry.detail });
    for (const entry of speechFailures(entries)) failures.push(`chapter ${index + 1}: ${describeSpeechFailure(entry)}`);
    const shot = await driver.capture(`tour-${String(index + 1).padStart(2, '0')}`);
    chapters.push({ chapter: index + 1, step: landed?.tour?.step, capture: shot.path, via: shot.via });
  }
  if (failures.length) throw new StepFailure(speechVerdict(failures), { chapters, narrations, speechFailures: failures });
  return {
    detail: `Walked ${plan.length} chapter${plan.length === 1 ? '' : 's'}; ${narrations.length} narrated line${narrations.length === 1 ? '' : 's'}, none refused.`,
    evidence: { total, autoplay: false, chapters, narrations },
  };
}

/**
 * The scene drew and the caption stands, so the page calls a refused line
 * degraded rather than failed. An unattended pass exists to catch exactly that:
 * a lesson nobody can hear is not a lesson that passed.
 */
function speechVerdict(failures: readonly string[]): string {
  return `${failures.length} spoken line${failures.length === 1 ? '' : 's'} did not reach the wearer -- ${failures[0]}`;
}

/** Send the step's agent commands and wait for each receipt to render. */
async function stepCommandsWithReceipts(driver: Driver, step: DriveStep): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  const receipts: Array<Record<string, unknown>> = [];
  const attempts = inFlightAttempts(driver.options.atomSites);
  for (const command of stepCommands(step)) {
    for (let attempt = 1; ; attempt++) {
      const answer = await driver.agent(command.tool, command.arguments);
      const structured = (answer.structuredContent ?? {}) as { command?: { commandId?: string; status?: string } };
      const commandId = structured.command?.commandId;
      if (!commandId) throw new StepFailure(`${command.tool} returned no command id.`, { said: agentText(answer).slice(0, 160) });
      const receipt = await waitForReceipt(driver, commandId);
      // On the wall tier, `stop` after `spin` on 40,908 sites comes back as a
      // REJECTED receipt, "A molecular change is still rendering" -- the host's
      // verdict, not a thrown refusal. Still "not yet".
      if (receipt.status === 'rejected' && isCommandInFlight(String(receipt.detail ?? '')) && attempt < attempts) {
        progress(`${step}: the headset is still rendering the previous change; sending ${command.tool} again (${attempt}/${attempts})`);
        await settle(2);
        continue;
      }
      receipts.push({ tool: command.tool, change: command.arguments.change, attempt, ...receipt });
      if (receipt.status !== 'rendered') {
        throw new StepFailure(`${command.tool} was ${receipt.status}${receipt.detail ? `: ${receipt.detail}` : ''}.`, { receipts });
      }
      break;
    }
    await settle(driver.options.settleSeconds);
  }
  const applied = receipts.map(receipt => String((receipt as { status?: string }).status)).join(', ');
  return { detail: `${receipts.length} command${receipts.length === 1 ? '' : 's'} ${applied}.`, evidence: { receipts } };
}

/**
 * Receipt statuses that mean "not yet": the command is accepted and still being
 * applied. One definition, in `agent-arguments.ts`, so this driver and the
 * agent CLI cannot drift into disagreeing about what "applied" means.
 */
export { RECEIPT_PENDING } from './agent-arguments.js';

/** Everything `waitForReceipt` and `sendTourCommand` need, so a test can be the host. */
export type CommandHost = {
  agent(name: string, args?: Record<string, unknown>): Promise<AgentResult>;
  inspectionState(): Promise<Record<string, any>>;
};

async function waitForReceipt(driver: CommandHost, commandId: string, timeoutMs = 60_000,
  wait: (seconds: number) => Promise<void> = settle): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await driver.inspectionState();
    const receipt = ((state.commands ?? []) as Record<string, any>[]).find(entry => entry.commandId === commandId);
    // `rendering` is the page mid-rebuild, not an answer: a best-quality
    // surface takes several seconds on a Quest 2 and the earlier read
    // reported "update_inspection was rendering" as a failure.
    if (receipt && !isReceiptPending(String(receipt.status))) return receipt;
    if (Date.now() >= deadline) return receipt ?? { commandId, status: 'never-received' };
    await wait(1);
  }
}

/**
 * Send one tour command, and do not come back until the host has finished with it.
 *
 * Measured: the `ask` step sent `pause` and then, because the lesson sat on its
 * last chapter, `back` in the same breath. The headset rendered the pause's
 * receipt one heartbeat after the `back` went out, and the host refused the
 * second command with "An inspection command is already in progress", which
 * ended the run. A driver has no wearer to retry for it, so every command here
 * waits for its own receipt, and a refusal that says another command is in
 * flight is a "not yet" rather than a failure.
 *
 * With `waitAvailableMs` set, every attempt first waits until
 * `get_inspection_state` shows the companion panel commandable. An autoplaying
 * lesson keeps its panel saving at every chapter transition, and a run died on
 * exactly that — "No panel is ready for a command right now (companion
 * unsaved)" — while the ring showed the tour advancing by itself. That
 * sentence already reads as "not yet" to
 * `isCommandInFlight` (PANEL_BETWEEN_BEATS), so it was always a retry here;
 * the wait makes the bound a span of time rather than a count of attempts.
 * Without the option this is byte-for-byte the old send, so `park`, `resume`
 * and `ask` are unchanged.
 */
export async function sendTourCommand(host: CommandHost, action: string, extra: Record<string, unknown> = {},
  { label = action, attempts = IN_FLIGHT_ATTEMPTS, wait = settle, note = progress, waitAvailableMs, now = Date.now }: {
    label?: string; attempts?: number; wait?: (seconds: number) => Promise<void>; note?: (message: string) => void;
    waitAvailableMs?: number; now?: () => number;
  } = {}): Promise<{ commandId: string; receipt: Record<string, any> }> {
  for (let attempt = 1; ; attempt++) {
    if (typeof waitAvailableMs === 'number' && waitAvailableMs > 0) {
      const seen = await waitForAvailablePanel(host, { timeoutMs: waitAvailableMs, wait, note, now, what: `the headset panel before ${action}` });
      if (!seen.available) {
        note(`${label}: the panel was still ${seen.panel?.availability ?? 'absent'} after ${(seen.waitedMs / 1000).toFixed(0)} s; sending ${action} anyway`);
      }
    }
    const commandId = `${label}-${attempt}-${Date.now().toString(36)}`;
    let answer: AgentResult | undefined;
    let refusal: unknown;
    try { answer = await host.agent('control_tour', { action, ...extra, commandId }); }
    catch (error) {
      if (isGateFailure(error)) throw error;
      refusal = error;
    }
    // A tool that answers rather than throws still says the same sentence.
    if (!refusal && answer && isCommandInFlight(agentText(answer))) refusal = Error(agentText(answer));
    if (refusal) {
      if (!isCommandInFlight(refusal) || attempt >= attempts) {
        throw new StepFailure(`The host refused ${action}: ${refusal instanceof Error ? refusal.message : String(refusal)}`, { action, attempt });
      }
      note(`${label}: the host is still finishing the command before this one; waiting to send ${action} again`);
      await wait(2);
      continue;
    }
    const structured = (answer!.structuredContent ?? {}) as { command?: { commandId?: string } };
    const id = structured.command?.commandId ?? commandId;
    return { commandId: id, receipt: await waitForReceipt(host, id, 60_000, wait) };
  }
}

// ----------------------------------------------------------- growing it

/**
 * How long one tier is given to appear, before its size is taken into account.
 *
 * A grow is not a command with a receipt. `grow_structure` replaces the
 * coordinates and the lesson on the Mac and returns; the headset finds out on
 * its own 1 Hz beat, hydrates, and rebuilds the structure inside the session it
 * is already presenting. So what is waited on is the panel reporting the new
 * lesson, and the wait has to cover a Quest 2 rebuilding cartoon geometry with
 * a wearer inside the old one.
 */
export const GROW_BASE_WAIT_MS = 30_000;
/**
 * How long a growth sentence owns the caption plate.
 *
 * Kept in lockstep with `growth-caption.mjs` `GROWTH_CAPTION_MS`. The
 * companion poll that delivers a host-initiated refusal runs at 1 Hz
 * (`inspector.ts`); capture has to land after that beat paints the overlay
 * and before the overlay expires (half-open at this duration).
 */
export const GROWTH_CAPTION_MS = 4_000;
/** Companion `poll_inspection` interval, the only way a host-initiated refusal reaches the page. */
export const COMPANION_POLL_MS = 1_000;
/** The part that scales with the tier. The wall tier is the slow one. */
export const GROW_MS_PER_THOUSAND_SITES = 2_000;
/**
 * The cap.
 *
 * Past three minutes the session is not slow, it is gone, and a driver that
 * keeps waiting reports a hang instead of the thing that actually happened.
 */
export const GROW_MAX_WAIT_MS = 180_000;
/** A staged demo has six tiers; this only has to stop a loop that never refuses. */
export const MAX_GROW_TIERS = 8;

/** 30 s, plus 2 s for every 1,000 atom sites the target tier carries, capped at 180 s. */
export function growWaitMs(atomSites: number): number {
  const sites = Number.isFinite(atomSites) && atomSites > 0 ? atomSites : 0;
  return Math.min(GROW_MAX_WAIT_MS, GROW_BASE_WAIT_MS + Math.ceil(sites / 1000) * GROW_MS_PER_THOUSAND_SITES);
}

/**
 * What a density tier's grow costs, from the hardware clock.
 *
 * Measured on a Quest 2 over a LAN: the `filament` map — EMD-6347 downsampled
 * four times, 8,389,632 bytes — crossed
 * the wire and parsed inside ONE `grow` phase of 1,131 ms, and the isosurface
 * Mol* built from it measured 178,236 triangles inside the 229 ms `built`
 * phase that followed it.
 *
 *   wire   1,131 ms / 8.39 MB  = 135 ms per megabyte
 *   mesh     229 ms / 178,236  =  13 ms per ten thousand triangles
 *
 * The slopes below are 400 ms per megabyte — three times the measured wire —
 * and 300 ms per ten thousand triangles, which is far more than three times
 * the measured mesh on purpose: that mesh was built on Mol*'s GPU isosurface
 * path, and a device that fails one of its three WebGL checks drops to CPU
 * marching cubes, a path nobody has timed on this headset.
 *
 * What this replaces was 8,000 ms per megabyte — roughly 1 MB/s, a guess at
 * Wi-Fi throughput and never a measurement. It made the filament's deadline
 * 138 s, about sixty times the transfer, so a swap that died in its first
 * second still held the driver for over two minutes before it could say so.
 */
export const GROW_MS_PER_MEGABYTE = 400;
/** The mesh build, at twenty times the measured GPU-path build (see above). */
export const GROW_MS_PER_TEN_THOUSAND_TRIANGLES = 300;
/**
 * A megabyte, as the map is counted and as this driver prints it.
 *
 * The map is 8,389,632 bytes, which EMDB and this driver's own step line both
 * call 8.4 MB. Dividing by 1,048,576 prints the same map as
 * "8.0 MB", which reads as a different file.
 */
export const BYTES_PER_MEGABYTE = 1_000_000;
/**
 * The floor under a density wait, and the part that is not the map.
 *
 * A grow is not a command with a receipt (see `GROW_BASE_WAIT_MS`): the page
 * finds out on its own 1 Hz beat, and the hydration around the transfer —
 * fetch, catalog, save, re-attach — is the part that has nothing to do with
 * how many bytes the map is. 15 s covers every one of those beats with room.
 */
export const GROW_DENSITY_BASE_WAIT_MS = 15_000;
/**
 * The cap on a density wait.
 *
 * The atomic cap is three minutes because a Quest 2 really can spend that long
 * parsing coordinates. Nothing measured on this route takes anywhere near 90 s:
 * past it the map is not slow, the swap is lost, and a driver that keeps
 * waiting reports a hang instead of the failure that actually happened.
 */
export const GROW_DENSITY_MAX_WAIT_MS = 90_000;

/**
 * The triangle count the `filament` tier is expected to draw.
 *
 * `plugin/demos/index.json` records it (`coordinates.volume.triangles`) and
 * `plugin/test/headset-drive.test.ts` asserts the two are equal, so this
 * constant cannot drift from the asset. It is the count a HEADSET draws —
 * Mol*'s GPU isosurface path quantizes the grid to uint8 before extracting the
 * surface — and not the 177,604 the same map meshes to over the float32 field
 * in Node. The page measured exactly this on hardware.
 */
export const DENSITY_EXPECTED_TRIANGLES = 178_236;
/**
 * How far a measured mesh may sit from the expected one and still be it.
 *
 * The two counts that have ever been seen for this map differ by 632 triangles
 * (0.35%), which is the GPU path against the CPU one. 2% admits that and
 * nothing else: a different contour, a different downsample or a different map
 * moves the count by whole percentage points.
 */
export const DENSITY_TRIANGLE_TOLERANCE = 0.02;

/**
 * The size of the tier being grown into, in the unit that tier is counted in.
 *
 * `grow.size` is what the host has answered with since the density tier landed.
 * `grow.atomSites` is the older field and stays the fallback, so this driver
 * still works against a host that predates it.
 */
export function growSize(grow: GrowAnswer): { count: number; unit: string } {
  const size = grow.size;
  if (size && typeof size.count === 'number' && Number.isFinite(size.count) && typeof size.unit === 'string') {
    return { count: Math.max(0, size.count), unit: size.unit };
  }
  const sites = Number(grow.atomSites ?? 0);
  return { count: Number.isFinite(sites) && sites > 0 ? sites : 0, unit: 'atom sites' };
}

/**
 * How long a map of this size is given to arrive, parse and mesh.
 *
 * The floor, plus a megabyte slope, plus a triangle slope, under the density
 * cap. Both slopes round up a whole unit, because a deadline that promises the
 * exact measured megabyte is a deadline with no margin in it at all. For the
 * filament that is 15 + 3.6 + 5.4 = 24 s against a measured 1.4 s — about
 * seventeen times the hardware, and a fifth of what this wait used to be.
 */
export function densityWaitMs(bytes: number, triangles: number): number {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const mesh = Number.isFinite(triangles) && triangles > 0 ? triangles : 0;
  const transferMs = Math.ceil(size / BYTES_PER_MEGABYTE) * GROW_MS_PER_MEGABYTE;
  const meshMs = Math.ceil(mesh / 10_000) * GROW_MS_PER_TEN_THOUSAND_TRIANGLES;
  return Math.min(GROW_DENSITY_MAX_WAIT_MS, GROW_DENSITY_BASE_WAIT_MS + transferMs + meshMs);
}

/** The one line a person reads about a density wait: "24 s for 8.4 MB + 178k triangles". */
export function describeDensityWait(bytes: number, triangles: number): string {
  const seconds = Math.round(densityWaitMs(bytes, triangles) / 1_000);
  const megabytes = (Math.max(0, Number.isFinite(bytes) ? bytes : 0) / BYTES_PER_MEGABYTE).toFixed(1);
  const mesh = Number.isFinite(triangles) && triangles > 0
    ? ` + ${Math.round(triangles / 1_000).toLocaleString()}k triangles` : '';
  return `${seconds} s for ${megabytes} MB${mesh}`;
}

/**
 * How long one tier gets, sized in the unit that tier is actually measured in.
 *
 * An atomic tier is exactly `growWaitMs` and nothing has changed for it. A
 * density tier has ZERO atom sites, so `growWaitMs` would have handed the
 * largest transfer this product has ever attempted the 30 s floor — the
 * `filament` tier would have timed out on every driven grow. It gets the
 * density wait above instead, which is now sized from the hardware clock
 * rather than from a guess about Wi-Fi: 24 s for the filament, where the same
 * formula used to say 138 s.
 */
export function growTierWaitMs(grow: GrowAnswer): number {
  const density = grow.density;
  const bytes = typeof density?.bytes === 'number' && Number.isFinite(density.bytes) && density.bytes > 0 ? density.bytes : 0;
  if (!bytes) return growWaitMs(Number(grow.atomSites ?? 0));
  const { count, unit } = growSize(grow);
  return densityWaitMs(bytes, unit === 'triangles' ? count : 0);
}

/**
 * How long to wait after a host refusal before photographing the plate.
 *
 * Without a wait, `grow-refused.png` was captured in the same tick as the host
 * answer, before any heartbeat, so the plate never showed the line. The page
 * learns of a Mac-initiated refusal on its 1 Hz poll, then owns the plate for
 * `GROWTH_CAPTION_MS` of XR frames. Waiting the full overlay duration would
 * photograph the chapter caption the overlay just returned to (half-open
 * expiry). One heartbeat plus a paint frame lands inside the window.
 */
export function growRefusalCaptureWaitMs({
  overlayMs = GROWTH_CAPTION_MS,
  heartbeatMs = COMPANION_POLL_MS,
  paintMs = 500,
}: { overlayMs?: number; heartbeatMs?: number; paintMs?: number } = {}): number {
  const overlay = Number.isFinite(overlayMs) && overlayMs > 0 ? overlayMs : GROWTH_CAPTION_MS;
  const beat = Number.isFinite(heartbeatMs) && heartbeatMs >= 0 ? heartbeatMs : COMPANION_POLL_MS;
  const paint = Number.isFinite(paintMs) && paintMs >= 0 ? paintMs : 0;
  const start = beat + paint;
  // Half-open at overlayMs: waiting the full duration photographs the
  // chapter caption. Leave at least one millisecond of overlay.
  const latest = Math.max(0, overlay - 1);
  return Math.min(start, latest);
}

/**
 * The phases of one swap, as the headset itself reported them.
 *
 * The formula above is a guess about a device; these are measurements from the
 * page. `inspector.ts` records one `grow` entry per phase — `requested`,
 * `source-fetched`, `parsed`, `built`, `placed`, `saved`, `attached` — and this
 * is how the driver turns them into the line a person reads. Without them a
 * 44 s timeout could only say "the dimer tier did not rebuild"; with them it
 * can say which phase it was still inside when the clock ran out.
 *
 * `lessonId` filters to the swap being waited on, because a pass that grows
 * several tiers records them all against the same kind.
 */
export function growPhaseRecords(entries: readonly DiagnosticRecord[], lessonId?: string): SwapPhaseRecord[] {
  const kept: SwapPhaseRecord[] = [];
  for (const entry of entries) {
    if (entry.kind !== SWAP_TRACE_KIND) continue;
    const detail = entry.detail ?? {};
    if (typeof detail.phase !== 'string') continue;
    if (lessonId && typeof detail.lessonId === 'string' && detail.lessonId !== lessonId) continue;
    kept.push(detail as unknown as SwapPhaseRecord);
  }
  return kept;
}

/** Whether the page has reported this swap all the way to a re-attached panel. */
export function growLanded(records: readonly SwapPhaseRecord[]): boolean {
  return records.some(record => record.phase === 'attached' && !record.failed);
}

/** The phase the page reported a failure or a timeout in, if any. */
export function growStalledPhase(records: readonly SwapPhaseRecord[]): SwapPhaseRecord | undefined {
  return records.find(record => record.timedOut || record.failed);
}

/** The kinds a density open is judged on, beside the swap trace itself. */
export const VOLUME_BUILD_KIND = 'volume-build';
export const VOLUME_DRAW_FAILED_KIND = 'volume-draw-failed';
export const HUD_OUTCOME_KIND = 'hud-outcome';
/**
 * The `hud-outcome` statuses that are not a failure.
 *
 * `inspector.ts` writes this entry every time the wearer's status row changes.
 * `rendered` is a command that landed, `queued` and `rendering` are ones on
 * their way, and `expired` is `retireStaleHud` taking down a plate whose
 * command is gone — none of them is the plate saying "Could not apply".
 * Anything else is an error status and is what a wearer would be reading.
 */
const HUD_OUTCOME_OK = new Set(['rendered', 'queued', 'rendering', 'expired']);

/** One ring entry as a person reads it, with anything token-shaped taken out. */
export function describeRingEntry(entry: DiagnosticRecord): string {
  return redactTokens(`${entry.kind} ${JSON.stringify(entry.detail ?? {})}`).slice(0, 300);
}

/** What a density open has to prove, and what the ring said about it instead. */
export type DensityOpenProof = {
  ok: boolean;
  /** The mesh the page measured, or null when it reported none. */
  triangles: number | null;
  /** One sentence per thing that is wrong; empty when the open is clean. */
  problems: string[];
  /** The ring entries those sentences are about, redacted. */
  offending: string[];
};

/**
 * Read the ring for what a density open has to prove.
 *
 * Early filament-tier runs all failed before the map was ever drawn — for a
 * page reason, a host reason and a scene-identity reason in turn — and every
 * one of them failed as a timeout whose message was about a panel that "did not
 * come up". The page had already said what happened, on its own diagnostics
 * ring, and the driver was not reading it.
 *
 * Three things together are a drawn map, and no two of them are:
 *
 * 1. A measured mesh. `volume-build` carries the triangle count Mol* actually
 *    built (`viewer.mjs`, `representationTriangles`), and 178,236 is what this
 *    map meshes to on the GPU path a Quest takes. A count far from it is a
 *    different picture, and a `volume-draw-failed` beside it is the map draw
 *    throwing.
 * 2. A swap that reached its `built` phase without failing. The `attached`
 *    phase means something: a page that did not pair records `skipped` with
 *    the reason instead of writing the same entry a paired page writes.
 * 3. A status row the wearer can read. A `hud-outcome` outside
 *    `HUD_OUTCOME_OK` is the plate saying "Could not apply" in front of the
 *    wearer's eyes, and it has never been a reason this driver failed a step.
 *
 * Pure, so the test drives the same function the run does. Nothing here throws:
 * the caller decides what a failed proof is worth.
 */
export function assessDensityOpen(entries: readonly DiagnosticRecord[],
  { expectedTriangles = DENSITY_EXPECTED_TRIANGLES, paired = false }:
  { expectedTriangles?: number; paired?: boolean } = {}): DensityOpenProof {
  const problems: string[] = [];
  const offending: DiagnosticRecord[] = [];

  const builds = entries.filter(entry => entry.kind === VOLUME_BUILD_KIND);
  const measured = builds.map(entry => entry.detail?.triangles)
    .filter((count): count is number => typeof count === 'number' && Number.isFinite(count) && count > 0).at(-1) ?? null;
  const drawFailures = entries.filter(entry => entry.kind === VOLUME_DRAW_FAILED_KIND);
  const phases = growPhaseRecords(entries);
  const built = phases.find(record => record.phase === 'built' && !record.failed && !record.timedOut);
  const stalled = phases.filter(record => record.failed || record.timedOut);
  // The plate the wearer is reading is the LAST one, not any
  // one. The judgement below now runs repeatedly over an accumulating ring, so
  // "any error plate ever recorded" would let a status row that has since gone
  // back to `rendered` fail an open that drew.
  const lastHud = entries.filter(entry => entry.kind === HUD_OUTCOME_KIND).at(-1);
  const hud = lastHud && !HUD_OUTCOME_OK.has(String(lastHud.detail?.status ?? '')) ? [lastHud] : [];

  if (measured === null) {
    problems.push(builds.length
      ? 'The page reported a volume build with no triangle count, so nothing says a mesh exists.'
      : 'The page never reported a volume build, so the map was not meshed.');
    offending.push(...builds);
  } else {
    const drift = Math.abs(measured - expectedTriangles) / expectedTriangles;
    if (drift > DENSITY_TRIANGLE_TOLERANCE) {
      problems.push(`The mesh measured ${measured.toLocaleString()} triangles, not the ${expectedTriangles.toLocaleString()} `
        + `this map draws (${(drift * 100).toFixed(1)}% out, tolerance ${(DENSITY_TRIANGLE_TOLERANCE * 100).toFixed(0)}%).`);
      offending.push(...builds);
    }
  }
  if (drawFailures.length) {
    problems.push(`The map draw failed: ${redactTokens(String(drawFailures.at(-1)?.detail?.failed ?? 'no reason given'))}`);
    offending.push(...drawFailures);
  }
  if (!built) {
    problems.push(stalled.length
      ? `The swap never built the map; it stalled in the ${String(stalled[0]!.phase)} phase.`
      : 'The page recorded no completed build phase for this source.');
    offending.push(...entries.filter(entry => entry.kind === SWAP_TRACE_KIND));
  } else if (stalled.length) {
    problems.push(`The swap reported a failure in the ${String(stalled[0]!.phase)} phase.`);
    offending.push(...entries.filter(entry => entry.kind === SWAP_TRACE_KIND
      && Boolean(entry.detail?.failed ?? entry.detail?.timedOut)));
  }
  if (hud.length) {
    problems.push(`The wearer's status row read an error: ${redactTokens(String(hud.at(-1)?.detail?.status ?? 'unknown'))}.`);
    offending.push(...hud);
  }
  if (!paired) problems.push('No companion panel is paired, so the Mac cannot command what the headset is drawing.');

  return { ok: problems.length === 0, triangles: measured, problems,
    offending: offending.map(describeRingEntry) };
}

/** How often a density open re-reads the ring while its budget runs. */
export const DENSITY_OPEN_POLL_MS = 1_000;

/**
 * Every entry read so far, in order, each one once.
 *
 * `newDiagnostics` is a CURSOR read: it answers what has arrived since the last
 * call and then moves the cursor past it. Judging a poll on one of those
 * answers alone would forget the `volume-build` that came in the poll before,
 * so the entries accumulate here instead. Entries are matched on the page's own
 * `seq` (or this Mac's `sequence`) so a re-read that overlaps costs nothing;
 * an entry carrying neither is kept as it comes, which is what the pure tests
 * and the emulator's synthesized rings look like.
 */
export function mergeRingEntries(seen: readonly DiagnosticRecord[],
  incoming: readonly DiagnosticRecord[]): DiagnosticRecord[] {
  const identity = (entry: DiagnosticRecord) => {
    const key = entry.sequence ?? entry.seq;
    return typeof key === 'number' && Number.isFinite(key) ? `#${key}` : undefined;
  };
  const known = new Set(seen.map(identity).filter((key): key is string => key !== undefined));
  const merged = [...seen];
  for (const entry of incoming) {
    const key = identity(entry);
    if (key !== undefined) {
      if (known.has(key)) continue;
      known.add(key);
    }
    merged.push(entry);
  }
  return merged;
}

/**
 * Whether the page has already recorded a failure that more waiting cannot undo.
 *
 * A map that has not been meshed yet and a map that failed to mesh read the
 * same on a ring that is still filling, and only one of them is worth waiting
 * out. The page says which: a `volume-draw-failed`, or a grow phase it marked
 * `failed` or `timedOut`, is the page reporting a finished attempt that lost,
 * so the step fails then and there with the page's own words rather than
 * spending the rest of the budget waiting for a build that already happened.
 */
export function densityOpenLost(entries: readonly DiagnosticRecord[]): boolean {
  if (entries.some(entry => entry.kind === VOLUME_DRAW_FAILED_KIND)) return true;
  return growPhaseRecords(entries).some(record => Boolean(record.failed) || Boolean(record.timedOut));
}

export type DensityOpenWatch = {
  proof: DensityOpenProof;
  /** Every ring entry the watch read, merged and in order. */
  entries: DiagnosticRecord[];
  waitedMs: number;
  polls: number;
  /** True when the page recorded a finished attempt that failed. */
  lost: boolean;
};

/**
 * Judge the open across its whole budget, not at one instant.
 *
 * A single-instant read failed the open 6.6 s in, with 20 s of an announced
 * 24 s budget unspent, saying the page had never meshed the map and no
 * companion was paired — while the headset's own ring held the finished build
 * (178,236 triangles) and the host listed the companion panel ready and
 * current. Nothing was wrong with what the driver read; it read too early. The
 * page had been on the headset for four seconds, its `volume-build` had not yet
 * ridden a 1 Hz heartbeat to this Mac, and the panel the pairing wait accepted
 * was the Mac's OWN desktop panel, which is present before the headset opens
 * anything (`companionPanel` falls back to `panels[0]`).
 *
 * So the budget is a budget now: the ring and the panel list are re-read until
 * they agree that the map is drawn, until the page says the attempt failed, or
 * until the budget runs out — and the failure then reports what the page still
 * had not said after all of it. Injectable clock and sleep, so the test drives
 * the same loop the run does.
 */
export async function watchDensityOpen({ readRing, readPaired, expectedTriangles = DENSITY_EXPECTED_TRIANGLES,
  budgetMs, pollMs = DENSITY_OPEN_POLL_MS, now = Date.now, wait = (ms: number) => settle(ms / 1000),
  onPoll }: {
    readRing: () => Promise<readonly DiagnosticRecord[]>;
    readPaired: () => Promise<boolean>;
    expectedTriangles?: number;
    budgetMs: number;
    pollMs?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
    onPoll?: (watch: { proof: DensityOpenProof; waitedMs: number; polls: number }) => void;
  }): Promise<DensityOpenWatch> {
  const started = now();
  let entries: DiagnosticRecord[] = [];
  let polls = 0;
  for (;;) {
    entries = mergeRingEntries(entries, await readRing());
    const paired = await readPaired();
    polls += 1;
    const proof = assessDensityOpen(entries, { expectedTriangles, paired });
    const waitedMs = Math.max(0, now() - started);
    const lost = densityOpenLost(entries);
    onPoll?.({ proof, waitedMs, polls });
    if (proof.ok || lost || waitedMs >= budgetMs) return { proof, entries, waitedMs, polls, lost };
    await wait(pollMs);
  }
}

/**
 * The atom-site count every size-aware wait after a grow needs.
 *
 * `--atom-sites` describes the structure the run OPENED with. A grow replaces
 * it, and a wait sized for the monomer (6,818 sites) is not a wait for the wall
 * (40,908). `grown` wins whenever a tier has actually landed; with no grow in
 * the plan this is exactly what it always was.
 */
export function liveAtomSites(atomSites: number | undefined, grown: number | undefined): number | undefined {
  return typeof grown === 'number' && Number.isFinite(grown) && grown > 0 ? grown : atomSites;
}

/**
 * The same question for a mesh, in the shape the waits take.
 *
 * There is no `--triangles` flag and there should not be one: a run only ever
 * arrives at a mesh by growing into one, so the triangle count is something the
 * driver learns rather than something it is told. The atom sites ride along
 * unchanged, which is what keeps the exit wait from getting SHORTER when a run
 * grows from the `tip` tier (43,066 sites, 86 s) into the `filament` mesh
 * (178,236 triangles, 66 s): `panelWaitMs` takes the heavier of the two.
 */
export function livePanelLoad(driver: Pick<EnterStepHost, 'options' | 'currentAtomSites' | 'currentTriangles'>): PanelLoad {
  return {
    atomSites: liveAtomSites(driver.options.atomSites, driver.currentAtomSites),
    triangles: driver.currentTriangles,
  };
}

/**
 * Poll until an immersive session reports that it is presenting.
 *
 * Both the first entry and the return from Mol* rebuild the current structure
 * before this heartbeat arrives. Their deadline therefore follows the live
 * post-grow load, while `waitForPanel` returns as soon as the condition is true
 * instead of parking for the whole allowance.
 */
export async function waitForPresentingPanel(
  driver: Pick<EnterStepHost, 'options' | 'currentAtomSites' | 'currentTriangles' | 'waitForPanel'>,
  what: string,
): Promise<Record<string, any> | undefined> {
  const load = livePanelLoad(driver);
  const timeoutMs = panelWaitMs(load, PANEL_READY_WAIT);
  progress(`${what}: polling · ${describePanelWait(load, PANEL_READY_WAIT)}`);
  return await driver.waitForPanel(what, candidate => candidate?.xrStartup?.presenting === true, timeoutMs);
}

/** What `grow_structure` answers with, in the fields this driver reads. */
export type GrowAnswer = {
  refused: boolean; from?: string; to?: string; demo?: string; grew?: boolean;
  deviceTier?: string; atomSites?: number; lessonId?: string; spoken?: string;
  /** The tier's own size and unit — `atom sites` for coordinates, `triangles` for a map. */
  size?: { count: number; unit: string };
  /** Present only for a density tier, and the reason its wait is what it is. */
  density?: { bytes: number; sha256: string; contour: number };
};

/**
 * Ask for one tier, and treat "another command is in flight" as "not yet".
 *
 * The same rule `sendTourCommand` is built on, for the same reason: this driver
 * has no wearer to retry for it, and a grow is sent right after a chapter whose
 * receipt the page may still be rendering.
 */
export async function sendGrowCommand(host: CommandHost, stage: string,
  { device, attempts = IN_FLIGHT_ATTEMPTS, wait = settle, note = progress }: {
    device?: string; attempts?: number; wait?: (seconds: number) => Promise<void>; note?: (message: string) => void;
  } = {}): Promise<{ grow: GrowAnswer; said: string }> {
  for (let attempt = 1; ; attempt++) {
    let answer: AgentResult | undefined;
    let refusal: unknown;
    try { answer = await host.agent('grow_structure', { stage, ...(device ? { device } : {}) }); }
    catch (error) {
      if (isGateFailure(error)) throw error;
      refusal = error;
    }
    if (!refusal && answer && isCommandInFlight(agentText(answer))) refusal = Error(agentText(answer));
    if (refusal) {
      if (!isCommandInFlight(refusal) || attempt >= attempts) {
        throw new StepFailure(`The host refused grow ${stage}: ${refusal instanceof Error ? refusal.message : String(refusal)}`,
          { stage, attempt });
      }
      note(`grow ${stage}: the host is still finishing the command before this one; waiting to ask again`);
      await wait(2);
      continue;
    }
    const grow = ((answer!.structuredContent ?? {}) as { grow?: GrowAnswer }).grow;
    // A refusal is a normal answer carrying `refused: true`. No `grow` field at
    // all is a host too old for this tool, and saying so beats a type error.
    if (!grow) {
      throw new StepFailure('grow_structure answered with no grow result, so this host does not have the staged-demo tool.',
        { said: agentText(answer!).slice(0, 200) });
    }
    return { grow, said: agentText(answer!) };
  }
}

/**
 * Wait for one tier, on the panel and on the page's own phase records together.
 *
 * The panel is the outside view: a new `panelId` carrying the new lesson id and
 * `ready` means the swap finished and re-attached. The records are the inside
 * view, and they are the only thing that exists during the window where the
 * page has detached itself to hydrate. Either one is enough to stop waiting.
 *
 * A timeout carries the phase timeline, so the failure names the step rather
 * than the elapsed time.
 */
async function waitForGrow(driver: Driver, grow: GrowAnswer, budgetMs: number):
Promise<{ panel: Record<string, any> | undefined; phases: SwapPhaseRecord[] }> {
  const started = Date.now();
  const deadline = started + budgetMs;
  let announced = 0;
  let panel: Record<string, any> | undefined;
  let records: SwapPhaseRecord[] = [];
  const timeline = () => describeSwapTimeline(records);
  for (;;) {
    panel = await driver.companionPanel();
    const attached = panel?.tour?.selectedId === grow.lessonId && panel?.availability === 'ready';
    // A `kind` read never moves the cursor (see `newDiagnostics`), so each beat
    // re-reads every phase this swap has reported so far rather than only the
    // newest one. The unfiltered read in `stepGrow` is what advances the cursor
    // between tiers.
    records = growPhaseRecords(await driver.newDiagnostics(SWAP_TRACE_KIND), grow.lessonId);
    if (attached || growLanded(records)) return { panel, phases: records };
    const stalled = growStalledPhase(records);
    if (stalled) {
      throw new StepFailure(`The headset gave up growing the ${grow.to} tier in its ${stalled.phase} phase: `
        + `${stalled.failed ?? 'it ran out of time'}`,
        { phase: stalled.phase, phases: timeline(), lastPanel: panel ?? null });
    }
    const elapsed = Math.floor((Date.now() - started) / 10_000);
    if (elapsed > announced) {
      announced = elapsed;
      const reached = records.at(-1)?.phase ?? 'nothing yet';
      progress(`still waiting for the ${grow.to} tier (panel ${panel?.availability ?? 'absent'}, `
        + `presenting ${String(panel?.xrStartup?.presenting)}, phase ${reached})`);
    }
    if (Date.now() >= deadline) {
      throw new StepFailure(`Timed out after ${Math.round(budgetMs / 1000)} s waiting for the ${grow.to} tier `
        + `to rebuild in the headset; phases: ${timeline()}.`,
        { phases: timeline(), lastReportedPhase: records.at(-1)?.phase ?? null,
          lastPanel: panel ? { availability: panel.availability, xrStartup: panel.xrStartup, tour: panel.tour } : null });
    }
    await settle(1);
  }
}

/**
 * Grow the staged lesson tier by tier, without leaving the session.
 *
 * The point of the step is what a wearer would see: the molecule the chapter is
 * talking about gets bigger where it stands, rather than the page reopening.
 * Each tier is photographed, and the session has to still be presenting after
 * every swap -- a tier that lands on a black headset is the failure this step
 * exists to catch, and it is how the wall tier has failed.
 *
 * It ends at the device ceiling rather than at the top of the list, and records
 * the sentence the wearer would have heard. That refusal is the product
 * working: the alternative is a Quest 2 taking 177,268 atom sites and dropping
 * the session with the headset on someone's face.
 */
async function stepGrow(driver: Driver): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  const opening = await driver.companionPanel();
  if (!opening) throw new StepFailure('No companion panel is paired, so there is no session to grow inside.', {});
  if (opening.xrStartup?.presenting !== true) {
    throw new StepFailure('The headset is not presenting, so a grow could not be seen. Run `enter` before `grow`.',
      { xrStartup: opening.xrStartup ?? null });
  }
  const device = driver.options.device;
  const tiers: Array<Record<string, unknown>> = [];
  let refusal: Record<string, unknown> | undefined;
  let from = String(opening.tour?.selectedId ?? '');
  for (let attempt = 1; attempt <= MAX_GROW_TIERS; attempt++) {
    const requestedAt = Date.now();
    const { grow, said } = await sendGrowCommand(driver, 'next', { device });
    if (grow.refused) {
      const captureWaitMs = growRefusalCaptureWaitMs();
      progress(`grow refused at ${grow.from}; waiting ${(captureWaitMs / 1000).toFixed(1)} s for the caption plate to show "${grow.spoken}"`);
      await settle(captureWaitMs / 1000);
      const shot = await driver.capture('grow-refused');
      refusal = { from: grow.from ?? null, deviceTier: grow.deviceTier ?? null, spoken: grow.spoken ?? null,
        said: said.slice(0, 300), capture: shot.path, via: shot.via, captureWaitMs, overlayMs: GROWTH_CAPTION_MS };
      break;
    }
    const budgetMs = growTierWaitMs(grow);
    const size = growSize(grow);
    // The tier's own unit. A density tier says "178,236 triangles"
    // and never "0 atom sites", which is what this line printed before and is a
    // sentence about a tier nobody is growing into.
    const transfer = grow.density ? `, ${(grow.density.bytes / BYTES_PER_MEGABYTE).toFixed(1)} MB of map` : '';
    progress(`growing ${grow.from} into ${grow.to} (${size.count.toLocaleString()} ${size.unit}${transfer}); `
      + `up to ${Math.round(budgetMs / 1000)} s for the headset to rebuild it`);
    // The panel id changes across a grow: hydrating detaches and re-attaches
    // (`inspector.ts:457` and `:521`). `companionPanel` finds it by surface, so
    // the new one is picked up, and the new lesson id is what says the tier
    // itself has landed rather than the old one having merely gone ready.
    //
    // The panel is no longer the only signal. While a swap runs,
    // the page is detached with reason `loading` and sends no heartbeat at all,
    // so the panel can only go stale — which is why a timeout used to say
    // nothing about what the headset was doing. The page's own `grow` phase
    // records are read on the same beat: whichever arrives first ends the wait,
    // and a phase the page has already reported as stalled ends it immediately
    // rather than burning the rest of the budget on a swap that is already lost.
    const { panel: landed, phases } = await waitForGrow(driver, grow, budgetMs);
    const loadMs = Date.now() - requestedAt;
    // The tier this headset is now holding, so `exit` and every
    // later size-aware wait is sized for the wall rather than for the monomer
    // the run opened with.
    if (Number.isFinite(grow.atomSites) && Number(grow.atomSites) > 0) driver.currentAtomSites = Number(grow.atomSites);
    // And the mesh, when the tier is one. Growing back out of a
    // density tier into an atomic one clears it, so a wait is never sized for a
    // mesh the headset is no longer holding.
    driver.currentTriangles = size.unit === 'triangles' && size.count > 0 ? size.count : undefined;
    await settle(driver.options.settleSeconds);
    const entries = await driver.newDiagnostics();
    const fps = driver.latestFps(entries);
    const loss = detectTrackingLoss({ xrStartup: landed?.xrStartup ?? null, framesPerSecond: fps });
    const shot = await driver.capture(`grow-${grow.to}`);
    const tier = { from: grow.from ?? from, to: grow.to ?? null, atomSites: grow.atomSites ?? null,
      size, ...(grow.density ? { density: grow.density } : {}),
      deviceTier: grow.deviceTier ?? null, spoken: grow.spoken ?? null, lessonId: grow.lessonId ?? null,
      // `elapsedMs` is this driver's clock from the press to the tier landing;
      // `phases` is what the page itself recorded on the way, and
      // `phaseTimeline` is the one line a person reads. Without them a 12 s
      // wall rebuild and a 12 s stall looked alike.
      loadMs, elapsedMs: loadMs, budgetMs, phases, phaseTimeline: describeSwapTimeline(phases),
      framesPerSecond: fps, presenting: landed?.xrStartup?.presenting === true,
      capture: shot.path, via: shot.via };
    tiers.push(tier);
    if (landed?.xrStartup?.presenting !== true) {
      throw new StepFailure(`The immersive session was gone after growing to ${grow.to}; the wearer would be looking at the 2D page.`,
        { tiers, xrStartup: landed?.xrStartup ?? null });
    }
    if (loss.lost) throw new StepFailure(`${loss.reason} ${TRACKING_LOSS_ADVICE}`, { tiers, trackingLoss: true });
    const speech = speechFailures(entries);
    if (speech.length) {
      throw new StepFailure(`Growing to ${grow.to} lost a spoken line -- ${describeSpeechFailure(speech[0])}`,
        { tiers, speechFailures: speech.map(describeSpeechFailure) });
    }
    from = String(grow.to ?? from);
  }
  if (!tiers.length) {
    throw new StepFailure(`Nothing grew: ${refusal ? String(refusal.said) : 'the host refused the very first tier.'}`,
      { refusal: refusal ?? null });
  }
  if (!refusal) {
    throw new StepFailure(`Grew ${MAX_GROW_TIERS} tiers without the host ever refusing one, which no staged demo should allow.`,
      { tiers });
  }
  const grown = tiers.map(tier => String(tier.to)).join(' -> ');
  return {
    detail: `Grew ${from0(opening)} -> ${grown} inside one session; stopped at ${String(refusal.from)} with "${String(refusal.spoken)}".`,
    evidence: { device: device ?? 'unstated (the host assumes quest2)', tiers, refusal },
  };
}

/** The tier the session opened on, for the sentence the step prints. */
function from0(panel: Record<string, any> | undefined): string {
  return String(panel?.tour?.selectedId ?? 'the loaded lesson');
}

async function stepVoice(driver: Driver): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  const spoken: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  for (const phrase of VOICE_PHRASES) {
    await driver.say(phrase);
    await settle(Math.max(driver.options.settleSeconds, 3));
    const entries = await driver.newDiagnostics();
    const receipt = entries.filter(entry => entry.kind === 'voice-command').at(-1);
    const outcome = String(receipt?.detail?.outcome ?? 'no-receipt');
    spoken.push({ origin: INJECTED_TRANSCRIPT_ORIGIN, phrase, action: receipt?.detail?.action ?? null, outcome, reason: receipt?.detail?.reason ?? null });
    if (outcome !== 'applied') failures.push(`"${phrase}" -> ${outcome}${receipt?.detail?.reason ? ` (${String(receipt.detail.reason)})` : ''}`);
    for (const entry of speechFailures(entries)) failures.push(`"${phrase}" spoken reply: ${describeSpeechFailure(entry)}`);
  }
  if (failures.length) throw new StepFailure(`${failures.length} of ${VOICE_PHRASES.length} phrases did not apply -- ${failures[0]}`, { method: DRIVE_METHOD_PHRASE, verified: false, spoken, failures });
  // The phrase table is handed to the command handler by a page hook, with no
  // microphone and no wearer, and each phrase is verified by its own receipt.
  return { detail: `All ${VOICE_PHRASES.length} spoken phrases applied. Synthetic input: no wearer.`,
    evidence: { method: DRIVE_METHOD_PHRASE, verified: true, origin: INJECTED_TRANSCRIPT_ORIGIN, spoken } };
}

/** What one verified step reports, whichever way its row was reached. */
export interface VerifyOutcome {
  verified: boolean;
  outcome?: 'refused';
  reason?: string;
  expected: string;
  observed: string;
  waitedMs: number;
  polls: number;
  after: MenuObservation;
  entries: DiagnosticRecord[];
}

export type MenuRefusal = { outcome: 'refused'; reason: string };

/** A forecast alone cannot prove a press. Require this press's drawn answer. */
function renderedMenuRefusal(state: Record<string, any>, panelId: string, id: string, before: MenuObservation,
  entries: readonly DiagnosticRecord[], previousCommands?: ReadonlySet<string>): MenuRefusal | undefined {
  const panel = state.panels?.find((candidate: Record<string, any>) => candidate.panelId === panelId
    && candidate.current === true && candidate.surface === 'companion');
  if (!panel) return undefined;
  const command = panel.lastCommand ?? state.commands?.filter((candidate: Record<string, any>) => candidate.panelId === panelId).at(-1);
  const reason = command?.reason;
  if (command?.status === 'refused' && command.panelId === panelId
    && typeof reason === 'string' && /catalog|budget|vertex.*limit/iu.test(reason)
    && typeof command.commandId === 'string' && previousCommands && !previousCommands.has(command.commandId)
    && entries.some(entry => entry.kind === 'outcome' && entry.detail && entry.detail.commandId === command.commandId
      && entry.detail.status === 'refused' && entry.detail.drawn === true && entry.detail.seatOutcome === 'shown'
      && entry.detail.stale !== true && (entry.detail.panelId === undefined || entry.detail.panelId === panelId))) {
    return { outcome: 'refused', reason };
  }
  if (id !== 'next' && id !== 'back') return undefined;
  const selectedId = field(before.state, 'tour', 'selectedId'), step = field(before.state, 'tour', 'step');
  if (typeof selectedId !== 'string' || typeof step !== 'number' || !Number.isInteger(step) || step < 0
    || panel.tour?.selectedId !== selectedId || panel.tour?.step !== step || panel.tour?.navigating === true) return undefined;
  const target = step + (id === 'next' ? 1 : -1);
  const chapter = state.experienceCatalog?.find((item: Record<string, any>) => item.id === selectedId)
    ?.deviceBudget?.chapters?.find((item: Record<string, any>) => item.stepIndex === target);
  const chapterReason = chapter?.status === 'refused' && typeof chapter.message === 'string' && chapter.message.trim()
    ? chapter.message : undefined;
  // The latest preparation binds this answer to the pressed direction, panel
  // and journey. A newer preparation cannot lend its caption to an older one.
  let prepared = -1;
  entries.forEach((entry, index) => {
    if (entry.kind === 'journey' && entry.detail?.phase === 'preparing') prepared = index;
  });
  const preparation = entries[prepared]?.detail;
  if (!preparation || preparation.owner !== panelId || preparation.panelId !== panelId
    || preparation.experienceId !== selectedId || preparation.stepIndex !== target || preparation.finish !== false) return undefined;
  const action = entries.filter(entry => entry.kind === 'toolbar-action').at(-1)?.detail;
  if (action && (action.kind !== `tour-${id}` || action.locked === true)) return undefined;
  // The caption owner emits text after committing its glyphs, then the seat's
  // measured verdict. Long reasons span pages: the first drawn page proves the
  // refusal appeared, while the tool record/catalog supplies its full reason.
  const normalized = (text: string) => text.trim().replace(/\s+/gu, ' ');
  let refusalReason = chapterReason;
  let caption: string | undefined;
  for (const entry of entries.slice(prepared + 1)) {
    if (entry.kind === 'tool-refused') {
      const detail = entry.detail;
      refusalReason = detail?.tool === 'navigate_experience' && detail.status === 409 && detail.captioned === true
        && detail.journeyPending === true && detail.staleBinding !== true
        && typeof detail.reason === 'string' && detail.reason.trim()
        && (chapterReason === undefined || normalized(detail.reason) === normalized(chapterReason))
        ? detail.reason : undefined;
      caption = undefined;
    }
    if (entry.kind === 'talk-caption') caption = typeof entry.detail?.text === 'string' ? entry.detail.text : undefined;
    if (entry.kind === 'talk-caption-seat' && refusalReason && caption
      && entry.detail?.outcome === 'shown' && entry.detail.measured !== false) {
      const page = normalized(caption), full = normalized(refusalReason);
      if (page === full || (page.startsWith(`Chapter ${target + 1} refused:`) && full.startsWith(`${page} `))) {
        return { outcome: 'refused', reason: refusalReason };
      }
    }
  }
  return undefined;
}

/** The sentence a failed expectation prints beside what was wanted. */
function describeObserved(expectation: RowExpectation, before: MenuObservation, after: MenuObservation,
  entries: readonly DiagnosticRecord[]): string {
  if (expectation.diagnostic) {
    return `the headset recorded no such change in ${entries.length} diagnostic entr${entries.length === 1 ? 'y' : 'ies'}`;
  }
  if (!expectation.read) return 'nothing was read';
  return `before ${describeReading(expectation.read(before))}, after ${describeReading(expectation.read(after))}`;
}

/**
 * Wait, bounded, for a row's own outcome — and report what was seen either way.
 *
 * The XR action chain settles on frames after the CDP call returns, so the
 * answer is never ready on the first look. Polling is therefore the only honest
 * shape: ask again until the expectation holds or the bound passes. The bound
 * is this step's own and does not change any existing timeout.
 */
export type MenuVerifyHost = {
  drainDiagnostics(): Promise<DiagnosticRecord[]>;
  observeMenu(options?: { allowMissing?: boolean }): Promise<MenuObservation>;
  readMenuRefusal?(id: string, before: MenuObservation, entries: readonly DiagnosticRecord[]): Promise<MenuRefusal | undefined>;
};

export async function verifyRowOutcome(driver: MenuVerifyHost, id: string, before: MenuObservation,
  { timeoutMs = VERIFY_TIMEOUT_MS, wait = settle, now = Date.now } = {}): Promise<VerifyOutcome> {
  const started = now();
  const entries: DiagnosticRecord[] = [];
  const expectation = rowExpectation(id);
  let after = before, polls = 0;
  let unreachable: string | undefined;
  for (;;) {
    polls++;
    // A row may end the session it is read through — the Mol* handoff does —
    // and a page that has navigated answers nothing. That is a reading, not a
    // crash: the menu is gone. It is recorded so the log can name it rather
    // than let a dropped connection read as a clean handoff.
    try { entries.push(...await driver.drainDiagnostics()); }
    catch (error) { unreachable = error instanceof Error ? error.message : String(error); }
    try { after = await driver.observeMenu({ allowMissing: true }); }
    catch (error) {
      unreachable = error instanceof Error ? error.message : String(error);
      after = { rows: [], state: null };
    }
    if (!expectation) {
      return { verified: false, waitedMs: now() - started, polls, after, entries,
        expected: `this script has no expectation for the row ${id}, so its outcome was not checked`,
        observed: `rows now: ${after.rows.map(row => row.id).join(', ') || '(none)'}`
          + (unreachable ? `; the page stopped answering (${unreachable})` : '') };
    }
    // A page that stopped answering is evidence only for the one row whose job
    // is to end the session. For every other row it is a lost connection, and a
    // lost connection must never read as "the state changed".
    const readable = !unreachable || expectation.endsTheSession === true;
    if (!unreachable && driver.readMenuRefusal) {
      const refusal = await driver.readMenuRefusal(id, before, entries).catch(() => undefined);
      if (refusal) return { verified: true, ...refusal, expected: expectation.expected,
        observed: `refused: ${refusal.reason}`, waitedMs: now() - started, polls, after, entries };
    }
    if (readable && expectationHeld(expectation, before, after, entries)) {
      return { verified: true, expected: expectation.expected, waitedMs: now() - started, polls, after, entries,
        observed: describeObserved(expectation, before, after, entries)
          + (unreachable ? `; the page stopped answering (${unreachable})` : '') };
    }
    if (now() - started >= timeoutMs) {
      return { verified: false, expected: expectation.expected, waitedMs: now() - started, polls, after, entries,
        observed: describeObserved(expectation, before, after, entries)
          + (unreachable ? `; the page stopped answering (${unreachable})` : '') };
    }
    await wait(VERIFY_POLL_MS / 1000);
  }
}

/** The evidence both driven steps share, so their report entries read alike. */
function driveEvidence(input: { method: string; id: string; label: string | null; rows: MenuRows;
  outcome: VerifyOutcome; capture: { path: string; via: string; note?: string }; expandedFirst: string | null;
  extra?: Record<string, unknown> }): Record<string, unknown> {
  const actionRecord = input.outcome.entries.filter(entry => entry.kind === 'toolbar-action').at(-1);
  const layoutRecord = input.outcome.entries.filter(entry => entry.kind === 'component-label-layout'
    && typeof entry.detail?.menuReason === 'string').at(-1);
  return {
    method: input.method, menuId: input.id, label: input.label, rows: [...input.rows],
    verified: input.outcome.verified, expected: input.outcome.expected, observed: input.outcome.observed,
    ...(input.outcome.outcome ? { outcome: input.outcome.outcome, reason: input.outcome.reason } : {}),
    verifyWaitedMs: input.outcome.waitedMs, verifyPolls: input.outcome.polls,
    ...(input.expandedFirst ? { expandedFirst: input.expandedFirst } : {}),
    toolbarAction: actionRecord?.detail ?? null,
    menuReason: layoutRecord?.detail?.menuReason ?? null, layoutRecord: layoutRecord?.detail ?? null,
    capture: input.capture.path, captureVia: input.capture.via, captures: [input.capture.path],
    ...(input.capture.note ? { captureNote: input.capture.note } : {}),
    ...(input.extra ?? {}),
  };
}

async function stepMenu(driver: Driver, step: DriveStep): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  await driver.beginMenuVerification();
  const actionStartedAt = Date.now();
  const pressed = await driver.pressMenu(step);
  // verifyRowOutcome polls the headset until the new drawing is observed.
  // Sleeping first hid the actual response time and added two seconds to
  // every menu check, even when the change had already rendered.
  const outcome = await verifyRowOutcome(driver, pressed.id, pressed.before);
  const actionToObservedMs = Date.now() - actionStartedAt;
  const shot = await driver.capture(pressed.captureName);
  const row = pressed.rows.find(candidate => candidate.id === pressed.id);
  const label = row?.label ?? null;
  const evidence = driveEvidence({ method: DRIVE_METHOD_PRESS, id: pressed.id, label, rows: pressed.rows,
    outcome, capture: shot, expandedFirst: pressed.expanded, extra: { actionToObservedMs } });
  if (!outcome.verified) {
    throw new StepFailure(`The spatial-menu row ${label ?? pressed.id} (${pressed.id}) took the press, but the `
      + `outcome never arrived: expected ${outcome.expected}; ${outcome.observed}. `
      + `Waited ${(outcome.waitedMs / 1000).toFixed(1)} s. A press is dispatch, not success.`, evidence);
  }
  return {
    detail: `${pressed.expanded ? 'Expanded the menu, then pressed' : 'Pressed'} spatial-menu row ${label ?? pressed.id} `
      + `(${pressed.id}) through the page hook, and ${outcome.outcome === 'refused'
        ? `verified outcome refused: ${outcome.reason}` : `verified that ${outcome.expected}`}`
      + ` (${(actionToObservedMs / 1000).toFixed(1)} s from press request to observed result). Synthetic input: no wearer.`,
    evidence,
  };
}

/**
 * The aimed step: the same row, reached the way a controller reaches it.
 *
 * Two things have to hold, and the second is the one `menu:<id>` could never
 * ask for. The pose must actually land on the row the operator named — the hit
 * test decides that, not this script — and the row's own outcome must then
 * arrive, exactly as for a press. `aim:miss` inverts both: it must land on
 * nothing, fire nothing, and leave the drawn state alone.
 */
async function stepAim(driver: Driver, step: DriveStep): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  await driver.beginMenuVerification();
  const actionStartedAt = Date.now();
  const aimed = await driver.aimMenu(step);
  const result = aimed.result as { fired?: unknown; hitId?: unknown; hovered?: unknown; reason?: unknown;
    aimedAt?: unknown; ray?: unknown; simulates?: unknown; betweenRows?: unknown };

  if (aimed.id === DRIVE_AIM_MISS) {
    // A miss has no positive state change to poll for, so give late frame
    // callbacks a chance to prove that an unintended action did fire.
    await settle(2);
    const outcome = await verifyMiss(driver, aimed.before, result);
    const shot = await driver.capture(aimed.captureName);
    const evidence = driveEvidence({ method: DRIVE_METHOD_RAY, id: aimed.id, label: null, rows: aimed.rows,
      outcome, capture: shot, expandedFirst: aimed.expanded, extra: { aim: aimed.result } });
    if (!outcome.verified) {
      throw new StepFailure(`A pose aimed at ${String(result.aimedAt ?? 'nothing')} on the drawn menu did not come `
        + `back empty: expected ${outcome.expected}; ${outcome.observed}.`, evidence);
    }
    return { detail: `A simulated controller pose aimed at ${String(result.aimedAt ?? 'nothing')} hit no row and `
      + `changed nothing, so the row rectangles are where the plates are drawn. Synthetic input: no wearer.`, evidence };
  }

  const row = aimed.rows.find(candidate => candidate.id === aimed.id);
  const label = row?.label ?? null;
  if (result.fired !== true || String(result.hitId ?? '') !== aimed.id) {
    const shot = await driver.capture(aimed.captureName);
    const outcome: VerifyOutcome = { verified: false, waitedMs: 0, polls: 0, after: aimed.before, entries: [],
      expected: `a controller pose aimed at ${aimed.id} lands on ${aimed.id} and fires it`,
      observed: `the ray ${result.hitId ? `landed on ${String(result.hitId)}` : 'landed on no row'} and `
        + `${result.fired === true ? 'fired' : 'fired nothing'} (${String(result.reason ?? 'no reason reported')})` };
    throw new StepFailure(`A simulated controller pose could not reach the spatial-menu row ${label ?? aimed.id} `
      + `(${aimed.id}): ${outcome.observed}. The row may dispatch fine and still be unreachable to a pointed hand.`,
    driveEvidence({ method: DRIVE_METHOD_RAY, id: aimed.id, label, rows: aimed.rows, outcome, capture: shot,
      expandedFirst: aimed.expanded, extra: { aim: aimed.result } }));
  }

  const outcome = await verifyRowOutcome(driver, aimed.id, aimed.before);
  const actionToObservedMs = Date.now() - actionStartedAt;
  const shot = await driver.capture(aimed.captureName);
  const evidence = driveEvidence({ method: DRIVE_METHOD_RAY, id: aimed.id, label, rows: aimed.rows, outcome,
    capture: shot, expandedFirst: aimed.expanded, extra: { aim: aimed.result, actionToObservedMs } });
  if (!outcome.verified) {
    throw new StepFailure(`A simulated controller pose landed on the spatial-menu row ${label ?? aimed.id} `
      + `(${aimed.id}) and fired it, but the outcome never arrived: expected ${outcome.expected}; ${outcome.observed}. `
      + `Waited ${(outcome.waitedMs / 1000).toFixed(1)} s.`, evidence);
  }
  return {
    detail: `${aimed.expanded ? 'Opened the grid, then aimed' : 'Aimed'} a simulated controller pose at spatial-menu row `
      + `${label ?? aimed.id} (${aimed.id}); the toolbar's own hit test took it`
      + `${result.hovered === aimed.id ? ' and highlighted it first' : ''}, and ${outcome.outcome === 'refused'
        ? `verified outcome refused: ${outcome.reason}` : outcome.expected}`
      + ` (${(actionToObservedMs / 1000).toFixed(1)} s from aim request to observed result). Synthetic input: no wearer.`,
    evidence,
  };
}

/** `aim:miss` passes only when the pose hit nothing AND the page did not move. */
export async function verifyMiss(driver: MenuVerifyHost, before: MenuObservation,
  result: { fired?: unknown; hitId?: unknown; reason?: unknown }, { now = Date.now } = {}): Promise<VerifyOutcome> {
  const started = now();
  const entries = await driver.drainDiagnostics();
  const after = await driver.observeMenu({ allowMissing: true });
  const expected = 'a pose aimed off the rows hits no row, fires nothing and leaves the menu as it was';
  const fired = result.fired === true, hit = result.hitId ? String(result.hitId) : null;
  const rowsMoved = JSON.stringify(before.rows) !== JSON.stringify(after.rows);
  const stateMoved = JSON.stringify(before.state ?? null) !== JSON.stringify(after.state ?? null);
  const verified = !fired && !hit && !rowsMoved && !stateMoved;
  return { verified, expected, waitedMs: now() - started, polls: 1, after, entries,
    observed: verified ? `nothing fired and neither the rows nor the drawn state changed (${String(result.reason ?? '')})`
      : [fired ? 'an action fired' : null, hit ? `the ray hit ${hit}` : null,
        rowsMoved ? 'the rows changed' : null, stateMoved ? 'the drawn state changed' : null]
        .filter(Boolean).join(', ') };
}

/** The first ffmpeg this Mac has, searched the same way the host searches for it. */
async function findFfmpeg(): Promise<string | undefined> {
  for (const candidate of ffmpegBinCandidates()) {
    try { await access(candidate); return candidate; } catch { /* try the next one */ }
  }
  return undefined;
}

/**
 * Speak one sentence into a recording shaped like a press from the headset.
 *
 * `say` writes AIFF and the decoder wants 16 kHz mono, which is what
 * `afconvert` is for; both ship with macOS, so nothing is installed. ffmpeg
 * then re-encodes that to WebM/Opus, because WebM/Opus is what Quest Browser's
 * MediaRecorder produces and a WAV press proves only that the route accepts a
 * container the headset never sends.
 *
 * A Mac with no ffmpeg fails here rather than quietly falling back to WAV. It
 * is not a limitation of this script: the host decodes every press with the
 * same ffmpeg, and AVFoundation does not open WebM, so a Mac without it cannot
 * hear a real headset press either. Reporting that as a pass would hide the
 * one fact the operator needs.
 *
 * Both files are kept beside the captures rather than deleted: when a turn
 * fails on a bad transcript the first question is always whether the audio was
 * any good, and an operator who can play it back answers that in seconds.
 */
async function recordPress(text: string, outDir: string, name: string): Promise<{ audio: Uint8Array; mime: string; path: string }> {
  const aiff = join(outDir, `${name}.aiff`);
  const wav = join(outDir, `${name}.wav`);
  const webm = join(outDir, `${name}.webm`);
  const said = await run('/usr/bin/say', ['-o', aiff, text]);
  if (said.code !== 0) throw new StepFailure(`macOS "say" could not record the spoken turn (${said.stderr.trim().slice(0, 120)}).`);
  const converted = await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
  if (converted.code !== 0) throw new StepFailure(`afconvert could not make a 16 kHz mono WAV (${converted.stderr.trim().slice(0, 120)}).`);

  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    throw new StepFailure('This Mac has no ffmpeg, so the spoken turn cannot be encoded the way the headset encodes one -- '
      + 'and the host decodes every press with that same ffmpeg, so a real press from the headset would not be heard here either.',
    { looked: [...ffmpegBinCandidates()] });
  }
  const encoded = await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', wav, '-c:a', 'libopus', '-b:a', '24k', '-ac', '1', '-ar', '48000', webm]);
  if (encoded.code !== 0) {
    throw new StepFailure(`ffmpeg could not encode the spoken turn as ${HEADSET_PRESS_MIME}, which is what the headset records (${encoded.stderr.trim().slice(0, 160)}).`);
  }
  const audio = await readFile(webm);
  if (audio.byteLength < 256) throw new StepFailure(`The spoken turn came out as ${audio.byteLength} bytes, which is not speech.`);
  return { audio, mime: HEADSET_PRESS_MIME, path: webm };
}

/**
 * Post one recording to the host's microphone route and read back what it
 * heard.
 *
 * Sent the way the headset sends it: several data chunks, then a bare
 * `final: true` that carries no audio at all. That last marker is a branch of
 * its own in `assembleChunks`, and a step that closed the utterance on a chunk
 * still carrying data never reached it.
 *
 * The transcript comes from the `final: true` answer rather than from a poll,
 * because that is the answer the headset's own recorder reads and a poll would
 * not distinguish this utterance from one the wearer left on the queue.
 *
 * One honest limit on the door. The page posts this tool over the companion's
 * authenticated `/tool` route on the private Wi-Fi listener; this posts it over
 * the Mac's loopback `/agent` route. Both land on the same
 * `transcriber.accept`, and everything after that point is identical, but the
 * allowlist and the binding in front of it are not under test here.
 */
async function sayIntoMicrophoneRoute(driver: Driver, press: { audio: Uint8Array; mime: string }, said: string): Promise<{ transcript: string; chunks: number; model?: string; fallback?: string }> {
  const utteranceId = randomUUID();
  const chunks = pressChunks(press.audio);
  if (!chunks.length) throw new StepFailure('The spoken turn produced no audio to send.');
  const post = async (seq: number, data: string | undefined, final: boolean) => {
    const answer = await driver.agent('push_to_talk_audio', {
      sessionId: driver.state.sessionId, utteranceId, seq, mime: press.mime, final, ...(data ? { data } : {}),
    });
    const outcome = (answer.structuredContent ?? {}) as Record<string, any>;
    if (outcome.accepted !== true) {
      // `disabled` is the one worth naming out loud: it is not a bug, it is a
      // host started without a transcriber, and the run should say so rather
      // than report that the wearer was not heard.
      const why = outcome.reason === 'disabled'
        ? 'this host has no local transcriber turned on, so nothing spoken into the headset can be heard (start it with --ptt, or set STEREOFOLD_PTT_TRANSCRIBE=1)'
        : `the host refused chunk ${seq} as ${String(outcome.reason ?? 'unknown')}`;
      throw new StepFailure(`"${said}" never reached transcription: ${why}.`, { outcome });
    }
    return outcome;
  };
  for (const [seq, data] of chunks.entries()) await post(seq, data, false);
  const outcome = await post(chunks.length, undefined, true);
  const transcript = String(outcome.transcript?.text ?? '');
  if (!transcript.trim()) throw new StepFailure(`"${said}" was accepted but transcribed to nothing, so the wearer would have been ignored.`, { outcome });
  return { transcript, chunks: chunks.length, model: outcome.transcript?.model, fallback: outcome.transcript?.transcriberFallback };
}

/** How long the reply caption is asked to stand, and the ceiling on waiting for it. */
const REPLY_HOLD_SECONDS = 6;

/**
 * Wait for the page to say what it did with one reply, instead of sampling the
 * log once.
 *
 * A single settle followed by one read had two ways to be wrong. Too short and
 * the clip record had not been written yet, so a working answer read as a
 * silent one; too long and the next turn's answer was already in the window.
 * This polls the page's own log until this caption is accounted for -- drawn,
 * played, or failed -- and gives up at the point the caption would have come
 * down anyway.
 *
 * Entries are accumulated because `newDiagnostics` moves the cursor, so a
 * record read on one poll is gone by the next.
 */
async function awaitReplyReceipts(driver: Driver, reply: { chars: number; audioBytes?: number; captionId?: string }, seconds = REPLY_HOLD_SECONDS + 4): Promise<ReplyReceipts> {
  const deadline = Date.now() + seconds * 1000;
  const entries: DiagnosticRecord[] = [];
  for (;;) {
    entries.push(...await driver.newDiagnostics());
    const receipts = replyReceipts(entries, reply);
    if (receipts.failed.length) return receipts;
    // A clip started into a stopped context writes one record and never
    // writes another, so waiting out the caption's hold would only delay the
    // same answer.
    if (receipts.received.length && receipts.silent.length) return receipts;
    if (receipts.received.length && receipts.played.length) return receipts;
    if (Date.now() >= deadline) return receipts;
    await settle(1);
  }
}

/**
 * Where the transcript queue is right now, without taking anything out of it.
 *
 * The seed exists so that turn one cannot be satisfied by something the wearer
 * said minutes ago, in the `voice` step or in a previous run. The obvious way
 * to write it -- `listen_voice` with a short timeout -- has a hole: that call
 * waits, and an utterance that lands inside the wait is returned to a caller
 * that throws the text away and keeps only the cursor. The press that produced
 * it is then already behind the cursor when turn one looks, and a working
 * headset reports that nothing reached the queue.
 *
 * `poll_voice_transcripts` with `waitMs: 0` is the same queue read with no
 * wait at all, so there is no window for anything to land in: it answers out
 * of what is already there. `listen_voice` remains the fallback for a host
 * that will not serve the app-only route, and `timeoutSeconds: 1` is the
 * shortest wait its schema allows.
 */
async function voiceQueueHead(driver: Driver): Promise<number> {
  try {
    const sessionId = String((await driver.inspectionState()).sessionId ?? '');
    if (sessionId) {
      const peek = await driver.agent('poll_voice_transcripts', { sessionId, after: 0, waitMs: 0 });
      const cursor = ((peek.structuredContent ?? {}) as { cursor?: number }).cursor;
      if (typeof cursor === 'number') return cursor;
    }
  } catch { /* An app-only route this host will not serve falls through to the model-side one. */ }
  const head = await driver.agent('listen_voice', { timeoutSeconds: 1 });
  const headCursor = ((head.structuredContent ?? {}) as { cursor?: number }).cursor;
  return typeof headCursor === 'number' ? headCursor : 0;
}

/**
 * The whole conversation loop, from real audio to a scene the wearer sees
 * change, with nobody wearing the headset.
 *
 * Each turn is asserted separately and the run stops at the first one that
 * fails, because a later turn's evidence is meaningless once an earlier hop is
 * broken: "continue the lesson" appearing to work when the question before it
 * was never heard tells an operator nothing.
 */
async function stepAsk(driver: Driver): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  const turns: Array<Record<string, unknown>> = [];

  // Park the lesson the way a wearer would: stop it mid-chapter to ask
  // something. `pause` leaves the chapter on screen and the session
  // presenting, which is the state the last turn has to restore.
  //
  // Two arrangements first, so the park is a real one rather than whatever the
  // previous step happened to leave behind. In a default run `ask` follows a
  // `tour` that walked every chapter, which parks the lesson on the last one --
  // and resuming the last chapter is the one case where `play` can run the
  // lesson off its end and change `step` on its own, which would make this
  // step's verdict depend on timing. Backing off the final chapter also means
  // `--steps ask` on its own has something to continue.
  //
  // Every send here waits for its own receipt. The pause and the back that
  // follows it are two inspection commands, and the host serves one at a time:
  // sending the second while the first was still rendering is what ends a run
  // (`sendTourCommand`).
  await sendTourCommand(driver, 'pause', {}, { label: 'park-pause' });
  const before = await driver.companionPanel();
  const total = Number(before?.tour?.total ?? 0);
  const arrange = planPark(before?.tour);
  if (arrange === 'open') {
    // `start` needs a lesson id and the panel may have selected none, which is
    // the ordinary state when `--steps ask` runs on its own. The session's own
    // catalog is the fallback, so the step opens a lesson rather than failing
    // schema validation on an empty string.
    const selected = String(before?.tour?.selectedId ?? '');
    const tourId = selected || String(((await driver.inspectionState()).tours ?? [])[0]?.id ?? '');
    if (!tourId) throw new StepFailure('This session has no lesson to open, so there is nothing for "continue the lesson" to continue.');
    progress(`no lesson is playing; opening ${tourId} so there is one to interrupt`);
    await sendTourCommand(driver, 'start', { tourId }, { label: 'park-start' });
    await driver.waitForPanel('the lesson to open', candidate => Number(candidate?.tour?.step) >= 0, 60_000);
    await sendTourCommand(driver, 'pause', {}, { label: 'park-pause' });
  } else if (arrange === 'back') {
    progress(`lesson sits on its last chapter (${total} of ${total}); stepping back one so "continue" has somewhere to go`);
    await sendTourCommand(driver, 'back', {}, { label: 'park-back' });
    await driver.waitForPanel('the lesson to step back off its last chapter',
      candidate => candidate?.tour?.navigating === false && Number(candidate?.tour?.step) < total - 1, 60_000);
    await sendTourCommand(driver, 'pause', {}, { label: 'park-pause' });
  }
  // `autoplay === false` is in the predicate, not just `navigating` and a real
  // chapter, because the heartbeat runs about once a second and the first
  // reading after a pause can still be the one taken before it. Reading the
  // park off that stale heartbeat records a lesson that was never parked, and
  // the resume check refuses to judge one of those -- so the race shows up as
  // this step failing on a headset where everything worked.
  //
  // The wait is bounded and the pause is re-sent rather than waited out: a
  // `pause` that never reached the player (the panel was answering `unsaved`,
  // the receipt was dropped) leaves autoplay running, and a single 30 s wait on
  // it ends in a sentence about a timeout that names no cause.
  let paused: Record<string, any> | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      paused = await driver.waitForPanel('the lesson to park on its chapter', candidate => tourParked(candidate?.tour), PARK_WAIT_MS);
      break;
    } catch {
      const last = await driver.companionPanel();
      if (attempt >= PARK_PAUSE_ATTEMPTS) throw new StepFailure(PARK_REFUSED_ADVICE, { tour: last?.tour ?? null, attempts: attempt });
      progress(`the lesson is still running after pause ${attempt}; sending it again`);
      await sendTourCommand(driver, 'pause', {}, { label: `park-pause-${attempt + 1}` });
    }
  }
  const parked = parkedTour(paused);
  if (!parked) {
    throw new StepFailure('No lesson was on screen to interrupt, so there is nothing to continue afterwards.', { tour: paused?.tour ?? null });
  }
  if (!resumeEdge(parked)) {
    throw new StepFailure('The lesson was still running after the pause, so "continue the lesson" could not be told apart from a command that was dropped.',
      { tour: paused?.tour ?? null });
  }
  progress(`lesson parked on chapter ${parked.step + 1} of ${parked.selectedId}`);

  // Start at the head of the voice queue, not at zero.
  //
  // `listen_voice` with a cursor of zero replays everything the queue still
  // holds, and the `voice` step immediately before this one leaves its own
  // phrases there. So the first turn's "it reached the agent" assertion could
  // be satisfied by an utterance spoken minutes earlier -- in a different step,
  // or in a previous run of this script. Reading the head once costs one call
  // and removes the whole class.
  driver.voiceCursor = await voiceQueueHead(driver);
  progress(`voice queue head is at cursor ${driver.voiceCursor}; nothing said before now counts`);

  for (const [index, turn] of ASK_TURNS.entries()) {
    const name = `ask-${index + 1}`;
    progress(`saying "${turn.said}" into the microphone route`);
    const press = await recordPress(turn.said, driver.options.outDir, name);
    const heard = await sayIntoMicrophoneRoute(driver, press, turn.said);
    const match = transcriptMatches(heard.transcript, turn.said);
    if (!match.ok) {
      throw new StepFailure(`The Mac heard "${match.heard}" when "${turn.said}" was spoken, so a wearer asking this would be answered about something else.`,
        { turns, match, model: heard.model });
    }

    // What an agent reads. The same text has to arrive on the queue
    // `listen_voice` serves, or the transcription worked and no agent could
    // ever act on it -- which is exactly the failure a transcript-only check
    // would miss. Equality, and exactly one new entry: overlap against
    // everything the cursor returned would accept a neighbouring utterance,
    // and that is the same false pass the seeded cursor above closes.
    const listened = await driver.agent('listen_voice', { timeoutSeconds: 5, cursor: driver.voiceCursor });
    const listenedStructured = (listened.structuredContent ?? {}) as { transcripts?: { text?: string }[]; cursor?: number };
    const queued = (listenedStructured.transcripts ?? []).map(entry => String(entry.text ?? ''));
    if (typeof listenedStructured.cursor === 'number') driver.voiceCursor = listenedStructured.cursor;
    if (queued.length !== 1 || queued[0] !== heard.transcript) {
      throw new StepFailure(queued.length
        ? `The queue an agent listens on did not carry "${turn.said}" as the one new thing the wearer said; it had ${queued.length} entries and the newest was "${queued.at(-1)}".`
        : `"${turn.said}" was transcribed but never reached the queue an agent listens on, so no agent could answer it.`,
      { turns, transcript: heard.transcript, queued });
    }

    // Read the page's log dry before sending, so nothing already in the ring
    // can be credited to this answer. A clip record from the turn before, or
    // from the fixed-grammar `voice` step, otherwise satisfies "the wearer
    // heard it" for a reply that was never played.
    await driver.newDiagnostics();

    // The reasoning hop. Canned here; a real agent would choose this sentence.
    const spoke = await driver.agent('say_to_headset', { text: turn.reply, holdSeconds: REPLY_HOLD_SECONDS });
    const spokeStructured = (spoke.structuredContent ?? {}) as { delivered?: boolean; audible?: boolean; captionId?: string; audioBytes?: number; text?: string };
    // `delivered` is not asserted. It only says whether a page took the reply
    // inside say_to_headset's own two-second wait; false means "not yet", and
    // the caption lands on the next heartbeat. The page's own record below is
    // both stricter and not a race, so failing here would fail runs that
    // worked.
    if (spokeStructured.audible !== true) {
      throw new StepFailure(`The answer to "${turn.said}" was delivered as text with no clip, so the wearer would have had to read it off the menu instead of being answered.`,
        { turns, said: spokeStructured });
    }

    // What the page did with it: the caption the wearer reads and the clip the
    // wearer hears, read separately because they fail separately, and waited
    // for rather than sampled once.
    // The caption queue's id for this answer. Without it the page's records
    // are matched by length and byte count, and the previous turn's clip
    // record counts as this turn's sound.
    const captionId = typeof spokeStructured.captionId === 'string' ? spokeStructured.captionId : undefined;
    if (!captionId) {
      throw new StepFailure(`The Mac queued the answer to "${turn.said}" without a caption id, so nothing the page records about it could be told apart from the turn before.`,
        { turns, said: spokeStructured });
    }
    const receipts = await awaitReplyReceipts(driver, {
      captionId,
      chars: String(spokeStructured.text ?? turn.reply).length,
      audioBytes: typeof spokeStructured.audioBytes === 'number' ? spokeStructured.audioBytes : undefined,
    });
    if (!receipts.received.length) {
      throw new StepFailure(`The answer to "${turn.said}" was queued on the Mac but no headset page recorded drawing it, so the caption never reached the wearer's eyes.`,
        { turns, said: spokeStructured });
    }
    if (receipts.failed.length) {
      throw new StepFailure(`The answer to "${turn.said}" was shown but not heard -- ${describeSpeechFailure(receipts.failed[0]!)}.`,
        { turns, failures: receipts.failed.map(entry => entry.detail ?? {}) });
    }
    if (!receipts.played.length) {
      // A started clip on a context the browser never resumed is the same
      // silence as no clip at all, and it is the one an unattended headset
      // produces, so it is named rather than reported as "never played".
      const stopped = receipts.silent[0];
      throw new StepFailure(stopped
        ? `The clip answering "${turn.said}" was started into an audio context that was ${String(stopped.detail?.contextState ?? 'not running')}, so nothing came out of the headset while the caption stood.`
        : `The clip answering "${turn.said}" reached the headset but the page never played it, so the wearer read the answer in silence.`,
      { turns, said: spokeStructured, ...(stopped ? { silent: stopped.detail ?? {} } : {}) });
    }

    // What the turn was actually for. The question only has to be answered;
    // the other two have to move something the wearer can see.
    const acted = turn.act === 'answer' ? { kind: 'answer' as const }
      : turn.act === 'show' ? await showSomething(driver)
        : await resumeLesson(driver, parked);

    // The whole point of the interruption is that it happens without leaving
    // immersion. A turn that answered correctly after the session dropped is
    // the wearer back on a flat page, which is the failure this run exists to
    // catch rather than something to note in passing.
    if (parked.presenting && (await driver.companionPanel())?.xrStartup?.presenting !== true) {
      throw new StepFailure(`The headset session ended during "${turn.said}", so the wearer was dropped out of VR mid-conversation.`, { turns });
    }

    const shot = await driver.capture(name);
    turns.push({
      said: turn.said, proves: turn.proves, transcript: heard.transcript, transcriptScore: Number(match.score.toFixed(2)),
      chunks: heard.chunks, mime: press.mime, transcriber: heard.model ?? null, transcriberFallback: heard.fallback ?? null,
      reply: turn.reply, captionId, delivered: spokeStructured.delivered === true,
      // Two records for one caption: the panel's delivery record and the
      // page's event record. They are the same showing seen twice, so the
      // routes are named rather than counted as two captions.
      captionRecords: receipts.received.length,
      captionRoutes: [...new Set(receipts.received.map(entry => String(entry.detail?.via ?? 'unknown')))],
      clipStarted: receipts.played.length,
      clipContext: String(receipts.played[0]?.detail?.contextState ?? 'unknown'),
      audioBytes: spokeStructured.audioBytes ?? null, acted, capture: shot.path,
    });
  }

  return {
    detail: `Three spoken turns went the host's push-to-talk route -> local transcription -> agent queue -> a caption drawn for that reply and its clip started into a running audio context, without leaving the headset; chain ${GUIDE_RNA_CHAIN} reported rendered and the page recorded the lesson back on chapter ${parked.step + 1} rather than restarted. The reasoning hop was this script, not a model.`,
    evidence: {
      turns, parked, chunkShape: `${HEADSET_PRESS_MIME}, at least ${PRESS_CHUNK_MINIMUM} chunks then a bare final marker; one ffmpeg file cut into chunks, not real recorder timeslices`,
      door: 'loopback /agent; the headset posts the same tool over the companion /tool route on the private Wi-Fi listener, which this does not exercise',
      heard: 'each clip record carries this reply\'s caption id and an AudioContext that was running when the source started; nobody measured sound leaving the headset speakers',
      shown: `focus_selection over chain ${GUIDE_RNA_CHAIN} reported rendered; no capture was checked for what it framed, so "the guide RNA was brought into view" is the panel's word for it`,
      resumed: 'the play command\'s own receipt reported rendered and the player recorded the parked chapter drawn or running, with no start record; the camera was not compared against the parked one',
      reasoningHop: 'canned in headset-drive.ts; a real agent reads listen_voice and chooses the reply',
    },
  };
}

/**
 * "Show me": an answer that has to become the thing the sentence named.
 *
 * The wearer asked this right after asking what the guide RNA does, so the
 * answer is the guide RNA brought into view -- not a turntable spin, which is
 * what this used to send. A spin changes the picture without showing anybody
 * anything, and the `spin` step already covers it, so the old version's name
 * promised more than it checked.
 *
 * Chain B is the single-guide RNA in 9KJ6, the coordinate set behind the
 * crispr-cas9 demo. It is looked up before it is focused, so a model with no
 * chain B fails with that sentence rather than with a resolver error.
 */
const GUIDE_RNA_CHAIN = 'B';

async function showSomething(driver: Driver): Promise<Record<string, unknown>> {
  const roster = await driver.agent('get_inspection_state', { residues: { labelChain: GUIDE_RNA_CHAIN, limit: 1 } });
  const rows = (((roster.structuredContent ?? {}) as { residues?: { rows?: { identity?: Record<string, unknown> }[] } }).residues?.rows) ?? [];
  if (!rows.length) {
    throw new StepFailure(`"Show me" had nothing to show: this model has no chain ${GUIDE_RNA_CHAIN}, and the guide RNA is what the wearer had just asked about. This step is written for the crispr-cas9 demo.`);
  }
  const answer = await driver.agent('focus_selection', { residues: { labelChain: GUIDE_RNA_CHAIN }, framing: 'fill' });
  const structured = (answer.structuredContent ?? {}) as { command?: { commandId?: string } };
  const commandId = structured.command?.commandId;
  if (!commandId) throw new StepFailure('"Show me" produced no command, so nothing was going to change.', { said: agentText(answer).slice(0, 160) });
  const receipt = await waitForReceipt(driver, commandId);
  if (receipt.status !== 'rendered') {
    throw new StepFailure(`"Show me" was answered but the scene never rendered the change (${String(receipt.status)}), so the wearer was told about something they cannot see.`, { receipt });
  }
  return { kind: 'scene', change: `focus:chain-${GUIDE_RNA_CHAIN}`, entityId: rows[0]?.identity?.entityId ?? null,
    receipt: { commandId, status: receipt.status } };
}

/**
 * "Continue the lesson": `play`, never `start`.
 *
 * `start` would also leave a playing lesson and a plausible `report.json`, and
 * it is the wrong command: it clears the player's captured scenes and opens at
 * chapter one, so a wearer who asked a question two thirds of the way through
 * would sit through the whole lesson again. The command is named here and the
 * parked chapter is asserted afterwards, so neither a wrong command nor a
 * right command that silently restarted can pass.
 */
/**
 * What the player itself recorded about one resume.
 *
 * Every flag this step can read off the heartbeat is also true of a lesson
 * nobody can see: `active` and `autoplay` are the player's own bookkeeping, and
 * a panel that set them without drawing anything looks identical from the Mac.
 * The player writes one `tour` diagnostic per decision (tour-player.ts:496), so
 * the page can be made to say which of the three things happened:
 *
 * - `scene`/`shown` at the parked index is the chapter rendered again, which is
 *   what a rejoin does for a lesson the wearer took over.
 * - `autoplay`/`resumed` is a paused lesson starting to run on the chapter
 *   already in front of the wearer, where nothing needs redrawing.
 * - `start` is a restart. It is the failure that costs the wearer the whole
 *   lesson, and on a lesson parked at its opening chapter the step index alone
 *   cannot tell it from a resume -- a restart lands on that same index
 *   (tour-player.ts:745). This is the only reading that can.
 */
export function resumeEvidence(entries: readonly DiagnosticRecord[], step: number): {
  shown?: DiagnosticRecord; resumed?: DiagnosticRecord; restarted?: DiagnosticRecord;
} {
  const tour = entries.filter(entry => entry.kind === 'tour');
  const at = (entry: DiagnosticRecord) => Number(entry.detail?.step);
  return {
    shown: tour.find(entry => entry.detail?.action === 'scene' && entry.detail?.outcome === 'shown' && at(entry) === step),
    resumed: tour.find(entry => entry.detail?.action === 'autoplay' && entry.detail?.outcome === 'resumed' && at(entry) === step),
    restarted: tour.find(entry => entry.detail?.action === 'start'),
  };
}

async function resumeLesson(driver: Driver, parked: TourPark): Promise<Record<string, unknown>> {
  // The edge comes from the state right now, not from the park. Between the
  // two, the "show me" turn committed a focus command, and any committed
  // inspection change stops the lesson (tour-player.ts:996): the panel that
  // was `active: true, autoplay: false` at the park is `active: false` by the
  // time this runs. Watching the park's edge would wait sixty seconds for an
  // autoplay that a rejoin never sets, and fail a resume that worked.
  const before = await driver.companionPanel();
  const sends: string[] = [];
  const receipts: Array<Record<string, unknown>> = [];
  // Read the page's log dry first, so every `tour` record collected below
  // belongs to this resume and not to the chapter the lesson was playing when
  // the wearer interrupted it.
  const seen: DiagnosticRecord[] = [];
  await driver.newDiagnostics();
  const play = async (what: string, edge: 'autoplay' | 'active') => {
    // A command id of this run's own, so the panel's receipt for this play can
    // be read back. The heartbeat flags say what the player believes; the
    // receipt says the panel applied the command and captured a scene, and
    // `queued` or `render_failed` here is a resume the wearer never got.
    sends.push('play');
    // `sendTourCommand` carries the same own-command-id trick and adds the one
    // thing this path lacked: a host that is still finishing the command before
    // this one answers "already in progress", and that is a wait, not a failure.
    const { commandId, receipt } = await sendTourCommand(driver, 'play', {}, { label: `resume-${sends.length}` });
    receipts.push({ commandId, status: String(receipt.status ?? 'never-received'), ...(receipt.reason ? { reason: String(receipt.reason) } : {}) });
    if (String(receipt.status) !== 'rendered') {
      throw new StepFailure(`"Continue the lesson" was ${String(receipt.status ?? 'never answered')}${receipt.reason ? `: ${String(receipt.reason)}` : ''}, so the chapter was never put back in front of the wearer.`,
        { parked, receipts, before: before?.tour ?? null });
    }
    // No `.catch`: a swallowed timeout here turned a sixty-second wait for a
    // lesson that never moved into a panel read that matched, which is the
    // difference between this step catching a dropped command and reporting
    // one as a working conversation.
    const panel = await driver.waitForPanel(what, candidate => candidate?.tour?.navigating === false && candidate?.tour?.[edge] === true, 60_000);
    seen.push(...await driver.newDiagnostics());
    return panel;
  };

  const first = resumeEdge({ active: before?.tour?.active === true, autoplay: before?.tour?.autoplay === true });
  if (!first) {
    throw new StepFailure('The lesson was already running when "continue the lesson" was asked, so nothing about a resume could be proven here.',
      { parked, before: before?.tour ?? null });
  }
  let after = await play(`the lesson to pick back up on chapter ${parked.step + 1} (${first} turning on)`, first);
  // A rejoin puts the chapter back on screen and leaves autoplay off
  // (inspection-tour-client.ts:90). That is not yet what a wearer means by
  // "continue the lesson": the scene returns and nothing ever moves again. A
  // second play on the now-active lesson is the toggle branch, and arms it.
  if (after?.tour?.autoplay !== true) {
    progress('the lesson rejoined its chapter but is not running; asking it to play again');
    after = await play(`the rejoined lesson to start running again on chapter ${parked.step + 1}`, 'autoplay');
  }
  const resumed = tourResumed(parked, after);
  if (!resumed.ok) {
    throw new StepFailure(`"Continue the lesson" did not pick it back up: ${resumed.reason}.`,
      { parked, before: before?.tour ?? null, after: after?.tour ?? null, presenting: after?.xrStartup?.presenting ?? null, receipts });
  }
  // The flags agree. Now the page has to agree too, because every one of them
  // is also true of a lesson that was restarted from the beginning and of a
  // player that changed its own bookkeeping and drew nothing.
  const evidence = resumeEvidence(seen, parked.step);
  if (evidence.restarted) {
    const opening = Number(evidence.restarted.detail?.opening ?? 0);
    throw new StepFailure(`"Continue the lesson" restarted it at chapter ${opening + 1} instead of carrying on from chapter ${parked.step + 1}, so the wearer would sit through everything they had already watched.`,
      { parked, receipts, restarted: evidence.restarted.detail ?? {} });
  }
  if (!evidence.shown && !evidence.resumed) {
    throw new StepFailure(`The panel reported the lesson running again on chapter ${parked.step + 1}, but the page never recorded drawing that chapter or starting to run on it, so nothing proves the wearer got their lesson back.`,
      { parked, receipts, tourRecords: seen.filter(entry => entry.kind === 'tour').map(entry => entry.detail ?? {}).slice(-6) });
  }
  return { kind: 'tour', via: `control_tour ${sends.join(' then ')}`, chapter: parked.step + 1, lesson: parked.selectedId,
    rejoined: first === 'active', presenting: after?.xrStartup?.presenting === true, receipts,
    onScreen: evidence.shown ? `the page redrew chapter ${parked.step + 1}` : `the page started running on chapter ${parked.step + 1}`,
    notRestarted: true };
}

/**
 * The toolbar's route to the full Mol* viewer, and back into VR.
 *
 * `open in mol star` resolves to the same `open-workbench` action the menu row
 * sends. Inside a session the page announces the transfer, ends the session and
 * navigates this tab to `/detailed`; outside one it opens the viewer on the
 * Mac, which the wearer cannot see. The `workbench` diagnostic's `here` field
 * is the difference, and it is asserted rather than assumed: the spoken route
 * has taken the Mac branch while the toolbar row took the headset one.
 *
 * Coming back is a one-tap hint. The `/detailed` page's "Back
 * to headset view" link returns this tab to the companion, which arms Enter VR
 * so the next tap on the page background is spent on it -- a navigation carries
 * no transient activation into the next document, so the tap that followed the
 * link cannot be.
 */
async function stepMolstar(driver: Driver): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  await driver.say('open in mol star');
  const deadline = Date.now() + 60_000;
  let handoff: DiagnosticRecord | undefined;
  for (;;) {
    handoff = (await driver.newDiagnostics()).filter(entry => entry.kind === 'workbench').at(-1);
    if (handoff) break;
    if (Date.now() >= deadline) throw new StepFailure('The page recorded no workbench handoff within 60 s of the spoken command.');
    await settle(2);
  }
  if (handoff.detail?.here !== true) {
    throw new StepFailure('"open in mol star" opened the workbench on the Mac rather than in the headset, so the wearer saw nothing.',
      { workbench: handoff.detail });
  }
  await waitForPath(driver, '/detailed', 90_000);
  // The session has ended, so the display sleeps within seconds; wake it or
  // the capture is black.
  await driver.wakeDisplay();
  const detailedShot = await driver.capture('molstar-detailed');

  // The same return leg the `return` step and `enter` run, so the
  // round trip and the rescue cannot drift apart about how to come home.
  const leg = await returnFromDetailedView(driver);

  // The hint expires, so read it rather than assuming it armed. The leg above
  // reads it once; this waits for it, because the whole point of this step is
  // that one tap on the background re-enters.
  const armed = await waitForEvaluate(driver, '(() => document.body.dataset.reenterXr || "none")()', value => value === 'armed', 30_000);
  const viewport = await driver.evaluate('(() => ({ w: innerWidth, h: innerHeight }))()') as { w: number; h: number };
  await driver.click(Math.round(viewport.w / 2), Math.max(8, Math.round(viewport.h * 0.08)));
  const panel = await waitForPresentingPanel(driver, 'the session to come back after Mol*');
  const backShot = await driver.capture('molstar-reentered');
  return {
    detail: 'Opened Mol* in the headset, came back through the Back link and re-entered VR with one tap.',
    evidence: { workbench: handoff.detail, detailedCapture: detailedShot.path, reentryHint: armed,
      returnLeg: { from: leg.from, ...(leg.to ? { to: leg.to } : {}), ...(leg.reentryHint ? { firstHintRead: leg.reentryHint } : {}) },
      reenteredCapture: backShot.path, xrStartup: panel?.xrStartup ?? null },
  };
}

async function waitForPath(driver: PathReadingHost, path: string | readonly string[], timeoutMs: number): Promise<string> {
  const paths = typeof path === 'string' ? [path] : [...path];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const target = await driver.stereofoldTarget();
    const found = (() => { try { return new URL(target?.url ?? '').pathname; } catch { return ''; } })();
    if (paths.some(prefix => found.startsWith(prefix))) return found;
    if (Date.now() >= deadline) throw new StepFailure(`The headset browser never reached ${paths.join(' or ')} (it is on ${found || 'no page'}).`);
    await settle(2);
  }
}

async function waitForEvaluate(driver: Driver, expression: string, accept: (value: unknown) => boolean, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try { last = await driver.evaluate(expression); } catch { last = undefined; }
    if (accept(last)) return last;
    if (Date.now() >= deadline) throw new StepFailure(`The page never answered ${expression} acceptably (last ${JSON.stringify(last)}).`);
    await settle(1);
  }
}

async function stepExit(driver: Driver): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  const before = await driver.companionPanel();
  if (before?.xrStartup?.presenting !== true) {
    return { detail: 'No session was presenting, so there was nothing to leave.', evidence: { xrStartup: before?.xrStartup ?? null } };
  }
  const leave = await driver.locate('button', 'Leave headset view');
  let via: string;
  if (leave) {
    await driver.click(leave.x, leave.y);
    via = 'trusted click';
  } else {
    // While presenting, the 2D layer's Leave button is in the DOM at zero size
    // (measured), so no pointer can reach it. Ending a session
    // needs no user activation, so a DOM click on the element is enough.
    const clicked = await driver.evaluateForAction(`(() => {
      const node = Array.from(document.querySelectorAll('button')).find(b => /Leave headset view/.test(b.textContent || ''));
      if (!node) return 'missing';
      node.click(); return 'clicked';
    })()`);
    if (clicked !== 'clicked') throw new StepFailure('The page shows no "Leave headset view" button.');
    via = 'DOM click (button had no size while presenting)';
  }
  // Leaving is a size-aware wait, not a fixed 30 s.
  //
  // Ending the session tears down the presentation representations and redraws
  // the 2D page for whatever is loaded. With the wall's 40,908 atom sites the
  // click landed, a fixed 30 s ran out, and the session ended about a minute
  // later — a working run reported as a failure. `PANEL_READY_WAIT` keeps 30 s
  // as its floor, so a run that never grew waits exactly as before.
  //
  // A session can also be holding a 178,236-triangle mesh with an honest zero
  // atom sites, which the atom-site wait describes as "no count was given" and
  // gives the 30 s base to.
  const load = livePanelLoad(driver);
  const timeoutMs = panelWaitMs(load, PANEL_READY_WAIT);
  progress(`exit: waiting for the session to end · ${describePanelWait(load, PANEL_READY_WAIT)}`);
  const panel = await driver.waitForPanel('the session to end', candidate => candidate?.xrStartup?.presenting !== true, timeoutMs);
  return { detail: `Left the headset view via ${via}; the session is idle.`,
    evidence: { xrStartup: panel?.xrStartup ?? null, via,
      atomSites: load.atomSites ?? null, triangles: load.triangles ?? null,
      timeoutSeconds: Math.round(timeoutMs / 1_000) } };
}

/**
 * The one step that cannot be driven blind.
 *
 * `ask` holds the grip, says a sentence and waits to be answered out loud. On a
 * host with no recognizer it produces a silent pass-shaped failure — the press
 * lands, nothing is transcribed, and the run reports the timeout rather than
 * the cause. Two of the six readiness items decide that outright, so the step
 * is refused with their own next-action sentences as the evidence instead of
 * being attempted and misdiagnosed.
 */
export function askRefusal(readiness: Readiness | undefined): string | undefined {
  if (!readiness) return undefined;
  const blocking = readinessBlockingSentences(readiness, ['transcription', 'replies']);
  return blocking.length === 0 ? undefined
    : `The ask step needs the wearer heard and answered aloud, and this host can do neither yet. ${blocking.join(' ')}`;
}

async function runStep(driver: Driver, step: DriveStep, readiness?: Readiness): Promise<{ detail: string; evidence: Record<string, unknown> }> {
  // This is the step boundary check. Individual write helpers check again at
  // their own final action boundary because a step may wait for many seconds.
  await driver.assertProximitySafe();
  if (step === 'ask') {
    const refusal = askRefusal(readiness);
    if (refusal) throw new StepFailure(refusal, { readiness: readiness?.items.filter(item => item.state === 'missing') ?? [] });
  }
  if (step.startsWith('menu:')) return await stepMenu(driver, step);
  if (step.startsWith('aim:')) return await stepAim(driver, step);
  switch (step) {
    case 'open': return await stepOpen(driver);
    case 'enter': return await stepEnter(driver);
    case 'return': return await stepReturn(driver);
    case 'tour': return await stepTour(driver);
    case 'grow': return await stepGrow(driver);
    case 'voice': return await stepVoice(driver);
    case 'ask': return await stepAsk(driver);
    case 'molstar': return await stepMolstar(driver);
    case 'exit': return await stepExit(driver);
    default: return await stepCommandsWithReceipts(driver, step);
  }
}

// ------------------------------------------------------------------ main

export async function readGate(driver: GateReadHost): Promise<DriveGate> {
  let presenting: boolean | null = null;
  try {
    const panels = (await driver.inspectionState()).panels;
    if (Array.isArray(panels)) presenting = panels.some(panel => panel?.xrStartup?.presenting === true);
  } catch { /* an unknown session state is also unsafe at the pre-run gate */ }

  // Read the sensor last: this is the value that guards the next action, so no
  // slower state read sits between it and the write.
  let power: { code: number; stdout: Buffer; stderr: string } | undefined;
  try { power = await driver.adbShell('dumpsys', 'power'); } catch { /* fail closed below */ }
  const text = power?.stdout.toString('utf8') ?? '';
  const proximityPositive = power && power.code === 0 && /mProximityPositive=/u.test(text)
    ? /mProximityPositive=true/u.test(text) : null;
  return { proximityPositive, presenting, readAt: nowIso() };
}

/** Check the latest sensor value immediately before a headset-side action. */
export async function assertProximitySafe(driver: GateReadHost): Promise<DriveGate> {
  const gate = await readGate(driver);
  if (gate.proximityPositive === true) throw new StepFailure(STOPPED_WORN, { gate });
  if (gate.proximityPositive !== false) throw new StepFailure(STOPPED_PROXIMITY_UNREADABLE, { gate });
  if (gate.presenting === null) throw new StepFailure(STOPPED_SESSION_UNREADABLE, { gate });
  return gate;
}

export async function executeDriveStep(driver: Driver, step: DriveStep, readiness?: Readiness): Promise<StepResult> {
  const stepStarted = nowIso();
  progress(`--- ${step}`);
  const lineMarker = driver.lines.length, responseMarker = driver.responses.length;
  const ringMark = driver.ringMark();
  const captureMark = driver.captureNotes.length;
  let ok = true; let detail = ''; let evidence: Record<string, unknown> = {};
  let stoppedByGate = false;
  try { ({ detail, evidence } = await runStep(driver, step, readiness)); }
  catch (error) {
    ok = false;
    detail = error instanceof Error ? error.message : String(error);
    if (error instanceof StepFailure) {
      evidence = { ...error.evidence };
      stoppedByGate = Boolean(error.evidence.gate);
    }
  }
  // Every step is photographed, passing or failing. A failure that is not
  // photographed is the one that gets misdiagnosed: the tracking
  // modal was legible only in the wearer view.
  if (!stoppedByGate && typeof evidence.capture !== 'string') {
    try {
      const shot = await driver.capture(step);
      evidence = { ...evidence, capture: shot.path, captureVia: shot.via, ...(shot.note ? { captureNote: shot.note } : {}) };
    } catch (error) {
      if (error instanceof StepFailure && error.evidence.gate) {
        ok = false;
        detail = error.message;
        evidence = { ...evidence, gate: error.evidence.gate };
        stoppedByGate = true;
      } else {
        evidence = { ...evidence, captureError: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  try { await driver.drainDiagnostics(); }
  catch (error) {
    ok = false;
    if (!detail) detail = 'The headset diagnostics ring could not be drained.';
    evidence = { ...evidence, ringError: error instanceof Error ? error.message : String(error) };
  }
  evidence = { ...evidence, ...(driver.effectiveUrl === undefined ? {} : { effectiveUrl: redactUrl(driver.effectiveUrl) }),
    ring: driver.ringSummarySince(ringMark) };
  // Apply the capture verdict once for every step, including captures stored
  // inside tour chapters or grow tiers. Non-black fallback notes are advisory.
  const blackCapture = driver.captureNotes.slice(captureMark).find(shot => /\bframe is black\b/iu.test(shot.note));
  const captureNote = blackCapture?.note ?? evidence.captureNote;
  if (typeof captureNote === 'string' && /\bframe is black\b/iu.test(captureNote)) {
    if (ok) detail = captureNote;
    else if (!detail.includes(captureNote)) detail += ` Capture failed: ${captureNote}`;
    ok = false;
    evidence = { ...evidence, captureNote, ...(blackCapture ? { failedCapture: blackCapture.path } : {}) };
  }
  // The method and the verdict come from the step's own evidence, so a step
  // that reached the page and did not check its outcome cannot be logged as
  // if it had. Anything without a method drove no hook and is neither.
  const method = typeof evidence.method === 'string' ? evidence.method : null;
  const verified = method === null ? null : evidence.verified === true;
  return {
    step, ok, ...(ok ? {} : { failure: detail }), method, verified,
    ...(evidence.outcome === 'refused' ? { outcome: 'refused' as const } : {}),
    detail, startedAt: stepStarted, endedAt: nowIso(), evidence,
    consoleErrors: driver.errorsSince(lineMarker), failedResponses: driver.responsesSince(responseMarker),
  };
}

export function formatDriveStep({ ok, step, method, verified, detail, evidence }: StepResult): string {
  if (ok && verified && evidence.outcome === 'refused') detail = `refused: ${evidence.reason}`;
  return `${ok ? 'pass' : 'FAIL'}  ${step.padEnd(14)}  ${method ? `[${method}${verified ? ' verified' : ' UNVERIFIED'}]  ` : ''}${detail}`;
}

async function main() {
  if (process.argv.slice(2).includes('--help')) { console.log(DRIVE_USAGE); return; }
  let options: DriveOptions;
  try { options = parseDriveArguments(process.argv.slice(2)); }
  catch (error) { console.error((error as Error).message); process.exit(64); return; }

  const adb = await findAdb({ env: process.env });
  if (!adb) { console.error('No adb was found. Set STEREOFOLD_ADB_BIN to its absolute path.'); process.exit(64); return; }
  const port = devtoolsPort();
  await run(adb, driveAdbArguments(['forward', `tcp:${port}`, 'localabstract:chrome_devtools_remote']));

  // A driver started in the same breath as the host used to die on ENOENT for
  // a file that was seconds away. `--wait-for-host` waits for it; without the
  // flag the clear message stands, because "no host is running" is usually
  // what is actually wrong.
  const state = await readControlState(options.sharePath, { waitForHost: options.waitForHost === true });
  const driver = new Driver(state, adb, port, nodeDevtoolsTransport(), options);

  const gate = await readGate(driver);
  const decision = decideDriveRefusal(gate, options);
  if (!decision.run) { console.error(decision.reason); process.exit(3); return; }
  if (decision.note) progress(decision.note);

  await mkdir(options.outDir, { recursive: true });
  // Start from what the headset has already reported, so a step's diagnostics
  // are its own rather than the whole session's backlog.
  await driver.drainDiagnostics();
  const runRingMark = driver.ringMark();

  // One call, before anything is pressed. The block is printed
  // whatever it says — a run that is about to fail for a missing recognizer
  // should have said so in its first six lines, not in a step's timeout.
  let readiness: Readiness | undefined;
  try {
    const answer = await driver.agent('get_readiness', options.steps.includes('ask') ? { speechCheck: true } : {});
    readiness = (answer.structuredContent as { readiness?: Readiness } | undefined)?.readiness;
    if (readiness) for (const line of formatReadiness(readiness).split('\n')) progress(line);
    else progress('This host answered get_readiness with no readiness block; it is older than this script.');
  } catch (error) {
    // Not fatal: every step below still reports its own failure, and a host too
    // old to answer must not be unable to be driven at all.
    progress(`readiness unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const startedAt = nowIso();
  const results: StepResult[] = [];
  for (const step of options.steps) {
    const result = await executeDriveStep(driver, step, readiness);
    results.push(result);
    console.log(formatDriveStep(result));
    if (!result.ok) break; // A failed step leaves the headset somewhere the next step does not expect.
  }

  driver.session?.close();
  const report = buildReport({ startedAt, endedAt: nowIso(), gate, options, steps: results,
    ring: driver.ringSummarySince(runRingMark), effectiveUrl: driver.effectiveUrl });
  const reportPath = join(options.outDir, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'}  ${results.length} step${results.length === 1 ? '' : 's'}. Wrote ${reportPath}`);
  for (const line of formatDriveSummary(report.drive)) console.log(`  ${line}`);
  for (const failure of report.failures) console.error(`  ${failure}`);
  process.exit(report.ok ? 0 : 1);
}

// Importing this file for its pure helpers must not drive a headset.
if (process.argv[1]?.endsWith('headset-drive.ts')) void main();
