import { createHash } from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { InspectionCompanionHttp } from '../src/inspection-companion-http.js';
import { DETAILED_VIEW_ROUTES, DETAILED_VIEW_SCRIPT_HASH } from '../src/detailed-view-page.js';

it('gives the detailed document unsafe-eval, admits its one inline script by hash, and keeps connect-src at self', async () => {
  // Run the actual HTTP handler with request/response doubles, without sockets.
  let handler: any;
  const listener = Object.assign(new EventEmitter(), {
    listening: true, setTimeout() {}, unref() {},
    listen(_port: number, _host: string, ready: () => void) { ready(); },
    address: () => ({address: '127.0.0.1', port: 12345}),
    close(done: () => void) { done(); },
  });
  const create = vi.spyOn(http, 'createServer').mockImplementation(((_options: any, handle: any) => {
    handler = handle; return listener;
  }) as any);
  const directory = await mkdtemp(join(tmpdir(), 'detailed-csp-'));
  let companion: InspectionCompanionHttp | undefined;
  try {
    await mkdir(join(directory, 'molstar'));
    await writeFile(join(directory, 'inspector.html'), '<html><script>void 0;</script></html>');
    await writeFile(join(directory, 'molstar/molstar.js'), 'globalThis.molstar={};');
    await writeFile(join(directory, 'molstar/molstar.css'), '.msp-plugin{}');
    companion = new InspectionCompanionHttp({htmlPath: join(directory, 'inspector.html'),
      dispatch: async () => ({}), source: async () => ({text: '', sha256: ''}),
      molstarRoots: {distRoot: directory, packageRoot: directory}, detailed: async () => { throw Error('not requested'); }});
    await companion.open('session', 'source');
    const get = (url: string) => new Promise<Record<string, string>>(resolve => {
      const headers: Record<string, string> = {};
      handler({url, method: 'GET', headers: {host: '127.0.0.1:12345'}}, {
        setHeader: (name: string, value: string) => { headers[name] = value; },
        writeHead: (status: number) => { expect(status).toBe(200); },
        end: (body: Buffer | string) => resolve({...headers, body: String(body)}),
      });
    });
    const detailed = await get(DETAILED_VIEW_ROUTES.page);
    // connect-src stays 'self' here on purpose: the only data: fetch Mol* makes
    // is its inlined MP4-encoder module, which falls back to a local decode
    // (measured in test/page-content-security-policy.test.ts). Widening the
    // policy would remove one console line and buy nothing.
    expect(detailed['Content-Security-Policy']).toContain("connect-src 'self';");
    expect(detailed['Content-Security-Policy']).not.toContain("connect-src 'self' data:");
    expect(detailed['Content-Security-Policy']).toContain("'unsafe-eval'");
    // Mol* writes names from the structure file into this page as HTML, so an
    // inline event handler in one must not run. The page's own script is
    // admitted by its digest, and nothing else inline is.
    const scriptSources = detailed['Content-Security-Policy'].split(';').map(part => part.trim())
      .find(part => part.startsWith('script-src '))!.split(/\s+/).slice(1);
    expect(scriptSources).not.toContain("'unsafe-inline'");
    expect(scriptSources).not.toContain("'unsafe-hashes'");
    const inline = [...detailed.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    expect(inline).toHaveLength(1);
    // The HTML parser turns CR and CRLF into LF before the browser hashes a
    // script, so a CR would make this digest disagree with Chromium's.
    expect(inline[0]).not.toMatch(/\r/);
    expect(scriptSources).toContain(`'sha256-${createHash('sha256').update(inline[0], 'utf8').digest('base64')}'`);
    expect(scriptSources).toContain(DETAILED_VIEW_SCRIPT_HASH);
    expect(detailed.body).toContain(`<script src="${DETAILED_VIEW_ROUTES.script}"></script>`);
    expect(detailed.body.replace(/<script>[\s\S]*?<\/script>/g, '')).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
    for (const route of ['/', '/xr-check', DETAILED_VIEW_ROUTES.script, DETAILED_VIEW_ROUTES.style]) {
      const headers = await get(route);
      expect(headers['Content-Security-Policy']).toContain("connect-src 'self';");
      expect(headers['Content-Security-Policy']).not.toContain("'unsafe-eval'");
    }
  } finally {
    await companion?.close(); create.mockRestore(); await rm(directory, {recursive: true, force: true});
  }
});
