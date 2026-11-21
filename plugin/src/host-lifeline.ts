/**
 * The standalone host's tie to the launcher that started it.
 *
 * `quest-share` starts the host in its own session and process group, so it
 * can stop the host's whole group and so a terminal's Ctrl-C reaches only the
 * launcher, which then stops the host in order. The cost is that nothing the
 * terminal does reaches the host: when the launcher dies without running its
 * shutdown (SIGKILL, a crash), the host and its private listener stay up with
 * nothing driving them.
 *
 * So the launcher holds the host's stdin open for as long as it runs and sets
 * this variable. The kernel closes that pipe however the launcher ends, and
 * the host closes itself when it sees the end. A host started any other way
 * leaves stdin alone, because its stdin may be a closed or empty file.
 */
export const HOST_LIFELINE_ENV = 'STEREOFOLD_HOST_LIFELINE';

type Lifeline = { on(event: 'end' | 'close' | 'error', listener: () => void): unknown; resume(): unknown };

/** Call `closed` once when the launcher's end of `input` goes away. Returns whether it is watching. */
export function watchHostLifeline(env: NodeJS.ProcessEnv, input: Lifeline, closed: () => void): boolean {
  if (env[HOST_LIFELINE_ENV] !== '1') return false;
  let fired = false;
  const fire = () => { if (fired) return; fired = true; closed(); };
  input.on('end', fire);
  input.on('close', fire);
  input.on('error', fire);
  input.resume();
  return true;
}
