/**
 * Headset grip -> Mac shell command.
 *
 * The companion sends `push_to_talk` with `{state:'down'}` when the wearer
 * squeezes the grip and `{state:'up'}` when they let go. This module turns
 * those two events into at most two user-configured shell commands.
 *
 * Three properties are deliberate:
 *
 * - The request carries one enum field. No part of a request is ever
 *   interpolated into a command. The command strings come only from
 *   `STEREOFOLD_PTT_DOWN` and `STEREOFOLD_PTT_UP`, read once at startup.
 * - This repository ships no command for either variable. Until the user
 *   exports one, a squeeze writes a log line and nothing else runs.
 * - Nothing here synthesizes a keystroke, a pointer event, or any other
 *   input. It runs the command the user wrote, and that command owns
 *   whatever it does.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export const PUSH_TO_TALK_TOOL = 'push_to_talk';
export const PUSH_TO_TALK_ENABLED_ENV = 'STEREOFOLD_PTT_ENABLED';
export const PUSH_TO_TALK_DOWN_ENV = 'STEREOFOLD_PTT_DOWN';
export const PUSH_TO_TALK_UP_ENV = 'STEREOFOLD_PTT_UP';
/** One grip press per 300 ms. A controller can chatter on a hard squeeze. */
export const PUSH_TO_TALK_DEBOUNCE_MS = 300;
/** A dictation-key command should return at once; 5 s is a stuck command. */
export const PUSH_TO_TALK_TIMEOUT_MS = 5_000;
export const PUSH_TO_TALK_MAX_COMMAND_LENGTH = 2048;
const MAX_OUTPUT_BYTES = 4096;
const SHELL = '/bin/sh';

export type PushToTalkState = 'down' | 'up';
export type PushToTalkReason = 'ran' | 'unconfigured' | 'disabled' | 'no_session' | 'repeat' | 'debounced' | 'unpaired' | 'failed';
export type PushToTalkSpawnOptions = {
  shell: false;
  stdio: ['ignore', 'pipe', 'pipe'];
  windowsHide: true;
  env: NodeJS.ProcessEnv;
};
export type PushToTalkSpawn = (command: string, args: readonly string[], options: PushToTalkSpawnOptions) => ChildProcess;
export type PushToTalkOptions = {
  enabled?: boolean;
  down?: string;
  up?: string;
  spawn?: PushToTalkSpawn;
  log?: (line: string) => void;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  debounceMs?: number;
  timeoutMs?: number;
};
export type PushToTalkResult = {
  state: PushToTalkState;
  accepted: boolean;
  reason: PushToTalkReason;
  ran: boolean;
  listening: boolean;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  message: string;
};

