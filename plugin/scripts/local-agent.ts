/**
 * The loopback client every local Stereofold command line shares.
 *
 * The standalone host writes a private control file holding its loopback
 * origin, an admin bearer and the current session ID, then serves `/agent` to
 * whoever can read that file. Everything here is that one hop: read the file,
 * refuse anything that is not loopback, post one tool call, hand back the
 * result. Nothing in this module knows what a tool means.
 *
 * The control file is re-read on every call, because the host rotates its
 * token and session ID when it recovers an expired session.
 */
import { sceneCallTimeoutMs } from '../src/scene-service.js';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export const AGENT_TIMEOUT_MS = 65_000;

/**
 * A request that asked the host to wait must outlive the
 * wait it asked for.
 *
 * `replace_inspection_source` takes `waitForRenderMs`, and the host holds the
 * response open for up to that long. A fixed 65 s abort would cut a request
 * that asked for more off at the client end and report a transport failure for
 * a load that was proceeding normally. The base stays exactly what it was for
 * legacy callers that supply only arguments. Named transport calls use the
 * shared bounded preparation/render policy plus five seconds for the outer hop.
 */
export function agentTimeoutMs(args: Record<string, unknown> = {}, name?:string): number {
  if(name) return sceneCallTimeoutMs(name,args)+5_000;
  const asked = args.waitForRenderMs;
  const wait = typeof asked === 'number' && Number.isFinite(asked) && asked > 0 ? asked : 0;
  return AGENT_TIMEOUT_MS + wait;
}

/**
 * Where a host puts its control file when nobody said otherwise: the shared
 * headset session first, then the plain standalone route. These are the only
 * two paths guessed, and the directory is never listed.
 */
export const DEFAULT_STATE_PATHS = [
  resolve(homedir(), '.stereofold/quest-share.json'),
  resolve(homedir(), '.stereofold/claude-code-state.json'),
];

export type ControlState = { origin: string; token: string; sessionId: string; serverEpoch?: string };
export type AgentResult = { content?: { type: string; text?: string }[]; structuredContent?: any };

/**
 * How long a command will wait for a host that is still starting, when it is
 * told to wait at all.
 *
 * A driver, an agent call and the host are three terminals, and the host takes
 * the longest to be ready: it builds a scene and writes the control file only
 * once it has one. Started together, the other two lost the race and died on
 * ENOENT — a stack trace for a file that was about to exist. Twenty seconds
 * covers that start without turning a genuinely absent host into a hang.
 */
export const HOST_WAIT_MS = 20_000;
/** How often the wait looks again. Short enough that the wait costs nothing once the file lands. */
const HOST_WAIT_POLL_MS = 250;
export const WAIT_FOR_HOST_ENV = 'STEREOFOLD_WAIT_FOR_HOST';

/**
 * Whether this run waits for a host that has not written its control file yet.
 *
 * Off by default, because "no host is running" is usually the truth and a
 * command that hangs on it is worse than one that says so. `--wait-for-host`
 * or `STEREOFOLD_WAIT_FOR_HOST=1` is the operator saying they have just
 * started one in another terminal.
 */
export function waitForHostRequested(argv: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): boolean {
  if (argv.includes('--wait-for-host')) return true;
  const setting = env[WAIT_FOR_HOST_ENV]?.trim().toLowerCase();
  return Boolean(setting) && !['0', 'off', 'no', 'false'].includes(setting as string);
}

