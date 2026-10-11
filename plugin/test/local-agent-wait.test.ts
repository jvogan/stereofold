/**
 * Starting the host and the thing that drives it in the same breath.
 *
 * The host writes `~/.stereofold/quest-share.json` only once it has a scene to
 * share, which is seconds after it starts. A driver or an agent call launched
 * beside it read that path first and died on ENOENT — a stack trace about a
 * file that was about to exist, at the exact moment an operator has three
 * terminals open and no reason to think the order mattered.
 *
 * So the wait is opt-in and bounded, and everything here is about the two
 * halves of that: it must actually wait, and it must never turn a host that is
 * genuinely not running, or a control file that is genuinely wrong, into a
 * silent twenty-second pause.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_WAIT_MS, readControlState, resolveStatePath, waitForHostRequested } from '../scripts/local-agent.js';

const control = (port = 53191) => JSON.stringify({ origin: `http://127.0.0.1:${port}`, token: 'a'.repeat(64), sessionId: 'session-1' });

/** A clock that only moves when the code under test sleeps, so a bounded wait costs no wall time. */
function fakeClock() {
  let elapsed = 0;
  const slept: number[] = [];
  return { now: () => elapsed, sleep: async(ms: number) => { slept.push(ms); elapsed += ms; }, slept, get elapsed() { return elapsed; } };
}

const directories: string[] = [];
async function scratch(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'stereofold-host-wait-'));
  directories.push(made);
  return made;
}
afterEach(async() => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('asking to wait for a host', () => {
  it('reads the flag and the environment variable, and treats the off settings as off', () => {
    expect(waitForHostRequested([], {})).toBe(false);
    expect(waitForHostRequested(['--wait-for-host'], {})).toBe(true);
    expect(waitForHostRequested([], { STEREOFOLD_WAIT_FOR_HOST: '1' })).toBe(true);
    expect(waitForHostRequested([], { STEREOFOLD_WAIT_FOR_HOST: ' yes ' })).toBe(true);
    for (const setting of ['0', 'off', 'no', 'false', '', '   ']) {
      expect(waitForHostRequested([], { STEREOFOLD_WAIT_FOR_HOST: setting }), setting).toBe(false);
    }
  });
});

describe('resolveStatePath while a host is still starting', () => {
  it('fails on the first look when nobody asked it to wait, and names where it looked', async() => {
    const directory = await scratch();
    const clock = fakeClock();
    await expect(resolveStatePath(undefined, { candidates: [join(directory, 'quest-share.json')], now: clock.now, sleep: clock.sleep }))
      .rejects.toThrow(/No running Stereofold host was found.*quest-share\.json/s);
    expect(clock.slept, 'a run that did not ask to wait must not pause at all').toEqual([]);
  });

  it('returns the path as soon as the host writes it', async() => {
    const directory = await scratch();
    const path = join(directory, 'quest-share.json');
    const clock = fakeClock();
    let looks = 0;
    const sleep = async(ms: number) => {
      await clock.sleep(ms);
      if (++looks === 3) await writeFile(path, control());
    };
    await expect(resolveStatePath(undefined, { candidates: [path], now: clock.now, sleep, waitForHost: true })).resolves.toBe(path);
    expect(looks).toBe(3);
  });

  it('gives up at the bound and says how long it waited, rather than hanging', async() => {
    const directory = await scratch();
    const clock = fakeClock();
    await expect(resolveStatePath(undefined, { candidates: [join(directory, 'quest-share.json')],
      now: clock.now, sleep: clock.sleep, waitForHost: true })).rejects.toThrow(/appeared within 20s/);
    expect(clock.elapsed).toBeGreaterThanOrEqual(HOST_WAIT_MS);
    expect(clock.elapsed).toBeLessThan(HOST_WAIT_MS * 2);
  });

  it('waits for a named path too, and still refuses a relative one outright', async() => {
    const directory = await scratch();
    const path = join(directory, 'named.json');
    const clock = fakeClock();
    const sleep = async(ms: number) => { await clock.sleep(ms); if (clock.elapsed >= 1_000) await writeFile(path, control()); };
    await expect(resolveStatePath(path, { now: clock.now, sleep, waitForHost: true })).resolves.toBe(path);
    await expect(resolveStatePath('relative.json', { waitForHost: true })).rejects.toThrow(/must be absolute/);
  });

  it('still takes a bare candidate list, so nothing that already called it has to change', async() => {
    const directory = await scratch();
    const path = join(directory, 'quest-share.json');
    await writeFile(path, control());
    await expect(resolveStatePath(undefined, [path])).resolves.toBe(path);
  });
});

describe('readControlState while a host is still starting', () => {
  it('raises the missing file immediately when nobody asked it to wait', async() => {
    const directory = await scratch();
    await expect(readControlState(join(directory, 'quest-share.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits out the missing file and the half-written one, then reads the host', async() => {
    const directory = await scratch();
    const path = join(directory, 'quest-share.json');
    const clock = fakeClock();
    let looks = 0;
    // A host mid-write hands back a truncated document, which is the same race
    // as the absent file rather than a corrupt control file.
    const sleep = async(ms: number) => {
      await clock.sleep(ms);
      if (++looks === 2) await writeFile(path, control().slice(0, 20));
      if (looks === 4) await writeFile(path, control());
    };
    await expect(readControlState(path, { waitForHost: true, now: clock.now, sleep }))
      .resolves.toMatchObject({ origin: 'http://127.0.0.1:53191', sessionId: 'session-1' });
  });

  it('never waits out a control file that is there and says something wrong', async() => {
    const directory = await scratch();
    const path = join(directory, 'quest-share.json');
    // TEST-NET-1 is a documentation-only non-loopback address.
    await writeFile(path, JSON.stringify({ origin: 'http://192.0.2.93:8443', token: 'a'.repeat(64), sessionId: 'session-1' }));
    const clock = fakeClock();
    await expect(readControlState(path, { waitForHost: true, now: clock.now, sleep: clock.sleep })).rejects.toThrow(/loopback/);
    expect(clock.slept, 'a refusal repeated for twenty seconds buries the sentence that explains it').toEqual([]);
  });

  it('gives up at the bound on a host that never writes one', async() => {
    const directory = await scratch();
    const clock = fakeClock();
    await expect(readControlState(join(directory, 'quest-share.json'), { waitForHost: true, now: clock.now, sleep: clock.sleep }))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(clock.elapsed).toBeGreaterThanOrEqual(HOST_WAIT_MS);
  });
});
