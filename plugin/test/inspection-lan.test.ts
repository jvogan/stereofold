import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_TOOLS, defaultCertificateStore, defaultLanPort, headsetClass, LanCompanion, listLanAddresses, OPENSSL_PATHS,
  pairingHtml, servesPairingPage } from '../src/inspection-lan.js';
import { DETAILED_VIEW_ROUTES } from '../src/detailed-view-page.js';
import { PAGE_SOURCE_REFUSAL } from '../src/inspection-page-source.js';
import { SourceRetargetQueue } from '../src/source-retarget-queue.js';

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address(); if (!address || typeof address === 'string') throw Error('loopback fixture did not bind');
  return { server, port: address.port };
}

async function unusedPort(host: string) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, host, () => resolve()); });
  const address = probe.address(); if (!address || typeof address === 'string') throw Error('LAN fixture did not bind');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return address.port;
}

async function httpsCall(host: string, port: number, path: string, { method = 'GET', headers = {}, body, ca }: { method?: string; headers?: Record<string, string>; body?: string; ca: Buffer } ) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const request = httpsRequest({ host, port, path, method, headers, ca, rejectUnauthorized: true }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk))); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject); if (body) request.write(body); request.end();
  });
}

/** Resolves 'cut' when the stream is torn down and 'ended' when it completes. */
function stream(host: string, port: number, token: string, ca: Buffer, path = '/source') {
  const received: string[] = [];
  let settle!: (value: 'cut' | 'ended') => void;
  const settled = new Promise<'cut' | 'ended'>(resolve => { settle = resolve; });
  const request = httpsRequest({ host, port, path, headers: { Authorization: `Bearer ${token}` }, ca, rejectUnauthorized: true }, response => {
    response.on('data', chunk => received.push(String(chunk)));
    response.once('aborted', () => settle('cut'));
    response.once('error', () => settle('cut'));
    response.once('end', () => settle('ended'));
  });
  request.once('error', () => settle('cut'));
  request.end();
  return { request, settled, received };
}

async function outcome(settled: Promise<'cut' | 'ended'>) {
  return Promise.race([settled, new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 4_000))]);
}

function certificatePath(directory: string, host: string) { return join(directory, `${createHash('sha256').update(host).digest('hex')}.crt`); }
function keyPath(directory: string, host: string) { return join(directory, `${createHash('sha256').update(host).digest('hex')}.key`); }

