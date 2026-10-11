import { describe, expect, it } from 'vitest';
import { GUARDIAN_DIALOG_ACTIVITY as DRIVER_ACTIVITY, detectGuardianDialog as driverDetect } from '../scripts/headset-drive.js';
import { detectGuardianDialog, GUARDIAN_DIALOG_ACTIVITY, guardianDialogShowing, packageRunning, parsePowerDump,
  readHeadsetState, type HeadsetShell } from '../src/quest-device-state.js';
import { CLEAR_DUMP, GUARDIAN_DUMP, powerDump, STALE_GUARDIAN_DUMP } from './helpers/fake-quest-adb.js';

/** A headset shell that records what it was asked and answers from a table. */
function shell(answers: Record<string, { code: number; stdout: string } | Error>) {
  const asked: string[] = [];
  const run: HeadsetShell = async args => {
    const said = args.join(' ');
    asked.push(said);
    const answer = answers[said];
    if (answer instanceof Error) throw answer;
    return answer ? { ...answer, stderr: '' } : { code: 1, stdout: '', stderr: 'no answer' };
  };
  return { asked, run };
}

describe('reading Meta\'s boundary screen off the headset', () => {
  it('is the one definition the drive script uses too', () => {
    expect(DRIVER_ACTIVITY).toBe(GUARDIAN_DIALOG_ACTIVITY);
    expect(driverDetect).toBe(detectGuardianDialog);
  });

  it('sees the screen only on a top-resumed line, never in history', async () => {
    expect(detectGuardianDialog(GUARDIAN_DUMP)).toBe(true);
    expect(detectGuardianDialog(STALE_GUARDIAN_DUMP)).toBe(false);
    const up = shell({ 'dumpsys activity activities': { code: 0, stdout: GUARDIAN_DUMP } });
    expect(await guardianDialogShowing(up.run)).toBe(true);
    expect(up.asked).toEqual(['dumpsys activity activities']);
    expect(await guardianDialogShowing(shell({ 'dumpsys activity activities': { code: 0, stdout: CLEAR_DUMP } }).run)).toBe(false);
  });

  it('answers unknown rather than clear when the dump cannot be read', async () => {
    expect(await guardianDialogShowing(shell({}).run)).toBeNull();
    expect(await guardianDialogShowing(shell({ 'dumpsys activity activities': Error('adb died') }).run)).toBeNull();
    expect(await guardianDialogShowing(shell({ 'dumpsys activity activities': { code: 0, stdout: 'ACTIVITY MANAGER ACTIVITIES\n' } }).run)).toBeNull();
  });
});

describe('reading the display, the sensor and the browser', () => {
  it('reads wakefulness and the proximity sensor out of dumpsys power', () => {
    expect(parsePowerDump(powerDump({ display: 'Asleep', worn: false }))).toEqual({ display: 'Asleep', worn: false });
    expect(parsePowerDump(powerDump({ worn: true }))).toEqual({ display: 'Awake', worn: true });
    expect(parsePowerDump('Power Manager State:\n')).toEqual({});
  });

  it('reads how long ago the display woke, in the old and the Android 13 wording', () => {
    expect(parsePowerDump(powerDump({ wokeMsAgo: 4130 }))).toEqual({ display: 'Awake', worn: false, wokeMsAgo: 4130 });
    expect(parsePowerDump('  mLastGlobalWakeTime=73541234 (812 ms ago)\n')).toEqual({ wokeMsAgo: 812 });
    expect(parsePowerDump('  mLastWakeTime=73541234 (now)\n')).toEqual({ wokeMsAgo: 0 });
    // A raw uptime with nothing to compare it against says nothing about when.
    expect(parsePowerDump('  mLastWakeTime=73541234\n')).toEqual({});
  });

  it('reads pidof as running, not running, or unknown', async () => {
    const asked = (stdout: string, code: number) => shell({ 'pidof com.oculus.browser': { code, stdout } }).run;
    expect(await packageRunning(asked('4242\n', 0), 'com.oculus.browser')).toBe(true);
    expect(await packageRunning(asked('', 1), 'com.oculus.browser')).toBe(false);
    // A build without pidof, or anything that is not a pid list, proves nothing.
    expect(await packageRunning(asked('/system/bin/sh: pidof: not found', 127), 'com.oculus.browser')).toBeUndefined();
    expect(await packageRunning(asked('Starting: Intent', 0), 'com.oculus.browser')).toBeUndefined();
    expect(await packageRunning(shell({ 'pidof com.oculus.browser': Error('offline') }).run, 'com.oculus.browser')).toBeUndefined();
  });

  it('stops reading once the boundary screen is up, and asks nothing that writes', async () => {
    const blocked = shell({ 'dumpsys activity activities': { code: 0, stdout: GUARDIAN_DUMP } });
    expect(await readHeadsetState(blocked.run, 'com.oculus.browser')).toEqual({ guardianDialog: true });
    expect(blocked.asked).toEqual(['dumpsys activity activities']);

    const clear = shell({ 'dumpsys activity activities': { code: 0, stdout: CLEAR_DUMP },
      'dumpsys power': { code: 0, stdout: powerDump({ display: 'Asleep' }) }, 'pidof com.oculus.browser': { code: 1, stdout: '' } });
    expect(await readHeadsetState(clear.run, 'com.oculus.browser'))
      .toEqual({ guardianDialog: false, display: 'Asleep', worn: false, browserRunning: false });
    expect(clear.asked).toEqual(['dumpsys activity activities', 'dumpsys power', 'pidof com.oculus.browser']);
    for (const said of clear.asked) expect(said).not.toMatch(/\b(?:input|broadcast|am start|keyevent|svc)\b/);
  });

  it('leaves out what the headset would not say', async () => {
    const offline: HeadsetShell = async () => { throw Error('error: device offline'); };
    expect(await readHeadsetState(offline, 'com.oculus.browser')).toEqual({ guardianDialog: null });
  });
});
