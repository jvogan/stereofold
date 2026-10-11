import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InspectionCompanionHttp } from '../src/inspection-companion-http.js';
import { LanCompanion, listLanAddresses } from '../src/inspection-lan.js';
import { DETAILED_VIEW_ROUTES, DETAILED_VIEW_SCRIPT_HASH } from '../src/detailed-view-page.js';

/**
 * The exact policy every page the headset loads is served under.
 *
 * This file exists because of one measurement. The devtools bridge read the
 * live headset's console and found Mol* being refused a
 * `fetch("data:application/octet-stream;base64,AGFzbQ...")` by `connect-src
 * 'self'`, which was read at the time as "Mol*'s WASM-accelerated paths are
 * dead in the headset" and a likely cause of a 3.245 s molecular surface. Both
 * halves of that are wrong, and the measurement that settles it is recorded
 * here so nobody widens the policy to chase it again:
 *
 *  - The blocked URI is the h264-mp4-encoder Emscripten module (traced through
 *    molstar.js.map to `webpack://HME/embuild/h264-mp4-encoder.js`), built with
 *    Emscripten SINGLE_FILE so its ~944 KB of WASM is inlined as base64. It
 *    belongs to Mol*'s MP4 animation export, which a headset wearer never runs,
 *    and it evaluates at bundle load because `h264-mp4-encoder.ts` calls the
 *    module factory at module scope. `disabledExtensions: ['mp4-export']` does
 *    not stop that; only rebuilding Mol* from source would.
 *  - Nothing in the molecular-surface, gaussian-density or marching-cubes path
 *    uses WebAssembly. They are TypeScript plus WebGL, so the block cannot be
 *    what made that surface slow.
 *  - The block is not fatal. The generated loader is
 *    `fetch(uri).catch(() => getBinarySync())`, and for a data: URI the sync
 *    path is a local `atob`. Measured in headless Chromium against this very
 *    server: with `connect-src 'self'` in force, `WebAssembly.instantiate` is
 *    still called once, with 707,751 bytes, and resolves in 2-3 ms. Allowing
 *    `data:` removes a console line and buys no time at all.
 *
 * So `connect-src` stays `'self'` on every route: adding `data:` would widen a
 * policy for no measured gain. What the module actually needs is the
 * `'unsafe-eval'` the detailed page already has for embind's `new Function`,
 * which covers WebAssembly compilation too. The blocked call to
 * webchem.ncbr.muni.cz stays blocked and is now also not made: the detailed
 * page passes `layoutShowRemoteState: false`.
 */
const LOOPBACK_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; "
  + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
  + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const DETAILED_CSP = LOOPBACK_CSP.replace("script-src 'self' 'unsafe-inline' blob:", `script-src 'self' ${DETAILED_VIEW_SCRIPT_HASH} 'unsafe-eval' blob:`);
const LAN_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; "
  + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/** Directive lookup, so a failure names the directive rather than a 400-character string. */
function directives(policy: string | undefined) {
  const found = new Map<string, string>();
  for (const part of (policy ?? '').split(';')) {
    const trimmed = part.trim(); if (!trimmed) continue;
    const gap = trimmed.indexOf(' ');
    found.set(gap < 0 ? trimmed : trimmed.slice(0, gap), gap < 0 ? '' : trimmed.slice(gap + 1));
  }
  return found;
}

async function companionSetup() {
  const dist = await mkdtemp(join(tmpdir(), 'stereofold-csp-'));
  await writeFile(join(dist, 'inspector.html'), '<!doctype html><html><body><script>void 0;</script></body></html>');
  await mkdir(join(dist, 'molstar'), { recursive: true });
  await writeFile(join(dist, 'molstar/molstar.js'), 'globalThis.molstar={};');
  await writeFile(join(dist, 'molstar/molstar.css'), '.msp-plugin{color:#fff}');
  const companion = new InspectionCompanionHttp({
    htmlPath: join(dist, 'inspector.html'),
    dispatch: async () => ({ content: [] }),
    source: async () => ({ text: 'data_example\n', sha256: 'a'.repeat(64) }),
    molstarRoots: { distRoot: dist, packageRoot: dist },
    detailed: async () => ({}) as never,
  });
  return { companion, cleanup: async () => { await companion.close(); await rm(dist, { recursive: true, force: true }); } };
}

