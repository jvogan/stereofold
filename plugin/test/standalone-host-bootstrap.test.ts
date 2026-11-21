import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { transpileModule, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { hasLocalControlToken } from '../scripts/local-host-security.js';
import { pageKeySource, reloadOnPageKeySource } from '../src/inspection-page-key.js';
import { DESKTOP_PAGE_CSP } from '../src/inspector-panel-host.js';
import { runDesktopBoot } from './fixtures/desktop-boot.js';

/**
 * The standalone host is a script with top-level effects, so these tests run
 * its actual request handler and its actual page bootstrap, sliced out of the
 * source, against stand-ins for the MCP child and the browser.
 */
const source = readFileSync(new URL('../scripts/serve-inspection.ts', import.meta.url), 'utf8');

const PORT = 41234;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ADMIN = 'a'.repeat(64);
const BROWSER = 'b'.repeat(64);

function slice(from: string, to: string): string {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  if (start < 0 || end < start) throw Error(`The standalone host no longer contains ${from}`);
  return source.slice(start, end);
}

/** The page bootstrap exactly as the host serves it: its template, evaluated. */
function bootScript(): string {
  const template = slice('bootstrap=`', '`;\n  server=createServer').slice('bootstrap='.length);
  return vm.runInNewContext(`${template}\``, { pageKeySource, reloadOnPageKeySource }) as string;
}

function handler(ensureBootstrapSession: () => Promise<void>, overrides: Record<string, unknown> = {}) {
  const code = transpileModule(slice('server=createServer(async(req,res)=>{', '\n  server.requestTimeout'),
    { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  const context: Record<string, unknown> = {
    server: undefined, createServer: (handle: unknown) => handle, port: PORT, localOrigin: () => ORIGIN,
    hasLocalControlToken, token: ADMIN, browserToken: BROWSER, ensureBootstrapSession,
    html: '<p>inspector</p>', opened: { structuredContent: { sessionId: 'session-1', sourceToken: 'source-1' } },
    page: '<!doctype html>', hostJs: '', bootstrap: '', permitted: new Set(), panelOnly: new Set(),
    raw: async () => ({}), sessionId: 'session-1', SESSIONLESS_TOOLS: new Set(), standaloneAgentResponse: (_: string, r: unknown) => r,
    Buffer, DESKTOP_PAGE_CSP, panelCall: async () => ({}), ...overrides,
  };
  // The panel's refusal shape is the host's own line, not a copy of it.
  const refusal = transpileModule(slice('const panelRefusal=', '\n'), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  return vm.runInNewContext(`${refusal}\n${code}\nserver;`, context) as (req: unknown, res: unknown) => Promise<void>;
}

async function get(handle: (req: unknown, res: unknown) => Promise<void>, path: string, headers: Record<string, string> = {}) {
  const response = { status: 0, body: '', writableEnded: false, destroyed: false, headersSent: false,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; },
    writeHead(status: number) { this.status = status; this.headersSent = true; },
    end(body: string) { this.body = body; this.writableEnded = true; } };
  await handle({ method: 'GET', url: path, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, response);
  return response;
}

async function post(handle: (req: unknown, res: unknown) => Promise<void>, path: string, key: string, body: unknown) {
  const response = { status: 0, body: '', writableEnded: false, destroyed: false, headersSent: false,
    writeHead(status: number) { this.status = status; this.headersSent = true; },
    end(text: string) { this.body = text; this.writableEnded = true; } };
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: path,
    headers: { host: `127.0.0.1:${PORT}`, origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${key}` } });
  await handle(request, response);
  return { status: response.status, body: JSON.parse(response.body || '{}') };
}

/**
 * The desktop panel recovers from a refusal by reading it. The standalone
 * host used to answer every refusal with a bare 409 that the page turned into
 * "Local host request failed", so the panel could not tell a stale
 * registration it knows how to refresh from a host that had gone, and kept
 * its Retry banner for the rest of the session.
 */
describe('standalone host panel route', () => {
  const refused = { content: [{ type: 'text', text: 'The panel must save or load the current inspection before attaching.' }], isError: true };
  it('hands the panel the tool refusal itself', async () => {
    const panelCall = vi.fn(async () => refused);
    const handle = handler(async () => undefined, { permitted: new Set(['attach_inspection']), panelCall });
    const answer = await post(handle, '/rpc', BROWSER, { name: 'attach_inspection', arguments: { sessionId: 'session-1' } });
    expect(answer).toEqual({ status: 200, body: refused });
    expect(panelCall).toHaveBeenCalledWith('attach_inspection', { sessionId: 'session-1' });
  });

  it('answers its own refusals in the same shape', async () => {
    const panelCall = vi.fn(async () => ({}));
    const handle = handler(async () => undefined, { permitted: new Set(['attach_inspection']), panelCall });
    expect(await post(handle, '/rpc', BROWSER, { name: 'open', arguments: {} }))
      .toEqual({ status: 200, body: { content: [{ type: 'text', text: 'Tool unavailable' }], isError: true } });
    expect(await post(handle, '/rpc', BROWSER, { name: 'attach_inspection', arguments: { sessionId: 'session-2' } }))
      .toEqual({ status: 200, body: { content: [{ type: 'text', text: 'Wrong session' }], isError: true } });
    expect(panelCall).not.toHaveBeenCalled();
  });

  it('keeps a call that never reached the child a failed request', async () => {
    const handle = handler(async () => undefined, { permitted: new Set(['poll_inspection']),
      panelCall: async () => { throw Error('Stereofold MCP child disconnected: The MCP child process exited.'); } });
    const answer = await post(handle, '/rpc', BROWSER, { name: 'poll_inspection', arguments: {} });
    expect(answer.status).toBe(503);
  });

  it('leaves the agent route as it was', async () => {
    const handle = handler(async () => undefined, { permitted: new Set(['attach_inspection']),
      raw: async () => { throw Error('Tool refused.'); } });
    expect(await post(handle, '/agent', ADMIN, { name: 'attach_inspection', arguments: {} }))
      .toEqual({ status: 409, body: { error: 'Tool refused.' } });
  });
});

describe('standalone host bootstrap route', () => {
  it('answers no bootstrap and touches no session without a bearer', async () => {
    const ensure = vi.fn(async () => undefined);
    const handle = handler(ensure);
    const attempts: Array<Record<string, string>> = [{}, { authorization: `Bearer ${'c'.repeat(64)}` }, { authorization: 'Bearer ' }];
    for (const headers of attempts) {
      const response = await get(handle, '/bootstrap', headers);
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(response.body).not.toContain('session-1');
      expect(response.body).not.toContain('inspector');
    }
    expect(ensure).not.toHaveBeenCalled();
  });

  it('answers the page bearer and the agent bearer', async () => {
    const ensure = vi.fn(async () => undefined);
    const handle = handler(ensure);
    for (const key of [BROWSER, ADMIN]) {
      const response = await get(handle, '/bootstrap', { authorization: `Bearer ${key}` });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ html: '<p>inspector</p>', opened: { structuredContent: { sessionId: 'session-1' } } });
    }
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('still serves the public shell without a bearer', async () => {
    const handle = handler(async () => undefined);
    const shell = await get(handle, '/');
    expect(shell.status).toBe(200);
    expect(shell.headers['content-security-policy']).toBe(DESKTOP_PAGE_CSP);
    expect((await get(handle, '/alive')).status).toBe(204);
  });
});

describe('standalone host page bootstrap', () => {
  it('sends the page key with its bootstrap request', async () => {
    const script = bootScript();
    const calls: Array<{ url: string; init?: { headers?: Record<string, string> } }> = [];
    const mount = vi.fn(async () => undefined);
    const element = () => ({ textContent: '', disabled: false, addEventListener() { /* unused */ } });
    const elements: Record<string, ReturnType<typeof element>> = { '#host-status': element(), '#host-detailed': element() };
    vm.runInNewContext(script, {
      location: { hash: `#${BROWSER}` },
      history: { replaceState() { /* the page key moves to storage */ } },
      document: { querySelector: (selector: string) => elements[selector] },
      addEventListener() { /* no later navigation in this run */ },
      window: { __host: { mount }, open() { /* unused */ } },
      fetch: async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ html: '<p>inspector</p>', opened: {} }) };
      },
    });
    await vi.waitFor(() => expect(mount).toHaveBeenCalled());
    const bootstrap = calls.find(call => call.url === '/bootstrap');
    expect(bootstrap?.init?.headers?.Authorization).toBe(`Bearer ${BROWSER}`);
    expect(elements['#host-status'].textContent).toBe('');
  });

  it('asks for the whole address and sends nothing when the page key is missing', async () => {
    const script = bootScript();
    const fetch = vi.fn();
    const status = { textContent: '', disabled: false, addEventListener() { /* unused */ } };
    vm.runInNewContext(script, {
      location: { hash: '' },
      history: { replaceState() { /* unused */ } },
      document: { querySelector: () => status },
      addEventListener() { /* no later navigation in this run */ },
      window: { __host: { mount: vi.fn() }, open() { /* unused */ } },
      fetch,
    });
    await vi.waitFor(() => expect(status.textContent).toContain('including the part after #'));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('standalone host page key', () => {
  it('takes the key out of the address before its first request and keeps the query', async () => {
    const storage = new Map<string, string>();
    const run = await runDesktopBoot(bootScript(), { hash: `#${BROWSER}`, search: '?hostOpened=1', storage });
    expect(run.events[0]).toBe('replace /?hostOpened=1');
    expect(run.location.hash).toBe('');
    expect([...storage.values()]).toEqual([BROWSER]);
    expect(run.events).toContain(`fetch /bootstrap Bearer ${BROWSER}`);
    expect(run.mounted).toHaveBeenCalled();
    await run.call({ name: 'get_inspection_state', arguments: {} });
    expect(run.events.at(-1)).toBe(`fetch /rpc Bearer ${BROWSER}`);
  });

  it('finds the key again when the same tab reloads without a fragment', async () => {
    const storage = new Map<string, string>();
    await runDesktopBoot(bootScript(), { hash: `#${BROWSER}`, storage });
    const reloaded = await runDesktopBoot(bootScript(), { hash: '', storage });
    expect(reloaded.status.textContent).toBe('');
    expect(reloaded.events).toEqual([`fetch /bootstrap Bearer ${BROWSER}`]);
    expect(reloaded.mounted).toHaveBeenCalled();
  });

  it('keeps the fragment, and works, when the browser refuses session storage', async () => {
    const run = await runDesktopBoot(bootScript(), { hash: `#${BROWSER}`, storage: 'blocked' });
    expect(run.location.hash).toBe(`#${BROWSER}`);
    expect(run.events).toEqual([`fetch /bootstrap Bearer ${BROWSER}`]);
    expect(run.mounted).toHaveBeenCalled();
  });
});
