import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createPushToTalk, pushToTalkFromEnv, PUSH_TO_TALK_DOWN_ENV, PUSH_TO_TALK_ENABLED_ENV, PUSH_TO_TALK_UP_ENV,
  type PushToTalkSpawn } from '../src/push-to-talk.js';

/** A child process stand-in with the three streams and events this module reads. */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding() { /* streams here are already strings */ } });
  stderr = Object.assign(new EventEmitter(), { setEncoding() { /* streams here are already strings */ } });
  killed: string[] = [];
  kill(signal: string) { this.killed.push(signal); return true; }
}

type Call = { command: string; args: readonly string[]; child: FakeChild };

/** Records every spawn and hands the test the child, so it controls the exit. */
function recorder() {
  const calls: Call[] = [];
  const spawn: PushToTalkSpawn = (command, args) => {
    const child = new FakeChild();
    calls.push({ command, args, child });
    return child as unknown as ReturnType<PushToTalkSpawn>;
  };
  return { calls, spawn };
}

/** Exit the newest child on the next turn so `handle` can attach its listeners. */
function finish(call: Call, code = 0, out = '', err = '') {
  queueMicrotask(() => {
    if (out) call.child.stdout.emit('data', out);
    if (err) call.child.stderr.emit('data', err);
    call.child.emit('close', code, null);
  });
}

const SESSION = 'session-1';

