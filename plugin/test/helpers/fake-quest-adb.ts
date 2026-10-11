import { QUEST_BROWSER_PACKAGE, type RunResult } from '../../src/quest-launch.js';

/**
 * `dumpsys activity activities` with Meta's boundary screen in front, trimmed
 * from a Quest 2 that rebooted on a flat battery in a dark room. The same
 * lines back the drive script's own dialog test.
 */
export const GUARDIAN_DUMP = [
  'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
  'Display #0 (activities from top to bottom):',
  '  * Task{50a6271 #878 type=standard A=10024:com.oculus.guardian:-1044315416 U=0 visible=true}',
  '      topResumedActivity=ActivityRecord{3973818 u0 com.oculus.guardian/com.oculus.vrguardianservice.guardiandialog.GuardianDialogActivity t878}',
  '  * Task{512426 #876 type=standard A=10020:com.oculus.vrshell:-339196040 U=0 visible=true}',
  '      topResumedActivity=ActivityRecord{c1fcb81 u0 com.oculus.vrshell/.FocusPlaceholderActivity t876}',
].join('\n');

export const CLEAR_DUMP = [
  'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
  'Display #0 (activities from top to bottom):',
  '  * Task{512426 #876 type=standard A=10020:com.oculus.vrshell:-339196040 U=0 visible=true}',
  '      topResumedActivity=ActivityRecord{c1fcb81 u0 com.oculus.vrshell/.FocusPlaceholderActivity t876}',
  '  * Task{29ef405 #837 type=standard A=10020:com.oculus.vrshell U=0 visible=true}',
  '      topResumedActivity=ActivityRecord{9b730a8 u0 com.oculus.vrshell/.HomeActivity t837}',
].join('\n');

/** The dialog activity left behind in history after a person pressed it away. */
export const STALE_GUARDIAN_DUMP = [
  'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)',
  'Display #0 (activities from top to bottom):',
  '  * Task{512426 #876 type=standard A=10020:com.oculus.vrshell U=0 visible=true}',
  '      topResumedActivity=ActivityRecord{c1fcb81 u0 com.oculus.vrshell/.FocusPlaceholderActivity t876}',
  '      * Hist  #0: ActivityRecord{3973818 u0 com.oculus.guardian/com.oculus.vrguardianservice.guardiandialog.GuardianDialogActivity t878}',
  '        state=STOPPED delayedResume=false finishing=true',
].join('\n');

/**
 * `dumpsys power`, cut to the header and the two lines the drive script reads,
 * plus the last wake in Android's `(<n> ms ago)` form when `wokeMsAgo` is given.
 */
export const powerDump = ({ display = 'Awake', worn = false, wokeMsAgo }: { display?: string; worn?: boolean; wokeMsAgo?: number } = {}) => [
  'POWER MANAGER (dumpsys power)', '', 'Power Manager State:', '  mDirty=0x0',
  `  mWakefulness=${display}`, '  mWakefulnessChanging=false', `  mProximityPositive=${worn}`,
  ...(wokeMsAgo === undefined ? [] : [`  mLastWakeTime=73541234 (${wokeMsAgo} ms ago)`, '  mLastSleepTime=73530000 (15364 ms ago)']),
].join('\n');

export type FakeHeadset = {
  /** What `adb devices` prints. */
  devices?: string;
  /** One dump for every read, or one per read in order, the last repeating. */
  activities?: string | RunResult | Array<string | RunResult>;
  /** One dump for every read, or one per read in order, the last repeating. */
  power?: string | RunResult | Array<string | RunResult>;
  /** A pid when Quest Browser is running, `null` when it is not. */
  browserPid?: string | null | RunResult;
  packages?: boolean | RunResult;
  intent?: RunResult;
  forward?: RunResult;
};

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const answer = (value: string | RunResult) => typeof value === 'string' ? ok(value) : value;

/**
 * A fake adb for the launch tests. It records every command it is given and
 * answers by what the command asks, so a test can add or drop a read without
 * reordering a script of answers.
 */
export function fakeQuestAdb(headset: FakeHeadset = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const activities = Array.isArray(headset.activities) ? [...headset.activities] : [headset.activities ?? CLEAR_DUMP];
  const powers = Array.isArray(headset.power) ? [...headset.power] : [headset.power ?? powerDump()];
  const run = async (command: string, args: readonly string[]): Promise<RunResult> => {
    calls.push({ command, args: [...args] });
    const asked = args[0] === '-s' ? args.slice(2) : [...args];
    const said = asked.join(' ');
    if (said === 'devices') return ok(headset.devices ?? 'List of devices attached\nQUEST2\tdevice\n');
    if (said === 'shell getprop') return ok('[ro.product.model]: [Quest 2]\n[ro.product.manufacturer]: [Oculus]\n[ro.serialno]: [QUEST2]\n');
    if (said === 'shell dumpsys activity activities') return answer(activities.length > 1 ? activities.shift()! : activities[0]!);
    if (said === 'shell dumpsys power') return answer(powers.length > 1 ? powers.shift()! : powers[0]!);
    if (said === 'shell input keyevent KEYCODE_WAKEUP') return ok('');
    if (said === `shell pidof ${QUEST_BROWSER_PACKAGE}`) {
      const pid = headset.browserPid === undefined ? '4242' : headset.browserPid;
      return pid === null ? { code: 1, stdout: '', stderr: '' } : answer(pid);
    }
    if (said === `shell pm list packages ${QUEST_BROWSER_PACKAGE}`) {
      const installed = headset.packages ?? true;
      return typeof installed === 'boolean' ? ok(installed ? `package:${QUEST_BROWSER_PACKAGE}\n` : '') : installed;
    }
    if (said.startsWith('shell am start')) return headset.intent ?? ok('Starting: Intent { act=android.intent.action.VIEW }');
    if (asked[0] === 'forward') return headset.forward ?? ok('');
    return { code: 1, stdout: '', stderr: `fake adb has no answer for: ${said}` };
  };
  /** Each call as the words after `-s <serial>`, for asserting order. */
  const asked = () => calls.map(call => (call.args[0] === '-s' ? call.args.slice(2) : call.args).join(' '));
  return { calls, run, asked };
}
