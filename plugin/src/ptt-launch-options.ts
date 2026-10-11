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
