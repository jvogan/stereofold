/**
 * The unattended headset driver's plan, its refusal rule and its report.
 *
 * Nothing here touches a headset. What is worth testing without one is
 * everything that decides whether input reaches a person's eyes, what the run
 * will actually send, and whether the answer it writes down can be trusted:
 * the flags, the gate, the step plan, the tracking-loss reading, and the shape
 * of `report.json`.
 */
import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// @ts-ignore Browser-only pure command grammar shared with the immersive toolbar.
import { voiceCommandFromTranscript } from '../../lab/browser-roundtrip/voice-command.mjs';
import { TOOLS as COMPANION_TOOLS } from '../src/inspection-companion-http.js';
import { ALLOWED_TOOLS as LAN_ALLOWED_TOOLS } from '../src/inspection-lan.js';
import { PUSH_TO_TALK_AUDIO_TOOL, containerExtension } from '../src/push-to-talk-transcribe.js';

import { SHARE_ENDED_MESSAGE } from '../src/companion-startup.js';
import { ASK_TURNS, DEFAULT_DRIVE_STEPS, DRIVE_STEPS, DriveUsageError, COMPANION_POLL_MS, GROW_BASE_WAIT_MS, GROW_MAX_WAIT_MS,
  GROW_MS_PER_THOUSAND_SITES, GROW_MS_PER_MEGABYTE, GROW_MS_PER_TEN_THOUSAND_TRIANGLES, GROWTH_CAPTION_MS, growRefusalCaptureWaitMs,
  BYTES_PER_MEGABYTE, GROW_DENSITY_BASE_WAIT_MS, GROW_DENSITY_MAX_WAIT_MS,
  DENSITY_EXPECTED_TRIANGLES, DENSITY_TRIANGLE_TOLERANCE, densityWaitMs, describeDensityWait,
  assessDensityOpen, describeRingEntry, densityOpenLost, mergeRingEntries, watchDensityOpen, DENSITY_OPEN_POLL_MS,
  growWaitMs, growTierWaitMs, growSize, growPhaseRecords, growLanded, growStalledPhase, liveAtomSites, sendGrowCommand,
  HEADSET_PRESS_MIME, PARK_PAUSE_ATTEMPTS, PARK_REFUSED_ADVICE,
  PARK_WAIT_MS, PRESS_CHUNK_MINIMUM, RECEIPT_PENDING, SHARE_ENDED_ON_PAGE,
  TRACKING_LOSS_ADVICE, TRANSCRIPT_EXTRA_ALLOWANCE, TRANSCRIPT_MATCH_THRESHOLD,
  VOICE_PHRASES, INJECTED_TRANSCRIPT_ORIGIN, buildReport, chunkAudioBase64,
  clipReachedOutput, decideDriveRefusal, describeSpeechFailure, detectHiddenSession, detectTrackingLoss, isCommandInFlight,
  isNarrationRecord, originCacheHolds, panelIsCommandable, parkedTour,
  menuStepArguments, menuExpansionPlan, isExitOnlyRun, looksLikeAdbSerial, MENU_EXPAND_ROW,
  parseDriveArguments, planOpen, planPark, pressChunks, replyReceipts, resumeEdge, resumeEvidence, sendTourCommand,
  speechFailures, stepCommands, summarizeRun, tourParked, tourPlan, tourResumed, transcriptMatches,
  type DiagnosticRecord, type StepResult, type TourPark,
  inFlightAttempts,
  TOUR_DEFAULT_DWELL_MS, TOUR_PANEL_WAIT_MS, TOUR_STALL_MARGIN_MS,
  companionPanelOf, needsPairingRecovery, tourIsAutoplaying, tourSceneShown, waitForAvailablePanel, watchAutoplayedTour,
  ENTER_VR_ENABLE_POLL_MS, ENTER_VR_ENABLE_WAIT_MS, waitForEnabledEnterButton, stepEnter, stepReturn,
  OBSERVE_IMMERSIVE_MENU_EXPRESSION, decideAlreadyPresenting,
  currentHeadsetPath, isDetailedViewPath, returnFromDetailedView,
  waitForPresentingPanel, assertProximitySafe, captureFileName, Driver, driveAdbArguments,
  GUARDIAN_DIALOG_ACTIVITY, GUARDIAN_DIALOG_ADVICE, detectGuardianDialog, readGuardianDialog,
  type DriveGate,
} from '../scripts/headset-drive.js';
import { describePanelWait, panelWaitMs, PANEL_READY_WAIT } from '../scripts/panel-wait.js';

const share = '/home/example/.stereofold/quest-share.json';
const base = [share, '--out', '/tmp/drive'];
const execFileAsync = promisify(execFile);

describe('parseDriveArguments', () => {
  it('takes the share path positionally and runs the default plan', () => {
    const options = parseDriveArguments(base);
    expect(options.sharePath).toBe(share);
    expect(options.outDir).toBe('/tmp/drive');
    expect(options.steps).toEqual([...DEFAULT_DRIVE_STEPS]);
    expect(options.resumeSession).toBe(false);
  });

  it('takes an atom-site count so the wait after entry can scale with the structure', () => {
    expect(parseDriveArguments(base).atomSites).toBeUndefined();
    expect(parseDriveArguments([...base, '--atom-sites', '40908']).atomSites).toBe(40_908);
    expect(() => parseDriveArguments([...base, '--atom-sites', '0'])).toThrow(DriveUsageError);
    expect(() => parseDriveArguments([...base, '--atom-sites', 'lots'])).toThrow(/--atom-sites/);
  });

  it('needs the share path, because a driver aimed at the wrong session is worse than none', () => {
    expect(() => parseDriveArguments(['--out', '/tmp/drive'])).toThrow(DriveUsageError);
  });

  it('needs an output directory, so captures and report.json have somewhere to land', () => {
    expect(() => parseDriveArguments([share])).toThrow(/--out/);
  });

  it('refuses a second positional rather than silently using one of them', () => {
    expect(() => parseDriveArguments([share, '/other/share.json', '--out', '/tmp/drive'])).toThrow(/one share path/);
  });

  it('runs the whole experience in the order a wearer would meet it', () => {
    expect([...DEFAULT_DRIVE_STEPS]).toEqual(['open', 'enter', 'tour', 'spin', 'stop', 'quality', 'voice', 'ask', 'molstar', 'exit']);
  });

  it('reads a step list and keeps the order asked for', () => {
    expect(parseDriveArguments([...base, '--steps', 'enter,spin,exit']).steps).toEqual(['enter', 'spin', 'exit']);
  });

  it('accepts a live spatial-menu row id as a step', () => {
    expect(parseDriveArguments([...base, '--steps', 'enter,menu:menu,menu:move,exit']).steps)
      .toEqual(['enter', 'menu:menu', 'menu:move', 'exit']);
  });

  it('refuses an empty or malformed spatial-menu row id', () => {
    expect(() => parseDriveArguments([...base, '--steps', 'menu:'])).toThrow(/menu:<id>/);
    expect(() => parseDriveArguments([...base, '--steps', 'menu:Move row'])).toThrow(/menu:<id>/);
  });

  it('names the unknown step instead of running a shorter pass than asked for', () => {
    expect(() => parseDriveArguments([...base, '--steps', 'enter,levitate'])).toThrow(/levitate/);
  });

  it('rejects an empty step list', () => {
    expect(() => parseDriveArguments([...base, '--steps', ' , '])).toThrow(DriveUsageError);
  });

  it('rejects an unknown option instead of ignoring it', () => {
    expect(() => parseDriveArguments([...base, '--fast'])).toThrow(/--fast/);
  });

  it('catches a flag that swallowed the next flag as its value', () => {
    expect(() => parseDriveArguments([share, '--out', '--steps', 'enter'])).toThrow(/--out needs a value/);
  });

  it('bounds --settle so a typo cannot park the headset in a session for an hour', () => {
    expect(parseDriveArguments([...base, '--settle', '0']).settleSeconds).toBe(0);
    expect(() => parseDriveArguments([...base, '--settle', '600'])).toThrow(DriveUsageError);
    expect(() => parseDriveArguments([...base, '--settle', 'soon'])).toThrow(DriveUsageError);
  });
});

describe('decideDriveRefusal', () => {
  const options = { resumeSession: false };
  const readAt = '2026-09-11T08:00:00.000Z';

  it('runs when the headset is off a face and no session is up', () => {
    expect(decideDriveRefusal({ proximityPositive: false, presenting: false, readAt }, options).run).toBe(true);
  });

  it('refuses when a session is already presenting, because a person is the usual reason', () => {
    const decision = decideDriveRefusal({ proximityPositive: false, presenting: true, readAt }, options);
    expect(decision.run).toBe(false);
    expect(decision.reason).toMatch(/--resume-session/);
  });

  it('lets the operator adopt an abandoned session with --resume-session', () => {
    expect(decideDriveRefusal({ proximityPositive: false, presenting: true, readAt }, { resumeSession: true }).run).toBe(true);
  });

  it('refuses a worn headset even with --resume-session, because that flag is about sessions, not faces', () => {
    const decision = decideDriveRefusal({ proximityPositive: true, presenting: true, readAt }, { resumeSession: true });
    expect(decision.run).toBe(false);
    expect(decision.reason).toMatch(/face/);
  });

  it('refuses a worn headset that is not presenting: the wearer is still wearing it', () => {
    expect(decideDriveRefusal({ proximityPositive: true, presenting: false, readAt }, options).run).toBe(false);
  });
});