describe('private LAN companion transport', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  it('isolates an explicitly configured certificate and remembered-device store without changing HOME', () => {
    expect(defaultCertificateStore({ STEREOFOLD_LAN_CERTIFICATE_STORE: '/tmp/isolated-stereofold-lan' })).toBe('/tmp/isolated-stereofold-lan');
    expect(isAbsolute(defaultCertificateStore({}))).toBe(true);
    for (const path of ['', 'relative/store'])
      expect(() => defaultCertificateStore({ STEREOFOLD_LAN_CERTIFICATE_STORE: path })).toThrow('must be an absolute directory path');
  });

  it('lists only assigned RFC1918 IPv4 interfaces and requires an unambiguous selection', async () => {
    const interfaces = () => ({ en1: [{ address: '10.0.0.9', family: 'IPv4', internal: false }], lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], vpn: [{ address: '172.20.0.2', family: 4, internal: false }], public: [{ address: '8.8.8.8', family: 'IPv4', internal: false }] });
    expect(listLanAddresses(interfaces)).toEqual([{ address: '10.0.0.9', interface: 'en1' }, { address: '172.20.0.2', interface: 'vpn' }]);
    const lan = new LanCompanion({ interfaces });
    await expect(lan.open({ url: 'http://127.0.0.1:1/#' + 'a'.repeat(64) })).rejects.toThrow('Select a LAN address explicitly');
    await expect(lan.open({ url: 'http://127.0.0.1:1/#' + 'a'.repeat(64), host: '192.168.77.20' })).rejects.toThrow('assigned RFC1918');
  });

  it('pairs once over HTTPS, scopes data and tools to paired clients, and forwards only the loopback capability', async () => {
    const lanAddress = listLanAddresses()[0];
    if (!lanAddress) return; // A host without a private interface cannot run a LAN listener integration fixture.
    const targetToken = 'a'.repeat(64);
    const forwarded: Array<{ name: string; args?: Record<string, unknown> }> = [];
    let target: { server: import('node:http').Server; port: number };
    target = await listen((request, response) => {
      expect(request.headers.host).toBe(`127.0.0.1:${target.port}`);
      expect(request.headers.origin).toBe(`http://127.0.0.1:${target.port}`);
      expect(request.headers.authorization).toBe(request.url === '/' ? undefined : `Bearer ${targetToken}`);
      if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><script>window.__STEREOFOLD_COMPANION__=true</script>'); return; }
      if (request.url === '/source') { response.end('data_local'); return; }
      // The loopback companion's `/density`, which the LAN proxies verbatim
      // rather than parsing.
      if (request.url === '/density') {
        response.setHeader('content-type', 'application/octet-stream');
        response.setHeader('X-Stereofold-Density-SHA256', 'a'.repeat(64));
        response.setHeader('X-Stereofold-Density-Contour', '3.3');
        response.end('MAP density bytes'); return;
      }
      if (request.url === '/tool') {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          forwarded.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true }));
    });
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = await unusedPort(lanAddress.address);
    const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}`, host: lanAddress.address, port });
    expect(opened.url).toBe(`https://${lanAddress.address}:${port}/`);
    expect(opened.fingerprint).toMatch(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
    expect((await stat(join(directory))).mode & 0o777).toBe(0o700);
    expect((await stat(keyPath(directory, opened.host))).mode & 0o777).toBe(0o600);
    const ca = await readFile(certificatePath(directory, opened.host));
    const pairingPage = await httpsCall(opened.host, opened.port, '/', { ca });
    expect(pairingPage.body).not.toContain(opened.pairingCode);
    // The pairing document owns inline styles; default-src 'self' alone
    // blocks them in Safari and turns the connection page into an unstyled form.
    expect(pairingPage.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'");
    expect(pairingPage.headers['content-security-policy']).toContain("connect-src 'self'");
    expect((await httpsCall(opened.host, opened.port, '/source', { ca })).status).toBe(401);
    // `/density` is behind the same pairing as `/source`, and is 401 rather
    // than 404 before a client has paired.
    expect((await httpsCall(opened.host, opened.port, '/density', { ca })).status).toBe(401);
    expect((await httpsCall(opened.host, opened.port, '/viewer', { ca })).body).toContain('__STEREOFOLD_COMPANION__');
    const origin = `https://${opened.host}:${opened.port}`;
    const paired = await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca });
    expect(paired.status).toBe(200); const capability = JSON.parse(paired.body) as { token: string; clientId: string };
    expect(capability.token).toMatch(/^[a-f0-9]{64}$/); expect(capability.token).not.toBe(targetToken);
    expect((await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca })).status).toBe(401);
    expect((await httpsCall(opened.host, opened.port, '/source', { headers: { Authorization: `Bearer ${capability.token}` }, ca })).body).toBe('data_local');
    // And the map crosses the same way — proxied verbatim, with
    // the digest and contour headers that authorize the mesh still on it.
    const density = await httpsCall(opened.host, opened.port, '/density', { headers: { Authorization: `Bearer ${capability.token}` }, ca });
    expect(density.status).toBe(200);
    expect(density.body).toBe('MAP density bytes');
    expect(density.headers['content-type']).toBe('application/octet-stream');
    expect(density.headers['x-stereofold-density-sha256']).toBe('a'.repeat(64));
    expect(density.headers['x-stereofold-density-contour']).toBe('3.3');
    // A map is a route, not a tool. Adding `/density` must not have widened the
    // set of tool names a paired headset may call. `poll_detailed_view` is the
    // detailed-page poll, and `get_inspection_bytes` is the chunked read a
    // comparison structure travels, added separately.
    expect([...ALLOWED_TOOLS]).toEqual(['get_inspection', 'get_inspection_bytes', 'sync_inspection', 'attach_inspection', 'poll_inspection',
      'complete_inspection','report_source_failure', 'detach_inspection', 'undo_last_change', 'redo_last_change', 'push_to_talk', 'push_to_talk_audio', 'navigate_experience',
      'acknowledge_experience_step', 'replace_inspection_source', 'grow_structure', 'voice_command',
      'voice_acknowledgement', 'speak_to_headset', 'claim_voice_intent', 'acknowledge_voice_intent',
      'acknowledge_voice_playback', 'open_detailed_view', 'return_detailed_view', 'poll_detailed_view',
      'report_detailed_selection', 'submit_headset_view']);
    expect(ALLOWED_TOOLS.has('density')).toBe(false);
    expect(ALLOWED_TOOLS.has('read_density')).toBe(false);
    expect((await httpsCall(opened.host, opened.port, '/tool', { method: 'POST', headers: { Authorization: `Bearer ${capability.token}`, Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: '{}', ca })).status).toBe(401);
    expect((await httpsCall(opened.host, opened.port, '/tool', { method: 'POST', headers: { Authorization: `Bearer ${capability.token}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'get_inspection' }), ca })).body).toBe('{"ok":true}');
    for (const name of ['undo_last_change', 'redo_last_change']) {
      const args = { commandId: `${name}-from-headset`, panelId: 'current-panel', baseInspectionRevision: 3 };
      const body = JSON.stringify({ name, args });
      expect((await httpsCall(opened.host, opened.port, '/tool', { method: 'POST', headers: {
        Origin: origin, 'Content-Type': 'application/json' }, body, ca })).status).toBe(401);
      const reply = await httpsCall(opened.host, opened.port, '/tool', { method: 'POST', headers: {
        Authorization: `Bearer ${capability.token}`, Origin: origin, 'Content-Type': 'application/json' }, body, ca });
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body)).toEqual({ ok: true });
      expect(forwarded.at(-1)).toEqual({ name, args });
    }
    // ALLOWED_TOOLS is the LAN-side name gate: an unknown tool, or a body with
    // no name, is 400 before the loopback companion is contacted.
    const unknown = await httpsCall(opened.host, opened.port, '/tool', { method: 'POST', headers: { Authorization: `Bearer ${capability.token}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'not_a_real_tool' }), ca });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toBe('{"error":"invalid_request"}');
    expect((await httpsCall(opened.host, opened.port, '/tool', { method: 'POST', headers: { Authorization: `Bearer ${capability.token}`, Origin: origin, 'Content-Type': 'application/json' }, body: '{}', ca })).status).toBe(400);
    expect(lan.status()?.clients).toEqual([expect.objectContaining({ id: capability.clientId })]);
    await expect(lan.revoke(capability.clientId)).resolves.toBe(true);
    expect((await httpsCall(opened.host, opened.port, '/source', { headers: { Authorization: `Bearer ${capability.token}` }, ca })).status).toBe(401);
  });

  it('lets a journey outlive the default ceiling, cuts any other slow call at it, and bounds both', async () => {
    const lanAddress = listLanAddresses()[0];
    if (!lanAddress) return; // A host without a private interface cannot run a LAN listener integration fixture.
    const targetToken = 'a'.repeat(64);
    const seen: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const target = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        if (request.url !== '/tool') { response.end('{}'); return; }
        const call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        seen.push(call);
        const delay = Number(call.args?.delayMs ?? 0);
        setTimeout(() => { if (!response.destroyed) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, name: call.name })); } }, delay);
      });
    });
    cleanups.push(() => new Promise(resolve => { target.server.closeAllConnections(); target.server.close(() => resolve()); }));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-ceiling-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = await unusedPort(lanAddress.address);
    // The production figures are 55 s and 130 s; the ratio is what is under test.
    const lan = new LanCompanion({ certificateStore: directory, remember: false,
      requestCeilingMs: tool => tool === 'navigate_experience' ? 1_500 : 400 });
    cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}`, host: lanAddress.address, port });
    const ca = await readFile(certificatePath(directory, opened.host));
    const origin = `https://${opened.host}:${opened.port}`;
    const paired = await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca });
    const token = (JSON.parse(paired.body) as { token: string }).token;
    const call = (name: string, args: Record<string, unknown>) => httpsCall(opened.host, opened.port, '/tool', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, args }), ca });
    const timed = async (work: () => Promise<{ status: number; body: string }>) => {
      const started = Date.now();
      const result = await work().then(value => ({ cut: false as const, status: value.status, body: value.body }), () => ({ cut: true as const, status: 0, body: '' }));
      return { ...result, ms: Date.now() - started };
    };

    // The chunk read a comparison structure travels is a tool a paired page may call.
    const chunk = { part: 'source', offset: 0, byteCount: 16, comparison: { sourceSha256: 'e'.repeat(64), assemblyId: 'asymmetric_unit' } };
    const read = await call('get_inspection_bytes', chunk);
    expect(read.status).toBe(200);
    expect(seen.at(-1)).toEqual({ name: 'get_inspection_bytes', args: chunk });

    // Inside every ceiling.
    expect((await timed(() => call('poll_inspection', { delayMs: 50 }))).status).toBe(200);
    // Past the default ceiling but inside a journey's: answered, then the same connection is held to the default again.
    const journey = await timed(() => call('navigate_experience', { delayMs: 900 }));
    expect(journey).toMatchObject({ cut: false, status: 200 });
    const ordinary = await timed(() => call('poll_inspection', { delayMs: 900 }));
    expect(ordinary.cut).toBe(true);
    expect(ordinary.ms).toBeLessThan(900);
    // A journey that never answers still ends, at its own ceiling and no later.
    const hung = await timed(() => call('navigate_experience', { delayMs: 8_000 }));
    expect(hung.cut).toBe(true);
    expect(hung.ms).toBeGreaterThanOrEqual(1_300);
    expect(hung.ms).toBeLessThan(4_000);
  }, 30_000);

  it('refuses a paired page that names a file, a web address or pasted coordinates before the loopback companion sees it', async () => {
    const lanAddress = listLanAddresses()[0];
    if (!lanAddress) return; // A host without a private interface cannot run a LAN listener integration fixture.
    const targetToken = 'a'.repeat(64);
    const forwarded: unknown[] = [];
    const target = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        if (request.url === '/tool') forwarded.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true }));
      });
    });
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-source-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = await unusedPort(lanAddress.address);
    const lan = new LanCompanion({ certificateStore: directory, remember: false }); cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}`, host: lanAddress.address, port });
    const ca = await readFile(certificatePath(directory, opened.host));
    const origin = `https://${opened.host}:${opened.port}`;
    const paired = JSON.parse((await httpsCall(opened.host, opened.port, '/pair', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca })).body);
    const replace = (args: Record<string, unknown>) => httpsCall(opened.host, opened.port, '/tool', { method: 'POST',
      headers: { Authorization: `Bearer ${paired.token}`, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'replace_inspection_source', args }), ca });
    for (const source of [{ kind: 'file', path: '/home/example/private.cif' }, { kind: 'url', url: 'https://example.test/model.cif' },
      { kind: 'pasted', text: 'data_x\n_atom_site.id 1\n' }]) {
      const refused = await replace({ mode: 'compare', source });
      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.body)).toEqual({ error: 'source_not_allowed', message: PAGE_SOURCE_REFUSAL });
    }
    expect(forwarded).toEqual([]);
    expect((await replace({ source: { kind: 'alphafold', accession: 'P69905' } })).status).toBe(200);
    expect((await replace({ pdbId: '4HHB' })).status).toBe(200);
    expect(forwarded).toEqual([{ name: 'replace_inspection_source', args: { source: { kind: 'alphafold', accession: 'P69905' } } },
      { name: 'replace_inspection_source', args: { pdbId: '4HHB' } }]);
  });

  it('uses a persistent per-IP certificate and revokes paired clients when a fresh loopback session is opened', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    const target = await listen((_request, response) => response.end('ok')); cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-cert-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const now = { value: 0 };
    const port = await unusedPort(lanAddress.address); const lan = new LanCompanion({ certificateStore: directory, now: () => now.value, sessionLifetimeMs: 60_000 }); cleanups.push(() => lan.close());
    const first = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port });
    const origin = `https://${first.host}:${first.port}`;
    const ca = await readFile(certificatePath(directory, first.host));
    const paired = JSON.parse((await httpsCall(first.host, first.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: first.pairingCode }), ca })).body);
    const second = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'b'.repeat(64)}`, host: lanAddress.address, port });
    expect(second.url).toBe(first.url); expect(second.fingerprint).toBe(first.fingerprint); expect(second.pairingCode).not.toBe(first.pairingCode);
    expect(lan.status()?.clients).toEqual([]);
    expect((await httpsCall(first.host, first.port, '/source', { headers: { Authorization: `Bearer ${paired.token}` }, ca })).status).toBe(401);
    // An elapsed session cannot revive its old listener or paired clients. It
    // starts a fresh listener at the same bookmarkable address and reuses only
    // the persistent certificate identity.
    now.value = 60_001;
    const expired = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'c'.repeat(64)}`, host: lanAddress.address, port });
    expect(expired.url).toBe(first.url); expect(expired.fingerprint).toBe(first.fingerprint);
    expect(expired.sessionExpiresAt).toBe(new Date(120_001).toISOString());
    expect(lan.status()?.clients).toEqual([]);
    await lan.close(); await expect(httpsCall(first.host, first.port, '/', { ca })).rejects.toThrow();
  });

  // The wearer's headset sees an elapsed share as a refused connection with no
  // reason. The deadline has to survive the close so `manage_companion status`
  // can say when it went and that re-opening needs no code typed in VR.
  it('remembers when a share ran out of time, and forgets it when one opens again', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    const target = await listen((_request, response) => response.end('ok')); cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-expiry-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const now = { value: 0 };
    const port = await unusedPort(lanAddress.address);
    const lan = new LanCompanion({ certificateStore: directory, now: () => now.value, sessionLifetimeMs: 60_000, remember: false });
    cleanups.push(() => lan.close());
    await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port });
    expect(lan.expiredAt()).toBeUndefined();

    now.value = 60_001;
    expect(lan.status()).toBeUndefined();
    expect(lan.expiredAt()).toBe(new Date(60_000).toISOString());

    await lan.open({ url: `http://127.0.0.1:${target.port}/#${'b'.repeat(64)}`, host: lanAddress.address, port });
    expect(lan.expiredAt()).toBeUndefined();
    await lan.close();
    // An explicit stop is a decision, not a failure, so it explains nothing.
    expect(lan.expiredAt()).toBeUndefined();
  });

  it('keeps sharing alive while a paired client is calling, up to a ceiling from the open', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    const target = await listen((_request, response) => response.end('ok')); cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-renew-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const now = { value: 0 };
    const port = await unusedPort(lanAddress.address);
    const lan = new LanCompanion({ certificateStore: directory, now: () => now.value, sessionLifetimeMs: 60_000, sessionMaxLifetimeMs: 100_000, remember: false });
    cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port });
    const ca = await readFile(certificatePath(directory, opened.host)), origin = `https://${opened.host}:${opened.port}`;
    expect(opened.sessionExpiresAt).toBe(new Date(60_000).toISOString());
    expect(opened.sessionMaxExpiresAt).toBe(new Date(100_000).toISOString());
    const capability = JSON.parse((await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca })).body);
    // Spent the moment it was redeemed. Renewal must never revive it.
    const pairedAt = lan.status()!.pairingExpiresAt;

    // An unauthorized caller cannot hold sharing open for a headset that left.
    now.value = 50_000;
    expect((await httpsCall(opened.host, opened.port, '/source', { headers: { Authorization: `Bearer ${'f'.repeat(64)}` }, ca })).status).toBe(401);
    expect(lan.status()?.sessionExpiresAt).toBe(new Date(60_000).toISOString());

    // A paired headset that is still polling pushes the expiry out, and the
    // pairing window it was let in through does not move with it.
    expect((await httpsCall(opened.host, opened.port, '/source', { headers: { Authorization: `Bearer ${capability.token}` }, ca })).status).toBe(200);
    expect(lan.status()?.sessionExpiresAt).toBe(new Date(100_000).toISOString());
    expect(lan.status()?.pairingExpiresAt).toBe(pairedAt);
    expect((await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca })).status).toBe(401);

    // Past the original thirty-minute-equivalent wall, still serving.
    now.value = 70_000;
    expect((await httpsCall(opened.host, opened.port, '/source', { headers: { Authorization: `Bearer ${capability.token}` }, ca })).status).toBe(200);
    expect(lan.status()?.sessionExpiresAt).toBe(new Date(100_000).toISOString());

    // The ceiling is absolute: activity cannot renew past it.
    now.value = 100_001;
    expect(lan.status()).toBeUndefined();
    expect((await httpsCall(opened.host, opened.port, '/source', { headers: { Authorization: `Bearer ${capability.token}` }, ca })).status).toBe(410);
  });

  it('renews the session on the handoff route the Mol* page re-requests while the wearer reads', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    const target = await listen((_request, response) => { response.setHeader('content-type', 'application/json'); response.end('{"version":1}'); });
    cleanups.push(() => new Promise<void>(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-handoff-renew-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const now = { value: 0 };
    const port = await unusedPort(lanAddress.address);
    const lan = new LanCompanion({ certificateStore: directory, now: () => now.value, sessionLifetimeMs: 60_000, sessionMaxLifetimeMs: 100_000, remember: false });
    cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port });
    const ca = await readFile(certificatePath(directory, opened.host)), origin = `https://${opened.host}:${opened.port}`;
    const capability = JSON.parse((await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca })).body);

    // The panel stops polling once the wearer is inside the Mol* page, so the
    // page's own five-minute handoff request is the only thing left holding
    // the listener open behind "Back to headset view".
    now.value = 50_000;
    const renewal = await httpsCall(opened.host, opened.port, DETAILED_VIEW_ROUTES.handoff, { headers: { Authorization: `Bearer ${capability.token}` }, ca });
    expect(renewal.status).toBe(200);
    expect(lan.status()?.sessionExpiresAt).toBe(new Date(100_000).toISOString());
  });

  it('serves the full Mol* viewer to a paired headset on its own origin', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    const targetToken = 'c'.repeat(64);
    const seen: Record<string, string | undefined> = {};
    const target = await listen((request, response) => {
      seen[request.url ?? ''] = request.headers.authorization;
      if (request.url === '/detailed') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<!doctype html><title>Mol* detail</title>'); return; }
      if (request.url === '/detailed/molstar.js') { response.setHeader('content-type', 'text/javascript; charset=utf-8'); response.end('globalThis.molstar={};'); return; }
      if (request.url === '/detailed/molstar.css') { response.setHeader('content-type', 'text/css; charset=utf-8'); response.end('.msp-plugin{}'); return; }
      if (request.url === '/detailed/handoff.json') { response.setHeader('content-type', 'application/json'); response.end('{"version":1}'); return; }
      response.statusCode = 404; response.end('{"error":"not_found"}');
    });
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-detailed-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = await unusedPort(lanAddress.address); const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}`, host: lanAddress.address, port });
    const ca = await readFile(certificatePath(directory, opened.host)), origin = `https://${opened.host}:${opened.port}`;
    // The page and the library carry no structure, so an unpaired GET reads
    // them exactly as it reads the companion page itself.
    const page = await httpsCall(opened.host, opened.port, '/detailed', { ca });
    expect(page.status).toBe(200); expect(page.body).toContain('Mol* detail');
    expect((await httpsCall(opened.host, opened.port, '/detailed/molstar.js', { ca })).body).toContain('molstar');
    expect((await httpsCall(opened.host, opened.port, '/detailed/molstar.css', { ca })).status).toBe(200);
    // The handoff carries the coordinates, so it needs the headset's own
    // capability and reaches loopback under the loopback bearer alone.
    expect((await httpsCall(opened.host, opened.port, '/detailed/handoff.json', { ca })).status).toBe(401);
    const paired = JSON.parse((await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca })).body);
    const handoff = await httpsCall(opened.host, opened.port, '/detailed/handoff.json', { headers: { Authorization: `Bearer ${paired.token}` }, ca });
    expect(handoff.status).toBe(200); expect(handoff.body).toBe('{"version":1}');
    expect(seen['/detailed/handoff.json']).toBe(`Bearer ${targetToken}`);
    expect((await httpsCall(opened.host, opened.port, '/detailed/handoff.json', { method: 'POST', headers: { Authorization: `Bearer ${paired.token}`, Origin: origin, 'Content-Type': 'application/json' }, body: '{}', ca })).status).toBe(401);
    await expect(lan.revoke(paired.clientId)).resolves.toBe(true);
    expect((await httpsCall(opened.host, opened.port, '/detailed/handoff.json', { headers: { Authorization: `Bearer ${paired.token}` }, ca })).status).toBe(401);
  });

  it('retargets only the loopback bearer without re-pairing LAN clients', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    let targetToken = 'a'.repeat(64);
    const target = await listen((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${targetToken}`);
      response.end(targetToken.slice(0, 1));
    });
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-retarget-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = await unusedPort(lanAddress.address); const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}`, host: lanAddress.address, port });
    const ca = await readFile(certificatePath(directory, opened.host)), origin = `https://${opened.host}:${opened.port}`;
    const paired = JSON.parse((await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca })).body);
    targetToken = 'b'.repeat(64);
    await lan.retarget(`http://127.0.0.1:${target.port}/#${targetToken}`);
    expect(lan.status()?.clients).toEqual([expect.objectContaining({ id: paired.clientId })]);
    expect((await httpsCall(opened.host, opened.port, '/source', { headers: { Authorization: `Bearer ${paired.token}` }, ca })).body).toBe('b');
  });

  it('keeps new source and density streams open across duplicate source handoffs, but cuts the next real transition', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    const held: ServerResponse[] = [];
    const target = await listen((_request, response) => {
      held.push(response); response.writeHead(200); response.write('started');
    });
    cleanups.push(() => { for (const response of held) response.destroy(); return new Promise(resolve => target.server.close(() => resolve())); });
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-retarget-dedupe-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    // The real companion bearer URL stays unchanged when its source changes.
    const url = `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`;
    const opened = await lan.open({ url, host: lanAddress.address, port: await unusedPort(lanAddress.address) });
    const ca = await readFile(certificatePath(directory, opened.host)), origin = `https://${opened.host}:${opened.port}`;
    const paired = JSON.parse((await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca })).body);
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 3_000;
      while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      expect(condition()).toBe(true);
    };
    const old = stream(opened.host, opened.port, paired.token, ca);
    await until(() => old.received.length > 0);
    const queue = new SourceRetargetQueue(), owner = {};
    let release!: () => void, retargeted!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const changed = new Promise<void>(resolve => { retargeted = resolve; });
    let effects = 0;
    const effect = async () => { effects++; await lan.retarget(url); };
    const first = queue.run(owner, 'source-a', 'source-b', async () => { await effect(); retargeted(); await hold; });
    await changed; expect(await outcome(old.settled)).toBe('cut');
    const source = stream(opened.host, opened.port, paired.token, ca);
    const density = stream(opened.host, opened.port, paired.token, ca, '/density');
    await until(() => source.received.length > 0 && density.received.length > 0);
    const duplicate = queue.run(owner, 'source-a', 'source-b', effect);
    expect(duplicate).toBe(first);
    release(); await Promise.all([first, duplicate]);
    await queue.run(owner, 'source-a', 'source-b', effect);
    expect(effects).toBe(1);
    for (const response of held.slice(1)) response.write('still-open');
    await until(() => source.received.join('').includes('still-open') && density.received.join('').includes('still-open'));
    await queue.run(owner, 'source-b', 'source-c', effect);
    expect(effects).toBe(2);
    expect(await outcome(source.settled)).toBe('cut');
    expect(await outcome(density.settled)).toBe('cut');
  });

  it('regenerates a stored certificate whose private key no longer matches it', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    const target = await listen((_request, response) => response.end('ok')); cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-pair-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = await unusedPort(lanAddress.address);
    const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    const first = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port });
    await lan.close();

    // An interrupted replacement leaves the new key beside the old certificate.
    // Every other reuse check still passes on that pair, so only the key-to-
    // certificate match can catch it before every TLS handshake fails.
    const foreign = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await writeFile(keyPath(directory, lanAddress.address), foreign.privateKey, { mode: 0o600 });

    const repaired = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'b'.repeat(64)}`, host: lanAddress.address, port });
    expect(repaired.fingerprint).not.toBe(first.fingerprint);
    const ca = await readFile(certificatePath(directory, repaired.host));
    expect((await httpsCall(repaired.host, repaired.port, '/', { ca })).status).toBeLessThan(500);
  });

  it('refuses symbolic-link certificate files instead of following them', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    const target = await listen((_request, response) => response.end('ok')); cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-links-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const victim = join(directory, 'victim'); await writeFile(victim, 'not a certificate');
    await symlink(victim, keyPath(directory, lanAddress.address)); await symlink(victim, certificatePath(directory, lanAddress.address));
    const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    await expect(lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port: await unusedPort(lanAddress.address) })).rejects.toThrow('symbolic links');
  });

  it('serializes close behind an in-flight open so no listener survives shutdown', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    const target = await listen((_request, response) => response.end('ok')); cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-close-race-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    // Seed a valid leaf certificate, then make the actual open wait before it
    // can bind. This reproduces close() arriving while certificate setup runs.
    const seed = new LanCompanion({ certificateStore: directory });
    const seedPort = await unusedPort(lanAddress.address);
    await seed.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port: seedPort }); await seed.close();
    const [key, cert] = await Promise.all([readFile(keyPath(directory, lanAddress.address)), readFile(certificatePath(directory, lanAddress.address))]);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const port = await unusedPort(lanAddress.address);
    const lan = new LanCompanion({ interfaces: () => ({ en0: [{ address: lanAddress.address, family: 'IPv4', internal: false }] }),
      createCertificate: async () => { await gate; return { key, cert, fingerprint: 'AA' }; } });
    const opening = lan.open({ url: `http://127.0.0.1:${target.port}/#${'b'.repeat(64)}`, host: lanAddress.address, port });
    await new Promise(resolve => setImmediate(resolve)); const closing = lan.close(); release();
    await opening; await closing;
    await expect(httpsCall(lanAddress.address, port, '/', { ca: cert })).rejects.toThrow();
  });

  it('bounds concurrent LAN proxy requests while a slow loopback source is in flight', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let started = 0;
    const target = await listen((request, response) => {
      if (request.url !== '/source') { response.end('ok'); return; }
      started++; void held.then(() => response.end('data_local'));
    });
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-busy-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = await unusedPort(lanAddress.address); const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port });
    const ca = await readFile(certificatePath(directory, opened.host)); const origin = `https://${opened.host}:${opened.port}`;
    const paired = JSON.parse((await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca })).body);
    const requests = Array.from({ length: 8 }, () => httpsCall(opened.host, opened.port, '/source', { headers: { Authorization: `Bearer ${paired.token}` }, ca }));
    const deadline = Date.now() + 5_000; while (started < 8 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(started).toBe(8);
    expect((await httpsCall(opened.host, opened.port, '/source', { headers: { Authorization: `Bearer ${paired.token}` }, ca })).status).toBe(429);
    release(); expect((await Promise.all(requests)).every(response => response.status === 200)).toBe(true);
  });

  it('keeps its certificate store absolute even when the environment supplies a relative home', () => {
    // A relative HOME would otherwise place private keys under the working
    // directory of whichever host process launched the server.
    expect(isAbsolute(defaultCertificateStore())).toBe(true);
    expect(() => new LanCompanion({ certificateStore: 'relative/store' })).toThrow('absolute certificate store');
    expect(() => new LanCompanion({ certificateStore: '' })).toThrow('absolute certificate store');
  });

  it('cuts an in-flight stream when its capability is revoked and when the session is reused', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    let hits = 0; const held = new Set<ServerResponse>();
    // The upstream never ends, so only an explicit teardown can settle the
    // proxied response before the 15s request timeout.
    const target = await listen((request, response) => {
      if (request.url !== '/source') { response.end('ok'); return; }
      hits += 1; held.add(response); response.writeHead(200); response.write('partial');
    });
    cleanups.push(() => { for (const response of held) response.destroy(); return new Promise(resolve => target.server.close(() => resolve())); });
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-cut-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = await unusedPort(lanAddress.address); const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port });
    const ca = await readFile(certificatePath(directory, opened.host)); const origin = `https://${opened.host}:${opened.port}`;
    const pair = async (code: string) => JSON.parse((await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), ca })).body) as { token: string; clientId: string };

    const first = await pair(opened.pairingCode);
    const revoked = stream(opened.host, opened.port, first.token, ca);
    let deadline = Date.now() + 5_000; while (hits < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(hits).toBe(1);
    await expect(lan.revoke(first.clientId)).resolves.toBe(true);
    expect(await outcome(revoked.settled)).toBe('cut');

    const renewed = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'b'.repeat(64)}`, host: lanAddress.address, port });
    const second = await pair(renewed.pairingCode);
    const reused = stream(opened.host, opened.port, second.token, ca);
    deadline = Date.now() + 5_000; while (hits < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(hits).toBe(2);
    await lan.open({ url: `http://127.0.0.1:${target.port}/#${'c'.repeat(64)}`, host: lanAddress.address, port });
    expect(await outcome(reused.settled)).toBe('cut');
  });

  it('caps raw connections so a slow-header flood cannot outlast the request limit', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    const target = await listen((_request, response) => response.end('ok')); cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-flood-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = await unusedPort(lanAddress.address); const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port });
    // Every socket stays silent, so none is ever counted against the
    // per-request cap; only the connection cap can bound them.
    const sockets: Socket[] = [];
    const survivors = await Promise.all(Array.from({ length: 48 }, () => new Promise<boolean>(resolve => {
      const socket = connect(opened.port, opened.host); sockets.push(socket);
      socket.once('error', () => resolve(false));
      socket.once('close', () => resolve(false));
      setTimeout(() => resolve(true), 1_200);
    })));
    for (const socket of sockets) socket.destroy();
    const open = survivors.filter(Boolean).length;
    expect(open).toBeLessThanOrEqual(32);
    expect(open).toBeGreaterThan(0);
  });

  it('releases the LAN slot after an aborted upstream response or disconnected client', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    let mode: 'abort' | 'hold' | 'ok' = 'abort'; let sourceHits = 0;
    let upstreamClosed!: () => void; const closed = new Promise<void>(resolve => { upstreamClosed = resolve; });
    const target = await listen((request, response) => {
      if (request.url !== '/source') { response.end('ok'); return; }
      sourceHits++;
      if (mode === 'abort') { response.writeHead(200); response.write('partial'); setImmediate(() => response.destroy(Error('fixture upstream abort'))); return; }
      if (mode === 'hold') { response.once('close', upstreamClosed); return; }
      response.end('recovered');
    });
    cleanups.push(() => new Promise(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-abort-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = await unusedPort(lanAddress.address); const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port });
    const ca = await readFile(certificatePath(directory, opened.host)); const origin = `https://${opened.host}:${opened.port}`;
    const paired = JSON.parse((await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: opened.pairingCode }), ca })).body);
    const sourceOptions = { headers: { Authorization: `Bearer ${paired.token}` }, ca };
    await expect(httpsCall(opened.host, opened.port, '/source', sourceOptions)).rejects.toThrow();
    mode = 'ok'; expect((await httpsCall(opened.host, opened.port, '/source', sourceOptions)).body).toBe('recovered');

    mode = 'hold';
    const aborted = httpsRequest({ host: opened.host, port: opened.port, path: '/source', headers: sourceOptions.headers, ca, rejectUnauthorized: true });
    aborted.once('error', () => {}); aborted.end();
    const deadline = Date.now() + 5_000; while (sourceHits < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(sourceHits).toBe(3); aborted.destroy();
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error('upstream remained open after client disconnect')), 5_000))]);
    mode = 'ok'; expect((await httpsCall(opened.host, opened.port, '/source', sourceOptions)).body).toBe('recovered');
  });
});

