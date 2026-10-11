import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allowedReviewPath,
  createXrReviewServer,
  forwardDotToTarget,
  lookTowardMenuQuaternion,
  parseXrReviewArguments,
  readCompanionTarget,
  sameLocalRequest,
} from '../scripts/serve-xr-review.js';

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve((server.address() as { port: number }).port); };
    server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
  });
}

describe('serve-xr-review', () => {
  it('points the IWER -Z forward ray at the physical menu anchor', () => {
    const head = [0, 1.6, 0] as const;
    const menu = [0.8, 1.35, -1.6] as const;
    const quaternion = lookTowardMenuQuaternion(head, menu);
    expect(forwardDotToTarget(head, menu, quaternion)).toBeGreaterThan(0.99);
  });

  it('requires explicit absolute runtime and private companion paths', () => {
    expect(() => parseXrReviewArguments([])).toThrow('--runtime must be an absolute path.');
    expect(() => parseXrReviewArguments(['--runtime', 'iwer.min.js', '--companion-file', '/tmp/launch.json']))
      .toThrow('--runtime must be an absolute path.');
    expect(parseXrReviewArguments(['--runtime', '/tmp/iwer.min.js', '--companion-file', '/tmp/launch.json', '--port', '0']))
      .toEqual({ runtimePath: '/tmp/iwer.min.js', companionFile: '/tmp/launch.json', port: 0 });
  });

  it('validates the private launch URL without exposing a general target', () => {
    const token = 'a'.repeat(64);
    expect(readCompanionTarget({ companion: { url: `http://127.0.0.1:1234/#${token}` } }))
      .toEqual({ origin: 'http://127.0.0.1:1234', path: '/', token });
    expect(() => readCompanionTarget({ companion: { url: `http://localhost:1234/#${token}` } })).toThrow();
    expect(() => readCompanionTarget({ companion: { url: `http://127.0.0.1:1234/source#${token}` } })).toThrow();
    expect(() => readCompanionTarget({ companion: { url: 'http://127.0.0.1:1234/' } })).toThrow();
  });

  it('keeps the route, host and origin allowlists narrow', () => {
    expect(allowedReviewPath('GET', '/')).toBe(true);
    expect(allowedReviewPath('GET', '/iwer.js')).toBe(true);
    expect(allowedReviewPath('POST', '/tool')).toBe(true);
    expect(allowedReviewPath('GET', '/tool')).toBe(false);
    expect(allowedReviewPath('GET', '/agent')).toBe(false);
    expect(allowedReviewPath('GET', '/source?path=/etc/passwd')).toBe(false);
    expect(allowedReviewPath('GET', '//other-host/')).toBe(false);
    const request = { headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' } } as any;
    expect(sameLocalRequest(request, 'http://127.0.0.1:4321')).toBe(true);
    request.headers.host = 'localhost:4321';
    expect(sameLocalRequest(request, 'http://127.0.0.1:4321')).toBe(false);
  });

  it('serves the fixture and maps local auth to the upstream companion only', async () => {
    const upstreamToken = 'b'.repeat(64);
    let observed: { authorization?: string; origin?: string; body?: string } | undefined;
    const upstream = createServer(async (request, response) => {
      observed = { authorization: request.headers.authorization, origin: request.headers.origin };
      if (request.url === '/source' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end('coordinates'); return;
      }
      let body = ''; for await (const chunk of request) body += String(chunk);
      observed.body = body;
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await listen(upstream);
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-xr-review-'));
    const runtimePath = join(directory, 'iwer.min.js');
    const companionFile = join(directory, 'launch.json');
    await writeFile(runtimePath, 'globalThis.IWER = {};');
    await writeFile(companionFile, JSON.stringify({ companion: { url: `http://127.0.0.1:${upstreamPort}/#${upstreamToken}` } }));
    let review: Awaited<ReturnType<typeof createXrReviewServer>> | undefined;
    try {
      review = await createXrReviewServer({ runtimePath, companionFile, port: 0 });
      const origin = `http://127.0.0.1:${review.port}`;
      const page = await fetch(`${origin}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('window.__STEREOFOLD_COMPANION__=true');
      expect(html).toContain('/iwer.js');
      expect(html).toContain('/setup.js');
      expect(html).not.toContain(upstreamToken);
      const setup = await (await fetch(`${origin}/setup.js`)).text();
      expect(setup).toContain('EMULATED QUEST');
      expect(setup).toContain('Walk around');
      expect(setup).toContain('Active tour');
      expect(setup).toContain('tourReadoutPage');
      expect(setup).toContain('[data-tour-next]');
      expect(setup).toContain('No fixture target matches the current active-tour row layout');
      expect(setup).toContain("selectedLabel?.startsWith('More text ')");
      expect(setup).toContain('The selected toolbar control is not present in the current active-tour row layout');
      expect(() => new Function(setup)).not.toThrow();
      const localToken = html.match(/location\.hash="#([a-f0-9]{64})"/)?.[1];
      expect(localToken).toMatch(/^[a-f0-9]{64}$/);
      const unauthorized = await fetch(`${origin}/tool`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
      expect(unauthorized.status).toBe(401);
      const tool = await fetch(`${origin}/tool`, {
        method: 'POST', headers: { Authorization: `Bearer ${localToken}`, 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ name: 'get_inspection', args: {} }),
      });
      expect(tool.status).toBe(200);
      expect(await tool.json()).toEqual({ ok: true });
      expect(observed).toEqual({
        authorization: `Bearer ${upstreamToken}`,
        origin: `http://127.0.0.1:${upstreamPort}`,
        body: JSON.stringify({ name: 'get_inspection', args: {} }),
      });
      const source = await fetch(`${origin}/source`, { headers: { Authorization: `Bearer ${localToken}` } });
      expect(source.status).toBe(200);
      expect(await source.text()).toBe('coordinates');
      const arbitrary = await fetch(`${origin}/agent`, { headers: { Authorization: `Bearer ${localToken}` } });
      expect(arbitrary.status).toBe(403);
    } finally {
      await review?.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
