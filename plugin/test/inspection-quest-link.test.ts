import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestLink } from '../src/inspection-quest-link.js';

const targetToken = 'a'.repeat(64);
const publicOrigin = 'https://quiet-field-123.trycloudflare.com';
const readyProbe = async () => ({ status: 405 });

class FakeCloudflared extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals) { this.killed.push(signal); this.emit('exit', 0, signal); return true; }
}

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('test server did not listen');
  return { server, port: address.port };
}

describe('QuestLink bounded HTTPS transport', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  it('uses a fresh public token and pins /source to the exact loopback capability', async () => {
    const upstream = vi.fn((request: http.IncomingMessage, response: http.ServerResponse) => {
      expect(request.headers.host).toBe(`127.0.0.1:${target.port}`);
      expect(request.headers.origin).toBe(`http://127.0.0.1:${target.port}`);
      expect(request.headers.authorization).toBe(`Bearer ${targetToken}`);
      expect(request.url).toBe('/source'); response.end('mmcif');
    });
    const target = await listen(upstream); cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const child = new FakeCloudflared(); let proxyPort = 0;
    const spawn = vi.fn((_command: string, args: readonly string[]) => {
      const tunnelUrl = args[args.indexOf('--url') + 1];
      proxyPort = Number(new URL(tunnelUrl).port);
      queueMicrotask(() => child.stderr.write(`INF tunnel available at ${publicOrigin}\n`));
      return child as any;
    });
    const link = new QuestLink({ dnsGraceMs:0, cloudflaredPath:'cloudflared', spawn: spawn as any, randomToken: () => 'b'.repeat(64), probe: readyProbe });
    cleanups.push(() => link.close());
    const opened = await link.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}` });
    expect(opened).toEqual({ url: `${publicOrigin}/#${'b'.repeat(64)}`, expiresAt: expect.any(String) });
    expect(spawn).toHaveBeenCalledWith('cloudflared',
      ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${proxyPort}`],
      { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    expect(spawn.mock.calls[0][1].join(' ')).not.toContain(targetToken);

    const source = await fetch(`http://127.0.0.1:${proxyPort}/source`, { headers: {
      Authorization: `Bearer ${'b'.repeat(64)}`, Origin: publicOrigin,
    } });
    expect(source.status).toBe(200); expect(await source.text()).toBe('mmcif');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('recognizes a Cloudflared origin before a large diagnostic suffix and when the origin spans output chunks', async () => {
    const target = await listen((_request, response) => response.end('ok'));
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const chunkSets = [
      [`INF route ${publicOrigin}\n${'diagnostic '.repeat(100)}`],
      [`INF route ${publicOrigin.slice(0, 25)}`, `${publicOrigin.slice(25)}\n`],
    ];
    for (const [index, chunks] of chunkSets.entries()) {
      const child = new FakeCloudflared();
      const link = new QuestLink({ dnsGraceMs:0, spawn: (() => {
        queueMicrotask(() => { for (const chunk of chunks) child.stderr.write(chunk); });
        return child as any;
      }) as any, randomToken: () => String(index + 7).repeat(64), probe: readyProbe });
      cleanups.push(() => link.close());
      const opened = await link.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}` });
      expect(opened.url).toBe(`${publicOrigin}/#${String(index + 7).repeat(64)}`);
    }
  });

  it('allows harmless root navigation but rejects wrong auth, origin, queries, and websocket upgrades', async () => {
    const target = await listen((request, response) => { response.end(request.url === '/' ? '<html>safe</html>' : 'unexpected'); });
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const child = new FakeCloudflared(); let proxyPort = 0;
    const link = new QuestLink({ dnsGraceMs:0, spawn: ((_command: string, args: readonly string[]) => {
      proxyPort = Number(new URL(args[args.indexOf('--url') + 1]).port);
      queueMicrotask(() => child.stdout.write(`${publicOrigin}/\n`)); return child as any;
    }) as any, randomToken: () => 'c'.repeat(64), probe: readyProbe });
    cleanups.push(() => link.close());
    await link.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}` });
    expect((await fetch(`http://127.0.0.1:${proxyPort}/`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${proxyPort}/source`, { headers: { Authorization: `Bearer ${'d'.repeat(64)}` } })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${proxyPort}/tool`, { method: 'POST', headers: {
      Authorization: `Bearer ${'c'.repeat(64)}`, Origin: 'https://attacker.invalid', 'Content-Type': 'application/json',
    }, body: '{}' })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${proxyPort}/source?x=1`, { headers: { Authorization: `Bearer ${'c'.repeat(64)}` } })).status).toBe(404);
    const upgraded = await new Promise<number>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: proxyPort, path: '/', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } }, response => resolve(response.statusCode ?? 0));
      request.once('error', reject); request.end();
    });
    expect(upgraded).toBe(404);
  });

  it('validates the input capability, reports a missing binary, and tears down its owned resources', async () => {
    const link = new QuestLink({ dnsGraceMs:0, spawn: (() => { const error: any = Error('missing'); error.code = 'ENOENT'; throw error; }) as any, probe: readyProbe });
    await expect(link.open({ url: 'http://localhost:1234/#' + targetToken })).rejects.toThrow('locally issued');
    await expect(link.open({ url: `http://127.0.0.1:1234/#${targetToken}` })).rejects.toThrow('needs cloudflared');

    const target = await listen((_request, response) => response.end('ok'));
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const child = new FakeCloudflared(); let proxyPort = 0;
    const live = new QuestLink({ dnsGraceMs:0, spawn: ((_command: string, args: readonly string[]) => {
      proxyPort = Number(new URL(args[args.indexOf('--url') + 1]).port);
      queueMicrotask(() => child.stdout.write(`${publicOrigin}\n`)); return child as any;
    }) as any, randomToken: () => 'e'.repeat(64), probe: readyProbe });
    await live.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}` });
    await live.close();
    expect(child.killed).toEqual(['SIGTERM']);
    await expect(fetch(`http://127.0.0.1:${proxyPort}/`)).rejects.toThrow();
  });

  it('revokes the proxy when cloudflared exits after issuing the URL', async () => {
    const target = await listen((_request, response) => response.end('ok'));
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const child = new FakeCloudflared(); let proxyPort = 0;
    const link = new QuestLink({ dnsGraceMs:0, spawn: ((_command: string, args: readonly string[]) => {
      proxyPort = Number(new URL(args[args.indexOf('--url') + 1]).port);
      queueMicrotask(() => child.stdout.write(`${publicOrigin}\n`)); return child as any;
    }) as any, randomToken: () => 'f'.repeat(64), probe: readyProbe });
    cleanups.push(() => link.close());
    await link.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}` });
    child.emit('exit', 1, null);
    await new Promise(resolve => setImmediate(resolve));
    await expect(fetch(`http://127.0.0.1:${proxyPort}/`)).rejects.toThrow();
  });

  it('drains cloudflared output after startup and cancels an in-flight startup', async () => {
    const target = await listen((_request, response) => response.end('ok'));
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const child = new FakeCloudflared(); let proxyPort = 0;
    const live = new QuestLink({ dnsGraceMs:0, spawn: ((_command: string, args: readonly string[]) => {
      proxyPort = Number(new URL(args[args.indexOf('--url') + 1]).port);
      queueMicrotask(() => child.stdout.write(`${publicOrigin}\n`)); return child as any;
    }) as any, randomToken: () => '1'.repeat(64), probe: readyProbe });
    cleanups.push(() => live.close());
    await live.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}` });
    child.stderr.write('x'.repeat(128 * 1024));
    expect(child.stderr.readableLength).toBe(0);

    const waitingChild = new FakeCloudflared();
    const waiting = new QuestLink({ dnsGraceMs:0, spawn: (() => waitingChild as any) as any, startupTimeoutMs: 5_000,
      randomToken: () => '2'.repeat(64), probe: readyProbe });
    const opening = waiting.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}` });
    await new Promise(resolve => setImmediate(resolve));
    await waiting.close();
    await expect(opening).rejects.toThrow('closed while starting');
    expect(waitingChild.killed).toEqual(['SIGTERM']);
    expect(proxyPort).toBeGreaterThan(0);
  });

  it('does not spawn or leave an exposed proxy for a malformed generated token, and returns 502 for an unavailable upstream', async () => {
    const target = await listen((_request, response) => response.end('ok'));
    const port = target.port;
    await new Promise<void>(resolve => target.server.close(() => resolve()));
    const spawn = vi.fn();
    const invalid = new QuestLink({ dnsGraceMs:0, spawn: spawn as any, randomToken: () => 'not-a-token', probe: readyProbe });
    await expect(invalid.open({ url: `http://127.0.0.1:${port}/#${targetToken}` })).rejects.toThrow('token generator');
    expect(spawn).not.toHaveBeenCalled();

    const child = new FakeCloudflared(); let proxyPort = 0;
    const live = new QuestLink({ dnsGraceMs:0, spawn: ((_command: string, args: readonly string[]) => {
      proxyPort = Number(new URL(args[args.indexOf('--url') + 1]).port);
      queueMicrotask(() => child.stdout.write(`${publicOrigin}\n`)); return child as any;
    }) as any, randomToken: () => '3'.repeat(64), probe: readyProbe });
    cleanups.push(() => live.close());
    await live.open({ url: `http://127.0.0.1:${port}/#${targetToken}` });
    expect((await fetch(`http://127.0.0.1:${proxyPort}/`)).status).toBe(502);
  });

  it('waits for the exact public HEAD 405, then times out or cancels with owned-process cleanup', async () => {
    const target = await listen((_request, response) => response.end('ok'));
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const child = new FakeCloudflared();
    const probe = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('HEAD'); expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
      return { status: probe.mock.calls.length === 1 ? 503 : 405 };
    });
    const ready = new QuestLink({ dnsGraceMs:0, spawn: (() => { queueMicrotask(() => child.stdout.write(`${publicOrigin}\n`)); return child as any; }) as any,
      randomToken: () => '4'.repeat(64), probe });
    cleanups.push(() => ready.close());
    await ready.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}` });
    expect(probe).toHaveBeenCalledTimes(2); expect(probe.mock.calls[0][0]).toBe(publicOrigin);

    const timedChild = new FakeCloudflared();
    const timed = new QuestLink({ dnsGraceMs:0, spawn: (() => { queueMicrotask(() => timedChild.stdout.write(`${publicOrigin}\n`)); return timedChild as any; }) as any,
      randomToken: () => '5'.repeat(64), probe: async () => ({ status: 503 }), readinessTimeoutMs: 10 });
    await expect(timed.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}` })).rejects.toThrow('timed out waiting for its HTTPS address');
    expect(timedChild.killed).toEqual(['SIGTERM']);

    const waitingChild = new FakeCloudflared();
    const waiting = new QuestLink({ dnsGraceMs:0, spawn: (() => { queueMicrotask(() => waitingChild.stdout.write(`${publicOrigin}\n`)); return waitingChild as any; }) as any,
      randomToken: () => '6'.repeat(64), probe: async (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(Error('aborted')))) });
    const opening = waiting.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}` });
    await new Promise(resolve => setImmediate(resolve));
    await waiting.close();
    await expect(opening).rejects.toThrow('closed while waiting for HTTPS');
    expect(waitingChild.killed).toEqual(['SIGTERM']);
  });
});