describe('STEREOFOLD_LAN_PORT override', () => {
  const originalEnv = process.env.STEREOFOLD_LAN_PORT;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.STEREOFOLD_LAN_PORT;
    else process.env.STEREOFOLD_LAN_PORT = originalEnv;
    vi.restoreAllMocks();
  });

  it('defaults to 8443 when unset', () => {
    delete process.env.STEREOFOLD_LAN_PORT;
    expect(defaultLanPort()).toBe(8443);
  });

  it('uses a valid override', () => {
    process.env.STEREOFOLD_LAN_PORT = '9443';
    expect(defaultLanPort()).toBe(9443);
  });

  it.each(['not-a-number', '80', '65536', '1024.5', ''])(
    'ignores an invalid value %j and warns, falling back to 8443',
    (value) => {
      process.env.STEREOFOLD_LAN_PORT = value;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(defaultLanPort()).toBe(8443);
      if (value === '') expect(warn).not.toHaveBeenCalled();
      else expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  it('threads through LanCompanion.open() when no explicit port is given', async () => {
    const lanAddress = listLanAddresses()[0]; if (!lanAddress) return;
    const port = await unusedPort(lanAddress.address);
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-port-env-'));
    const lan = new LanCompanion({ certificateStore: directory });
    process.env.STEREOFOLD_LAN_PORT = String(port);
    try {
      const opened = await lan.open({ url: `http://127.0.0.1:1/#${'a'.repeat(64)}`, host: lanAddress.address });
      expect(opened.port).toBe(port);
    } finally {
      await lan.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('a port another listener already holds', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
  /** Listen on a given port or a fresh one; release also cuts whatever is still connected. */
  async function hold(server: NetServer, port = 0, host = '127.0.0.1') {
    const sockets = new Set<Socket>();
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()); });
    let released: Promise<void> | undefined;
    const release = () => released ??= new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); });
    cleanups.push(release);
    return { port: (server.address() as AddressInfo).port, release };
  }
  const refused = (opening: Promise<unknown>) =>
    opening.then(() => { throw Error('The share opened on a port another listener holds.'); }, (error: NodeJS.ErrnoException) => error);

  it('tells the pairing page apart from any other answer, or from none', async () => {
    const openssl = OPENSSL_PATHS.find(path => existsSync(path));
    if (!openssl) return; // Without openssl nothing can stand in for a share's certificate.
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-holder-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const key = join(directory, 'share.key'), cert = join(directory, 'share.crt');
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
    const share = await hold(createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => response.end(pairingHtml())));
    const port = share.port;
    expect(await servesPairingPage('127.0.0.1', port)).toBe(true);
    await share.release();
    const plain = await hold(createServer((_request, response) => response.end('<!doctype html><title>Something else</title>')), port);
    expect(await servesPairingPage('127.0.0.1', port)).toBe(false);
    await plain.release();
    // A holder that accepts and never answers costs the probe its timeout and no more.
    const silent = await hold(createNetServer(), port);
    const started = Date.now();
    expect(await servesPairingPage('127.0.0.1', port, 300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    await silent.release();
    expect(await servesPairingPage('127.0.0.1', port)).toBe(false);
  });

  it('names the share or the program that holds its port, and the way past each', async () => {
    const lanAddress = listLanAddresses()[0];
    if (!lanAddress) return; // A host without a private interface cannot run a LAN listener.
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-held-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const host = lanAddress.address, port = await unusedPort(host), url = `http://127.0.0.1:9/#${'a'.repeat(64)}`;
    const holder = new LanCompanion({ certificateStore: directory, remember: false }); cleanups.push(() => holder.close());
    await holder.open({ url, host, port });
    const lan = new LanCompanion({ certificateStore: directory, remember: false }); cleanups.push(() => lan.close());
    const shared = await refused(lan.open({ url, host, port }));
    expect(shared).toMatchObject({ code: 'EADDRINUSE' });
    expect(shared.message).toContain(`cannot listen on ${host}:${port}: another Stereofold share on this Mac already does`);
    // Every role continue_session can return here has its own next step.
    for (const step of ['Call continue_session to join its scene', 'With role=attached', 'With role=none', 'With role=owner', 'manage_companion action="close"'])
      expect(shared.message).toContain(step);
    expect(lan.status()).toBeUndefined();

    await holder.close();
    await hold(createServer((_request, response) => response.end('not a share')), port, host);
    const other = await refused(lan.open({ url, host, port }));
    expect(other).toMatchObject({ code: 'EADDRINUSE' });
    expect(other.message).toContain(`cannot listen on ${host}:${port}: another program on this Mac already does`);
    expect(other.message).toContain(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    expect(other.message).toContain('another lanPort');
    expect(lan.status()).toBeUndefined();
  });
});

