/**
 * What a Quest is showing, read over adb without changing anything on it.
 *
 * An adb launch hears back only that Android accepted its intent. Once
 * that was "launch attempted" while Meta's "Finding position in
 * room" screen sat in front of Quest Browser: no page opened, the cold start
 * brought back two stale tabs instead, and the result blamed those tabs. The
 * reads here answer what the intent cannot: whether that screen is up, whether
 * the display is awake and on a face, and whether Quest Browser is running at
 * all. Each is one `adb shell` query; none sends input, wakes the display or
 * starts a process.
 */

/**
 * The activity Meta's boundary screens run as.
 *
 * Measured on a Quest 2 that had rebooted on a flat battery in a dark room:
 * the headset came up on "Finding position in room" and stayed
 * there. Behind that screen Quest Browser never receives a VIEW intent.
 * "Confirm boundary", raised after the headset is moved to another room, is
 * the same activity.
 */
export const GUARDIAN_DIALOG_ACTIVITY = 'com.oculus.vrguardianservice.guardiandialog.GuardianDialogActivity';

/**
 * Read `dumpsys activity activities` for the dialog being on screen.
 *
 * `topResumedActivity=` is the line that matters: it names only the activity a
 * task is actually showing. The same dump keeps finished and stopped Guardian
 * records under `Hist`, so matching the component name anywhere in the text
 * would report the dialog long after a person had pressed it away.
 */
export function detectGuardianDialog(dump: string): boolean {
  for (const line of dump.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('topResumedActivity=')) continue;
    if (trimmed.includes(GUARDIAN_DIALOG_ACTIVITY)) return true;
  }
  return false;
}

/**
 * `dumpsys power`, for the display, the proximity sensor and the last wake.
 *
 * `mWakefulness` is `Awake`, `Asleep`, `Dozing` or `Dreaming`; outside an
 * immersive session the display sleeps seconds after the headset comes off.
 * `mProximityPositive=true` means something is against the sensor between the
 * lenses, which is how the drive script decides the headset is on a face.
 * Android prints the last wake as `mLastWakeTime=<uptime> (<n> ms ago)`, or
 * `(now)`, and names it `mLastGlobalWakeTime` from Android 13; a dump without
 * that suffix leaves the wake unknown.
 */
export function parsePowerDump(dump: string): { display?: string; worn?: boolean; wokeMsAgo?: number } {
  const display = /mWakefulness=(\w+)/u.exec(dump)?.[1];
  const proximity = /mProximityPositive=(true|false)/u.exec(dump)?.[1];
  const woke = /mLast(?:Global)?WakeTime=\d+ \((?:(\d+) ms ago|now)\)/u.exec(dump);
  return { ...(display ? { display } : {}), ...(proximity ? { worn: proximity === 'true' } : {}),
    ...(woke ? { wokeMsAgo: Number(woke[1] ?? 0) } : {}) };
}

/** What one launch read off the headset. A missing field is one the headset did not answer. */
export type HeadsetState = {
  /** `null` where the dump could not be read: unreadable is never proof the screen is gone. */
  guardianDialog: boolean | null;
  /** `mWakefulness`, such as `Awake` or `Asleep`. */
  display?: string;
  /** Whether the proximity sensor reads a face. */
  worn?: boolean;
  /** How long before the read the display last woke, in milliseconds. */
  wokeMsAgo?: number;
  /** Whether Quest Browser has a process. `false` means the launch starts it cold. */
  browserRunning?: boolean;
};

export type HeadsetShell = (args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

async function shellText(shell: HeadsetShell, args: readonly string[]): Promise<{ code: number; stdout: string } | undefined> {
  try { const answered = await shell(args); return { code: answered.code, stdout: String(answered.stdout ?? '') }; }
  catch { return undefined; }
}

/**
 * Is the boundary screen in front right now?
 *
 * A dump that cannot be read, or that carries no `topResumedActivity=` line,
 * answers `null`: only an answer that actually saw the screen may stop a
 * launch, and only one that actually saw it gone may call it clear.
 */
export async function guardianDialogShowing(shell: HeadsetShell): Promise<boolean | null> {
  const dump = await shellText(shell, ['dumpsys', 'activity', 'activities']);
  if (!dump || dump.code !== 0 || !dump.stdout.includes('topResumedActivity=')) return null;
  return detectGuardianDialog(dump.stdout);
}

/**
 * Whether a package has a process. `pidof` prints its pids and exits 0, or
 * prints nothing and exits 1; anything else, including a build without
 * `pidof`, is unknown.
 */
export async function packageRunning(shell: HeadsetShell, name: string): Promise<boolean | undefined> {
  const answered = await shellText(shell, ['pidof', name]);
  if (!answered) return undefined;
  const text = answered.stdout.trim();
  if (answered.code === 0 && /^\d+(?:\s+\d+)*$/u.test(text)) return true;
  if (answered.code === 1 && text === '') return false;
  return undefined;
}

/**
 * Everything a launch reads before it sends the intent, boundary screen first.
 *
 * A screen that is up ends the read there: the launch stops on it, and the
 * display and the browser are no longer questions worth a round trip.
 */
export async function readHeadsetState(shell: HeadsetShell, browserPackage: string): Promise<HeadsetState> {
  const guardianDialog = await guardianDialogShowing(shell);
  if (guardianDialog === true) return { guardianDialog };
  const power = await shellText(shell, ['dumpsys', 'power']);
  const browserRunning = await packageRunning(shell, browserPackage);
  return { guardianDialog, ...(power?.code === 0 ? parsePowerDump(power.stdout) : {}),
    ...(browserRunning === undefined ? {} : { browserRunning }) };
}
