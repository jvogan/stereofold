/**
 * Stopping a launch leaves nothing behind.
 *
 * `pnpm run demo` runs pnpm, a second pnpm, the tsx CLI, the demo launcher and
 * quest-share, and quest-share starts the host in its own session. These cover
 * the three ways that chain used to strand the host on the private port: a
 * signal sent to the top process alone, the terminal closing, and the launcher
 * dying without running its shutdown.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeTakenPort, findPortHolder, isStereofoldHostCommand, launchChain, launchChainBroken, parseProcessTable,
  pollUntil, preflightProblems, readProcessTable, type ProcessRow,
} from '../scripts/quest-share.js';
import { forwardStopSignals, lanPortOf } from '../scripts/quest-demo.js';
import { HOST_LIFELINE_ENV, watchHostLifeline } from '../src/host-lifeline.js';
import type { DoctorReport } from '../scripts/setup-doctor.js';

const pluginRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// A shell (its own group) runs pnpm, which re-executes pnpm, which runs the
// tsx CLI, the demo launcher and quest-share, all in the job's group 200.
const job: ProcessRow[] = [
  { pid: 100, ppid: 90, pgid: 100 },
  { pid: 200, ppid: 100, pgid: 200 },
  { pid: 210, ppid: 200, pgid: 200 },
  { pid: 220, ppid: 210, pgid: 200 },
  { pid: 230, ppid: 220, pgid: 200 },
  { pid: 240, ppid: 230, pgid: 200 },
];

describe('the launch chain', () => {
  it('follows a package-script launch up to the job and stops below the shell', () => {
    expect(launchChain(job, { pid: 240, ppid: 230 }).map(row => row.pid)).toEqual([230, 220, 210, 200]);
  });

  it('keeps the direct parent when it leads another group', () => {
    const direct = [{ pid: 100, ppid: 90, pgid: 100 }, { pid: 300, ppid: 100, pgid: 300 }];
    expect(launchChain(direct, { pid: 300, ppid: 100 }).map(row => row.pid)).toEqual([100]);
    expect(launchChain([], { pid: 300, ppid: 100 })).toEqual([]);
  });

  it('notices the top process killed alone, even before its shell reaps it', () => {
    const chain = launchChain(job, { pid: 240, ppid: 230 });
    expect(launchChainBroken(chain, job)).toBe(false);
    // The killed pnpm still lists with its old parent until it is reaped; the
    // pnpm below it has already been handed to init.
    const killedTop = job.map(row => row.pid === 210 ? { ...row, ppid: 1 } : row);
    expect(launchChainBroken(chain, killedTop)).toBe(true);
    expect(launchChainBroken(chain, job.filter(row => row.pid !== 220))).toBe(true);
  });

  it('reads ps output, and reports undefined when ps cannot run', async () => {
    expect(parseProcessTable('  240   230   200\n\n 1 0 1\nps: junk\n')).toEqual([
      { pid: 240, ppid: 230, pgid: 200 }, { pid: 1, ppid: 0, pgid: 1 },
    ]);
    expect(await readProcessTable([1], async () => undefined)).toBeUndefined();
    expect(await readProcessTable([240], async () => '')).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('finds this process with its real parent', async () => {
    const rows = await readProcessTable([process.pid]);
    expect(rows).toEqual([expect.objectContaining({ pid: process.pid, ppid: process.ppid })]);
  });
});

describe('a port another launch holds', () => {
  const holder = { pid: 4242, command: '/home/tester/.nvm/node /home/tester/stereofold/plugin/dist/server.mjs' };

  it('names the holder, says it is left alone, and keeps the home folder out', () => {
    const text = describeTakenPort(8448, holder, '/home/tester');
    expect(text).toMatch(/^TCP 8448 already has a listening process: pid 4242, a Stereofold host/);
    expect(text).toContain('This launch leaves it alone');
    expect(text).toContain('kill 4242');
    expect(text).not.toContain('/home/tester');
    expect(describeTakenPort(8448, { pid: 7, command: '/usr/sbin/httpd' }, '/home/tester')).toContain('another program');
    expect(describeTakenPort(8443)).toMatch(/^TCP 8443 already has a listening process\. Stop that session/);
  });

  it('carries the holder into the preflight problem', () => {
    const report = { node: { check: 'ok' }, openssl: { check: 'ok' }, build: { state: 'fresh' },
      lan: { addresses: [{ interface: 'en0', address: '192.0.2.10' }] }, port: { state: 'listening', port: 8448 } } as unknown as DoctorReport;
    expect(preflightProblems(report, false, holder)).toEqual([expect.stringContaining('pid 4242')]);
  });

  it('asks lsof and ps, and finds nothing on a free port', async () => {
    const asked: string[] = [];
    const run = async (command: string, args: readonly string[]) => {
      asked.push(`${command} ${args.join(' ')}`);
      return command === 'lsof' ? 'p4242\nf15\n' : `${holder.command}\n`;
    };
    expect(await findPortHolder(8448, run)).toEqual(holder);
    expect(asked[0]).toBe('lsof -nP -iTCP:8448 -sTCP:LISTEN -F p');
    expect(await findPortHolder(8448, async () => '')).toBeUndefined();
    expect(isStereofoldHostCommand('node --import tsx /x/plugin/scripts/serve-inspection.ts 1CRN')).toBe(true);
    expect(isStereofoldHostCommand('node /x/server.mjs.bak')).toBe(false);
  });

  it('checks the port the demo will ask for', () => {
    expect(lanPortOf(['--headless'])).toBe(8443);
    expect(lanPortOf(['--lan-port', '8448', '--headless'])).toBe(8448);
  });
});

describe('the demo launcher', () => {
  it('forwards Ctrl-C, SIGTERM and the terminal closing to quest-share until it exits', () => {
    const handlers = new Map<string, () => void>();
    const child = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, sent: [] as string[],
      kill(signal?: NodeJS.Signals | number) { this.sent.push(String(signal)); return true; } };
    forwardStopSignals(child, (signal, listener) => handlers.set(signal, listener));
    expect([...handlers.keys()]).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
    handlers.get('SIGHUP')!();
    handlers.get('SIGINT')!();
    expect(child.sent).toEqual(['SIGHUP', 'SIGINT']);
    child.exitCode = 0;
    handlers.get('SIGTERM')!();
    expect(child.sent).toEqual(['SIGHUP', 'SIGINT']);
  });
});

describe('the host lifeline', () => {
  it('watches stdin only when the launcher asked, and fires once', () => {
    const input = Object.assign(new EventEmitter(), { resumed: 0, resume() { this.resumed++; } });
    let closed = 0;
    expect(watchHostLifeline({}, input, () => { closed++; })).toBe(false);
    expect(input.listenerCount('end') + input.resumed).toBe(0);
    expect(watchHostLifeline({ [HOST_LIFELINE_ENV]: '1' }, input, () => { closed++; })).toBe(true);
    input.emit('end'); input.emit('close');
    expect(closed).toBe(1);
    expect(input.resumed).toBe(1);
  });

  // A launcher that dies without its shutdown (SIGKILL here) closes the pipe,
  // and a host in its own session then exits on its own. Without the variable
  // the same host outlives the launcher, which is the leak this guards.
  for (const lifeline of [true, false]) {
    it.skipIf(process.platform === 'win32')(`a detached host ${lifeline ? 'exits' : 'stays'} when its launcher is killed ${lifeline ? 'with' : 'without'} the lifeline`, async () => {
      const hostCode = `import { watchHostLifeline } from ${JSON.stringify(resolve(pluginRoot, 'src/host-lifeline.ts'))};`
        + 'watchHostLifeline(process.env, process.stdin, () => process.exit(0)); setInterval(() => {}, 1000);';
      const launcherCode = `const host=require('node:child_process').spawn(process.execPath,['--import','tsx','--input-type=module','-e',${JSON.stringify(hostCode)}],`
        + `{cwd:${JSON.stringify(pluginRoot)},detached:true,stdio:['pipe','ignore','ignore'],env:{...process.env,${HOST_LIFELINE_ENV}:${JSON.stringify(lifeline ? '1' : '0')}}});`
        + 'process.stdout.write(String(host.pid));setInterval(()=>{},1000)';
      const launcher = spawn(process.execPath, ['-e', launcherCode], { cwd: pluginRoot, stdio: ['ignore', 'pipe', 'ignore'] });
      let host: number | undefined;
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
      try {
        const [chunk] = await once(launcher.stdout!, 'data');
        host = Number(String(chunk));
        expect(Number.isSafeInteger(host)).toBe(true);
        // Let the host load its module before the pipe closes.
        await new Promise(done => setTimeout(done, 1_500));
        expect(alive(host)).toBe(true);
        launcher.kill('SIGKILL');
        await once(launcher, 'exit');
        if (lifeline) {
          await pollUntil(async () => !alive(host!), gone => gone, 'the host to exit', { timeoutMs: 5_000, intervalMs: 50 });
        } else {
          await new Promise(done => setTimeout(done, 1_000));
          expect(alive(host)).toBe(true);
        }
      } finally {
        if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
        if (host && alive(host)) process.kill(host, 'SIGKILL');
      }
    }, 20_000);
  }
});