describe('per-action proximity gate', () => {
  it('targets forwarding with the documented serial before Android’s fallback', () => {
    const forward = ['forward', 'tcp:9222', 'localabstract:chrome_devtools_remote'];
    expect(driveAdbArguments(forward, { STEREOFOLD_ADB_SERIAL: ' usb-headset ', ANDROID_SERIAL: '127.0.0.1:5555' }))
      .toEqual(['-s', 'usb-headset', ...forward]);
    expect(driveAdbArguments(forward, { STEREOFOLD_ADB_SERIAL: ' ', ANDROID_SERIAL: ' fallback-headset ' }))
      .toEqual(['-s', 'fallback-headset', ...forward]);
    expect(driveAdbArguments(forward, {})).toEqual(forward);
    expect(driveAdbArguments(forward, {STEREOFOLD_QUEST_SERIAL:'192.168.77.9:5555'}))
      .toEqual(['-s','192.168.77.9:5555',...forward]);
  });

  it.each([
    { STEREOFOLD_ADB_SERIAL: ' usb-headset ' },
    { STEREOFOLD_ADB_SERIAL: 'usb-headset', ANDROID_SERIAL: '127.0.0.1:5555' },
    { ANDROID_SERIAL: 'usb-headset' },
  ])('reads proximity from the selected headset through the real Driver shell path (%j)', async env => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-driver-serial-'));
    const fakeAdb = join(directory, 'fake-adb');
    try {
      // Model a ready USB target plus an offline proxy: an unscoped command
      // cannot read proximity, and the proxy must never override the USB name.
      await writeFile(fakeAdb, '#!/bin/sh\n'
        + 'if [ "$1" = "-s" ] && [ "$2" = "usb-headset" ] && [ "$3" = "shell" ] && [ "$4" = "dumpsys" ] && [ "$5" = "power" ]; then\n'
        + '  printf "%s\\n" "mProximityPositive=false"\n'
        + 'elif [ "$1" = "-s" ] && [ "$2" = "usb-headset" ] && [ "$3" = "exec-out" ] && [ "$4" = "screencap" ] && [ "$5" = "-p" ]; then\n'
        + '  dd if=/dev/zero bs=1024 count=1 2>/dev/null\n'
        + 'else\n  printf "%s\\n" "error: ambiguous or offline device" >&2\n  exit 1\nfi\n');
      await chmod(fakeAdb, 0o755);
      const driver = new Driver({} as any, fakeAdb, 0, {} as any, parseDriveArguments([share, '--out', directory]), env);
      driver.inspectionState = async () => ({ panels: [] });
      await expect(assertProximitySafe(driver)).resolves.toMatchObject({ proximityPositive: false, presenting: false });
      driver.agent = async () => { throw Error('Host capture unavailable'); };
      const capture = await driver.capture('serial');
      expect(capture.via).toBe('adb screencap');
      expect((await readFile(capture.path)).byteLength).toBe(1024);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('re-reads a fake adb sensor between steps and stops before the next action', async() => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-gate-'));
    const stateFile = join(directory, 'reads');
    const fakeAdb = join(directory, 'fake-adb');
    await writeFile(fakeAdb, '#!/bin/sh\n'
      + 'count=$(cat "$FAKE_ADB_STATE" 2>/dev/null || printf \'0\')\n'
      + 'count=$((count + 1))\n'
      + 'printf \'%s\' "$count" > "$FAKE_ADB_STATE"\n'
      + 'if [ "$count" -eq 1 ]; then\n'
      + '  printf \'%s\n\' \'mProximityPositive=false\'\n'
      + 'else\n'
      + '  printf \'%s\n\' \'mProximityPositive=true\'\n'
      + 'fi\n');
    await chmod(fakeAdb, 0o755);

    const host = {
      async adbShell(...args: string[]) {
        const result = await execFileAsync(fakeAdb, args, { env: { ...process.env, FAKE_ADB_STATE: stateFile } });
        return { code: 0, stdout: Buffer.from(String(result.stdout)), stderr: String(result.stderr ?? '') };
      },
      async inspectionState() { return { panels: [] }; },
    };
    const gates: DriveGate[] = [];
    let actions = 0;
    const guardedStep = async() => { gates.push(await assertProximitySafe(host)); actions += 1; };

    try {
      await guardedStep();
      await expect(guardedStep()).rejects.toThrow('stopped: the headset is being worn');
      expect(actions).toBe(1);
      expect(gates[0]?.proximityPositive).toBe(false);
      expect(typeof gates[0]?.readAt).toBe('string');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed and keeps the unreadable gate in the error evidence', async() => {
    const host = {
      async adbShell() { return { code: 1, stdout: Buffer.from(''), stderr: 'offline' }; },
      async inspectionState() { return { panels: [] }; },
    };
    await expect(assertProximitySafe(host)).rejects.toMatchObject({
      message: 'stopped: the proximity gate could not be read',
      evidence: { gate: { proximityPositive: null, presenting: false, readAt: expect.any(String) } },
    });
  });

  it('fails closed when session state is malformed even if proximity is readable', async() => {
    const host = {
      async adbShell() { return { code: 0, stdout: Buffer.from('mProximityPositive=false\n'), stderr: '' }; },
      async inspectionState() { return {}; },
    };
    await expect(assertProximitySafe(host)).rejects.toMatchObject({
      message: 'stopped: the headset session state could not be read',
      evidence: { gate: { proximityPositive: false, presenting: null, readAt: expect.any(String) } },
    });
  });
});

describe('capture names and diagnostics ring accounting', () => {
  it('adds a run-local ordinal to every capture name', () => {
    expect(captureFileName('tour', 1)).toBe('tour-001.png');
    expect(captureFileName('tour', 2)).toBe('tour-002.png');
    expect(captureFileName('tour', 1)).not.toBe(captureFileName('tour', 2));
  });

  it('drains every ring page and advances the Mac cursor independently of page sequences', async() => {
    const pages = [
      { entries: [{ sequence: 1, seq: 9, kind: 'before-navigation' }], cursor: 1, more: true, summary: { dropped: 0 } },
      { entries: [{ sequence: 2, seq: 1, kind: 'after-navigation' }], cursor: 2, more: false, summary: { dropped: 1 } },
      { entries: [], cursor: 2, more: false, summary: { dropped: 1 } },
    ];
    const driver = new Driver({} as any, 'fake-adb', 0, {} as any, parseDriveArguments(base));
    const calls: Array<Record<string, unknown>> = [];
    driver.agent = async(_name: string, args: Record<string, unknown> = {}) => {
      calls.push(args);
      return { content: [], structuredContent: pages.shift() } as any;
    };
    const mark = driver.ringMark();
    const drained = await driver.drainDiagnostics();
    const summary = driver.ringSummarySince(mark);
    expect(drained.map(entry => entry.kind)).toEqual(['before-navigation', 'after-navigation']);
    expect(calls.map(call => call.sinceSequence)).toEqual([0, 1, 2]);
    expect(summary).toMatchObject({ identity: 'headset-diagnostics', entriesRead: 2, evicted: true, cursor: 2 });
  });
});

describe('stepCommands', () => {
  it('starts a tour with start and nothing else, because the chapter count and lesson id are read live', () => {
    expect(stepCommands('tour')).toEqual([{ tool: 'control_tour', arguments: { action: 'start' } }]);
  });

  it('sends spin and stop as motion patches', () => {
    expect(stepCommands('spin')[0]).toEqual({ tool: 'update_inspection',
      arguments: { change: { kind: 'motion', patch: { state: 'spin' } } } });
    expect(stepCommands('stop')[0]?.arguments).toMatchObject({ change: { patch: { state: 'stop' } } });
  });

  it('raises quality and then puts it back, so a pass does not leave the wearer somewhere new', () => {
    const quality = stepCommands('quality');
    expect(quality.map(command => (command.arguments.change as { patch: { level: string } }).patch.level))
      .toEqual(['best', 'balanced']);
    expect(quality.every(command => command.tool === 'update_inspection')).toBe(true);
  });

  it('sends no agent command for the page gestures: entry, exit, opening, the menu and the Mol* handoff', () => {
    for (const step of ['open', 'enter', 'exit', 'voice', 'menu:move', 'molstar'] as const) {
      expect(stepCommands(step)).toEqual([]);
    }
  });
});

describe('menuStepArguments', () => {
  it('reads rows and presses once without awaiting the page action', () => {
    const action = menuStepArguments('menu:move');
    const rows = [{ id: 'menu', label: 'Menu', active: true }, { id: 'move', label: 'Move', active: true }];
    const pressed: string[] = [];
    const page = { __stereofoldMenu: { rows: () => rows, press: (id: string) => { pressed.push(id); return true; } } };
    const result = Function('globalThis', `return ${action.expression}`)(page);
    expect(action).toMatchObject({ id: 'move', captureName: 'menu-move' });
    expect(result).toEqual({ status: 'pressed', rows, before: { rows, state: null } });
    expect(pressed).toEqual(['move']);
    expect(action.expression).not.toMatch(/\bawait\b/u);
  });

  it('reports a missing hook without attempting a press', () => {
    const action = menuStepArguments('menu:menu');
    expect(Function('globalThis', `return ${action.expression}`)({}))
      .toEqual({ status: 'no-hook', rows: [] });
  });
});

describe('a menu row that lives behind Menu', () => {
  const collapsed = [{ id: 'talk', label: 'Talk', active: true }, { id: 'tour', label: 'Tour', active: true },
    { id: 'reset', label: 'Reset', active: true }, { id: 'room', label: 'Room', active: true },
    { id: 'menu', label: 'Menu', active: true }, { id: 'move', label: 'Move', active: true }];
  const expanded = [{ id: 'menu', label: 'Close', active: true }, { id: 'molstar', label: 'Mol*', active: true },
    { id: 'sequence', label: 'Sequence', active: true }];

  it('reports an absent row with the rows that are showing, instead of throwing in the page', () => {
    const action = menuStepArguments('menu:sequence');
    const page = { __stereofoldMenu: { rows: () => collapsed, press: () => { throw Error('must not press'); } } };
    expect(Function('globalThis', `return ${action.expression}`)(page))
      .toEqual({ status: 'absent', rows: collapsed, before: { rows: collapsed, state: null } });
  });

  it('presses Menu first when the wanted row is not on the collapsed panel', () => {
    expect(menuExpansionPlan('sequence', collapsed)).toMatchObject({ expand: true });
    expect(menuExpansionPlan('sequence', collapsed).reason).toMatch(/collapsed/);
  });

  it('leaves menu:menu alone, because that step is the toggle itself', () => {
    // Pressing Menu to reach Menu would double a press an operator asked for
    // exactly once, and `menu:menu` is how a plan opens the grid deliberately.
    expect(menuExpansionPlan(MENU_EXPAND_ROW, expanded.filter(row => row.id !== 'menu'))).toMatchObject({ expand: false });
  });

  it('never expands a row that is already showing, an open grid, or a menu with no Menu row', () => {
    expect(menuExpansionPlan('move', collapsed)).toMatchObject({ expand: false, reason: 'the row is already showing' });
    expect(menuExpansionPlan('cartoon', expanded)).toMatchObject({ expand: false, reason: 'the menu is already expanded' });
    expect(menuExpansionPlan('cartoon', [{ id: 'talk', label: 'Talk', active: true }])).toMatchObject({ expand: false });
    expect(menuExpansionPlan('cartoon', [{ id: 'menu', label: 'Menu', active: false }])).toMatchObject({ expand: false });
  });

  it('expands, presses and says so; the pressed row and the rows it saw are the expanded ones', async() => {
    const driver = new Driver({} as any, 'fake-adb', 0, {} as any, parseDriveArguments(base));
    const seen: string[] = [];
    let open = false;
    driver.evaluateForAction = async(expression: string) => {
      const wanted = /"([a-z-]+)"/u.exec(expression)?.[1] ?? '';
      seen.push(wanted);
      const rows = open ? expanded : collapsed;
      if (!rows.some(row => row.id === wanted)) return { status: 'absent', rows };
      if (wanted === 'menu') open = !open;
      return { status: 'pressed', rows };
    };
    const pressed = await driver.pressMenu('menu:sequence');
    expect(seen).toEqual(['sequence', 'menu', 'sequence']);
    expect(pressed).toMatchObject({ id: 'sequence', captureName: 'menu-sequence', rows: expanded });
    expect(pressed.expanded).toMatch(/collapsed/);
  }, 10_000);

  it('fails with every row it can see when the row is absent from the expanded grid too', async() => {
    const driver = new Driver({} as any, 'fake-adb', 0, {} as any, parseDriveArguments(base));
    let open = false;
    driver.evaluateForAction = async(expression: string) => {
      const wanted = /"([a-z-]+)"/u.exec(expression)?.[1] ?? '';
      if (wanted === 'menu') { open = true; return { status: 'pressed', rows: collapsed }; }
      return { status: 'absent', rows: open ? expanded : collapsed };
    };
    await expect(driver.pressMenu('menu:nowhere')).rejects.toThrow(/no row nowhere, even with the menu expanded.*sequence/s);
  }, 10_000);
});

describe('--device names a class, and says where the serial goes', () => {
  it('tells an operator who passed an adb serial which flag it belongs to', () => {
    expect(() => parseDriveArguments([...base, '--device', '1WMHH000X00000']))
      .toThrow(/--device quest2.*STEREOFOLD_ADB_SERIAL/s);
    expect(looksLikeAdbSerial('1WMHH000X00000')).toBe(true);
  });

  it('still lists the classes for a plain typo, and still refuses the serial', () => {
    expect(() => parseDriveArguments([...base, '--device', 'quest9'])).toThrow(/Unknown device class quest9/);
    expect(looksLikeAdbSerial('quest9')).toBe(false);
    expect(() => parseDriveArguments([...base, '--device', '1WMHH000X00000'])).toThrow(DriveUsageError);
  });
});

describe('a run that is only the way out', () => {
  const readAt = '2026-09-11T08:00:00.000Z';
  const presenting = { proximityPositive: false, presenting: true, readAt };

  it('resumes a presenting session without --resume-session when exit is the only step', () => {
    const decision = decideDriveRefusal(presenting, { resumeSession: false, steps: ['exit'] });
    expect(decision.run).toBe(true);
    expect(decision.run && decision.note).toMatch(/only exit/);
    expect(isExitOnlyRun(['exit'])).toBe(true);
  });

  it('keeps the refusal for any list that does more than exit', () => {
    for (const steps of [['tour', 'exit'], ['exit', 'exit'], ['open'], []] as const) {
      expect(isExitOnlyRun([...steps] as never)).toBe(false);
      expect(decideDriveRefusal(presenting, { resumeSession: false, steps: [...steps] as never }).reason).toMatch(/--resume-session/);
    }
    // No steps at all is still the old refusal, so nothing that calls this
    // without a plan silently gains the waiver.
    expect(decideDriveRefusal(presenting, { resumeSession: false }).run).toBe(false);
  });

  it('still refuses a worn headset, because this is about sessions and not faces', () => {
    expect(decideDriveRefusal({ proximityPositive: true, presenting: true, readAt }, { resumeSession: false, steps: ['exit'] }))
      .toMatchObject({ run: false, reason: expect.stringMatching(/face/) });
  });
});

describe('waiting for a host that is still starting', () => {
  it('is off unless the flag asks for it', () => {
    expect(parseDriveArguments(base).waitForHost).toBeUndefined();
    expect(parseDriveArguments([...base, '--wait-for-host']).waitForHost).toBe(true);
  });
});

describe('tourPlan', () => {
  it('starts once and then steps through every remaining chapter', () => {
    expect(tourPlan(6)).toEqual(['start', 'next', 'next', 'next', 'next', 'next']);
    expect(tourPlan(1)).toEqual(['start']);
  });

  it('starts (not plays) before stepping: play resumes a parked lesson, start opens at scene 1', () => {
    // `control_tour next` on an inactive tour used to be a silent no-op that
    // answered "queued" and moved nothing. It now starts the lesson, so this
    // ordering is about what the wearer hears, not about whether the first
    // command lands.
    expect(tourPlan(4)[0]).toBe('start');
  });

  it('plans nothing for a panel that reports no chapters, rather than playing into an empty catalog', () => {
    expect(tourPlan(0)).toEqual([]);
    expect(tourPlan(-3)).toEqual([]);
    expect(tourPlan(Number.NaN)).toEqual([]);
  });
});

describe('planOpen', () => {
  // The title is part of the answer now (see `isStereofoldTarget`), so these
  // are the titles the product actually serves rather than a placeholder.
  const tab = (id: string, url: string, title = 'Stereofold') => ({ id, type: 'page', title, url, webSocketDebuggerUrl: `ws://x/${id}` });
  const viewer = 'https://host.test:8443/viewer';

  it('sends the intent only when Quest Browser has no Stereofold tab', () => {
    expect(planOpen([tab('68', 'chrome://panel-app-nav/ntp', 'New Tab')], false)).toEqual({ launch: true, close: [] });
  });

  it('keeps the newest Stereofold tab and closes the frozen duplicates, without activating anything', () => {
    // Each VIEW intent opens one more /viewer tab, and a background one holds
    // the immersive session the runtime then refuses to hand out again. The share origin is named, because closing a tab is only
    // allowed when it is.
    const share = 'https://host.test:8443';
    const plan = planOpen([tab('74', viewer), tab('73', viewer), tab('72', viewer), tab('68', 'chrome://panel-app-nav/ntp', 'New Tab')],
      false, true, share);
    expect(plan.launch).toBe(false);
    expect('activate' in plan).toBe(false);
    expect(plan.close.sort()).toEqual(['72', '73']);
  });

  it('closes nothing at all while the share origin is unknown', () => {
    // The cold `open` path runs before the host is sharing, so the origin is
    // unknown exactly when the close list is longest. Path-and-title
    // is a guess good enough to attach a debugger to and not good enough to
    // shut a tab with: duplicates are left for the run that knows the origin.
    const plan = planOpen([tab('74', viewer), tab('73', viewer), tab('72', viewer)], false);
    expect(plan.close).toEqual([]);
    expect(plan.launch).toBe(false);
  });

  it('ignores a stranger’s /viewer tab when the share origin is unknown', () => {
    // Without this the plan read someone else's page as "the page is already
    // open" and never sent the intent that opens ours.
    const plan = planOpen([tab('90', 'https://unrelated.example/viewer', 'Viewer')], false);
    expect(plan).toEqual({ launch: true, close: [] });
  });

  it('touches nothing while resuming a session: activating the presenting tab hides its immersive view', () => {
    const plan = planOpen([tab('74', viewer), tab('73', viewer)], true);
    expect(plan.launch).toBe(false);
    expect(plan.close).toEqual([]);
  });
  it('never closes a tab on another site, however much its path looks like ours', () => {
    // A page the wearer left open on some other host that serves /viewer was
    // both picked as the Stereofold page and put on the close list. An
    // unattended driver may not close a stranger's tab.
    const share = 'https://host.test:8443';
    const plan = planOpen([tab('90', 'https://unrelated.example/viewer'), tab('74', `${share}/viewer`),
      tab('73', `${share}/viewer`)], false, true, share);
    expect(plan.launch).toBe(false);
    expect(plan.close).toEqual(['73']);
  });

  it('still closes same-origin duplicates when an origin is named', () => {
    const share = 'https://host.test:8443';
    const plan = planOpen([tab('74', `${share}/viewer`), tab('73', `${share}/detailed`), tab('72', `${share}/viewer`)],
      false, true, share);
    expect(plan.close.sort()).toEqual(['72', '73']);
  });

  it('sends the intent when every open tab belongs to someone else', () => {
    const plan = planOpen([tab('90', 'https://unrelated.example/viewer')], false, true, 'https://host.test:8443');
    expect(plan).toEqual({ launch: true, close: [] });
  });

  it('replaces only the share origin when the companion panel is gone', () => {
    const share = 'https://host.test:8443';
    const plan = planOpen([tab('90', 'https://unrelated.example/viewer'), tab('74', `${share}/viewer`)], false, false, share);
    expect(plan.launch).toBe(true);
    expect(plan.close).toEqual(['74']);
  });

  it('replaces every tab and reopens the share when the host has lost the companion panel', () => {
    // The share window closed behind the tab; the page showed "WAITING FOR
    // STRUCTURE" and a reload changed nothing.
    const share = 'https://host.test:8443';
    const plan = planOpen([tab('74', viewer), tab('73', viewer)], false, false, share);
    expect(plan.launch).toBe(true);
    expect(plan.close.sort()).toEqual(['73', '74']);
  });

  it('reopens the share without closing anything when the origin is unknown', () => {
    // Same lost-panel case, no origin. The share still has to be reopened --
    // that is the only way back -- but the tabs stay, because "looks like ours"
    // is not enough to close one. The duplicates cost a frozen tab; closing a
    // stranger's costs the wearer their page.
    const plan = planOpen([tab('74', viewer), tab('73', viewer)], false, false);
    expect(plan).toEqual({ launch: true, close: [] });
  });
});

describe('RECEIPT_PENDING', () => {
  it('keeps waiting through rendering, which is the page mid-rebuild rather than an answer', () => {
    expect(RECEIPT_PENDING.has('rendering')).toBe(true);
    expect(RECEIPT_PENDING.has('queued')).toBe(true);
    expect(RECEIPT_PENDING.has('rendered')).toBe(false);
    expect(RECEIPT_PENDING.has('rejected')).toBe(false);
  });
});

describe('isNarrationRecord', () => {
  it('reads the tour player\'s narration action, filed under kind tour', () => {
    expect(isNarrationRecord({ kind: 'tour', detail: { action: 'narration', chars: 78 } } as never)).toBe(true);
    expect(isNarrationRecord({ kind: 'tour', detail: { action: 'scene' } } as never)).toBe(false);
    expect(isNarrationRecord({ kind: 'narration', detail: {} } as never)).toBe(false);
  });
});

describe('detectHiddenSession', () => {
  it('reads a presenting session with hidden visibility as a Quest dialog on top', () => {
    // "Confirm boundary" after the headset moved rooms.
    expect(detectHiddenSession({ presenting: true, sessionVisibility: 'hidden' })).toBe(true);
  });

  it('leaves a visible or not-yet-presenting session alone', () => {
    expect(detectHiddenSession({ presenting: true, sessionVisibility: 'visible' })).toBe(false);
    expect(detectHiddenSession({ presenting: false, sessionVisibility: 'hidden' })).toBe(false);
    expect(detectHiddenSession(null)).toBe(false);
  });
});

describe('detectTrackingLoss', () => {
  it('reads a bare Error plus reloadRequired as the Quest losing its room, not as a page bug', () => {
    const loss = detectTrackingLoss({ xrStartup: { errorName: 'Error', reloadRequired: true, phase: 'requesting-headset' } });
    expect(loss.lost).toBe(true);
    expect(loss.reason).toMatch(/requesting-headset/);
  });

  it('reads a presenting session measuring zero frames as the same failure', () => {
    expect(detectTrackingLoss({ xrStartup: { presenting: true }, framesPerSecond: 0 }).lost).toBe(true);
  });

  it('leaves a named WebXR refusal alone: NotAllowedError is a permission, not a dark room', () => {
    expect(detectTrackingLoss({ xrStartup: { errorName: 'NotAllowedError', reloadRequired: true } }).lost).toBe(false);
  });

  it('calls a healthy session healthy', () => {
    expect(detectTrackingLoss({ xrStartup: { presenting: true, reloadRequired: false, errorName: null }, framesPerSecond: 71.8 }).lost).toBe(false);
    expect(detectTrackingLoss({}).lost).toBe(false);
  });

  it('tells the operator what to physically do, and never suggests tapping the dialog', () => {
    expect(TRACKING_LOSS_ADVICE).toMatch(/lit, textured wall/);
    expect(TRACKING_LOSS_ADVICE).not.toMatch(/tap/iu);
  });
});

describe('the spoken phrases', () => {
  it('covers passthrough, the render budget and both directions of motion', () => {
    expect([...VOICE_PHRASES]).toEqual(['show the room', 'better quality', 'spin it', 'stop']);
  });

  it('labels the page-hook receipt as an injected transcript, not microphone capture', () => {
    expect(INJECTED_TRANSCRIPT_ORIGIN).toBe('injected-transcript');
  });
});

describe('speechFailures', () => {
  const entries = [
    { kind: 'narration', detail: { chars: 41 } },
    { kind: 'speech-failed', detail: { route: 'tour-narration', chars: 41, status: 409, reason: 'request_failed' } },
    { kind: 'frame-rate', detail: { fps: 71.8 } },
  ];

  it('picks out only the lines the wearer never heard', () => {
    expect(speechFailures(entries)).toHaveLength(1);
    expect(speechFailures(entries.filter(entry => entry.kind !== 'speech-failed'))).toEqual([]);
  });

  it('names the route and the HTTP status, because 409 is the failure this run exists to catch', () => {
    expect(describeSpeechFailure(entries[1]!)).toBe('tour-narration HTTP 409: request_failed');
  });

  it('still reads when the page recorded no status', () => {
    expect(describeSpeechFailure({ kind: 'speech-failed', detail: { route: 'voice-confirmation' } }))
      .toBe('voice-confirmation: no reason recorded');
  });
});

describe('the report', () => {
  const step = (name: StepResult['step'], ok: boolean, detail: string,
    extra: Partial<StepResult> = {}): StepResult => ({
    step: name, ok, method: null, verified: null, detail,
    startedAt: '2026-09-11T08:00:00.000Z', endedAt: '2026-09-11T08:00:10.000Z',
    evidence: { capture: `/tmp/drive/${name}.png` }, consoleErrors: [], failedResponses: [], ...extra,
  });

  it('passes only when every step passed', () => {
    expect(summarizeRun([step('enter', true, 'in'), step('exit', true, 'out')]).ok).toBe(true);
    expect(summarizeRun([]).ok).toBe(true);
  });

  it('names the failing step and its reason, so the exit code has something to point at', () => {
    const summary = summarizeRun([step('enter', true, 'in'), step('tour', false, '2 spoken lines did not reach the wearer')]);
    expect(summary.ok).toBe(false);
    expect(summary.failures).toEqual(['tour: 2 spoken lines did not reach the wearer']);
  });

  it('writes a report that carries the gate, the plan, every step and its evidence path', () => {
    const options = parseDriveArguments([...base, '--steps', 'enter,tour']);
    const report = buildReport({
      startedAt: '2026-09-11T08:00:00.000Z', endedAt: '2026-09-11T08:05:00.000Z',
      gate: { proximityPositive: false, presenting: false, readAt: '2026-09-11T08:00:00.000Z' }, options,
      steps: [step('enter', true, 'in'), step('tour', false, 'no chapters')],
    });
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.gate.proximityPositive).toBe(false);
    expect(report.options.steps).toEqual(['enter', 'tour']);
    expect(report.steps.map(entry => entry.evidence.capture)).toEqual(['/tmp/drive/enter.png', '/tmp/drive/tour.png']);
    expect(report.ring).toMatchObject({ identity: 'headset-diagnostics', entriesRead: 0, evicted: false, cursor: 0 });
  });
});

/**
 * The `ask` step's readings.
 *
 * These are the judgements that decide whether a spoken conversation is
 * reported as working, and every one of them has a way to look right while
 * being wrong: a transcript that came back as somebody else's sentence, a
 * reply the host delivered that the page never drew, a "continue" that quietly
 * restarted the lesson. Nothing here needs a headset, a microphone or a host.
 */
describe('transcriptMatches', () => {
  it('accepts what a local transcriber really returns, punctuation and casing included', () => {
    const match = transcriptMatches(' What does the guide RNA do here? ', 'what does the guide RNA do here');
    expect(match.ok).toBe(true);
    expect(match.score).toBe(1);
    expect(match.missing).toEqual([]);
  });

  it('forgives filler words, which carry no evidence either way', () => {
    expect(transcriptMatches('what the guide RNA here', 'what does the guide RNA do here').ok).toBe(true);
  });

  // The off-by-one that made this check worthless on the one turn it matters
  // on. Four content words, a threshold of three quarters, and the cheapest
  // word to lose is the only one that makes the sentence about this molecule.
  it('refuses a transcript that lost RNA, which the old three-quarter threshold passed', () => {
    const match = transcriptMatches('what does the guide do here', ASK_TURNS[0]!.said);
    expect(match.ok).toBe(false);
    expect(match.missing).toEqual(['rna']);
    expect(match.score).toBe(0.75);
  });

  // whisper is primed with a prompt full of these same nouns, so a press it
  // heard nothing in comes back as the prompt. Overlap alone scored that 1.00.
  it('refuses a transcript that came back with a leaked prompt attached', () => {
    const match = transcriptMatches('what does the guide RNA do here spin it stop spinning reset the view show the menu',
      ASK_TURNS[0]!.said);
    expect(match.ok).toBe(false);
    expect(match.score).toBe(1);
    expect(match.extra.length).toBeGreaterThan(TRANSCRIPT_EXTRA_ALLOWANCE);
  });

  it('still allows a word or two of hesitation around the sentence', () => {
    expect(transcriptMatches('so what does the guide RNA do here then', ASK_TURNS[0]!.said).ok).toBe(true);
  });

  it('refuses a transcript that is somebody elses sentence, and says which words went missing', () => {
    const match = transcriptMatches('better quality', 'what does the guide RNA do here');
    expect(match.ok).toBe(false);
    expect(match.score).toBeLessThan(TRANSCRIPT_MATCH_THRESHOLD);
    expect(match.missing).toContain('guide');
    expect(match.missing).toContain('rna');
  });

  it('refuses silence, which is what a microphone that recorded nothing produces', () => {
    expect(transcriptMatches('', 'show me').ok).toBe(false);
    expect(transcriptMatches('   ', 'show me').score).toBe(0);
  });

  it('scores every turn the step actually speaks against itself', () => {
    for (const turn of ASK_TURNS) expect(transcriptMatches(turn.said, turn.said).ok).toBe(true);
  });
});

describe('pressChunks', () => {
  // The headset streams a timeslice about once a second and closes the
  // utterance with a bare final marker. A two-second recording fits in one
  // chunk under the route's ceiling, so the step used to send exactly one and
  // exercised neither the assembly nor the ordering it claimed to cover.
  it('splits a short press the way a recorder would, not into one chunk', () => {
    const chunks = pressChunks(new Uint8Array(60_000));
    expect(chunks.length).toBeGreaterThanOrEqual(PRESS_CHUNK_MINIMUM);
  });

  it('reassembles to exactly the bytes that went in', () => {
    const audio = new Uint8Array(9_001).map((_, index) => index % 251);
    expect(Buffer.concat(pressChunks(audio).map(chunk => Buffer.from(chunk, 'base64')))).toEqual(Buffer.from(audio));
  });

  it('never pads in the middle, so the hosts concatenation decodes', () => {
    for (const chunk of pressChunks(new Uint8Array(9_001)).slice(0, -1)) expect(chunk).not.toContain('=');
  });

  it('stays inside the routes encoded ceiling on a long press', () => {
    const chunks = pressChunks(new Uint8Array(4 * 1024 * 1024), PRESS_CHUNK_MINIMUM, 4_096);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4_096);
    expect(chunks.length).toBeGreaterThan(PRESS_CHUNK_MINIMUM);
  });

  it('sends nothing for no audio rather than an empty chunk the route would refuse', () => {
    expect(pressChunks(new Uint8Array())).toEqual([]);
  });
});