describe('the paired headset class', () => {
  const cleanups: Array<() => Promise<unknown> | unknown> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  it('reads the model out of the User-Agent and falls back to unknown', () => {
    expect(headsetClass('Mozilla/5.0 (X11; Linux x86_64; Quest 2) OculusBrowser/39.2.0.0.56')).toBe('quest2');
    expect(headsetClass('Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/39.2.0.0.56')).toBe('quest3');
    expect(headsetClass('Mozilla/5.0 (X11; Linux x86_64; Quest Pro) OculusBrowser/39.2')).toBe('quest-pro');
    // visionOS Safari names no model, and a Mac browser names none either.
    expect(headsetClass('Mozilla/5.0 (Macintosh) Safari/605.1.15')).toBe('unknown');
    expect(headsetClass(undefined)).toBe('unknown');
    expect(headsetClass('')).toBe('unknown');
    // The header is LAN-peer text, so it only ever matches this fixed set.
    expect(['quest2', 'quest3', 'quest-pro', 'vision-pro', 'hand-only', 'unknown'])
      .toContain(headsetClass('<script>alert(1)</script>'.repeat(200)));
  });

  it('reports the class of every live paired client in status', async () => {
    const lanAddress = listLanAddresses()[0];
    if (!lanAddress) return; // No private interface on this host; the fixture cannot bind.
    let target: { server: import('node:http').Server; port: number };
    target = await listen((_request, response) => { response.end('data_local'); });
    cleanups.push(() => new Promise<void>(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-lan-class-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const port = await unusedPort(lanAddress.address);
    const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${'a'.repeat(64)}`, host: lanAddress.address, port });
    const ca = await readFile(certificatePath(directory, opened.host));
    const origin = `https://${opened.host}:${opened.port}`;
    const paired = await httpsCall(opened.host, opened.port, '/pair', { method: 'POST', ca,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/39.2.0.0.56' },
      body: JSON.stringify({ code: opened.pairingCode, remember: false }) });
    expect(paired.status).toBe(200);
    const clients = lan.status()?.clients ?? [];
    expect(clients).toEqual([expect.objectContaining({ id: JSON.parse(paired.body).clientId, deviceClass: 'quest3' })]);
  });
});

// The real LAN lifecycle and authorization paths with only the socket boundary
// replaced. These deterministic expiry tests also run in the socket sandbox.
describe('paired share liveness without sockets', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks(); vi.useRealTimers();
  });
  async function fixture(lifetime = 30 * 60_000, ceiling = 8 * 60 * 60_000) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(0);
    const https = (await import('node:https')).default;
    const { EventEmitter } = await import('node:events');
    const { Readable, Writable } = await import('node:stream');
    const http = (await import('node:http')).default;
    let handle: (request: IncomingMessage, response: ServerResponse) => void;
    const server = new EventEmitter() as any;
    server.setTimeout = server.unref = () => server;
    server.listen = (_port: number, address: string, ready: () => void) => {
      server.address = () => ({ address, port: 8443 }); server.listening = true;ready();
    };
    server.close = (done: () => void) => { server.listening = false;done(); };
    vi.spyOn(https, 'createServer').mockImplementation(((_options: unknown, handler: typeof handle) => {
      handle = handler;return server;
    }) as any);
    vi.spyOn(http, 'request').mockImplementation(((_options: unknown, answer: (response: any) => void) => {
      const request = new EventEmitter() as any;
      request.end = () => {
        const response = Readable.from(['{"ok":true}']) as any;
        response.statusCode = 200; response.headers = {};
        answer(response);
      };
      request.destroy = () => {};
      return request;
    }) as any);
    const lan = new LanCompanion({ interfaces: () => ({ en0: [{ address: '192.168.77.2', family: 'IPv4' }] }),
      certificateStore: '/tmp/c8-unused-certificate-store', remember: false,
      createCertificate: async () => ({ key: Buffer.from('fixture'), cert: Buffer.from('fixture'), fingerprint: 'fixture' }),
      sessionLifetimeMs: lifetime, sessionMaxLifetimeMs: ceiling });
    cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:45000/#${'a'.repeat(64)}` });
    async function request(path: string, body?: unknown, token?: string, method = 'POST') {
      const req = Readable.from(body ? [JSON.stringify(body)] : []) as any;
      req.url = path; req.method = method; req.socket = { remoteAddress: '192.168.77.3' };
      req.headers = { host: '192.168.77.2:8443', origin: 'https://192.168.77.2:8443', 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}) };
      const res = new Writable({ write(_chunk, _encoding, done) { done(); } }) as any;
      res.setHeader = () => {}; res.writeHead = (status: number) => { res.statusCode = status;return res; };
      const chunks: Buffer[] = [];
      res._write = (chunk: Buffer, _encoding: string, done: () => void) => { chunks.push(chunk);done(); };
      const finished = new Promise<{ status: number; body: any }>(resolve => res.on('finish', () =>
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) })));
      handle(req, res);
      return finished;
    }
    const pair = await request('/pair', { code: opened.pairingCode });
    expect(pair.status).toBe(200);
    const beat = () => request('/tool', { name: 'poll_inspection', args: {} }, pair.body.token);
    return { lan, server, beat, request, token: pair.body.token, opened };
  }

  it('beats exactly 60 s apart still renew', async () => {
    const f = await fixture();
    const pairingDeadline = f.lan.status()!.pairingExpiresAt;
    for (let beat = 1; beat <= 35; beat++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await f.beat()).status).toBe(200);
      expect(f.lan.status()?.sessionExpiresAt).toBe(new Date(beat * 60_000 + 30 * 60_000).toISOString());
      expect(f.lan.status()?.lastAuthorizedAt).toBe(new Date(beat * 60_000).toISOString());
    }
    expect(f.server.listening).toBe(true);
    expect(f.lan.status()?.pairingExpiresAt).toBe(pairingDeadline);
  });

  it('a recently used paired client blocks expiry even below renewal granularity', async () => {
    const f = await fixture(80_000, 200_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await f.beat();
    expect(f.lan.status()?.sessionExpiresAt).toBe(new Date(80_000).toISOString());
    await vi.advanceTimersByTimeAsync(75_000); // Fire the original timer.
    expect(f.server.listening).toBe(true);
    expect(f.lan.status()?.sessionExpiresAt).toBe(new Date(85_000).toISOString());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.server.listening).toBe(false);
    expect(f.lan.status()).toBeUndefined();
  });

  it('the ceiling still ends a continuously used share', async () => {
    const f = await fixture(80_000, 160_000);
    for (let i = 0; i < 15; i++) { await vi.advanceTimersByTimeAsync(10_000);await f.beat(); }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.server.listening).toBe(false);
    expect(f.lan.expiredAt()).toBe(new Date(160_000).toISOString());
  });

  it('warns fifteen minutes before the ceiling ends a share in use, then says it did', async () => {
    expect(new LanCompanion({ certificateStore: '/tmp/c8-unused-certificate-store', remember: false }).notice()).toBeUndefined();
    const f = await fixture(30 * 60_000, 60 * 60_000);
    for (let minute = 1; minute <= 44; minute++) { await vi.advanceTimersByTimeAsync(60_000);await f.beat(); }
    expect(f.lan.notice()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);await f.beat();
    expect(f.lan.notice()).toEqual({ state: 'closing', reason: 'ceiling', at: new Date(60 * 60_000).toISOString() });
    for (let minute = 46; minute <= 60; minute++) { await vi.advanceTimersByTimeAsync(60_000);await f.beat(); }
    expect(f.server.listening).toBe(false);
    expect(f.lan.notice()).toEqual({ state: 'closed', reason: 'ceiling', at: new Date(60 * 60_000).toISOString() });
  });

  it('warns when a silent headset is fifteen minutes from ending the share, then says it did', async () => {
    const f = await fixture();
    await vi.advanceTimersByTimeAsync(10 * 60_000);await f.beat();
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(f.lan.notice()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.lan.notice()).toEqual({ state: 'closing', reason: 'idle', at: new Date(40 * 60_000).toISOString() });
    // One request from the headset and there is nothing left to say.
    await f.beat();
    expect(f.lan.notice()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(f.server.listening).toBe(false);
    expect(f.lan.notice()).toEqual({ state: 'closed', reason: 'idle', at: new Date(55 * 60_000).toISOString() });
    // Stopping the share on purpose needs no explanation.
    await f.lan.close();
    expect(f.lan.notice()).toBeUndefined();
    expect(f.lan.expiredAt()).toBeUndefined();
  });

  it('unauthorized requests and revoked clients cannot block inactivity expiry', async () => {
    const f = await fixture(80_000, 200_000);
    await vi.advanceTimersByTimeAsync(5_000);await f.beat();
    await f.lan.revoke(f.lan.status()!.clients[0].id);
    await vi.advanceTimersByTimeAsync(65_000);
    expect((await f.request('/tool', { name: 'poll_inspection' }, f.token)).status).toBe(401);
    expect(f.lan.status()?.lastAuthorizedAt).toBe(new Date(5_000).toISOString());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.server.listening).toBe(false);
  });
});