/** Reject an empty or oversized command instead of handing it to a shell. */
function readCommand(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a shell command string.`);
  const command = value.trim();
  if (!command) return undefined;
  if (command.length > PUSH_TO_TALK_MAX_COMMAND_LENGTH)
    throw new RangeError(`${name} must be at most ${PUSH_TO_TALK_MAX_COMMAND_LENGTH} characters.`);
  if (command.includes('\0')) throw new TypeError(`${name} must not contain a null byte.`);
  return command;
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT_BYTES ? `${text.slice(0, MAX_OUTPUT_BYTES)}…` : text;
}

export function createPushToTalk(options: PushToTalkOptions = {}) {
  const spawn = (options.spawn ?? nodeSpawn) as PushToTalkSpawn;
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const debounceMs = options.debounceMs ?? PUSH_TO_TALK_DEBOUNCE_MS;
  const timeoutMs = options.timeoutMs ?? PUSH_TO_TALK_TIMEOUT_MS;
  const enabled = options.enabled ?? false;
  const commands: Record<PushToTalkState, string | undefined> = {
    down: readCommand(options.down, PUSH_TO_TALK_DOWN_ENV),
    up: readCommand(options.up, PUSH_TO_TALK_UP_ENV),
  };
  const configured = Boolean(commands.down || commands.up);
  let held = false;
  let lastDownAt = Number.NEGATIVE_INFINITY;
  let running: Promise<unknown> = Promise.resolve();

  /** Run one configured command to completion, bounded by `timeoutMs`. */
  function run(state: PushToTalkState): Promise<Omit<PushToTalkResult, 'state' | 'listening'>> {
    const command = commands[state];
    if (!command) {
      log(`push-to-talk ${state}: no ${state === 'down' ? PUSH_TO_TALK_DOWN_ENV : PUSH_TO_TALK_UP_ENV} command is set.`);
      return Promise.resolve({ accepted: true, reason: 'unconfigured' as const, ran: false,
        message: `Grip ${state} recorded. No ${state === 'down' ? PUSH_TO_TALK_DOWN_ENV : PUSH_TO_TALK_UP_ENV} command is set.` });
    }
    return new Promise(resolve => {
      let child: ChildProcess;
      try {
        // The command string is the user's own. Request data never reaches it,
        // so there is nothing here to escape or interpolate.
        child = spawn(SHELL, ['-c', command], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The push-to-talk command could not start.';
        log(`push-to-talk ${state}: ${message}`);
        resolve({ accepted: true, reason: 'failed', ran: false, message: `Grip ${state} could not run its command. ${message}` });
        return;
      }
      let out = '', err = '', settled = false, timedOut = false;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { if (out.length < MAX_OUTPUT_BYTES) out += chunk; });
      child.stderr?.on('data', (chunk: string) => { if (err.length < MAX_OUTPUT_BYTES) err += chunk; });
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* The command may have exited between the check and the signal. */ }
        settle(null, 'SIGKILL');
      }, timeoutMs);
      const settle = (code: number | null, signal: NodeJS.Signals | string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (out.trim()) log(`push-to-talk ${state} stdout: ${clip(out.trim())}`);
        if (err.trim()) log(`push-to-talk ${state} stderr: ${clip(err.trim())}`);
        const outcome = timedOut
          ? `Grip ${state} command was killed after ${timeoutMs} ms.`
          : code === 0 ? `Grip ${state} command finished.` : `Grip ${state} command exited with ${signal ?? code}.`;
        log(`push-to-talk ${state}: ${outcome}`);
        resolve({ accepted: true, reason: timedOut || code !== 0 ? 'failed' : 'ran', ran: true,
          exitCode: code, signal: signal ?? null, timedOut, message: outcome });
      };
      child.on('error', (error: Error) => {
        log(`push-to-talk ${state}: ${error.message}`);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ accepted: true, reason: 'failed', ran: false, message: `Grip ${state} could not run its command. ${error.message}` });
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => settle(code, signal));
    });
  }

  function reject(state: PushToTalkState, reason: PushToTalkReason, message: string): PushToTalkResult {
    return { state, accepted: false, reason, ran: false, listening: held, message };
  }

  return {
    /** True once the user has exported at least one of the two variables. */
    get configured() { return configured; },
    get enabled() { return enabled; },
    /** True between an accepted down and its matching up. */
    listening() { return held; },
    /** One line for the host to print at startup. */
    describe(): string {
      // The binding is A and X, not the left grip,
      // so the startup banner names the buttons the wearer holds.
      // The event names inside this module are unchanged.
      if (!enabled) return 'Push-to-talk is off. Add --ptt to let the wearer hold A or X to talk.';
      const parts: string[] = [];
      if (commands.down) parts.push(`${PUSH_TO_TALK_DOWN_ENV}=${commands.down}`);
      if (commands.up) parts.push(`${PUSH_TO_TALK_UP_ENV}=${commands.up}`);
      if (!parts.length)
        return `Push-to-talk is on and logging only. Export ${PUSH_TO_TALK_DOWN_ENV} and ${PUSH_TO_TALK_UP_ENV} to run a command.`;
      return `Push-to-talk runs ${parts.join(' and ')}`;
    },
    /**
     * Accept one grip event. `sessionId` must be the live inspection session
     * the caller already resolved; an absent one is never acted on.
     */
    async handle(state: PushToTalkState, sessionId: unknown): Promise<PushToTalkResult> {
      if (state !== 'down' && state !== 'up') throw new TypeError('Push-to-talk state must be down or up.');
      if (typeof sessionId !== 'string' || !sessionId)
        return reject(state, 'no_session', 'Push-to-talk needs a live inspection session.');
      if (!enabled) return reject(state, 'disabled', 'Push-to-talk is off. Restart the host with --ptt.');
      if (state === 'down') {
        if (held) return reject('down', 'repeat', 'The grip is already held.');
        const at = now();
        if (at - lastDownAt < debounceMs) return reject('down', 'debounced', 'That grip press arrived too soon after the last one.');
        held = true;
        lastDownAt = at;
      } else {
        if (!held) return reject('up', 'unpaired', 'No grip press is open.');
        held = false;
      }
      // Serialize so an up can never overtake the down it closes.
      const queued = running.then(() => run(state), () => run(state));
      running = queued.catch(() => {});
      const outcome = await queued;
      return { ...outcome, state, listening: held };
    },
  };
}

export type PushToTalk = ReturnType<typeof createPushToTalk>;

/**
 * Read the host's configuration from the environment it was started with.
 * An unusable command variable degrades to logging rather than stopping the
 * server, because push-to-talk is an accessory to an inspection session.
 */
export function pushToTalkFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: PushToTalkOptions = {}): PushToTalk {
  const base: PushToTalkOptions = {
    enabled: env[PUSH_TO_TALK_ENABLED_ENV] === '1',
    down: env[PUSH_TO_TALK_DOWN_ENV],
    up: env[PUSH_TO_TALK_UP_ENV],
    env,
    ...overrides,
  };
  try { return createPushToTalk(base); }
  catch (error) {
    const log = base.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
    log(`push-to-talk: ${error instanceof Error ? error.message : 'A command variable could not be read.'} Logging grip events only.`);
    return createPushToTalk({ ...base, down: undefined, up: undefined });
  }
}