describe('headset grip push-to-talk', () => {
  it('runs the configured commands once per press and reports what they printed', async () => {
    const { calls, spawn } = recorder();
    const logs: string[] = [];
    const ptt = createPushToTalk({ enabled: true, down: 'press-dictation', up: 'press-dictation --again', spawn, log: line => logs.push(line) });

    const down = ptt.handle('down', SESSION);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('/bin/sh');
    expect(calls[0].args).toEqual(['-c', 'press-dictation']);
    finish(calls[0], 0, 'started\n');
    const downResult = await down;
    expect(downResult).toMatchObject({ state: 'down', accepted: true, reason: 'ran', ran: true, listening: true, exitCode: 0 });
    expect(logs.some(line => line.includes('stdout: started'))).toBe(true);

    const up = ptt.handle('up', SESSION);
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(['-c', 'press-dictation --again']);
    finish(calls[1]);
    expect(await up).toMatchObject({ state: 'up', accepted: true, ran: true, listening: false });
    expect(ptt.listening()).toBe(false);
  });

  it('never interpolates the request into the command', async () => {
    const { calls, spawn } = recorder();
    const ptt = createPushToTalk({ enabled: true, down: 'echo fixed', spawn, log: () => {} });
    const down = ptt.handle('down', SESSION);
    await Promise.resolve();
    finish(calls[0]);
    await down;
    expect(JSON.stringify(calls[0].args)).not.toMatch(/down|up|session/);
  });

  it('logs and runs nothing when neither command is set', async () => {
    const { calls, spawn } = recorder();
    const logs: string[] = [];
    const ptt = createPushToTalk({ enabled: true, spawn, log: line => logs.push(line) });
    expect(ptt.configured).toBe(false);
    expect(await ptt.handle('down', SESSION)).toMatchObject({ accepted: true, reason: 'unconfigured', ran: false, listening: true });
    expect(await ptt.handle('up', SESSION)).toMatchObject({ accepted: true, reason: 'unconfigured', ran: false, listening: false });
    expect(calls).toHaveLength(0);
    expect(logs.filter(line => line.includes(PUSH_TO_TALK_DOWN_ENV) || line.includes(PUSH_TO_TALK_UP_ENV))).toHaveLength(2);
    expect(ptt.describe()).toContain('STEREOFOLD_PTT_DOWN');
    expect(ptt.describe()).toContain('STEREOFOLD_PTT_UP');
  });

  it('debounces a second press inside 300 ms and refuses an unpaired edge', async () => {
    const { calls, spawn } = recorder();
    let clock = 1_000;
    const ptt = createPushToTalk({ enabled: true, down: 'down-command', up: 'up-command', spawn, log: () => {}, now: () => clock });

    const first = ptt.handle('down', SESSION);
    await Promise.resolve();
    finish(calls[0]);
    await first;
    // A second down while the grip is held is a repeat, not a new press.
    expect(await ptt.handle('down', SESSION)).toMatchObject({ accepted: false, reason: 'repeat' });

    const release = ptt.handle('up', SESSION);
    await Promise.resolve();
    finish(calls[1]);
    await release;
    // An up with no press open is refused.
    expect(await ptt.handle('up', SESSION)).toMatchObject({ accepted: false, reason: 'unpaired' });

    clock = 1_299;
    expect(await ptt.handle('down', SESSION)).toMatchObject({ accepted: false, reason: 'debounced' });
    clock = 1_300;
    const third = ptt.handle('down', SESSION);
    await Promise.resolve();
    finish(calls[2]);
    expect(await third).toMatchObject({ accepted: true, ran: true });
    expect(calls).toHaveLength(3);
  });

  it('kills a command that outlasts its timeout', async () => {
    const { calls, spawn } = recorder();
    const logs: string[] = [];
    const ptt = createPushToTalk({ enabled: true, down: 'sleep 60', spawn, log: line => logs.push(line), timeoutMs: 5 });
    const result = await ptt.handle('down', SESSION);
    expect(result).toMatchObject({ accepted: true, reason: 'failed', ran: true, timedOut: true });
    expect(calls[0].child.killed).toEqual(['SIGKILL']);
    expect(logs.some(line => line.includes('killed after 5 ms'))).toBe(true);
    // A killed down still leaves the grip held, so the matching up is accepted.
    expect(ptt.listening()).toBe(true);
  });

  it('refuses every event without a session or without --ptt', async () => {
    const { calls, spawn } = recorder();
    const enabled = createPushToTalk({ enabled: true, down: 'down-command', spawn, log: () => {} });
    expect(await enabled.handle('down', '')).toMatchObject({ accepted: false, reason: 'no_session' });
    expect(await enabled.handle('down', undefined)).toMatchObject({ accepted: false, reason: 'no_session' });

    const off = createPushToTalk({ down: 'down-command', spawn, log: () => {} });
    expect(await off.handle('down', SESSION)).toMatchObject({ accepted: false, reason: 'disabled' });
    expect(off.describe()).toContain('--ptt');
    expect(calls).toHaveLength(0);
    await expect(enabled.handle('sideways' as 'down', SESSION)).rejects.toThrow(/down or up/);
  });

  it('reports a command that cannot start instead of throwing', async () => {
    const spawn: PushToTalkSpawn = () => { throw new Error('spawn ENOENT'); };
    const ptt = createPushToTalk({ enabled: true, down: 'missing-command', spawn, log: () => {} });
    expect(await ptt.handle('down', SESSION)).toMatchObject({ accepted: true, reason: 'failed', ran: false });
  });

  it('reads the environment the host was started with and degrades on a bad value', () => {
    const { spawn } = recorder();
    const configured = pushToTalkFromEnv({ [PUSH_TO_TALK_ENABLED_ENV]: '1', [PUSH_TO_TALK_DOWN_ENV]: 'a', [PUSH_TO_TALK_UP_ENV]: 'b' }, { spawn, log: () => {} });
    expect(configured.enabled).toBe(true);
    expect(configured.describe()).toContain('runs STEREOFOLD_PTT_DOWN=a and STEREOFOLD_PTT_UP=b');

    expect(pushToTalkFromEnv({}, { spawn, log: () => {} }).enabled).toBe(false);

    const logs: string[] = [];
    const oversized = pushToTalkFromEnv({ [PUSH_TO_TALK_ENABLED_ENV]: '1', [PUSH_TO_TALK_DOWN_ENV]: 'x'.repeat(4096) }, { spawn, log: line => logs.push(line) });
    expect(oversized.configured).toBe(false);
    expect(logs.some(line => line.includes('Logging grip events only'))).toBe(true);
  });
});