describe('content security policy on every page the headset loads', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  it('serves the companion, the WebXR check and the Mol* asset routes under exactly the loopback policy', async () => {
    const t = await companionSetup(); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const origin = new URL(link.url).origin;
    for (const path of ['/', '/xr-check', DETAILED_VIEW_ROUTES.script, DETAILED_VIEW_ROUTES.style]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-security-policy'), path).toBe(LOOPBACK_CSP);
    }
  });

  it('gives the detailed Mol* page unsafe-eval, and its own script by hash in place of unsafe-inline', async () => {
    const t = await companionSetup(); cleanups.push(t.cleanup);
    const link = await t.companion.openDetailed('session-a', 'source-a');
    const response = await fetch(`${new URL(link.url).origin}${DETAILED_VIEW_ROUTES.page}`);
    expect(response.status).toBe(200);
    const policy = response.headers.get('content-security-policy');
    expect(policy).toBe(DETAILED_CSP);
    const found = directives(policy ?? undefined);
    // embind names its exported functions with `new Function`, and the same
    // relaxation is what lets the inlined WASM compile at all. The other
    // difference narrows the policy: Mol* writes names from the structure file
    // into this page as HTML, so the page's one inline script is admitted by
    // its digest and no inline event handler runs.
    expect(found.get('script-src')).toBe(`'self' ${DETAILED_VIEW_SCRIPT_HASH} 'unsafe-eval' blob:`);
    expect(DETAILED_CSP.replace(`${DETAILED_VIEW_SCRIPT_HASH} 'unsafe-eval'`, "'unsafe-inline'")).toBe(LOOPBACK_CSP);
  });

  it('keeps connect-src at self on every route, so Mol* decodes its own WASM and webchem stays blocked', async () => {
    const t = await companionSetup(); cleanups.push(t.cleanup);
    const link = await t.companion.openDetailed('session-a', 'source-a');
    const origin = new URL(link.url).origin;
    for (const path of ['/', '/xr-check', DETAILED_VIEW_ROUTES.page, DETAILED_VIEW_ROUTES.script]) {
      const found = directives((await fetch(`${origin}${path}`)).headers.get('content-security-policy') ?? undefined);
      // 'self' is a loopback or LAN origin, so neither the third-party remote
      // state server nor a base64 data: URI is reachable. Both are deliberate.
      expect(found.get('connect-src'), path).toBe("'self'");
      expect(found.get('default-src'), path).toBe("'self'");
    }
    for (const policy of [LOOPBACK_CSP, DETAILED_CSP, LAN_CSP]) {
      expect(policy).not.toContain('connect-src \'self\' data:');
      expect(policy).not.toContain('webchem');
    }
  });

  it('serves the LAN pairing page under its own policy and proxies the companion policy through unchanged', async () => {
    const lanAddress = listLanAddresses()[0];
    if (!lanAddress) return; // A host with no private interface cannot run a LAN listener fixture.
    const targetToken = 'a'.repeat(64);
    let target: { server: ReturnType<typeof createServer>; port: number };
    const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
      const server = createServer(handler);
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
      const address = server.address(); if (!address || typeof address === 'string') throw Error('loopback fixture did not bind');
      return { server, port: address.port };
    };
    target = await listen((request, response) => {
      // Stand in for the loopback companion: the only thing under test here is
      // that the LAN listener hands the browser the upstream policy verbatim.
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Content-Security-Policy', request.url === DETAILED_VIEW_ROUTES.page ? DETAILED_CSP : LOOPBACK_CSP);
      response.end('<!doctype html><script>window.__STEREOFOLD_COMPANION__=true</script>');
    });
    cleanups.push(() => new Promise<void>(resolve => target.server.close(() => resolve())));
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-csp-lan-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, lanAddress.address, () => resolve()); });
    const probed = probe.address(); if (!probed || typeof probed === 'string') throw Error('LAN fixture did not bind');
    const port = probed.port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const lan = new LanCompanion({ certificateStore: directory }); cleanups.push(() => lan.close());
    const opened = await lan.open({ url: `http://127.0.0.1:${target.port}/#${targetToken}`, host: lanAddress.address, port });
    const ca = await readFile(join(directory, `${createHash('sha256').update(opened.host).digest('hex')}.crt`));
    const call = (path: string) => new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
      const request = httpsRequest({ host: opened.host, port: opened.port, path, ca, rejectUnauthorized: true }, response => {
        response.resume(); response.once('error', reject); response.once('end', () => resolve(response.headers));
      });
      request.once('error', reject); request.end();
    });
    expect((await call('/'))['content-security-policy']).toBe(LAN_CSP);
    expect((await call('/viewer'))['content-security-policy']).toBe(LOOPBACK_CSP);
    expect((await call(DETAILED_VIEW_ROUTES.page))['content-security-policy']).toBe(DETAILED_CSP);
  });
});