describe('chunkAudioBase64', () => {
  it('sends a short press as one chunk', () => {
    const chunks = chunkAudioBase64(new Uint8Array(60_000));
    expect(chunks).toHaveLength(1);
    expect(Buffer.from(chunks[0]!, 'base64').byteLength).toBe(60_000);
  });

  it('splits a long press and loses no audio, reassembling to the original bytes', () => {
    const audio = new Uint8Array(1_000).map((_, index) => index % 251);
    const chunks = chunkAudioBase64(audio, 400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64')))).toEqual(Buffer.from(audio));
  });

  it('keeps every chunk inside the routes encoded ceiling', () => {
    for (const chunk of chunkAudioBase64(new Uint8Array(900), 400)) expect(chunk.length).toBeLessThanOrEqual(400);
  });

  it('never pads in the middle, so the hosts concatenation decodes', () => {
    // Interior padding is the bug that makes assembled audio decode to noise
    // rather than fail outright, so it is asserted directly.
    const chunks = chunkAudioBase64(new Uint8Array(900), 400);
    for (const chunk of chunks.slice(0, -1)) expect(chunk).not.toContain('=');
  });

  it('sends nothing for no audio rather than an empty chunk the route would refuse', () => {
    expect(chunkAudioBase64(new Uint8Array())).toEqual([]);
  });
});

describe('replyReceipts', () => {
  const entry = (kind: string, detail: Record<string, unknown> = {}): DiagnosticRecord => ({ kind, detail });
  /** A clip record the way the page writes one when sound actually left the context. */
  const heard = (detail: Record<string, unknown> = {}) => entry('reply-audio-play', { via: 'context', contextState: 'running', started: true, ...detail });

  it('reads the caption and the clip separately, because they fail separately', () => {
    const receipts = replyReceipts([entry('reply-received', { chars: 52 }), heard({ bytes: 9_000 })]);
    expect(receipts.received).toHaveLength(1);
    expect(receipts.played).toHaveLength(1);
    expect(receipts.failed).toEqual([]);
  });

  it('does not count an empty reply as a caption the wearer read', () => {
    expect(replyReceipts([entry('reply-received', { chars: 0, empty: true })]).received).toEqual([]);
  });

  it('counts a silent lesson as a failure even though the caption stood', () => {
    const receipts = replyReceipts([entry('reply-received', { chars: 52 }), entry('reply-audio-error', { stage: 'decode' })]);
    expect(receipts.received).toHaveLength(1);
    expect(receipts.failed).toHaveLength(1);
  });

  it('folds in the narration routes own refusals', () => {
    const receipts = replyReceipts([entry('speech-failed', { route: 'voice-command', status: 409 })]);
    expect(receipts.failed).toHaveLength(1);
    expect(describeSpeechFailure(receipts.failed[0]!)).toContain('409');
  });

  // A conversation read over a time window credits the previous turn's caption
  // to this one. Length is the only field on the record that tells two replies
  // apart.
  it('counts only the caption of the reply it was asked about', () => {
    const entries = [entry('reply-received', { chars: 52 }), entry('reply-received', { chars: 24 })];
    expect(replyReceipts(entries, { chars: 24 }).received).toHaveLength(1);
    expect(replyReceipts(entries, { chars: 24 }).received[0]!.detail?.chars).toBe(24);
    expect(replyReceipts(entries, { chars: 99 }).received).toEqual([]);
  });

  // The other half of "the wearer heard it": a clip record left in the ring by
  // the previous turn satisfied this turn's check, so a silent answer reported
  // as heard.
  it('counts only the clip of the reply it was asked about', () => {
    const entries = [heard({ bytes: 9_000 }), heard({ bytes: 4_200 })];
    expect(replyReceipts(entries, { audioBytes: 4_200 }).played).toHaveLength(1);
    expect(replyReceipts(entries, { audioBytes: 7_777 }).played).toEqual([]);
  });

  it('does not count a caption that reached a surface which drew nothing', () => {
    expect(replyReceipts([entry('reply-received', { chars: 52, drawn: false })], { chars: 52 }).received).toEqual([]);
  });

  // The false pass this closes: turn one's clip is still in the ring, turn two
  // is never played, and the step reports that the wearer was answered aloud.
  // Same length and same byte count, because a canned reply pair can have both.
  it('refuses the previous turn\'s clip and caption, however alike they are', () => {
    const stale = [entry('reply-received', { captionId: 'turn-1', chars: 52 }), heard({ captionId: 'turn-1', bytes: 9_000 })];
    const receipts = replyReceipts(stale, { captionId: 'turn-2', chars: 52, audioBytes: 9_000 });
    expect(receipts.received).toEqual([]);
    expect(receipts.played).toEqual([]);
    expect(receipts.silent).toEqual([]);
  });

  // A page that predates caption ids fails loudly rather than passing on
  // length alone: the driver serves the bundle it just built, so a record with
  // no id is a stale page, not an old one.
  it('does not credit a record that names no reply at all', () => {
    expect(replyReceipts([heard({ bytes: 9_000 })], { captionId: 'turn-2', audioBytes: 9_000 }).played).toEqual([]);
  });

  // start(0) on a context the browser never resumed is a play record with no
  // sound behind it, which is precisely the unattended-Quest case.
  it('holds a clip started into a suspended context apart from one that was heard', () => {
    const entries = [entry('reply-audio-play', { via: 'context', captionId: 'turn-2', contextState: 'suspended', bytes: 9_000 })];
    const receipts = replyReceipts(entries, { captionId: 'turn-2', audioBytes: 9_000 });
    expect(receipts.played).toEqual([]);
    expect(receipts.silent).toHaveLength(1);
  });

  it('accepts the element fallback, whose play() resolving is the same claim', () => {
    const entries = [entry('reply-audio-play', { via: 'element', captionId: 'turn-2', started: true, contextState: 'absent', bytes: 9_000 })];
    expect(replyReceipts(entries, { captionId: 'turn-2', audioBytes: 9_000 }).played).toHaveLength(1);
  });

  // The mirror-image false fail: a clip error left by another reply aborted
  // the wait and failed a turn that worked.
  it('does not fail this reply for an error belonging to another one', () => {
    const entries = [entry('reply-audio-error', { captionId: 'turn-1', stage: 'decode' })];
    expect(replyReceipts(entries, { captionId: 'turn-2' }).failed).toEqual([]);
  });
});

describe('resumeEvidence', () => {
  const tour = (detail: Record<string, unknown>): DiagnosticRecord => ({ kind: 'tour', detail });

  it('reads the chapter being drawn again as the rejoin it is', () => {
    const evidence = resumeEvidence([tour({ action: 'scene', outcome: 'shown', step: 3, title: 'The PAM' })], 3);
    expect(evidence.shown).toBeDefined();
    expect(evidence.restarted).toBeUndefined();
  });

  it('reads a paused lesson starting to run again', () => {
    expect(resumeEvidence([tour({ action: 'autoplay', outcome: 'resumed', step: 3 })], 3).resumed).toBeDefined();
  });

  // The false pass: a lesson parked on its opening chapter, restarted rather
  // than resumed, lands on the same index. Every flag agrees; only the
  // player's own start record disagrees.
  it('catches a restart that lands back on the parked chapter', () => {
    const evidence = resumeEvidence([tour({ action: 'start', opening: 0, autoplay: false, step: -1 }),
      tour({ action: 'scene', outcome: 'shown', step: 0 })], 0);
    expect(evidence.restarted).toBeDefined();
  });

  it('does not accept a scene drawn on some other chapter', () => {
    const evidence = resumeEvidence([tour({ action: 'scene', outcome: 'shown', step: 5 })], 3);
    expect(evidence.shown).toBeUndefined();
    expect(evidence.resumed).toBeUndefined();
  });

  // The panel can set its own flags without drawing anything. A resume with no
  // record at all is the case this refuses.
  it('finds nothing in a log where the player recorded nothing', () => {
    expect(resumeEvidence([{ kind: 'frame-rate', detail: { fps: 72 } }], 3)).toEqual({ shown: undefined, resumed: undefined, restarted: undefined });
  });
});

describe('clipReachedOutput', () => {
  it('refuses a started source on a context that was closed or suspended', () => {
    expect(clipReachedOutput({ kind: 'reply-audio-play', detail: { via: 'context', contextState: 'suspended' } })).toBe(false);
    expect(clipReachedOutput({ kind: 'reply-audio-play', detail: { via: 'context', contextState: 'closed' } })).toBe(false);
    expect(clipReachedOutput({ kind: 'reply-audio-play', detail: { via: 'context', contextState: 'running' } })).toBe(true);
    // An element record that never reached its resolved play() is not a claim.
    expect(clipReachedOutput({ kind: 'reply-audio-play', detail: { via: 'element' } })).toBe(false);
  });
});

describe('parkedTour', () => {
  it('reads a paused lesson off the heartbeat', () => {
    expect(parkedTour({ tour: { selectedId: 'lesson-crispr-cas9', step: 3, active: true, autoplay: false }, xrStartup: { presenting: true } }))
      .toEqual({ selectedId: 'lesson-crispr-cas9', step: 3, presenting: true, active: true, autoplay: false });
  });

  it('treats a taken-over lesson as parked, even though the heartbeat calls it inactive', () => {
    // `stopped` is never reported, so a real park reads as active:false with a
    // real step. Reading `active` instead of `step` would lose it.
    expect(parkedTour({ tour: { selectedId: 'lesson-crispr-cas9', step: 5, active: false }, xrStartup: { presenting: true } })?.step).toBe(5);
  });

  it('records both play flags, because which one was off decides what a resume has to change', () => {
    expect(parkedTour({ tour: { selectedId: 'lesson-crispr-cas9', step: 5, active: false, autoplay: false } }))
      .toMatchObject({ active: false, autoplay: false });
    expect(parkedTour({ tour: { selectedId: 'lesson-crispr-cas9', step: 5, active: true, autoplay: true } }))
      .toMatchObject({ active: true, autoplay: true });
  });

  it('finds no park when no lesson has opened', () => {
    expect(parkedTour({ tour: { selectedId: '', step: -1 } })).toBeUndefined();
    expect(parkedTour({})).toBeUndefined();
    expect(parkedTour(undefined)).toBeUndefined();
  });
});

describe('resumeEdge', () => {
  it('watches autoplay after a pause, which is the park this step arranges', () => {
    expect(resumeEdge({ active: true, autoplay: false })).toBe('autoplay');
  });

  // The "show me" turn commits a focus command between the park and the
  // resume, and any committed inspection change stops the lesson. Reading the
  // edge off the park would then wait for an autoplay a rejoin never sets and
  // fail a resume that worked.
  it('watches active once the lesson has been stopped, where play rejoins instead', () => {
    expect(resumeEdge({ active: false, autoplay: false })).toBe('active');
  });

  it('finds no edge in a lesson that is already running', () => {
    expect(resumeEdge({ active: true, autoplay: true })).toBeUndefined();
    expect(resumeEdge(undefined)).toBeUndefined();
  });
});

describe('tourResumed', () => {
  // Paused: the shape `control_tour pause` leaves behind, and the one the ask
  // step arranges on purpose.
  const parked: TourPark = { selectedId: 'lesson-crispr-cas9', step: 3, presenting: true, active: true, autoplay: false };
  const panel = (tour: Record<string, unknown>, presenting = true) => ({ tour, xrStartup: { presenting } });
  const playing = (over: Record<string, unknown> = {}) =>
    panel({ selectedId: 'lesson-crispr-cas9', step: 3, navigating: false, active: true, autoplay: true, ...over });

  it('passes when play put the wearer back on the chapter they left', () => {
    expect(tourResumed(parked, playing()).ok).toBe(true);
  });

  // The regression this whole rewrite exists for. Every equality in the old
  // check was already true the moment the lesson was paused, so a `play` the
  // panel never acted on matched on the first poll and the step reported a
  // working conversation loop.
  it('fails a play that changed nothing at all, which the parked state already satisfied', () => {
    const answer = tourResumed(parked, panel({ selectedId: 'lesson-crispr-cas9', step: 3, navigating: false, active: true, autoplay: false }));
    expect(answer.ok).toBe(false);
    expect(answer.reason).toContain('not running again');
  });

  // A rejoin puts the chapter back and leaves autoplay off. The scene returns
  // and the lesson never moves again, which is not what a wearer means by
  // "continue"; `resumeLesson` sends a second play rather than this accepting
  // the still frame.
  it('does not accept a chapter that came back but is not running', () => {
    const answer = tourResumed(parked, panel({ selectedId: 'lesson-crispr-cas9', step: 3, navigating: false, active: true, autoplay: false }));
    expect(answer.ok).toBe(false);
    expect(answer.reason).toContain('not running again');
  });

  it('does not accept a lesson that never rejoined its chapter', () => {
    expect(tourResumed({ ...parked, active: false }, panel({ selectedId: 'lesson-crispr-cas9', step: 3, navigating: false, active: false, autoplay: false })).ok).toBe(false);
  });

  // The takeover park, which is what the ask step actually has by the time it
  // resumes: the "show me" turn committed a focus command and stopped the
  // lesson, so the edge is `active`. A rejoin lifts `active` and leaves
  // autoplay off, and accepting that reports a still frame as a lesson the
  // wearer got back.
  it('does not accept a rejoin of a taken-over lesson that is not running', () => {
    const takenOver: TourPark = { ...parked, active: false };
    const answer = tourResumed(takenOver, panel({ selectedId: 'lesson-crispr-cas9', step: 3, navigating: false, active: true, autoplay: false }));
    expect(answer.ok).toBe(false);
    expect(answer.reason).toContain('not running again');
    expect(tourResumed(takenOver, playing()).ok).toBe(true);
  });

  it('refuses to judge a lesson that was still running when the conversation started', () => {
    const running: TourPark = { ...parked, active: true, autoplay: true };
    expect(tourResumed(running, playing()).reason).toContain('still running');
  });

  it('fails a "continue" that restarted the lesson, and says so in the wearers terms', () => {
    const answer = tourResumed(parked, playing({ step: 0 }));
    expect(answer.ok).toBe(false);
    expect(answer.reason).toContain('restarted at chapter 1');
  });

  it('fails a lesson that ran on while the wearer was talking', () => {
    const answer = tourResumed(parked, playing({ step: 5 }));
    expect(answer.ok).toBe(false);
    expect(answer.reason).toContain('missed chapter 4');
  });

  it('fails when a different lesson opened, which a bare step check would pass', () => {
    expect(tourResumed(parked, playing({ selectedId: 'lesson-microtubule' })).reason).toContain('different lesson');
  });

  it('does not call a still-navigating player resumed', () => {
    expect(tourResumed(parked, playing({ navigating: true })).ok).toBe(false);
  });

  it('fails when the resume only worked because the session dropped and came back', () => {
    expect(tourResumed(parked, panel({ selectedId: 'lesson-crispr-cas9', step: 3, navigating: false, active: true, autoplay: true }, false)).reason)
      .toContain('session ended');
  });

  it('refuses to report a resume when nothing was parked', () => {
    expect(tourResumed(undefined, playing({ step: 0 })).ok).toBe(false);
  });
});

describe('the ask steps plan', () => {
  // Both steps stay in the run. `voice` proves the fixed grammar, which is
  // still what answers a wearer when no agent is listening; `ask` proves the
  // hop past it. Neither replaces the other.
  it('is in the default run, after the fixed-grammar voice step it builds on', () => {
    expect(DRIVE_STEPS).toContain('voice');
    expect(DRIVE_STEPS).toContain('ask');
    expect(DRIVE_STEPS.indexOf('ask')).toBeGreaterThan(DRIVE_STEPS.indexOf('voice'));
    expect(parseDriveArguments([share, '--out', '/tmp/drive', '--steps', 'ask']).steps).toEqual(['ask']);
  });

  // Not just "it is not in the driver's own phrase list": the real grammar the
  // headset runs has to miss it, or "unscripted" is a caption on nothing.
  it('asks something the shipped voice grammar cannot answer', () => {
    expect(voiceCommandFromTranscript(ASK_TURNS[0]!.said)).toBeUndefined();
    for (const phrase of VOICE_PHRASES) expect(ASK_TURNS[0]!.said).not.toBe(phrase);
    expect(ASK_TURNS.map(turn => turn.said)).toEqual(['what does the guide RNA do here', 'show me', 'continue the lesson']);
  });

  // Every driven phrase in the `voice` step must still be in that grammar, so
  // the contrast the ask step draws is a real one.
  it('keeps the fixed-grammar step on phrases the grammar does answer', () => {
    for (const phrase of VOICE_PHRASES) expect(voiceCommandFromTranscript(phrase)).toBeDefined();
  });

  it('names what the agent does on each turn, so reordering the table cannot swap the actions', () => {
    expect(ASK_TURNS.map(turn => turn.act)).toEqual(['answer', 'show', 'resume']);
    expect(new Set(ASK_TURNS.map(turn => turn.act)).size).toBe(ASK_TURNS.length);
  });

  it('keeps every reply inside say_to_headsets one-sentence limit', () => {
    for (const turn of ASK_TURNS) {
      expect(turn.reply.length).toBeGreaterThan(0);
      expect(turn.reply.length).toBeLessThanOrEqual(280);
    }
  });

  // The step posts its audio over the loopback /agent door; the headset posts
  // the same tool over the companion /tool door on the private Wi-Fi listener.
  // They are different allowlists, so the one claim worth pinning is that the
  // page's own doors carry this tool at all.
  it('sends the microphone route a tool both of the pages own doors allow', () => {
    expect(COMPANION_TOOLS.has(PUSH_TO_TALK_AUDIO_TOOL)).toBe(true);
    expect(LAN_ALLOWED_TOOLS.has(PUSH_TO_TALK_AUDIO_TOOL)).toBe(true);
  });

  it('sends the container the headsets recorder produces, not the one the route merely accepts', () => {
    expect(HEADSET_PRESS_MIME).toBe('audio/webm;codecs=opus');
    expect(containerExtension(HEADSET_PRESS_MIME)).toBe('webm');
  });
});

describe('planPark', () => {
  it('steps back off the last chapter, where a preceding full tour walk leaves the lesson', () => {
    // Resuming the final chapter is the one case where play can run the lesson
    // off its end and move step by itself, which would make the verdict depend
    // on how long the conversation took.
    expect(planPark({ selectedId: 'lesson-crispr-cas9', step: 5, total: 6 })).toBe('back');
  });

  it('leaves a lesson parked in the middle alone', () => {
    expect(planPark({ selectedId: 'lesson-crispr-cas9', step: 2, total: 6 })).toBe('none');
    expect(planPark({ selectedId: 'lesson-crispr-cas9', step: 0, total: 6 })).toBe('none');
  });

  it('opens a lesson when none is playing, so --steps ask works on its own', () => {
    expect(planPark({ selectedId: 'lesson-crispr-cas9', step: -1, total: 6 })).toBe('open');
    expect(planPark({ total: 6 })).toBe('open');
  });

  it('opens a lesson when the panel reports no chapters at all', () => {
    // These used to answer `none`, which arranges nothing and then
    // waits 30 s for a chapter that is never coming, so a panel with no tour
    // ended the step on "Timed out after 30 s" -- a sentence about the wait,
    // naming nothing a person could act on. `stepAsk` takes the lesson id from
    // the session catalog and says plainly when the session has no lesson.
    expect(planPark({ step: -1, total: 0 })).toBe('open');
    expect(planPark(undefined)).toBe('open');
  });

  it('does not try to step back in a one-chapter lesson', () => {
    expect(planPark({ selectedId: 'lesson-tiny', step: 0, total: 1 })).toBe('none');
  });

  it('treats an autoplaying lesson as parked only once it has actually stopped', () => {
    // `planPark` reads `step` and `total` and never looks at `autoplay`, so a
    // lesson playing in the middle of a lesson arranges nothing. That is right
    // -- the pause is sent before the plan is consulted -- but the wait
    // afterwards has to be the thing that checks.
    expect(planPark({ selectedId: 'lesson-crispr-cas9', step: 1, total: 5, autoplay: true })).toBe('none');
    expect(tourParked({ navigating: false, step: 1, autoplay: true })).toBe(false);
    expect(tourParked({ navigating: false, step: 1, autoplay: false })).toBe(true);
    expect(tourParked({ navigating: true, step: 1, autoplay: false })).toBe(false);
    expect(tourParked({ navigating: false, step: -1, autoplay: false })).toBe(false);
    expect(tourParked(undefined)).toBe(false);
  });

  it('says what went wrong when a lesson will not stop, instead of naming the wait', () => {
    expect(PARK_REFUSED_ADVICE).toContain(String(PARK_PAUSE_ATTEMPTS));
    expect(PARK_REFUSED_ADVICE).toMatch(/would not stop/);
    expect(PARK_REFUSED_ADVICE).not.toMatch(/timed out/i);
    // The whole park is bounded: three pauses, ten seconds each.
    expect(PARK_PAUSE_ATTEMPTS * PARK_WAIT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('one inspection command at a time', () => {
  /**
   * When the tour has walked every chapter, `ask` sends `pause` and then `back`
   * in the same breath, and the host refuses the second with "An inspection
   * command is already in progress. Check its status first." The page renders
   * the pause's receipt one heartbeat later.
   */
  const REFUSAL = 'An inspection command is already in progress. Check its status first.';

  function host(script: Array<'refuse' | 'accept'>) {
    const sent: Array<Record<string, unknown>> = [];
    let rendered = false;
    let turn = 0;
    return {
      sent, states: 0,
      async agent(_name: string, args: Record<string, unknown> = {}) {
        const answer = script[turn++] ?? 'accept';
        if (answer === 'refuse') throw Error(REFUSAL);
        sent.push(args);
        rendered = false;
        return { content: [], structuredContent: { command: { commandId: String(args.commandId) } } } as any;
      },
      async inspectionState() {
        // The first read is the page mid-rebuild, the second is the receipt.
        const status = rendered ? 'rendered' : (rendered = true, 'rendering');
        return { commands: sent.map(args => ({ commandId: String(args.commandId), status })) };
      },
    };
  }

  it('waits for the command in flight rather than failing the run', async() => {
    const fake = host(['refuse', 'refuse', 'accept']);
    const waits: number[] = [];
    const sent = await sendTourCommand(fake, 'back', {}, { wait: async seconds => { waits.push(seconds); }, note: () => {} });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ action: 'back' });
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(sent.receipt.status).toBe('rendered');
  });

  it('does not return until the receipt is terminal, so the next command is never sent early', async() => {
    const fake = host(['accept']);
    const { receipt } = await sendTourCommand(fake, 'pause', {}, { wait: async() => {}, note: () => {} });
    // `rendering` is the page still rebuilding: the state a following `back`
    // would be sent into.
    expect(RECEIPT_PENDING).toContain('rendering');
    expect(receipt.status).toBe('rendered');
  });

  it('gives up on a refusal that is not about another command, with the host’s own words', async() => {
    const fake = {
      async agent() { throw Error('This session has no lesson to play.'); },
      async inspectionState() { return {}; },
    };
    await expect(sendTourCommand(fake, 'play', {}, { wait: async() => {}, note: () => {} }))
      .rejects.toThrow('This session has no lesson to play.');
  });

  it('stops waiting eventually, rather than retrying a wedged host forever', async() => {
    const fake = { async agent() { throw Error(REFUSAL); }, async inspectionState() { return {}; } };
    await expect(sendTourCommand(fake, 'pause', {}, { wait: async() => {}, note: () => {} })).rejects.toThrow(/already in progress/);
    expect(isCommandInFlight(Error(REFUSAL))).toBe(true);
    expect(isCommandInFlight(Error('The panel is unsaved.'))).toBe(false);
  });

  it('waits out the one beat after a receipt in which the panel is not yet current', async() => {
    // A pause renders, and a `back` sent on the next tick is refused because
    // the panel's beat has not caught up.
    const between = 'No panel is showing this inspection. Open the printed address in a browser, let the structure render and save, then try again.';
    let calls = 0;
    let sentId = '';
    const fake = {
      async agent(_name: string, args: Record<string, unknown> = {}) {
        calls++;
        if (calls === 1) throw Error(between);
        sentId = String(args.commandId);
        return { content: [{ type: 'text', text: 'queued' }], structuredContent: { command: { commandId: args.commandId } } } as any;
      },
      async inspectionState() { return { commands: [{ commandId: sentId || `back-2-${''}`, status: 'rendered' }] }; },
    };
    const sent = await sendTourCommand(fake, 'back', {}, { wait: async() => {}, note: () => {}, attempts: 3 });
    expect(calls).toBe(2);
    expect(sent.receipt.status === 'rendered' || sent.receipt.status === 'never-received').toBe(true);
    expect(isCommandInFlight(Error(between))).toBe(true);
    expect(isCommandInFlight(Error('No panel is ready for a command right now (companion busy). Let the panel finish, then try again.'))).toBe(true);
  });
});

describe('the share origin the tab rules are built on', () => {
  it('never stands on an answer of “not sharing yet”', () => {
    // The cold `open` path asks before the share exists, and the undefined
    // answer was cached for the same ten seconds as a real one --
    // which is the whole of the open step. Everything inside that window ran on
    // the path-only rule the origin guard exists to replace.
    expect(originCacheHolds(undefined, Date.now(), Date.now())).toBe(false);
    expect(originCacheHolds('https://host.test:8443', Date.now(), Date.now())).toBe(true);
  });

  it('re-asks for a known origin once it is old, because a share can reopen on another port', () => {
    const checked = 1_000_000;
    expect(originCacheHolds('https://host.test:8443', checked, checked + 9_000)).toBe(true);
    expect(originCacheHolds('https://host.test:8443', checked, checked + 10_001)).toBe(false);
  });
});

describe('the share-ended plate the driver reads off the page', () => {
  it('matches the words the companion page actually shows', () => {
    // Two files, one sentence: the driver stops on the plate instead of
    // reloading into a share only the Mac can reopen.
    expect(SHARE_ENDED_ON_PAGE.test(SHARE_ENDED_MESSAGE)).toBe(true);
    expect(SHARE_ENDED_ON_PAGE.test('The viewer couldn’t finish starting. The structure couldn’t load.')).toBe(false);
  });
});

describe('a change still rendering is not yet rendered', () => {
  it('retries when the host says a molecular change is still rendering', () => {
    expect(isCommandInFlight(new Error('update_inspection was rejected: A molecular change is still rendering.'))).toBe(true);
    expect(isCommandInFlight('The share has ended.')).toBe(false);
  });
});

describe('waiting for the headset to be drivable after entry', () => {
  const panel = (extra: Record<string, unknown> = {}) =>
    ({ panelId: 'c1', surface: 'companion', availability: 'ready', current: true, ...extra });

  it('accepts only a headset panel that is at the saved revision and not rendering', () => {
    expect(panelIsCommandable(panel())).toBe(true);
    // The three shapes that produce "No panel is showing this inspection": a
    // panel behind the revision, one mid-render, and the desktop's.
    expect(panelIsCommandable(panel({ current: false }))).toBe(false);
    expect(panelIsCommandable(panel({ availability: 'busy' }))).toBe(false);
    expect(panelIsCommandable(panel({ availability: 'unsaved' }))).toBe(false);
    expect(panelIsCommandable({ panelId: 'd1', surface: 'desktop', availability: 'ready', current: true })).toBe(false);
    expect(panelIsCommandable(undefined)).toBe(false);
  });

  it('waits long enough for the stage the wall failed on, and still bounds it', () => {
    // Six in-flight retries run out after twenty-two seconds.
    expect(panelWaitMs(40_908, PANEL_READY_WAIT)).toBeGreaterThan(22_000);
    expect(panelWaitMs(40_908, PANEL_READY_WAIT)).toBe(112_000);
    // No count given is the base wait, never a shorter one.
    expect(panelWaitMs(undefined, PANEL_READY_WAIT)).toBe(PANEL_READY_WAIT.baseMs);
    expect(panelWaitMs(1_000_000, PANEL_READY_WAIT)).toBe(PANEL_READY_WAIT.capMs);
  });
});

describe('growing a staged lesson inside the session', () => {
  /**
   * `grow_structure` replaces the coordinates and the authored
   * lesson together and the headset rebuilds in place, so there is no command
   * receipt to wait on: what says a tier landed is the panel reporting the new
   * lesson id while the session is still presenting.
   */
  function growHost(answers: Array<Record<string, unknown> | Error>) {
    const sent: Array<Record<string, unknown>> = [];
    let turn = 0;
    return {
      sent,
      async agent(name: string, args: Record<string, unknown> = {}) {
        expect(name).toBe('grow_structure');
        const answer = answers[turn++];
        if (answer instanceof Error) throw answer;
        sent.push(args);
        return { content: [{ type: 'text', text: 'grown' }], structuredContent: { grow: answer } } as any;
      },
      async inspectionState() { return {}; },
    };
  }

  it('asks for the next tier and hands back what the host answered', async() => {
    const host = growHost([{ refused: false, from: 'monomer', to: 'dimer', atomSites: 6818,
      lessonId: 'lesson-microtubule-growth-dimer', spoken: 'Grown to one tubulin dimer.' }]);
    const { grow } = await sendGrowCommand(host, 'next', { wait: async() => {}, note: () => {} });
    expect(host.sent[0]).toEqual({ stage: 'next' });
    expect(grow.to).toBe('dimer');
    // The id the panel will report is the compiled tour's, not the manifest's.
    expect(grow.lessonId).toBe('lesson-microtubule-growth-dimer');
  });

  it('passes the device class through, because that is what sets the tier ceiling', async() => {
    const host = growHost([{ refused: true, from: 'wall', deviceTier: 'quest2',
      spoken: 'Too big for this headset. Staying here.' }]);
    const { grow } = await sendGrowCommand(host, 'next', { device: 'quest2', wait: async() => {}, note: () => {} });
    expect(host.sent[0]).toEqual({ stage: 'next', device: 'quest2' });
    // A refusal is a normal answer, not a thrown error: the run records the
    // line the wearer would hear and stops there.
    expect(grow.refused).toBe(true);
    expect(String(grow.spoken).split(/\s+/).length).toBeLessThan(12);
  });

  it('waits out a command still in flight rather than failing the run', async() => {
    const host = growHost([Error('An inspection command is already in progress. Check its status first.'),
      { refused: false, to: 'dimer', atomSites: 6818, lessonId: 'lesson-microtubule-growth-dimer' }]);
    const waits: number[] = [];
    const { grow } = await sendGrowCommand(host, 'next', { wait: async seconds => { waits.push(seconds); }, note: () => {} });
    expect(waits.length).toBeGreaterThanOrEqual(1);
    expect(grow.to).toBe('dimer');
  });

  it('waits out a companion 409 that the panel is still rendering another command', async() => {
    const host = growHost([
      Error('The requested panel is unavailable, dirty, stale, or rendering another command.'),
      { refused: false, to: 'dimer', atomSites: 6818, lessonId: 'lesson-microtubule-growth-dimer' },
    ]);
    const waits: number[] = [];
    const { grow } = await sendGrowCommand(host, 'next', { wait: async seconds => { waits.push(seconds); }, note: () => {} });
    expect(isCommandInFlight(Error('The requested panel is unavailable, dirty, stale, or rendering another command.'))).toBe(true);
    expect(waits).toEqual([2]);
    expect(grow.to).toBe('dimer');
  });

  it('gives up with the host’s own words on a refusal that is not about another command', async() => {
    const host = growHost([Error('This session is not playing a staged lesson, so there is no tier to grow from.')]);
    await expect(sendGrowCommand(host, 'next', { wait: async() => {}, note: () => {} }))
      .rejects.toThrow(/not playing a staged lesson/);
  });

  it('says so plainly when the host is too old to have the tool', async() => {
    const host = {
      async agent() { return { content: [{ type: 'text', text: 'Unknown tool.' }], structuredContent: {} } as any; },
      async inspectionState() { return {}; },
    };
    await expect(sendGrowCommand(host, 'next', { wait: async() => {}, note: () => {} }))
      .rejects.toThrow(/does not have the staged-demo tool/);
  });
});

describe('when a refused grow is photographed', () => {
  it('waits one companion heartbeat plus a paint frame, inside the overlay window', () => {
    expect(GROWTH_CAPTION_MS).toBe(4_000);
    expect(COMPANION_POLL_MS).toBe(1_000);
    expect(growRefusalCaptureWaitMs()).toBe(1_500);
    expect(growRefusalCaptureWaitMs()).toBeLessThan(GROWTH_CAPTION_MS);
    // Capturing in the same tick as the host answer leaves ~0 s of driver
    // wait. Waiting the full overlay would photograph the chapter caption the
    // overlay just returned to (half-open expiry).
    expect(growRefusalCaptureWaitMs({ overlayMs: GROWTH_CAPTION_MS, heartbeatMs: COMPANION_POLL_MS, paintMs: 0 }))
      .toBe(COMPANION_POLL_MS);
    expect(growRefusalCaptureWaitMs({ overlayMs: 4_000, heartbeatMs: 6_000 })).toBe(3_999);
    expect(growRefusalCaptureWaitMs({ overlayMs: 0 })).toBe(1_500);
  });
});

describe('how long a tier is given to rebuild', () => {
  it('is 30 s plus 2 s for every thousand atom sites of the target tier', () => {
    expect(growWaitMs(0)).toBe(GROW_BASE_WAIT_MS);
    expect(growWaitMs(6_818)).toBe(GROW_BASE_WAIT_MS + 7 * GROW_MS_PER_THOUSAND_SITES);
    expect(growWaitMs(13_636)).toBe(GROW_BASE_WAIT_MS + 14 * GROW_MS_PER_THOUSAND_SITES);
    // The wall is the tier that stalled a real Quest 2.
    expect(growWaitMs(40_908)).toBe(GROW_BASE_WAIT_MS + 41 * GROW_MS_PER_THOUSAND_SITES);
  });

  it('caps the wait, because past three minutes the session is gone rather than slow', () => {
    expect(growWaitMs(177_268)).toBe(GROW_MAX_WAIT_MS);
    expect(growWaitMs(Number.POSITIVE_INFINITY)).toBe(GROW_BASE_WAIT_MS);
    expect(growWaitMs(-1)).toBe(GROW_BASE_WAIT_MS);
  });
});

describe('how long a DENSITY tier is given, which is what the hardware measured', () => {
  // The filament tier carries an honest zero atom sites, so `growWaitMs`
  // handed the largest transfer in the product its 30 s floor: a driven grow
  // into it would have timed out before the map had crossed the LAN. An
  // earlier guess of 8 s per megabyte, about 1 MB/s, was sixty times the
  // measurement — 8,389,632 bytes fetched AND parsed in 1,131 ms, meshed to
  // 178,236 triangles in the 229 ms after it — so the driver sat on a dead
  // swap for over two minutes before it could report anything.
  const filament = {
    refused: false, from: 'wall', to: 'filament', atomSites: 0,
    size: { count: DENSITY_EXPECTED_TRIANGLES, unit: 'triangles' },
    density: { bytes: 8_389_632, sha256: 'a'.repeat(64), contour: 3.3 },
  } as const;
  /** What the ring recorded, and what every constant here is three or more times. */
  const MEASURED_TRANSFER_MS = 1_131;
  const MEASURED_MESH_MS = 229;

  it('reads the tier\'s own size and unit, and falls back to atom sites for an older host', () => {
    expect(growSize(filament)).toEqual({ count: 178_236, unit: 'triangles' });
    expect(growSize({ refused: false, atomSites: 40_908 })).toEqual({ count: 40_908, unit: 'atom sites' });
    // A host that predates `grow.size` still drives; a malformed one does not
    // get to invent a unit.
    expect(growSize({ refused: false, atomSites: 6_818, size: { count: Number.NaN, unit: 'triangles' } }))
      .toEqual({ count: 6_818, unit: 'atom sites' });
    expect(growSize({ refused: false })).toEqual({ count: 0, unit: 'atom sites' });
  });

  it('keeps a three-times margin over the transfer the headset actually managed', () => {
    // 8,389,632 bytes is 8.39 MB, and the slope rounds up to the whole
    // megabyte, so the map's own term is 9 x 400 ms.
    const megabytes = Math.ceil(8_389_632 / BYTES_PER_MEGABYTE);
    expect(megabytes).toBe(9);
    expect(megabytes * GROW_MS_PER_MEGABYTE).toBeGreaterThanOrEqual(3 * MEASURED_TRANSFER_MS);
    // The mesh slope keeps a far larger one on purpose: the measured build took
    // Mol*'s GPU isosurface path, and a device that fails one of its WebGL
    // checks drops to CPU marching cubes, which nobody has timed here.
    expect(18 * GROW_MS_PER_TEN_THOUSAND_TRIANGLES).toBeGreaterThan(3 * MEASURED_MESH_MS);
    // A megabyte is a megabyte: the map EMDB calls 8.4 MB is not printed as
    // 8.0 by dividing it by 1,048,576.
    expect(BYTES_PER_MEGABYTE).toBe(1_000_000);
  });

  it('gives the filament its whole transfer and its mesh, in a quarter of the old wait', () => {
    // 15 s floor + 9 MB x 400 ms + 18 x 10,000 triangles x 300 ms.
    expect(growTierWaitMs(filament)).toBe(
      GROW_DENSITY_BASE_WAIT_MS + 9 * GROW_MS_PER_MEGABYTE + 18 * GROW_MS_PER_TEN_THOUSAND_TRIANGLES);
    expect(growTierWaitMs(filament)).toBe(24_000);
    // What it used to be, and what the wearer used to wait for a failure.
    expect(growTierWaitMs(filament)).toBeLessThan(138_000 / 4);
    // Still seventeen times the 1.4 s the hardware took end to end.
    expect(growTierWaitMs(filament)).toBeGreaterThan(10 * (MEASURED_TRANSFER_MS + MEASURED_MESH_MS));
    // The thing this replaces: the same tier through the atom-site wait.
    expect(growWaitMs(Number(filament.atomSites))).toBe(GROW_BASE_WAIT_MS);
    expect(growTierWaitMs(filament)).toBeLessThan(GROW_DENSITY_MAX_WAIT_MS);
  });

  it('says what the wait is for, in the units the map is counted in', () => {
    expect(describeDensityWait(8_389_632, DENSITY_EXPECTED_TRIANGLES)).toBe('24 s for 8.4 MB + 178k triangles');
    // A map whose mesh nobody has measured yet still gets its transfer.
    expect(describeDensityWait(8_389_632, 0)).toBe('19 s for 8.4 MB');
  });

  it('leaves every atomic tier exactly as long as it was', () => {
    for (const atomSites of [0, 6_818, 13_636, 40_908, 43_066, 177_268]) {
      expect(growTierWaitMs({ refused: false, atomSites })).toBe(growWaitMs(atomSites));
    }
    // A `size` in atom sites is not a density tier and must not be treated as one.
    expect(growTierWaitMs({ refused: false, atomSites: 40_908, size: { count: 40_908, unit: 'atom sites' } }))
      .toBe(growWaitMs(40_908));
    // And the atom-site formula itself is untouched, cap included.
    expect(growWaitMs(177_268)).toBe(GROW_MAX_WAIT_MS);
  });

  it('caps at 90 s, because past that the swap is lost rather than large', () => {
    // A gigabyte of map is not a slow transfer, it is a wrong number.
    expect(growTierWaitMs({ ...filament, density: { ...filament.density, bytes: 1_000_000_000 } }))
      .toBe(GROW_DENSITY_MAX_WAIT_MS);
    expect(GROW_DENSITY_MAX_WAIT_MS).toBeLessThan(GROW_MAX_WAIT_MS);
    // No bytes, a negative or a non-finite count: fall back rather than invent
    // a shorter deadline out of a number nobody can trust.
    for (const bytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(growTierWaitMs({ ...filament, density: { ...filament.density, bytes } })).toBe(GROW_BASE_WAIT_MS);
    }
    // A mesh count that is nonsense costs the map its transfer and nothing more.
    expect(densityWaitMs(8_389_632, Number.NaN)).toBe(densityWaitMs(8_389_632, 0));
  });
});

describe('the triangle count the driver expects', () => {
  it('is the one the demo index ships for the filament, to the triangle', async () => {
    // The driver cannot read the index at run time — a session
    // opened straight onto the filament lesson carries the map's bytes and no
    // count — so it holds the number as a constant. This is what stops that
    // constant from drifting away from the asset the headset downloads.
    const index = JSON.parse(await readFile(new URL('../demos/index.json', import.meta.url), 'utf8'));
    const growth = index.demos.find((demo: any) => demo.name === 'microtubule-growth');
    const filament = growth.stages.find((stage: any) => stage.id === 'filament');
    expect(filament.coordinates.volume.triangles).toBe(DENSITY_EXPECTED_TRIANGLES);
    expect(filament.coordinates.atomSites).toBe(0);
    // The old Quest 2 hold is gone and must stay gone: the tier is offered
    // to both headsets on its measured size.
    expect(filament.tiers).toEqual(['quest2', 'quest3']);
  });
});

describe('what a density `open` has to prove, read from the headset\'s own ring', () => {
  // Three failures of this tier — a page reason, a host reason and a
  // scene-identity reason — all surfaced as a timeout about a panel that did
  // not come up, while the page's ring already carried the measured mesh, the
  // phase it died in and the plate the wearer was reading.
  const build = (triangles: number): DiagnosticRecord =>
    ({ kind: 'volume-build', detail: { id: 'session', contour: 3.3, bytes: 8_389_632, triangles } });
  const phase = (name: string, extra: Record<string, unknown> = {}): DiagnosticRecord =>
    ({ kind: 'grow', detail: { lessonId: 'microtubule-growth-filament', phase: name, atMs: 1_388, phaseMs: 229, ...extra } });
  const hud = (status: string): DiagnosticRecord => ({ kind: 'hud-outcome', detail: { status, fields: 'scene', revision: 2 } });
  const clean: DiagnosticRecord[] = [
    phase('parsed'), build(DENSITY_EXPECTED_TRIANGLES), phase('built'), phase('placed'),
    phase('saved'), phase('attached'), hud('rendered'),
  ];

  it('passes only when the mesh, the swap, the plate and the pairing all agree', () => {
    const proof = assessDensityOpen(clean, { paired: true });
    expect(proof.ok).toBe(true);
    expect(proof.triangles).toBe(178_236);
    expect(proof.problems).toEqual([]);
    expect(proof.offending).toEqual([]);
    // Queued and rendering are commands on their way, and `expired` is the
    // stale-plate sweep; none of them is the wearer reading "Could not apply".
    for (const status of ['queued', 'rendering', 'expired']) {
      expect(assessDensityOpen([...clean, hud(status)], { paired: true }).ok).toBe(true);
    }
  });

  it('takes the count the headset measured within two percent, and nothing further', () => {
    // The CPU marching-cubes count for the same map at the same contour is
    // 0.35% away and is still this mesh; a tenth more triangles is not.
    expect(assessDensityOpen([...clean.slice(0, 1), build(178_236), ...clean.slice(2)], { paired: true }).ok).toBe(true);
    const wrong = assessDensityOpen([...clean.slice(0, 1), build(200_000), ...clean.slice(2)], { paired: true });
    expect(wrong.ok).toBe(false);
    expect(wrong.triangles).toBe(200_000);
    expect(wrong.problems.join(' ')).toMatch(/200,000 triangles, not the 178,236/);
    expect(DENSITY_TRIANGLE_TOLERANCE).toBe(0.02);
  });

  it('names a failed scene restore as the cause instead of a timeout', () => {
    // The map WAS meshed, and the swap then failed restoring a scene whose
    // identity did not match it.
    const failed = 'A rich inspection can only be restored to its exact source, model and assembly.';
    const ring: DiagnosticRecord[] = [
      phase('parsed'), build(178_236), phase('built', { failed }), phase('placed'), phase('saved'), phase('attached'),
      { kind: 'volume-draw-failed', detail: { failed } },
    ];
    const proof = assessDensityOpen(ring, { paired: false });
    expect(proof.ok).toBe(false);
    expect(proof.triangles).toBe(178_236);
    expect(proof.problems.join(' ')).toContain('exact source, model and assembly');
    expect(proof.problems.join(' ')).toMatch(/No companion panel is paired/);
    expect(proof.offending.some(line => line.startsWith('volume-draw-failed'))).toBe(true);
  });

  it('says the map was never meshed when the page reported no build at all', () => {
    const proof = assessDensityOpen([phase('parsed'), phase('built', { timedOut: true })], { paired: true });
    expect(proof.ok).toBe(false);
    expect(proof.triangles).toBeNull();
    expect(proof.problems[0]).toMatch(/never reported a volume build/);
    expect(proof.problems.join(' ')).toMatch(/stalled in the built phase/);
  });

  it('fails a plate the wearer would be reading as an error', () => {
    const proof = assessDensityOpen([...clean, hud('failed')], { paired: true });
    expect(proof.ok).toBe(false);
    expect(proof.problems.join(' ')).toMatch(/status row read an error: failed/);
  });

  it('prints the ring entry and never the token inside it', () => {
    const secret = 'a'.repeat(40);
    const line = describeRingEntry({ kind: 'grow', detail: { lessonId: secret, phase: 'built' } });
    expect(line).not.toContain(secret);
    expect(line).toContain('<redacted>');
    expect(line).toContain('"phase":"built"');
    // A short identifier is not a secret and stays.
    expect(describeRingEntry({ kind: 'volume-build', detail: { id: 'session', triangles: 178_236 } }))
      .toBe('volume-build {"id":"session","triangles":178236}');
  });
});

describe('a density open is judged across its budget, not at one instant', () => {
  /**
   * On a real Quest 2, `open` failed 6.6 s after it started — 4 s after the
   * VIEW intent — saying the page had never meshed the map and no companion
   * was paired. The headset's own ring, read over CDP at that moment, held the
   * finished build, and the host listed the companion panel ready and current.
   * The entries below are those, and the arrival times are what a 1 Hz
   * heartbeat does with them.
   */
  const entry = (seq: number, kind: string, detail: Record<string, unknown>): DiagnosticRecord =>
    ({ seq, at: 1_789_171_379_298 + seq, kind, detail });
  const heartbeatRun: DiagnosticRecord[] = [
    entry(1, 'page-open', { userAgent: 'OculusBrowser/150.1.0.24.52.1046134268', secureContext: true, hasWebXr: true }),
    entry(5, 'grow', { phase: 'parsed', atMs: 795, phaseMs: 768, presenting: false }),
    entry(6, 'volume-build', { id: 'session', contour: 3.3, bytes: 8_389_632, triangles: 178_236 }),
    entry(7, 'grow', { lessonId: 'microtubule-growth-filament', phase: 'built', atMs: 1_226, phaseMs: 430, presenting: false }),
    entry(8, 'grow', { lessonId: 'microtubule-growth-filament', phase: 'placed', atMs: 1_226, phaseMs: 0, presenting: false }),
    entry(9, 'grow', { lessonId: 'microtubule-growth-filament', phase: 'saved', atMs: 1_259, phaseMs: 33, presenting: false }),
    entry(10, 'grow', { lessonId: 'microtubule-growth-filament', phase: 'attached', atMs: 1_268, phaseMs: 9, presenting: false }),
  ];

  /** A clock and a ring that fill the way the real ones did. */
  function replay(arrivals: ReadonlyArray<readonly DiagnosticRecord[]>, pairsAtPoll: number) {
    let clock = 0;
    let read = 0;
    let polls = 0;
    return {
      now: () => clock,
      wait: async (ms: number) => { clock += ms; },
      readRing: async () => arrivals[read++] ?? [],
      readPaired: async () => { polls += 1; return polls > pairsAtPoll; },
      get polls() { return polls; },
    };
  }

  it('passes once the heartbeat has delivered what the page already drew', async () => {
    // Nothing on the first read: the page is four seconds old and its entries
    // have not ridden a heartbeat yet — which is exactly the state the old
    // one-shot check failed on. The companion pairs on the third poll.
    const world = replay([[], heartbeatRun.slice(0, 2), heartbeatRun.slice(2)], 2);
    const watch = await watchDensityOpen({ readRing: world.readRing, readPaired: world.readPaired,
      budgetMs: 24_000, now: world.now, wait: world.wait });
    expect(watch.proof.ok).toBe(true);
    expect(watch.proof.problems).toEqual([]);
    expect(watch.proof.triangles).toBe(178_236);
    expect(watch.polls).toBe(3);
    expect(watch.waitedMs).toBe(2 * DENSITY_OPEN_POLL_MS);
    expect(watch.lost).toBe(false);
    // The same entries judged once, at the instant the panel list first
    // answered, are what the old one-shot check reported.
    const atOnce = assessDensityOpen([], { paired: false });
    expect(atOnce.ok).toBe(false);
    expect(atOnce.problems.join(' ')).toMatch(/never reported a volume build.*No companion panel is paired/s);
  });

  it('spends the whole budget before it says the map was not drawn', async () => {
    const world = replay([], 99);
    const watch = await watchDensityOpen({ readRing: world.readRing, readPaired: world.readPaired,
      budgetMs: 24_000, now: world.now, wait: world.wait });
    expect(watch.proof.ok).toBe(false);
    expect(watch.waitedMs).toBeGreaterThanOrEqual(24_000);
    expect(watch.polls).toBe(25);
    expect(watch.proof.problems.join(' ')).toMatch(/never reported a volume build/);
  });

  it('keeps the failure the page itself reported, and stops waiting for it', async () => {
    // The map WAS meshed and the swap then failed on scene identity. Reported at the first poll that sees it,
    // with the page's own words, rather than 24 s later.
    const failed = 'A rich inspection can only be restored to its exact source, model and assembly.';
    const lost: DiagnosticRecord[] = [
      entry(5, 'grow', { phase: 'parsed', atMs: 1_158, phaseMs: 1_131 }),
      entry(6, 'volume-build', { id: 'session', contour: 3.3, bytes: 8_389_632, triangles: 178_236 }),
      entry(7, 'grow', { lessonId: 'microtubule-growth-filament', phase: 'built', atMs: 1_388, phaseMs: 229, failed }),
      entry(8, 'grow', { lessonId: 'microtubule-growth-filament', phase: 'placed', atMs: 1_388, phaseMs: 0 }),
      entry(9, 'grow', { lessonId: 'microtubule-growth-filament', phase: 'saved', atMs: 1_390, phaseMs: 1 }),
      entry(10, 'grow', { lessonId: 'microtubule-growth-filament', phase: 'attached', atMs: 1_391, phaseMs: 1 }),
      entry(11, 'volume-draw-failed', { failed }),
    ];
    const world = replay([[], lost], 0);
    const watch = await watchDensityOpen({ readRing: world.readRing, readPaired: world.readPaired,
      budgetMs: 24_000, now: world.now, wait: world.wait });
    expect(watch.lost).toBe(true);
    expect(watch.polls).toBe(2);
    expect(watch.waitedMs).toBe(DENSITY_OPEN_POLL_MS);
    expect(watch.proof.ok).toBe(false);
    expect(watch.proof.problems.join(' ')).toContain('exact source, model and assembly');
    expect(watch.proof.offending.some(line => line.startsWith('volume-draw-failed'))).toBe(true);
  });

  it('keeps the zero-triangle failure of the run before it', async () => {
    // `triangles: 0` and a build that threw. A mesh of zero triangles is not a mesh, and the page said so.
    const zero: DiagnosticRecord[] = [
      entry(6, 'volume-build', { id: 'session', contour: 3.3, bytes: 8_389_632, triangles: 0 }),
      entry(7, 'grow', { lessonId: 'microtubule-growth-filament', phase: 'built', atMs: 1_322, phaseMs: 202,
        failed: "Cannot read properties of undefined (reading 'checkValid')" }),
    ];
    expect(densityOpenLost(zero)).toBe(true);
    const world = replay([zero], 0);
    const watch = await watchDensityOpen({ readRing: world.readRing, readPaired: world.readPaired,
      budgetMs: 24_000, now: world.now, wait: world.wait });
    expect(watch.proof.ok).toBe(false);
    expect(watch.polls).toBe(1);
    expect(watch.proof.triangles).toBeNull();
    expect(watch.proof.problems.join(' ')).toMatch(/volume build with no triangle count/);
    expect(watch.proof.problems.join(' ')).toMatch(/stalled in the built phase/);
  });

  it('never counts one entry twice, and a page that is still filling is not lost', () => {
    const merged = mergeRingEntries(heartbeatRun.slice(0, 3), heartbeatRun);
    expect(merged).toHaveLength(heartbeatRun.length);
    expect(merged.map(record => record.seq)).toEqual(heartbeatRun.map(record => record.seq));
    // An entry with no sequence of its own is kept as it comes.
    const loose = mergeRingEntries(merged, [{ kind: 'hud-outcome', detail: { status: 'rendered' } }]);
    expect(loose).toHaveLength(heartbeatRun.length + 1);
    expect(densityOpenLost(heartbeatRun)).toBe(false);
    expect(densityOpenLost([])).toBe(false);
  });

  it('reads the status row the wearer is on, not every one the run ever saw', () => {
    // The ring accumulates across polls now, so a plate that has already gone
    // back to `rendered` must not fail an open that drew.
    const hud = (status: string): DiagnosticRecord => ({ kind: 'hud-outcome', detail: { status } });
    const drawn = [...heartbeatRun, hud('failed'), hud('rendered')];
    expect(assessDensityOpen(drawn, { paired: true }).ok).toBe(true);
    expect(assessDensityOpen([...heartbeatRun, hud('rendered'), hud('failed')], { paired: true }).problems.join(' '))
      .toMatch(/status row read an error: failed/);
  });
});

describe('the wait for a headset that is holding a mesh rather than atoms', () => {
  it('sizes a panel wait off triangles when that is what the page is drawing', () => {
    // 30 s + 178,236 / 10,000 x 2 s, rounded to the second.
    expect(panelWaitMs({ triangles: 178_236 }, PANEL_READY_WAIT)).toBe(66_000);
    // Before this, a density tier described itself as having no size at all.
    expect(panelWaitMs({ atomSites: 0, triangles: 0 }, PANEL_READY_WAIT)).toBe(PANEL_READY_WAIT.baseMs);
    expect(panelWaitMs({ triangles: 10_000_000 }, PANEL_READY_WAIT)).toBe(PANEL_READY_WAIT.capMs);
  });

  it('takes the heavier of the two, so growing into a mesh never shortens a wait', () => {
    // The filament opens beside 3JAK's 43,066 atom sites. The page draws the
    // mesh and never parses them, but the exit wait must not drop below what
    // the tip tier already earned.
    const tip = panelWaitMs(43_066, PANEL_READY_WAIT);
    expect(panelWaitMs({ atomSites: 43_066, triangles: 178_236 }, PANEL_READY_WAIT)).toBe(tip);
    expect(panelWaitMs({ atomSites: 43_066, triangles: 178_236 }, PANEL_READY_WAIT))
      .toBeGreaterThanOrEqual(panelWaitMs({ triangles: 178_236 }, PANEL_READY_WAIT));
    // A plain number still means atom sites, so nothing that existed moved.
    expect(panelWaitMs(40_908, PANEL_READY_WAIT)).toBe(112_000);
    expect(panelWaitMs({ atomSites: 40_908 }, PANEL_READY_WAIT)).toBe(112_000);
  });

  it('says triangles when there are triangles, and never "0 atom sites"', () => {
    expect(describePanelWait({ triangles: 178_236 }, PANEL_READY_WAIT)).toBe('66s for 178,236 triangles');
    expect(describePanelWait({ atomSites: 43_066, triangles: 178_236 }, PANEL_READY_WAIT))
      .toBe('116s for 178,236 triangles beside 43,066 atom sites');
    expect(describePanelWait({ atomSites: 0, triangles: 178_236 }, PANEL_READY_WAIT)).not.toMatch(/atom sites/);
    expect(describePanelWait({ triangles: 10_000_000 }, PANEL_READY_WAIT)).toMatch(/at the cap$/);
    expect(describePanelWait({}, PANEL_READY_WAIT)).toBe('30s (no atom-site count was given, so this is the base wait)');
    expect(describePanelWait(40_908, PANEL_READY_WAIT)).toBe('112s for 40,908 atom sites');
  });
});

describe('the size every wait after a grow is measured against', () => {
  // `--steps open,enter,tour,grow,exit --device quest2` grew the monomer to
  // the wall and then failed `exit` with "Timed out after 30 s
  // waiting for the session to end" — on a session that ended about a minute
  // later. The wait was sized for the structure the run OPENED with.
  it('is the grown tier once one has landed, and the run\'s own count until then', () => {
    expect(liveAtomSites(6_818, undefined)).toBe(6_818);
    expect(liveAtomSites(6_818, 40_908)).toBe(40_908);
    expect(liveAtomSites(undefined, 40_908)).toBe(40_908);
    expect(liveAtomSites(undefined, undefined)).toBeUndefined();
  });

  it('ignores a count that is not a positive number rather than shortening a wait', () => {
    expect(liveAtomSites(6_818, 0)).toBe(6_818);
    expect(liveAtomSites(6_818, -1)).toBe(6_818);
    expect(liveAtomSites(6_818, Number.NaN)).toBe(6_818);
  });

  it('turns the wall into a wait minutes long, while an ungrown run keeps its 30 s', () => {
    expect(panelWaitMs(liveAtomSites(undefined, undefined), PANEL_READY_WAIT)).toBe(PANEL_READY_WAIT.baseMs);
    expect(panelWaitMs(liveAtomSites(6_818, 40_908), PANEL_READY_WAIT))
      .toBeGreaterThan(3 * PANEL_READY_WAIT.baseMs);
  });

  it('sizes the entry and Mol* return poll from the current wall, then returns on the first presenting reading', async () => {
    let timeoutMs = 0;
    let predicateReads = 0;
    const result = await waitForPresentingPanel({
      options: { atomSites: 6_818 },
      currentAtomSites: 40_908,
      currentTriangles: undefined,
      async waitForPanel(_what, accept, timeout) {
        timeoutMs = timeout ?? 0;
        predicateReads++;
        expect(accept({ xrStartup: { presenting: false } })).toBe(false);
        predicateReads++;
        const ready = { xrStartup: { presenting: true } };
        expect(accept(ready)).toBe(true);
        return ready;
      },
    }, 'the session to come back after Mol*');

    expect(timeoutMs).toBe(112_000);
    expect(predicateReads).toBe(2);
    expect(result?.xrStartup.presenting).toBe(true);
    const source = await readFile(new URL('../scripts/headset-drive.ts', import.meta.url), 'utf8');
    expect(source.match(/waitForPresentingPanel\(driver,/gu)).toHaveLength(2);
    expect(source).not.toContain('40_000');
  });
});

describe('the grow phase records the headset reports', () => {
  const entry = (detail: Record<string, unknown>): DiagnosticRecord => ({ kind: 'grow', detail });
  const swap = [
    entry({ phase: 'requested', atMs: 0, phaseMs: 0, presenting: true, lessonId: 'lesson-microtubule-growth-dimer' }),
    entry({ phase: 'source-fetched', atMs: 900, phaseMs: 900, presenting: true, lessonId: 'lesson-microtubule-growth-dimer' }),
    entry({ phase: 'built', atMs: 4_200, phaseMs: 3_300, presenting: true, lessonId: 'lesson-microtubule-growth-dimer' }),
  ];

  it('keeps only this swap, not the tier before it', () => {
    const noise: DiagnosticRecord[] = [entry({ phase: 'built', lessonId: 'lesson-microtubule-growth-monomer' }),
      { kind: 'frame-cost', detail: { fps: 71 } }, ...swap];
    expect(growPhaseRecords(noise, 'lesson-microtubule-growth-dimer').map(record => record.phase))
      .toEqual(['requested', 'source-fetched', 'built']);
  });

  it('ends the wait only once the page says it re-attached', () => {
    expect(growLanded(growPhaseRecords(swap))).toBe(false);
    expect(growLanded(growPhaseRecords([...swap, entry({ phase: 'attached', atMs: 6_100 })]))).toBe(true);
    // A swap that reached `attached` and threw there has not landed.
    expect(growLanded(growPhaseRecords([entry({ phase: 'attached', failed: 'The viewer is not connected.' })]))).toBe(false);
  });

  it('names the phase a stalled swap died in, so the driver stops waiting out its budget', () => {
    expect(growStalledPhase(growPhaseRecords(swap))).toBeUndefined();
    const stalled = growPhaseRecords([...swap,
      entry({ phase: 'built', atMs: 49_200, phaseMs: 45_000, timedOut: true, failed: 'stalled' })]);
    expect(growStalledPhase(stalled)?.phase).toBe('built');
  });
});

describe('the grow step in the plan', () => {
  it('is a known step, in the place a wearer would meet it', () => {
    expect([...DRIVE_STEPS]).toEqual(['open', 'enter', 'return', 'tour', 'grow', 'spin', 'stop', 'quality', 'voice', 'ask', 'molstar', 'exit']);
  });

  it('is left out of a bare run, because an ordinary lesson has no tier to grow from', () => {
    expect(parseDriveArguments(base).steps).not.toContain('grow');
    // `return` joined `grow` as opt-in. The default run reaches Mol*
    // through `molstar`, which already comes home.
    expect([...DEFAULT_DRIVE_STEPS]).toEqual(DRIVE_STEPS.filter(step => step !== 'grow' && step !== 'return'));
  });

  it('is asked for by name, with the tour that gives it a lesson', () => {
    expect(parseDriveArguments([...base, '--steps', 'open,enter,tour,grow']).steps)
      .toEqual(['open', 'enter', 'tour', 'grow']);
  });

  it('takes the headset class, and refuses one it does not know', () => {
    expect(parseDriveArguments([...base, '--device', 'quest3']).device).toBe('quest3');
    // Unstated is the conservative case: the host then assumes the smallest budget.
    expect(parseDriveArguments(base).device).toBeUndefined();
    expect(() => parseDriveArguments([...base, '--device', 'quest9'])).toThrow(/Unknown device class/);
    expect(() => parseDriveArguments([...base, '--device'])).toThrow(DriveUsageError);
  });
});

describe('wall tier: a rejected receipt that says still rendering is retried on a size-aware budget', () => {
  it('scales the retry budget with the atom count and never below the base', () => {
    expect(inFlightAttempts(undefined)).toBeGreaterThanOrEqual(6);
    expect(inFlightAttempts(6_818)).toBeGreaterThanOrEqual(inFlightAttempts(undefined));
    expect(inFlightAttempts(40_908)).toBe(56);
  });
});

describe('an autoplaying lesson is watched, not pushed', () => {
  /**
   * The tour step started the lesson, saw chapter 1 "Three wide", and then
   * failed with "No panel is ready for a command right now (companion
   * unsaved)" while the page's own ring showed the lesson advancing by itself
   * — scene 0 (dwell 10 s), narration, scene 1 "Two contacts" (dwell 12 s).
   * The scene record below is copied from a real ring.
   */
  const UNSAVED = 'No panel is ready for a command right now (companion unsaved). Let the panel finish, then try again.';

  /** A fake headset: a ring on a virtual clock, a panel whose availability is scripted, and a capture log. */
  function ring({ total = 3, availability = ['ready'] as string[] } = {}) {
    let clock = 0;
    let seq = 0;
    let latest = availability[0] ?? 'ready';
    let reads = 0;
    const pending: Array<{ at: number; entry: DiagnosticRecord }> = [];
    const captures: string[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const notes: string[] = [];
    let onNext: ((emit: (afterMs: number, step: number, dwellMs: number, title?: string) => void) => void) | undefined;
    const host = {
      get clock() { return clock; },
      captures, sent, notes,
      now: () => clock,
      wait: async(seconds: number) => { clock += seconds * 1_000; },
      note: (message: string) => { notes.push(message); },
      whenNudged(handler: (emit: (afterMs: number, step: number, dwellMs: number, title?: string) => void) => void) { onNext = handler; },
      emit(afterMs: number, kind: string, detail: Record<string, unknown>) {
        pending.push({ at: clock + afterMs, entry: { seq: ++seq, at: clock + afterMs, kind, detail } });
      },
      scene(afterMs: number, step: number, dwellMs: number, title?: string) {
        host.emit(afterMs, 'tour', { action: 'scene', step, total, active: true, autoplay: true, xr: true, outcome: 'shown', title, dwellMs });
      },
      narration(afterMs: number, step: number) {
        host.emit(afterMs, 'tour', { action: 'narration', step, total, active: true, autoplay: true, xr: true, chars: 54 });
      },
      async newDiagnostics() {
        const due = pending.filter(item => item.at <= clock);
        for (const item of due) pending.splice(pending.indexOf(item), 1);
        return due.sort((left, right) => (left.at - right.at) || (Number(left.entry.seq) - Number(right.entry.seq))).map(item => item.entry);
      },
      async capture(name: string) { captures.push(name); return { path: `/out/${name}.png`, via: 'adb screencap' }; },
      async agent(name: string, args: Record<string, unknown> = {}) {
        // The real `Driver.agent` throws this out of `fillAgentArguments`
        // (agent-arguments.ts:181) when `choosePanel` sees an unsaved companion.
        if (latest !== 'ready') throw Error(UNSAVED);
        sent.push({ name, ...args });
        if (name === 'control_tour' && args.action === 'next') onNext?.(host.scene);
        return { content: [], structuredContent: { command: { commandId: String(args.commandId) } } } as any;
      },
      async inspectionState() {
        latest = availability[Math.min(reads++, availability.length - 1)] ?? 'ready';
        return {
          panels: [{ panelId: 'c1', surface: 'companion', current: true, availability: latest }],
          commands: sent.map(args => ({ commandId: String(args.commandId), status: 'rendered' })),
        };
      },
    };
    return host;
  }

  it('reads the scene records the page actually writes', () => {
    const shown = tourSceneShown({ seq: 310, at: 1789181988998, kind: 'tour',
      detail: { action: 'scene', step: 3, total: 5, active: true, autoplay: true, xr: true, outcome: 'shown', title: 'Same cargo', dwellMs: 11000 } });
    expect(shown).toEqual({ step: 3, dwellMs: 11_000, total: 5, title: 'Same cargo' });
    // Narration shares the kind and is not a chapter; a scene the player could
    // not show is not one either.
    expect(tourSceneShown({ kind: 'tour', detail: { action: 'narration', step: 2, chars: 54 } })).toBeUndefined();
    expect(tourSceneShown({ kind: 'tour', detail: { action: 'scene', step: 1, outcome: 'refused' } })).toBeUndefined();
    expect(tourSceneShown({ kind: 'frame-rate', detail: { fps: 72 } })).toBeUndefined();
    expect(tourIsAutoplaying({ autoplay: true, step: 0 })).toBe(true);
    expect(tourIsAutoplaying({ autoplay: false, step: 0 })).toBe(false);
    expect(tourIsAutoplaying(undefined)).toBe(false);
  });

  it('watches three autoplayed chapters through without sending one command', async() => {
    const host = ring();
    host.scene(1_000, 0, 10_000, 'Three wide');
    host.narration(2_000, 0);
    host.scene(12_000, 1, 12_000, 'Two contacts');
    host.narration(13_000, 1);
    host.scene(25_000, 2, 11_000, 'Same cargo');
    host.narration(26_000, 2);
    const watch = await watchAutoplayedTour(host, { total: 3, wait: host.wait, now: host.now, note: host.note });
    expect(host.sent).toHaveLength(0);
    expect(watch.nudges).toHaveLength(0);
    expect(watch.chapters).toHaveLength(3);
    expect(watch.chapters.map(chapter => chapter.title)).toEqual(['Three wide', 'Two contacts', 'Same cargo']);
    expect(watch.chapters.map(chapter => chapter.dwellMs)).toEqual([10_000, 12_000, 11_000]);
    // Photographed at the moment each chapter appeared, named for its chapter.
    expect(host.captures).toEqual(['tour-01', 'tour-02', 'tour-03']);
    expect(watch.narrations).toHaveLength(3);
    expect(watch.narrations.map(line => line.chapter)).toEqual([1, 2, 3]);
    expect(watch.failures).toHaveLength(0);
  });

  it('nudges once when the lesson stalls past its dwell, and only then', async() => {
    const host = ring();
    host.scene(1_000, 0, 10_000, 'Three wide');
    let next = 1;
    host.whenNudged(scene => { scene(1_000, next, 12_000, `Chapter ${next + 1}`); next += 1; });
    const watch = await watchAutoplayedTour(host, { total: 3, wait: host.wait, now: host.now, note: host.note });
    expect(watch.chapters).toHaveLength(3);
    expect(watch.nudges).toHaveLength(2);
    expect(host.sent.every(command => command.name === 'control_tour' && command.action === 'next')).toBe(true);
    // The stall is the chapter's own dwell plus the margin, not a fixed timer.
    expect(Number(watch.nudges[0].waitedSeconds)).toBeGreaterThanOrEqual((10_000 + TOUR_STALL_MARGIN_MS) / 1_000);
    expect(watch.chapters[1].nudged).toBe(true);
    expect(watch.chapters[0].nudged).toBe(false);
    expect(host.captures).toEqual(['tour-01', 'tour-02', 'tour-03']);
  });

  it('fails with the chapter it died on when the nudges do not move it either', async() => {
    const host = ring();
    host.scene(1_000, 0, 10_000, 'Three wide');
    await expect(watchAutoplayedTour(host, { total: 3, wait: host.wait, now: host.now, note: host.note, maxNudges: 1 }))
      .rejects.toThrow(/stopped after 1 of 3 chapters/);
    expect(host.sent).toHaveLength(1);
  });

  it('records a spoken line that never reached the wearer', async() => {
    const host = ring();
    host.scene(1_000, 0, 10_000, 'Three wide');
    host.emit(2_000, 'speech-failed', { route: 'speak_to_headset', status: 409, reason: 'panel busy' });
    host.scene(5_000, 1, 10_000, 'Two contacts');
    const watch = await watchAutoplayedTour(host, { total: 2, wait: host.wait, now: host.now, note: host.note });
    expect(watch.failures).toHaveLength(1);
    expect(watch.failures[0]).toContain('speak_to_headset HTTP 409');
  });

  it('waits out a panel that is unsaved for two polls, then sends', async() => {
    const host = ring({ availability: ['unsaved', 'unsaved', 'ready'] });
    const seen = await waitForAvailablePanel(host, { timeoutMs: TOUR_PANEL_WAIT_MS, wait: host.wait, now: host.now, note: host.note });
    expect(seen.available).toBe(true);
    expect(seen.polls).toBe(3);
    expect(seen.waitedMs).toBe(2_000);
    // Two beats is well inside the bound, so nothing is sent early and nothing fails.
    expect(seen.waitedMs).toBeLessThan(TOUR_PANEL_WAIT_MS);
    const sent = await sendTourCommand(host, 'next', {}, { wait: host.wait, now: host.now, note: host.note, waitAvailableMs: TOUR_PANEL_WAIT_MS });
    expect(sent.receipt.status).toBe('rendered');
    expect(host.sent).toHaveLength(1);
  });

  it('treats the unsaved refusal as a retry rather than the end of the run', async() => {
    // The panel is saving the scene the lesson just advanced to, and the old
    // step reported that sentence as the step's failure.
    expect(isCommandInFlight(Error(UNSAVED))).toBe(true);
    const host = ring({ availability: ['unsaved'] });
    const seen = await waitForAvailablePanel(host, { timeoutMs: 4_000, wait: host.wait, now: host.now, note: host.note });
    expect(seen.available).toBe(false);
    expect(seen.panel?.availability).toBe('unsaved');
    await expect(sendTourCommand(host, 'next', {}, { wait: host.wait, now: host.now, note: host.note, attempts: 2, waitAvailableMs: 2_000 }))
      .rejects.toThrow(/companion unsaved/);
    // It was tried, not given up on at the first sentence.
    expect(host.notes.some(message => /sending next anyway/.test(message))).toBe(true);
  });

  it('reads the headset panel out of a state reading the same way every step does', () => {
    const companion = { panelId: 'c1', surface: 'companion', availability: 'unsaved', current: true };
    const desktop = { panelId: 'd1', surface: 'desktop', availability: 'ready', current: true };
    expect(companionPanelOf({ panels: [desktop, companion] })).toBe(companion);
    expect(companionPanelOf({ panels: [desktop] })).toBeUndefined();
    expect(companionPanelOf({ panels: [] })).toBeUndefined();
    expect(companionPanelOf(undefined)).toBeUndefined();
  });

  it('follows the replacement companion after navigation instead of its stale predecessor', () => {
    const stale = { panelId: 'before-molstar', surface: 'companion', availability: 'unsaved', current: false,
      xrStartup: { presenting: false, stale: true, ageMs: 44_464 } };
    const live = { panelId: 'after-molstar', surface: 'companion', availability: 'ready', current: true,
      xrStartup: { presenting: true, stale: false, ageMs: 156 } };
    expect(companionPanelOf({ panels: [stale, live] })).toBe(live);
    expect(companionPanelOf({ panels: [live, stale] })).toBe(live);
  });

  it('binds multiple live companions to this page id and refuses an ambiguous device choice', () => {
    const first = { panelId: 'quest-a', surface: 'companion', availability: 'ready', current: true,
      xrStartup: { presenting: true, stale: false } };
    const second = { panelId: 'quest-b', surface: 'companion', availability: 'ready', current: true,
      xrStartup: { presenting: false, stale: false } };
    expect(companionPanelOf({ panels: [first, second] }, 'quest-b')).toBe(second);
    expect(companionPanelOf({ panels: [first, second] })).toBeUndefined();
  });

  it('fails a supplied page identity closed instead of falling through to another device', () => {
    const retiredPage = { panelId: 'this-page', surface: 'companion', availability: 'unsaved', current: false };
    const otherDevice = { panelId: 'other-headset', surface: 'companion', availability: 'ready', current: true,
      xrStartup: { presenting: true, stale: false } };
    expect(companionPanelOf({ panels: [retiredPage, otherDevice] }, 'this-page')).toBeUndefined();
    expect(companionPanelOf({ panels: [otherDevice] }, 'missing-page')).toBeUndefined();
  });

  it('refuses two current devices even when only one heartbeat is fresh', () => {
    const stale = { panelId: 'quest-a', surface: 'companion', availability: 'unsaved', current: true,
      xrStartup: { presenting: false, stale: true } };
    const fresh = { panelId: 'quest-b', surface: 'companion', availability: 'ready', current: true,
      xrStartup: { presenting: true, stale: false } };
    expect(companionPanelOf({ panels: [stale, fresh] })).toBeUndefined();
    expect(companionPanelOf({ panels: [fresh, stale] })).toBeUndefined();
  });

  it('uses root pairing recovery only for an authorized page that reports a dead connection', () => {
    expect(needsPairingRecovery({ pageKeyPresent: true, message: 'Disconnected. Reconnecting.' })).toBe(true);
    expect(needsPairingRecovery({ pageKeyPresent: false, message: 'This tab needs pairing.' })).toBe(false);
    expect(needsPairingRecovery({ pageKeyPresent: true, message: 'Loading structure…' })).toBe(false);
  });

  it('keeps the watch constants in the range the hardware measured', () => {
    // Measured dwells were 10-12 s; the default stands in for a record
    // that carries none, and the margin has to be smaller than the shortest.
    expect(TOUR_DEFAULT_DWELL_MS).toBe(12_000);
    expect(TOUR_STALL_MARGIN_MS).toBeLessThan(10_000);
    expect(TOUR_PANEL_WAIT_MS).toBeGreaterThan(TOUR_STALL_MARGIN_MS);
  });
});

describe('waiting for Enter VR to enable', () => {
  /**
   * After a LAN host restart the button is in the DOM but disabled while the
   * lesson scene loads. The enter step used to click that reading and fail.
   * A fake page session scripts `locate` the way the density and tour tests
   * script a host: a virtual clock, a scripted button, and a click log.
   */
  const control = (disabled: boolean) => ({ x: 120, y: 40, disabled, text: 'Enter VR' });
  const trackingLost = { errorName: 'Error', reloadRequired: true, phase: 'requesting-headset' };

  function pageSession(states: Array<{ disabled: boolean } | null>, xrStartup: Record<string, unknown> | null = null) {
    let clock = 0;
    let reads = 0;
    const clicks: Array<{ x: number; y: number }> = [];
    const notes: string[] = [];
    const waits: number[] = [];
    const host = {
      clicks, notes, waits,
      options: {} as { atomSites?: number },
      now: () => clock,
      wait: async (ms: number) => { waits.push(ms); clock += ms; },
      note: (message: string) => { notes.push(message); },
      async locate(_selector: string, _pattern: string) {
        const state = states[Math.min(reads++, states.length - 1)] ?? null;
        return state === null ? null : control(state.disabled);
      },
      async click(x: number, y: number) { clicks.push({ x, y }); },
      async companionPanel() {
        return {
          surface: 'companion',
          current: true,
          availability: 'ready',
          xrStartup: clicks.length > 0
            ? { presenting: true, mode: 'immersive-ar', blendMode: 'alpha-blend', trustedClick: true }
            : xrStartup,
        };
      },
      async waitForPanel(_what: string, accept: (panel: Record<string, any> | undefined) => boolean) {
        const panel = await host.companionPanel();
        if (!accept(panel)) throw new Error(`test host: panel was not accepted for ${_what}`);
        return panel;
      },
      async newDiagnostics() { return [] as DiagnosticRecord[]; },
      latestFps() { return null; },
      async pageStatus() { return ''; },
      async wakeDisplay() {},
      async repair() {},
      async reload() {},
    };
    return host;
  }

  it('waits through several disabled polls, then clicks once the button enables', async () => {
    const page = pageSession([{ disabled: true }, { disabled: true }, { disabled: true }, { disabled: false }]);
    const ready = await waitForEnabledEnterButton(page, { wait: page.wait, now: page.now, note: page.note });
    await page.click(ready.button.x, ready.button.y);
    expect(page.clicks).toEqual([{ x: 120, y: 40 }]);
    expect(ready.button.disabled).toBe(false);
    expect(ready.polls).toBe(4);
    expect(ready.waitedMs).toBe(3 * ENTER_VR_ENABLE_POLL_MS);
    expect(page.waits).toEqual([ENTER_VR_ENABLE_POLL_MS, ENTER_VR_ENABLE_POLL_MS, ENTER_VR_ENABLE_POLL_MS]);
    expect(page.notes.some(line => line.includes(`waited ${3 * ENTER_VR_ENABLE_POLL_MS} ms`))).toBe(true);
  });

  it('fails with the button state when it never enables', async () => {
    const page = pageSession([{ disabled: true }]);
    await expect(waitForEnabledEnterButton(page, {
      timeoutMs: ENTER_VR_ENABLE_WAIT_MS, pollMs: ENTER_VR_ENABLE_POLL_MS,
      wait: page.wait, now: page.now, note: page.note,
    })).rejects.toThrow(/Timed out after 90 s waiting for Enter VR to enable \(button is disabled\)/);
    expect(page.clicks).toHaveLength(0);
    expect(ENTER_VR_ENABLE_WAIT_MS).toBe(90_000);
    expect(ENTER_VR_ENABLE_POLL_MS).toBe(250);
  });

  it('clicks an already-enabled button after one poll and no extra delay', async () => {
    const page = pageSession([{ disabled: false }]);
    const ready = await waitForEnabledEnterButton(page, { wait: page.wait, now: page.now, note: page.note });
    await page.click(ready.button.x, ready.button.y);
    expect(ready.polls).toBe(1);
    expect(ready.waitedMs).toBe(0);
    expect(page.waits).toEqual([]);
    expect(page.clicks).toEqual([{ x: 120, y: 40 }]);
    expect(page.notes.some(line => line.includes('waited 0 ms'))).toBe(true);
  });

  it('fails at once with tracking-loss advice when the disabled button is tracking loss', async () => {
    const host = pageSession([{ disabled: true }], trackingLost);
    const error = await stepEnter(host).then(() => undefined, thrown => thrown as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('Enter VR is disabled.');
    expect(error?.message).toContain('requesting-headset');
    expect(error?.message).toContain(TRACKING_LOSS_ADVICE);
    expect(host.clicks).toHaveLength(0);
    expect(host.waits).toEqual([]);
  });

  /**
   * `--steps enter
   * --resume-session` polled 321 times for 90 044 ms on a disabled button
   * while the page was presenting and the panel read `presenting: false`.
   */
  it('returns already-presenting from the page hook instead of waiting out a disabled button', async () => {
    const evaluated: string[] = [];
    const host = Object.assign(pageSession([{ disabled: true }], { presenting: false }), {
      evaluate: async (expression: string) => { evaluated.push(expression); return { hook: true, rows: 17 }; },
    });
    const result = await stepEnter(host);
    expect(evaluated).toEqual([OBSERVE_IMMERSIVE_MENU_EXPRESSION]);
    expect(host.clicks).toHaveLength(0);
    expect(host.waits).toEqual([]);
    expect(result.evidence.method).toBe('already-presenting');
    expect(result.evidence.verified).toBe(true);
    expect(result.evidence.presentingSource).toBe('page');
    expect(result.evidence.spatialRows).toBe(17);
    expect(result.evidence.buttonState).toBe('disabled');
    expect(result.detail).toMatch(/the page's immersive menu is running \(17 rows\)/);
  });

  it('names already-presenting on the panel route and trusts session evidence over an enabled button', async () => {
    const host = pageSession([{ disabled: true }], { presenting: true });
    const result = await stepEnter(host);
    expect(host.clicks).toHaveLength(0);
    expect(result.evidence.method).toBe('already-presenting');
    expect(result.evidence.presentingSource).toBe('panel');
    expect(decideAlreadyPresenting({ button: { x: 1, y: 2, disabled: false, text: 'Enter VR' },
      panelPresenting: true, spatialRows: 17 })).toEqual({ already: true, source: 'page' });
    expect(decideAlreadyPresenting({ button: null, panelPresenting: false, spatialRows: 0 }))
      .toEqual({ already: false, source: null });
    expect(decideAlreadyPresenting({ button: null, panelPresenting: null, spatialRows: null }))
      .toEqual({ already: false, source: null });
  });

  it('still clicks after several disabled polls when tracking is not lost', async () => {
    // stepEnter locates once before the wait, so four disabled readings leave
    // three polls inside waitForEnabledEnterButton before the enable.
    const host = pageSession(
      [{ disabled: true }, { disabled: true }, { disabled: true }, { disabled: true }, { disabled: false }],
      { presenting: false },
    );
    const result = await stepEnter(host);
    expect(host.clicks).toEqual([{ x: 120, y: 40 }]);
    expect(host.waits).toEqual([ENTER_VR_ENABLE_POLL_MS, ENTER_VR_ENABLE_POLL_MS, ENTER_VR_ENABLE_POLL_MS]);
    expect(result.detail).toMatch(/Presenting immersive-ar/);
    expect(result.detail).toMatch(/trusted click true/);
    expect(result.evidence.clickedAt).toBe('120,40');
  });
});

/**
 * Meta's boundary dialog, read over adb.
 *
 * The dump lines here are trimmed from a real Quest 2 that had rebooted on a
 * flat battery in a dark room: the dialog was up, Quest Browser
 * never received the page, and every `open` could do was spend its 90 s. The
 * distinguishing text is `topResumedActivity=`, which names only the activity
 * a task is actually showing — the same dump carries paused Guardian records
 * in other states, so matching the component name anywhere would misread them.
 */
const GUARDIAN_DUMP = [
  'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
  'Display #0 (activities from top to bottom):',
  '  * Task{50a6271 #878 type=standard A=10024:com.oculus.guardian:-1044315416 U=0 visible=true}',
  '      topResumedActivity=ActivityRecord{3973818 u0 com.oculus.guardian/com.oculus.vrguardianservice.guardiandialog.GuardianDialogActivity t878}',
  '  * Task{512426 #876 type=standard A=10020:com.oculus.vrshell:-339196040 U=0 visible=true}',
  '      topResumedActivity=ActivityRecord{c1fcb81 u0 com.oculus.vrshell/.FocusPlaceholderActivity t876}',
].join('\n');

const CLEAR_DUMP = [
  'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
  'Display #0 (activities from top to bottom):',
  '  * Task{512426 #876 type=standard A=10020:com.oculus.vrshell:-339196040 U=0 visible=true}',
  '      topResumedActivity=ActivityRecord{c1fcb81 u0 com.oculus.vrshell/.FocusPlaceholderActivity t876}',
  '  * Task{29ef405 #837 type=standard A=10020:com.oculus.vrshell U=0 visible=true}',
  '      topResumedActivity=ActivityRecord{9b730a8 u0 com.oculus.vrshell/.HomeActivity t837}',
].join('\n');

/** The same dialog activity, left behind in history rather than on screen. */
const STALE_RECORD_DUMP = [
  'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
  'Display #0 (activities from top to bottom):',
  '  * Task{512426 #876 type=standard A=10020:com.oculus.vrshell U=0 visible=true}',
  '      topResumedActivity=ActivityRecord{c1fcb81 u0 com.oculus.vrshell/.FocusPlaceholderActivity t876}',
  '      * Hist  #0: ActivityRecord{3973818 u0 com.oculus.guardian/com.oculus.vrguardianservice.guardiandialog.GuardianDialogActivity t878}',
  '        state=STOPPED delayedResume=false finishing=true',
].join('\n');

const dumpHost = (stdout: string, code = 0) => ({
  async adbShell() { return { code, stdout: Buffer.from(stdout), stderr: '' }; },
});

describe('the Quest boundary dialog', () => {
  it('names the dialog from the activity the headset is actually showing', () => {
    expect(detectGuardianDialog(GUARDIAN_DUMP)).toBe(true);
  });

  it('reads a cleared headset as clear', () => {
    expect(detectGuardianDialog(CLEAR_DUMP)).toBe(false);
  });

  it('does not read a finished dialog left in history as the dialog being up', () => {
    expect(detectGuardianDialog(STALE_RECORD_DUMP)).toBe(false);
  });

  it('reports the dialog with the time it was read', async() => {
    const state = await readGuardianDialog(dumpHost(GUARDIAN_DUMP));
    expect(state.showing).toBe(true);
    expect(state.activity).toBe(GUARDIAN_DIALOG_ACTIVITY);
    expect(typeof state.readAt).toBe('string');
  });

  it('reports a clear headset without naming an activity', async() => {
    const state = await readGuardianDialog(dumpHost(CLEAR_DUMP));
    expect(state.showing).toBe(false);
    expect(state.activity).toBeUndefined();
  });

  it('answers unknown rather than clear when adb fails, so the wait still runs', async() => {
    expect((await readGuardianDialog(dumpHost('', 1))).showing).toBeNull();
    expect((await readGuardianDialog({ async adbShell() { throw new Error('device offline'); } })).showing).toBeNull();
  });

  it('aborts a hung adb read and answers unknown so the wait still runs', async() => {
    let signal: AbortSignal | undefined;
    const state = await readGuardianDialog({
      adbShell(...args) {
        expect(args.slice(0, 3)).toEqual(['dumpsys', 'activity', 'activities']);
        const options = args.at(-1);
        if (typeof options === 'object') signal = options.signal;
        return new Promise(() => {});
      },
    }, 20);
    expect(state).toEqual({ showing: null, reason: 'adb timed out', readAt: expect.any(String) });
    expect(signal?.aborted).toBe(true);
  }, 1_000);

  it('kills the hung adb child when the guardian read times out', async() => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-dialog-'));
    const fakeAdb = join(directory, 'fake-adb');
    let pid: number | undefined;
    try {
      await writeFile(fakeAdb, '#!/bin/sh\n'
        + 'echo $$ > "$0.pid"\n'
        + 'trap "" TERM\n'
        + 'exec sleep 60\n');
      await chmod(fakeAdb, 0o755);
      const driver = new Driver({} as any, fakeAdb, 0, {} as any, parseDriveArguments(base));
      const state = await readGuardianDialog(driver, 1_000);
      pid = Number(await readFile(`${fakeAdb}.pid`, 'utf8'));
      expect(state.showing).toBeNull();
      expect(state.reason).toBe('adb timed out');
      // The abort event can arrive before the OS has reaped the killed child.
      await expect.poll(() => {
        try { process.kill(pid!, 0); return false; }
        catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      }, { timeout: 1_000 }).toBe(true);
      pid = undefined;
    } finally {
      if (pid !== undefined) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('answers unknown when the dump carries no top-resumed line to read', async() => {
    expect((await readGuardianDialog(dumpHost('ACTIVITY MANAGER ACTIVITIES\n(nothing)\n'))).showing).toBeNull();
  });

  it('tells a person what to do rather than reporting a bare timeout', () => {
    expect(GUARDIAN_DIALOG_ADVICE).toMatch(/Finding position in room/);
    expect(GUARDIAN_DIALOG_ADVICE).toMatch(/Continue without tracking/);
  });
});

/**
 * After `aim:molstar`
 * the tab sits on `/detailed`, which is the stock Mol* viewer and has no Enter
 * VR button on it at all. `--steps enter` read that page and failed "The page
 * shows no Enter VR button", and `open_detailed_view` answered with a loopback
 * address the headset cannot reach. The only route home was the page's own
 * Back control, clicked by hand through the debugger.
 */
describe('bringing the headset back from the Mol* handoff', () => {
  const backLink = { x: 60, y: 18, disabled: false, text: '\u2190 Back to headset view' };
  const enterButton = { x: 120, y: 40, disabled: false, text: 'Enter VR' };

  function detailedTab({ path = '/detailed', back = true, entry = true, hint = 'armed',
    pageSaid = '', presenting = false }: {
    path?: string; back?: boolean; entry?: boolean; hint?: string; pageSaid?: string; presenting?: boolean;
  } = {}) {
    let here = path;
    const clicks: Array<{ x: number; y: number }> = [];
    const notes: string[] = [];
    const wakes: string[] = [];
    const host = {
      clicks, notes, wakes,
      options: {} as { atomSites?: number },
      now: () => 0,
      wait: async () => {},
      note: (message: string) => { notes.push(message); },
      async stereofoldTarget() { return { url: `https://192.0.2.7:8443${here}`, id: '1' }; },
      async locate(selector: string, _pattern: string) {
        if (selector === 'a') return back ? backLink : null;
        if (here === '/detailed') return null;
        return entry ? enterButton : null;
      },
      async click(x: number, y: number) {
        clicks.push({ x, y });
        // The Back control is a same-tab navigation to the viewer.
        if (y === backLink.y) here = '/viewer';
      },
      async evaluate(_expression: string) { return hint; },
      async companionPanel() {
        return { surface: 'companion', current: true, availability: 'ready',
          xrStartup: clicks.some(click => click.y === enterButton.y) || presenting
            ? { presenting: true, mode: 'immersive-ar', blendMode: 'alpha-blend', trustedClick: true }
            : null };
      },
      async waitForPanel(_what: string, accept: (panel: Record<string, any> | undefined) => boolean) {
        const panel = await host.companionPanel();
        if (!accept(panel)) throw new Error('test host: panel was not accepted');
        return panel;
      },
      async newDiagnostics() { return [] as never[]; },
      latestFps() { return null; },
      async pageStatus() { return pageSaid; },
      async wakeDisplay() { wakes.push(here); },
      async repair() {},
      async reload() {},
    };
    return host;
  }

  it('reads which page the tab is on, and knows the Mol* one', async () => {
    expect(await currentHeadsetPath(detailedTab())).toBe('/detailed');
    expect(await currentHeadsetPath({ async stereofoldTarget() { return undefined; } })).toBe('');
    expect(await currentHeadsetPath({ async stereofoldTarget() { throw Error('no debugger'); } })).toBe('');
    expect(isDetailedViewPath('/detailed')).toBe(true);
    expect(isDetailedViewPath('/detailed/handoff.json')).toBe(true);
    expect(isDetailedViewPath('/viewer')).toBe(false);
  });

  it('clicks the page\u2019s own Back control and lands on the viewer with entry offered again', async () => {
    const host = detailedTab();
    const leg = await returnFromDetailedView(host as never);
    expect(leg).toMatchObject({ left: true, from: '/detailed', to: '/viewer', reentryHint: 'armed' });
    expect(host.clicks).toEqual([{ x: backLink.x, y: backLink.y }]);
    // Both sides of the trip need the display awake: the link is on a page
    // whose session already ended, and the viewer boot needs frames.
    expect(host.wakes).toEqual(['/detailed', '/viewer']);
  });

  it('leaves a tab that is not in the Mol* viewer exactly where it is', async () => {
    const host = detailedTab({ path: '/viewer' });
    const leg = await returnFromDetailedView(host as never);
    expect(leg).toEqual({ left: false, from: '/viewer' });
    expect(host.clicks).toEqual([]);
    expect(host.wakes).toEqual([]);
  });

  it('names the Mac\u2019s own rescue when the page shows no Back control', async () => {
    const host = detailedTab({ back: false });
    const error = await returnFromDetailedView(host as never, { backWaitMs: 0 }).then(() => undefined, thrown => thrown as Error);
    expect(error?.message).toContain('no "Back to headset view" link');
    expect(error?.message).toContain('recall_headset');
    expect(host.clicks).toEqual([]);
  });

  it('keeps the share-ended refusal rather than spending the recovery bound on a shut door', async () => {
    const host = detailedTab({ entry: false, pageSaid: 'Sharing from your Mac has ended.' });
    const error = await returnFromDetailedView(host as never).then(() => undefined, thrown => thrown as Error);
    expect(error?.message).toContain('sharing from the Mac has ended');
    expect(host.clicks).toEqual([{ x: backLink.x, y: backLink.y }]);
  });

  it('makes the enter step take the way back first instead of failing on a page with no Enter VR', async () => {
    const host = detailedTab();
    const entered = await stepEnter(host as never);
    expect(entered.detail).toContain('Came back from /detailed to /viewer');
    expect(entered.detail).toContain('Presenting immersive-ar');
    expect(entered.evidence.returnLeg).toMatchObject({ left: true, from: '/detailed', to: '/viewer', reentryHint: 'armed' });
    expect(host.clicks).toEqual([{ x: backLink.x, y: backLink.y }, { x: enterButton.x, y: enterButton.y }]);
  });

  it('leaves the enter step untouched for a tab that is already on the viewer', async () => {
    const host = detailedTab({ path: '/viewer' });
    const entered = await stepEnter(host as never);
    expect(entered.detail).not.toContain('Came back from');
    expect(entered.evidence.returnLeg).toBeUndefined();
    expect(host.clicks).toEqual([{ x: enterButton.x, y: enterButton.y }]);
  });

  it('runs the whole way home as one step, and says so when there was nothing to come back from', async () => {
    const parked = detailedTab();
    const home = await stepReturn(parked as never);
    expect(home.detail).toContain('Left the full Mol* viewer through its Back control and landed on /viewer');
    expect(home.detail).toContain('Presenting immersive-ar');
    expect(home.evidence.returnLeg).toMatchObject({ left: true, from: '/detailed', to: '/viewer' });

    const already = detailedTab({ path: '/viewer' });
    const nothing = await stepReturn(already as never);
    expect(nothing.detail).toContain('nothing to come back from');
    expect(nothing.evidence.returnLeg).toMatchObject({ left: false, from: '/viewer' });
  });

  it('is a step the driver accepts by name, and not one the default run spends time on', () => {
    expect(DRIVE_STEPS).toContain('return');
    expect(DEFAULT_DRIVE_STEPS).not.toContain('return');
    expect(parseDriveArguments([...base, '--steps', 'return']).steps).toEqual(['return']);
    expect(() => parseDriveArguments([...base, '--steps', 'retrun']))
      .toThrow(/Unknown step retrun.*return/s);
  });
});
