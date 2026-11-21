/** Explicit flags win over the environment; callers retain their own default. */
export function pttLaunchEnabled(args: readonly string[], env: NodeJS.ProcessEnv, fallback: boolean): boolean {
  let flag: boolean | undefined;
  for (const arg of args) {
    if (arg === '--ptt') flag = true;
    if (arg === '--no-ptt') flag = false;
  }
  if (flag !== undefined) return flag;
  // Read the way push-to-talk-transcribe.ts reads it: 0/off/no/false turn it
  // off, any other non-empty value turns it on, blank or unset leaves the
  // caller's default alone.
  const setting = env.STEREOFOLD_PTT_TRANSCRIBE?.trim().toLowerCase();
  if (!setting) return fallback;
  return !['0', 'off', 'no', 'false'].includes(setting);
}

/**
 * The MCP server's sign that the person turned the headset microphone off.
 *
 * A launcher sets it only when the person's own command line ends its voice
 * flags with `--no-ptt`. Push-to-talk transcription is also off on a host
 * started with no voice flag, and there the Talk row keeps working, so that
 * setting cannot carry "the person said no"; this variable does.
 */
export const HEADSET_MICROPHONE_OFF_ENV = 'STEREOFOLD_HEADSET_MICROPHONE_OFF';

/** Whether the last of `--ptt` and `--no-ptt` on a command line is `--no-ptt`, the way `pttLaunchEnabled` reads them. */
export function pttLaunchRefused(args: readonly string[]): boolean {
  let refused = false;
  for (const arg of args) {
    if (arg === '--ptt') refused = false;
    if (arg === '--no-ptt') refused = true;
  }
  return refused;
}

/** What a launcher adds to the MCP server's environment for its command line. */
export function headsetMicrophoneOffEnvironment(args: readonly string[]): Record<string, string> {
  return pttLaunchRefused(args) ? { [HEADSET_MICROPHONE_OFF_ENV]: '1' } : {};
}

/**
 * The one reading of `HEADSET_MICROPHONE_OFF_ENV`. Any non-empty value other
 * than 0/off/no/false means no route may record the headset microphone.
 */
export function headsetMicrophoneOff(env: NodeJS.ProcessEnv): boolean {
  const setting = env[HEADSET_MICROPHONE_OFF_ENV]?.trim().toLowerCase();
  return !!setting && !['0', 'off', 'no', 'false'].includes(setting);
}