export type StatePathOptions = {
  candidates?: readonly string[];
  /** Wait for the file to appear instead of failing on the first look. */
  waitForHost?: boolean;
  waitMs?: number;
  /** Seams, so the wait is tested without spending twenty seconds of wall clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/** The newest control file among the candidates, or undefined while none exists. */
async function newestControlFile(candidates: readonly string[]): Promise<string | undefined> {
  const found: { path: string; modified: number }[] = [];
  for (const path of candidates) {
    try {
      const entry = await stat(path);
      if (entry.isFile()) found.push({ path, modified: entry.mtimeMs });
    } catch { /* a host that is not running left no file */ }
  }
  return found.sort((a, b) => b.modified - a.modified)[0]?.path;
}

/**
 * The newest control file among the defaults, or a clear failure naming them.
 *
 * With `waitForHost`, the same answer, given up to `waitMs` for a host that is
 * still starting to write one. The failure at the end of a wait says how long
 * it waited, so the message stays true to what was actually tried.
 */
export async function resolveStatePath(given?: string, options: readonly string[] | StatePathOptions = {}): Promise<string> {
  // The second argument used to be the candidate list itself. Both shapes are
  // accepted so nothing that already calls it has to change.
  const settings: StatePathOptions = Array.isArray(options) ? { candidates: options } : options as StatePathOptions;
  const candidates = settings.candidates ?? DEFAULT_STATE_PATHS;
  const waitMs = Math.max(0, settings.waitMs ?? HOST_WAIT_MS);
  const now = settings.now ?? (() => Date.now());
  const sleep = settings.sleep ?? realSleep;

  if (given) {
    if (!isAbsolute(given)) throw Error('The control state-file path must be absolute.');
    if (!settings.waitForHost) return given;
    const deadline = now() + waitMs;
    for (;;) {
      if (await stat(given).then(entry => entry.isFile(), () => false)) return given;
      if (now() >= deadline) {
        throw Error(`No host wrote ${given} within ${Math.round(waitMs / 1_000)}s. Start one, or drop --wait-for-host to fail immediately.`);
      }
      await sleep(HOST_WAIT_POLL_MS);
    }
  }

  const deadline = now() + waitMs;
  for (;;) {
    const newest = await newestControlFile(candidates);
    if (newest) return newest;
    if (!settings.waitForHost) {
      throw Error(`No running Stereofold host was found. Start one, or name its control file. Looked at: ${candidates.join(', ')}.`);
    }
    if (now() >= deadline) {
      throw Error(`No running Stereofold host appeared within ${Math.round(waitMs / 1_000)}s. `
        + `Start one, or name its control file. Looked at: ${candidates.join(', ')}.`);
    }
    await sleep(HOST_WAIT_POLL_MS);
  }
}

export type ControlStateOptions = { waitForHost?: boolean; waitMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };

/**
 * Read one host's control file.
 *
 * Without `waitForHost` this is the old behaviour exactly, ENOENT included:
 * the caller named a path and it is not there. With it, the read is retried
 * until the host writes the file or the wait runs out, because a host that is
 * mid-write can also hand back a truncated document, and a parse failure in
 * the first hundred milliseconds of a session is the same race as the missing
 * file rather than a corrupt one.
 */
export async function readControlState(statePath: string, options: ControlStateOptions = {}): Promise<ControlState> {
  const waitMs = Math.max(0, options.waitMs ?? HOST_WAIT_MS);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? realSleep;
  const deadline = now() + waitMs;
  for (;;) {
    try { return parseControlState(await readFile(resolve(statePath), 'utf8')); }
    catch (error) {
      // Only the race is waited out. A file that is there and says the host is
      // not on loopback is a refusal, and repeating it for twenty seconds
      // would bury the sentence that explains it.
      const racing = (error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError;
      if (!options.waitForHost || !racing || now() >= deadline) throw error;
      await sleep(HOST_WAIT_POLL_MS);
    }
  }
}

function parseControlState(raw: string): ControlState {
  const state = JSON.parse(raw) as ControlState;
  const url = new URL(state.origin);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw Error('Local control requires loopback.');
  if (typeof state.token !== 'string' || typeof state.sessionId !== 'string') throw Error('The control state file is incomplete.');
  return state;
}

/**
 * One tool call on the host's admin route. A refusal comes back as a 409 with
 * the host's own sentence, which is more useful than the status code, so it is
 * raised as the error message.
 */
export async function callLocalAgent(state: ControlState, name: string, args: Record<string, unknown> = {}): Promise<AgentResult> {
  const response = await fetch(`${state.origin}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(agentTimeoutMs(args,name)),
  });
  const body = await response.json().catch(() => undefined) as any;
  if (!response.ok) throw Error(body?.error ?? `The local host refused ${name} with status ${response.status}.`);
  return body as AgentResult;
}

/** The result's own words, which is what a person reads. */
export function agentText(result: AgentResult): string {
  return (result.content ?? []).filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string).join('\n').trim();
}

/**
 * Hide the page key in a companion or detailed-view address before printing
 * it. The fragment is the capability; the rest is only a loopback port.
 */
export function redactFragment(address: string): string {
  const cut = address.indexOf('#');
  return cut < 0 ? address : `${address.slice(0, cut)}#<page key hidden>`;
}
