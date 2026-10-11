import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InspectionCompanionHttp } from '../src/inspection-companion-http.js';
import { SourceRetargetQueue } from '../src/source-retarget-queue.js';
import { PAGE_SOURCE_REFUSAL } from '../src/inspection-page-source.js';
import { syntheticMap } from './synthetic-map.js';

const hash = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const key = 'stereo_structure/inspection';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function setup({ text = 'data_example\n_atom_site.id 1\n', now = { value: 0 }, handoff, extraMeta, density, requestCeilingMs, delayed }: {
  text?: string; now?: { value: number }; handoff?: unknown; extraMeta?: Record<string, unknown>;
  density?: (sessionId: string, sourceToken: string) => Promise<{ bytes: Buffer; sha256: string; contour: number } | undefined>;
  requestCeilingMs?: (tool: string) => number; delayed?: boolean;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'stereofold-companion-'));
  const htmlPath = join(directory, 'inspector.html');
  await writeFile(htmlPath, '<!doctype html><html><head></head><body><script src="inspection.js"></script></body></html>');
  let sourceError = false;
  const source = vi.fn(async (sessionId: string, sourceToken: string) => {
    if (sourceError || sessionId !== 'session-a' || sourceToken !== 'source-a') throw Error('stale source capability');
    return { text, sha256: hash(text) };
  });
  const dispatch = vi.fn(async (_sessionId: string, _sourceToken: string, name: string, args: Record<string, unknown>) => {
    if (delayed) await new Promise(done => setTimeout(done, Number(args.delayMs ?? 0)));
    return {
    content: [{ type: 'text', text: `${name} complete` }], structuredContent: { name, args },
    _meta: { [key]: { structureText: text, catalog: { source: { sha256: hash(text) } }, source: { internal: true },
      ...(handoff === undefined ? {} : { nativeStructureViewerHandoff: handoff }), ...(extraMeta ?? {}) } },
    };
  });
  const companion = new InspectionCompanionHttp({ htmlPath, dispatch, source, now: () => now.value,
    ...(density ? { density } : {}), ...(requestCeilingMs ? { requestCeilingMs } : {}) });
  const cleanup = async () => { await companion.close(); await rm(directory, { recursive: true, force: true }); };
  return { companion, dispatch, source, now, setSourceError: (value: boolean) => { sourceError = value; }, cleanup };
}

const tokenOf = (url: string) => new URL(url).hash.slice(1);
const originOf = (url: string) => new URL(url).origin;
async function api(url: string, path: '/tool' | '/source' | '/density', options: RequestInit = {}) {
  const token = tokenOf(url), origin = originOf(url);
  return fetch(`${origin}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) } });
}

describe('inspection companion loopback transport', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  it.each(['undo_last_change','redo_last_change'])('dispatches authenticated %s against the paired session',async name=>{
    const t=await setup();cleanups.push(t.cleanup);
    const link=await t.companion.open('session-a','source-a');
    const origin=originOf(link.url),headers={Origin:origin,'Content-Type':'application/json'};
    const args={panelId:'panel-1',commandId:'history-1',serverEpoch:'epoch-1',sourceToken:'source-a',
      baseStateRevision:1,baseInspectionRevision:2};
    const body=JSON.stringify({name,args});
    expect((await fetch(`${origin}/tool`,{method:'POST',headers,body})).status).toBe(401);
    expect(t.dispatch).not.toHaveBeenCalled();
    const allowed=await api(link.url,'/tool',{method:'POST',headers,body});
    expect(allowed.status).toBe(200);
    expect(t.dispatch).toHaveBeenCalledWith('session-a','source-a',name,{...args,sessionId:'session-a'});
    const other=await api(link.url,'/tool',{method:'POST',headers,body:JSON.stringify({name,args:{...args,sessionId:'other-session'}})});
    expect(other.status).toBe(400);
    expect(t.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rechecks an older pair after a newer handoff changes loopback but fails at LAN',async()=>{
    const t=await setup();cleanups.push(t.cleanup);
    await t.companion.open('session-a','source-a');
    const queue=new SourceRetargetQueue(),owner={};
    await queue.run(owner,'source-a','source-b',async()=>{await t.companion.retarget('session-a','source-a','source-b');});
    let release!:()=>void;
    const hold=new Promise<void>(resolve=>{release=resolve;});
    const newer=queue.run(owner,'source-b','source-c',async()=>{
      await t.companion.retarget('session-a','source-b','source-c');
      await hold;
      throw Error('LAN handoff failed');
    });
    const failed=expect(newer).rejects.toThrow('LAN handoff failed');
    const recheck=vi.fn(async()=>{await t.companion.retarget('session-a','source-a','source-b');});
    const older=queue.run(owner,'source-a','source-b',recheck);
    const refused=expect(older).rejects.toThrow('The companion link is no longer current.');
    release();await Promise.all([failed,refused]);
    expect(recheck).toHaveBeenCalledOnce();
    const retry=vi.fn(async()=>{await t.companion.retarget('session-a','source-b','source-c');});
    await queue.run(owner,'source-b','source-c',retry);
    await queue.run(owner,'source-b','source-c',retry);
    expect(retry).toHaveBeenCalledOnce();
  });

  it('keeps one authenticated bearer across overlapping reads and two source retargets',async()=>{
    const text='data_next\n_atom_site.id 2\n',t=await setup({text});cleanups.push(t.cleanup);
    const link=await t.companion.open('session-a','source-a');
    const headers={Origin:originOf(link.url),'Content-Type':'application/json'};
    let current='source-a';
    t.source.mockImplementation(async(session,source)=>{expect(session).toBe('session-a');expect(source).toBe(current);return{text,sha256:hash(text)};});
    for(const next of ['source-b','source-c']) {
      const previous=current;current=next;
      let arrived=0,release:()=>void=()=>{};
      const bothReads=new Promise<void>(resolve=>{release=resolve;});
      t.dispatch.mockImplementation(async(session,source,name,args)=>{
        if(name==='get_inspection_bytes') {
          expect(source).toBe(current);
          const offset=Number(args.offset),bytes=Buffer.from(text).subarray(offset,offset+5);
          return {structuredContent:{sourceToken:current,offset,base64:bytes.toString('base64'),sha256:hash(text)}} as any;
        }
        expect(source).toBe(previous);
        if(++arrived===2)release();
        await bothReads;
        // Actual LAN dispatcher retargets after its awaited host read. Both
        // in-flight requests have authenticated the same prior source here.
        const retained=await t.companion.retarget(session,source,current);
        expect(retained.url).toBe(link.url);
        return {structuredContent:{sourceToken:current},_meta:{[key]:{structureText:text,catalog:{source:{sha256:hash(text)}}}}} as any;
      });
      const responses=await Promise.all(['poll_inspection','get_inspection'].map(name=>api(link.url,'/tool',{
        method:'POST',headers,body:JSON.stringify({name,args:{}})})));
      expect(responses.map(response=>response.status)).toEqual([200,200]);
      for(const response of responses)expect((await response.json()).structuredContent.sourceToken).toBe(current);
      const chunks:Buffer[]=[];
      for(let offset=0;offset<Buffer.byteLength(text);offset+=5) {
        const response=await api(link.url,'/tool',{method:'POST',headers,
          body:JSON.stringify({name:'get_inspection_bytes',args:{offset}})});
        expect(response.status).toBe(200);
        chunks.push(Buffer.from((await response.json()).structuredContent.base64,'base64'));
      }
      expect(Buffer.concat(chunks).toString()).toBe(text);
      expect(await (await api(link.url,'/source')).text()).toBe(text);
      await expect(t.companion.retarget('session-a','unrelated',current)).rejects.toThrow('no longer current');
    }
    await expect(t.companion.retarget('session-a','source-a','source-b')).rejects.toThrow('no longer current');
    expect((await api(link.url,'/source')).status).toBe(200);
  });

  it('remembers an authorized HTTP read handoff for a repeated LAN retarget',async()=>{
    const t=await setup();cleanups.push(t.cleanup);
    const link=await t.companion.open('session-a','source-a');
    t.dispatch.mockResolvedValue({structuredContent:{sourceToken:'source-b'}} as any);
    const response=await api(link.url,'/tool',{method:'POST',
      headers:{Origin:originOf(link.url),'Content-Type':'application/json'},
      body:JSON.stringify({name:'poll_inspection',args:{}})});
    expect(response.status).toBe(200);
    expect((await t.companion.retarget('session-a','source-a','source-b')).url).toBe(link.url);
    await expect(t.companion.retarget('session-a','other','source-b')).rejects.toThrow('no longer current');
  });

  it('does not let a delayed old read rewind a newer authorized handoff',async()=>{
    const t=await setup();cleanups.push(t.cleanup);
    const link=await t.companion.open('session-a','source-a');
    let entered:()=>void=()=>{},release:()=>void=()=>{};
    const began=new Promise<void>(resolve=>{entered=resolve;});
    const held=new Promise<void>(resolve=>{release=resolve;});
    t.dispatch.mockImplementation(async()=>{entered();await held;return{structuredContent:{sourceToken:'source-b'}} as any;});
    const reading=api(link.url,'/tool',{method:'POST',
      headers:{Origin:originOf(link.url),'Content-Type':'application/json'},
      body:JSON.stringify({name:'poll_inspection',args:{}})});
    await began;
    await t.companion.retarget('session-a','source-a','source-b');
    await t.companion.retarget('session-a','source-b','source-c');
    release();
    expect((await reading).status).toBe(409);
    t.source.mockImplementation(async(_session,source)=>{expect(source).toBe('source-c');return{text:'current',sha256:hash('current')};});
    expect(await (await api(link.url,'/source')).text()).toBe('current');
  });

  it('keeps a rendered reply clip behind the same bearer as the rest of the heartbeat', async () => {
    // The reply audio rides the caption in the heartbeat's private meta rather
    // than on a route of its own, so it inherits this bearer and this
    // same-origin check instead of needing a second one.
    const audio = { base64: Buffer.from('OggS spoken reply').toString('base64'), mimeType: 'audio/ogg; codecs=opus', format: 'ogg-opus', bytes: 17 };
    const headsetCaption = { id: 'caption-1', seq: 1, text: 'Thirteen protofilaments.', speak: true, holdSeconds: 6, audio };
    const t = await setup({ extraMeta: { headsetCaption } }); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const origin = originOf(link.url);
    const headers = { Origin: origin, 'Content-Type': 'application/json' };
    const body = JSON.stringify({ name: 'poll_inspection', args: { panelId: 'panel-1' } });

    expect((await fetch(`${origin}/tool`, { method: 'POST', headers, body })).status).toBe(401);
    expect((await fetch(`${origin}/tool`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${'0'.repeat(64)}` }, body })).status).toBe(401);
    expect(t.dispatch).not.toHaveBeenCalled();

    const allowed = await api(link.url, '/tool', { method: 'POST', headers, body });
    expect(allowed.status).toBe(200);
    expect((await allowed.json())._meta[key].headsetCaption).toEqual(headsetCaption);
  });

  it('reads one slice of a comparison without re-digesting the primary source', async () => {
    const t = await setup(); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const origin = originOf(link.url), headers = { Origin: origin, 'Content-Type': 'application/json' };
    const args = { part: 'source', offset: 0, byteCount: 16, comparison: { sourceSha256: 'e'.repeat(64), assemblyId: 'asymmetric_unit' } };
    const reply = await api(link.url, '/tool', { method: 'POST', headers, body: JSON.stringify({ name: 'get_inspection_bytes', args }) });
    expect(reply.status).toBe(200);
    expect(t.dispatch).toHaveBeenCalledWith('session-a', 'source-a', 'get_inspection_bytes', { ...args, sessionId: 'session-a' });
    // The primary source is digested for hydration and for the other tools, not once per slice.
    expect(t.source).not.toHaveBeenCalled();
    await api(link.url, '/tool', { method: 'POST', headers, body: JSON.stringify({ name: 'push_to_talk', args: {} }) });
    expect(t.source).toHaveBeenCalledTimes(1);
    // The session is the link's own: a slice cannot be read for another.
    const foreign = await api(link.url, '/tool', { method: 'POST', headers,
      body: JSON.stringify({ name: 'get_inspection_bytes', args: { ...args, sessionId: 'other-session' } }) });
    expect(foreign.status).toBe(400);
  });

  it('lets a journey outlive the default ceiling, cuts any other slow call at it, and bounds both', async () => {
    const t = await setup({ delayed: true, requestCeilingMs: tool => tool === 'navigate_experience' ? 1_500 : 400 });
    cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const origin = originOf(link.url), token = tokenOf(link.url);
    // One keep-alive connection, so a ceiling left on the socket would show up on the next request.
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(async () => agent.destroy());
    const call = (name: string, args: Record<string, unknown>) => new Promise<{ status: number } | { cut: true }>(resolve => {
      const request = httpRequest(`${origin}/tool`, { method: 'POST', agent, headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
        response => { response.resume(); response.once('end', () => resolve({ status: response.statusCode ?? 0 })); response.once('error', () => resolve({ cut: true })); });
      request.once('error', () => resolve({ cut: true }));
      request.end(JSON.stringify({ name, args }));
    });
    const timed = async (name: string, delayMs: number) => { const started = Date.now(); const result = await call(name, { delayMs }); return { result, ms: Date.now() - started }; };

    expect((await timed('poll_inspection', 50)).result).toEqual({ status: 200 });
    expect((await timed('navigate_experience', 900)).result).toEqual({ status: 200 });
    const ordinary = await timed('poll_inspection', 900);
    expect(ordinary.result).toEqual({ cut: true });
    expect(ordinary.ms).toBeLessThan(900);
    const hung = await timed('navigate_experience', 8_000);
    expect(hung.result).toEqual({ cut: true });
    expect(hung.ms).toBeGreaterThanOrEqual(1_300);
    expect(hung.ms).toBeLessThan(4_000);
  }, 30_000);

  it('holds a page to a PDB ID or an AlphaFold accession when it replaces the source', async () => {
    // A paired headset reaches this route through the LAN listener or the
    // Quest link, and a local path named here used to be read off this Mac.
    const t = await setup(); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const headers = { Origin: originOf(link.url), 'Content-Type': 'application/json' };
    const replace = (args: Record<string, unknown>) => api(link.url, '/tool', { method: 'POST', headers,
      body: JSON.stringify({ name: 'replace_inspection_source', args: { panelId: 'panel-1', ...args } }) });
    for (const source of [{ kind: 'file', path: '/home/example/private.cif' }, { kind: 'url', url: 'https://example.test/model.cif' },
      { kind: 'pasted', text: 'data_x\n_atom_site.id 1\n' }, { kind: 'FILE', path: '/etc/hosts' }, null, 'pdb']) {
      for (const mode of ['replace', 'compare']) {
        const refused = await replace({ mode, source });
        expect(refused.status, JSON.stringify(source)).toBe(403);
        expect(await refused.json()).toEqual({ error: 'source_not_allowed', message: PAGE_SOURCE_REFUSAL });
      }
    }
    expect(t.dispatch).not.toHaveBeenCalled();
    for (const args of [{ pdbId: '4HHB' }, { source: { kind: 'pdb', id: '4HHB' } }, { source: { kind: 'alphafold', accession: 'P69905' } },
      { mode: 'compare', source: { kind: 'pdb', id: '2HHB' } }]) {
      expect((await replace(args)).status, JSON.stringify(args)).toBe(200);
    }
    expect(t.dispatch.mock.calls.map(call => call[3].source ?? { pdbId: call[3].pdbId })).toEqual([
      { pdbId: '4HHB' }, { kind: 'pdb', id: '4HHB' }, { kind: 'alphafold', accession: 'P69905' }, { kind: 'pdb', id: '2HHB' }]);
  });

  it('lazily serves only the injected inspector and reuses a source-scoped link', async () => {
    const t = await setup(); cleanups.push(t.cleanup);
    const first = await t.companion.open('session-a', 'source-a');
    const repeated = await t.companion.open('session-a', 'source-a');
    expect(first).toEqual(repeated);
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#(?:[a-f0-9]{64})$/);
    const page = await fetch(`${originOf(first.url)}/`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('window.__STEREOFOLD_COMPANION__=true');
    expect(html.indexOf('__STEREOFOLD_COMPANION__')).toBeLessThan(html.indexOf('<script src'));
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect((await fetch(`${originOf(first.url)}/anything`)).status).toBe(404);
  });

  it('serves a self-contained same-origin XR admission probe without bearer data', async () => {
    const t = await setup(); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const response = await fetch(`${originOf(link.url)}/xr-check`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('Request VR (no options)');
    expect(html).toContain('Request microphone');
    expect(html).toContain("requestSession('immersive-vr')");
    expect(html).toContain("getUserMedia({audio:true})");
    expect(html).toContain('blockedUntilReload');
    expect(html).not.toContain('location.href');
    expect(html).not.toContain(link.url.slice(link.url.indexOf('#')));
    expect((await fetch(`${originOf(link.url)}/xr-check?token=leak`)).status).toBe(404);
  });

  it('closes an accepted native session when local-space admission fails', async () => {
    const t = await setup(); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const html = await (await fetch(`${originOf(link.url)}/xr-check`)).text();
    const session = { end: vi.fn(async () => {}), requestReferenceSpace: vi.fn(async () => { throw Error('tracking denied'); }) };
    const elements = new Map<string, any>();
    const makeButton = () => { const item: any = { disabled: false, addEventListener(type: string, callback: () => unknown) { if (type === 'click') item.click = callback; } }; return item; };
    const button: any = makeButton();
    const support: any = makeButton(), mic: any = makeButton(), out: any = { textContent: '' };
    elements.set('#support', support); elements.set('#vr', button); elements.set('#mic', mic); elements.set('#out', out);
    const document = { querySelector: (selector: string) => elements.get(selector), querySelectorAll: () => [support, button, mic], permissionsPolicy: undefined, featurePolicy: undefined };
    const window: any = {}; window.top = window;
    const context: any = { document, window, location: { origin: originOf(link.url) }, isSecureContext: true,
      navigator: { xr: { requestSession: vi.fn(() => Promise.resolve(session)), isSessionSupported: vi.fn(async () => true) } },
      setTimeout, clearTimeout, Promise, Error, Object, JSON, String, Boolean, console };
    const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    runInNewContext(script!, context);
    await button.click();
    const result = JSON.parse(out.textContent);
    expect(session.requestReferenceSpace).toHaveBeenCalledWith('local');
    expect(session.end).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ sessionAccepted: true, phase: 'reference-space', blockedUntilReload: false });
    expect(result.error).toMatchObject({ name: 'Error', message: 'tracking denied' });
  });

  it('authenticates a link, scopes tool calls, strips coordinates, and returns raw source bytes', async () => {
    const text = `data_large\n${'ATOM 1\n'.repeat(12_000)}`;
    const t = await setup({ text }); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const origin = originOf(link.url);
    expect((await fetch(`${origin}/source`)).status).toBe(401);
    const source = await api(link.url, '/source');
    expect(source.status).toBe(200);
    expect(source.headers.get('content-type')).toContain('chemical/x-mmcif');
    expect(source.headers.get('x-stereofold-source-sha256')).toBe(hash(text));
    expect(source.headers.get('digest')).toMatch(/^sha-256=/);
    expect(await source.text()).toBe(text);

    const result = await api(link.url, '/tool', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'get_inspection', args: {} }) });
    expect(result.status).toBe(200);
    const body = await result.json() as any;
    expect(t.dispatch).toHaveBeenCalledWith('session-a', 'source-a', 'get_inspection', { sessionId: 'session-a' });
    expect(JSON.stringify(body)).not.toContain(text);
    expect(body._meta[key].source).toEqual({ url: '/source', sha256: hash(text), bytes: Buffer.byteLength(text) });
    expect(body._meta[key].structureText).toBeUndefined();
  });

  it('never delivers a desktop local-file handoff path to a companion', async () => {
    const localPath = '/home/example/private/structure.cif';
    const t = await setup({ handoff: { kind: 'local-file', filePath: localPath, sourceSha256: hash('source') } }); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const result = await api(link.url, '/tool', { method: 'POST', headers: { Origin: originOf(link.url), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'get_inspection', args: {} }) });
    const body = await result.json() as any;
    expect(JSON.stringify(body)).not.toContain(localPath);
    expect(body._meta[key].nativeStructureViewerHandoff).toBeUndefined();
  });

  it('rejects cross-origin, unapproved, oversized, and cross-session API input', async () => {
    const t = await setup(); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const origin = originOf(link.url);
    const post = (body: unknown, headers: Record<string, string> = {}) => api(link.url, '/tool', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const unknown = await post({ name: 'not_allowed', args: {} });
    expect([unknown.status, await unknown.json()]).toEqual([400, { error: 'invalid_request' }]);
    const malformed = await post({ name: 'sync_inspection', args: { sessionId: 7 } });
    expect([malformed.status, await malformed.json()]).toEqual([400, { error: 'invalid_request' }]);
    // A page left on an earlier session must be able to tell this from a malformed request.
    const changed = await post({ name: 'sync_inspection', args: { sessionId: 'other-session' } });
    expect([changed.status, await changed.json()])
      .toEqual([400, { error: 'session_changed', message: 'This link shares a different session.' }]);
    expect((await api(link.url, '/tool', { method: 'POST', headers: { Origin: 'http://evil.invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'get_inspection', args: {} }) })).status).toBe(403);
    expect((await post({ name: 'get_inspection', args: {} }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await api(link.url, '/tool', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(400);
    const oversized = 'x'.repeat(2 * 1024 * 1024 + 16 * 1024 + 1);
    expect((await post({ name: 'get_inspection', args: { oversized } })).status).toBe(413);
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('rejects stale source callbacks and does not dispatch against a replaced source', async () => {
    const t = await setup(); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    t.setSourceError(true);
    const origin = originOf(link.url);
    const result = await api(link.url, '/tool', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'attach_inspection', args: {} }) });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: 'request_failed', message: 'stale source capability' });
    expect(t.dispatch).not.toHaveBeenCalled();
    expect((await api(link.url, '/source')).status).toBe(409);
  });

  it('puts the busy-panel sentence on a grow_structure 409 so the page can retry', async () => {
    const t = await setup(); cleanups.push(t.cleanup);
    t.dispatch.mockRejectedValueOnce(Error('The requested panel is unavailable, dirty, stale, or rendering another command.'));
    const link = await t.companion.open('session-a', 'source-a');
    const origin = originOf(link.url);
    const result = await api(link.url, '/tool', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'grow_structure', args: {} }) });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({
      error: 'request_failed',
      message: 'The requested panel is unavailable, dirty, stale, or rendering another command.',
    });
  });

  it('caps raw connections so silent sockets cannot outlast the request limit', async () => {
    const t = await setup(); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const port = Number(new URL(link.url).port);
    // Each socket sends no bytes, so none is ever counted against the
    // per-request cap; only the connection cap can bound them.
    const sockets: Socket[] = [];
    const survivors = await Promise.all(Array.from({ length: 48 }, () => new Promise<boolean>(resolve => {
      const socket = connect(port, '127.0.0.1'); sockets.push(socket);
      socket.once('error', () => resolve(false));
      socket.once('close', () => resolve(false));
      setTimeout(() => resolve(true), 1_200);
    })));
    for (const socket of sockets) socket.destroy();
    const open = survivors.filter(Boolean).length;
    expect(open).toBeLessThanOrEqual(32);
    expect(open).toBeGreaterThan(0);
  });

  it('expires idle links, caps active links, and invalidates them on close', async () => {
    const t = await setup(); cleanups.push(t.cleanup);
    const first = await t.companion.open('session-a', 'source-a');
    t.now.value = 30 * 60 * 1000 + 1;
    expect((await api(first.url, '/source')).status).toBe(401);
    const renewed = await t.companion.open('session-a', 'source-a');
    expect(renewed.url).not.toBe(first.url);
    for (let index = 0; index < 7; index += 1) await t.companion.open(`session-${index}`, `source-${index}`);
    await expect(t.companion.open('overflow', 'overflow')).rejects.toThrow('link limit');
    await t.companion.close();
    await expect(fetch(`${originOf(renewed.url)}/`)).rejects.toThrow();
  });

  it('revokes stale same-session source links before allocating a replacement capability', async () => {
    const t = await setup(); cleanups.push(t.cleanup);
    const first = await t.companion.open('session-a', 'source-a');
    let current = first;
    // Nine replacements would exceed the global limit without revoking stale
    // tokens, even though every old link belongs to an obsolete source.
    for (let revision = 1; revision <= 9; revision += 1) {
      current = await t.companion.open('session-a', `source-${revision}`);
    }
    expect(current.url).not.toBe(first.url);
    expect((await api(first.url, '/source')).status).toBe(401);
    // The reclaimed pool still enforces the eight-link bound across sessions.
    for (let index = 0; index < 7; index += 1) await t.companion.open(`other-${index}`, `source-${index}`);
    await expect(t.companion.open('overflow', 'overflow')).rejects.toThrow('link limit');
  });
});

describe('the density map route, end to end over a real socket', () => {
  // Exercises `/density` against an actual HTTP server on the loopback, with
  // an actual fetch, and compares the bytes against the ones the hook handed
  // over.
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

  const map = syntheticMap();
  const contour = 3.3;
  const serving = () => vi.fn(async (sessionId: string, sourceToken: string) => {
    if (sessionId !== 'session-a' || sourceToken !== 'source-a') throw Error('stale source capability');
    return { bytes: map, sha256: digest(map), contour };
  });

  it('serves the exact bytes, their digest and the contour they were meshed at', async () => {
    const t = await setup({ density: serving() }); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const response = await api(link.url, '/density');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    const body = Buffer.from(await response.arrayBuffer());
    // Byte-identical, not merely the same length: this route is the only one in
    // the product that carries binary, and a text-mode slip would be invisible
    // to a length check.
    expect(body.equals(map)).toBe(true);
    expect(digest(body)).toBe(digest(map));
    expect(response.headers.get('x-stereofold-density-sha256')).toBe(digest(map));
    expect(response.headers.get('digest')).toBe(`sha-256=${createHash('sha256').update(map).digest('base64')}`);
    // The contour rides the response that carries the bytes, so a mesh cannot
    // be built at a level nobody served.
    expect(response.headers.get('x-stereofold-density-contour')).toBe('3.3');
  });

  it('refuses a wrong bearer with no body at all, exactly as /source does', async () => {
    const density = serving();
    const t = await setup({ density }); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const origin = originOf(link.url);

    const wrong: Record<string, string>[] = [{}, { Authorization: `Bearer ${'0'.repeat(64)}` }, { Authorization: 'Bearer not-a-token' }];
    for (const headers of wrong) {
      const refused = await fetch(`${origin}/density`, { headers });
      expect(refused.status).toBe(401);
      expect(Buffer.from(await refused.arrayBuffer()).includes(Buffer.from('MAP '))).toBe(false);
    }
    // And the hook was never asked, so an unauthorized caller cannot even make
    // the host read a map off disk.
    expect(density).not.toHaveBeenCalled();
  });

  it('sends nothing when the hook own digest disagrees with its bytes', async () => {
    // `#freshDensity` re-digests on every send. A hook that hands over a stale
    // or wrong sha is the case where the page would otherwise mesh bytes that
    // nobody verified.
    const t = await setup({ density: async () => ({ bytes: map, sha256: 'f'.repeat(64), contour }) });
    cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const refused = await api(link.url, '/density');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'density_unavailable' });
    expect(refused.headers.get('x-stereofold-density-sha256')).toBeNull();
  });

  it('refuses a malformed descriptor rather than serving it', async () => {
    for (const bad of [undefined, { bytes: Buffer.alloc(0), sha256: digest(Buffer.alloc(0)), contour },
      { bytes: map, sha256: 'not a digest', contour }, { bytes: map, sha256: digest(map), contour: Number.NaN }]) {
      const t = await setup({ density: async () => bad as never }); cleanups.push(t.cleanup);
      const link = await t.companion.open('session-a', 'source-a');
      expect((await api(link.url, '/density')).status).toBe(409);
    }
  });

  it('is a GET and only a GET', async () => {
    const t = await setup({ density: serving() }); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const refused = await api(link.url, '/density', { method });
      expect(refused.status, method).toBe(405);
      expect(await refused.json()).toMatchObject({ error: 'method_not_allowed' });
    }
  });

  it('does not exist at all on a host that was built without the hook', async () => {
    // Every atomic session the product has ever served is this one, and the
    // route has to be absent rather than empty for it.
    const t = await setup(); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const absent = await api(link.url, '/density');
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({ error: 'not_found' });
    // Still inside the bearer check, though: an unauthorized caller cannot use
    // a 404 to learn whether this host holds a map.
    expect((await fetch(`${originOf(link.url)}/density`)).status).toBe(401);
  });

  it('tells the page about the map in the hydration', async () => {
    const t = await setup({ density: serving() }); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const headers = { Origin: originOf(link.url), 'Content-Type': 'application/json' };
    const hydration = await api(link.url, '/tool', { method: 'POST', headers,
      body: JSON.stringify({ name: 'get_inspection', args: { panelId: 'panel-1' } }) });

    expect(hydration.status).toBe(200);
    const meta = (await hydration.json())._meta[key];
    // The descriptor is how the page knows to ask, and what to check when the
    // bytes arrive. Its byte count and digest are the served ones.
    expect(meta.density).toEqual({ url: '/density', sha256: digest(map), bytes: map.byteLength, contour });
    expect(meta.structureText).toBeUndefined();
  });

  it('leaves an atomic session with no density field for the page to act on', async () => {
    const t = await setup(); cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const headers = { Origin: originOf(link.url), 'Content-Type': 'application/json' };
    const hydration = await api(link.url, '/tool', { method: 'POST', headers,
      body: JSON.stringify({ name: 'get_inspection', args: { panelId: 'panel-1' } }) });

    const meta = (await hydration.json())._meta[key];
    expect('density' in meta).toBe(false);
    // The coordinates are still described, so the absence above is the map's
    // and not a hydration that lost its descriptors altogether.
    expect(meta.source).toMatchObject({ url: '/source', sha256: hash('data_example\n_atom_site.id 1\n') });
  });

  it('drops the descriptor again when a session stops holding a map', async () => {
    // Shrinking back out of a density tier has to REMOVE the field, not leave
    // the last tier descriptor behind for the page to re-fetch.
    let holding = true;
    const t = await setup({ density: async () => (holding ? { bytes: map, sha256: digest(map), contour } : undefined) });
    cleanups.push(t.cleanup);
    const link = await t.companion.open('session-a', 'source-a');
    const headers = { Origin: originOf(link.url), 'Content-Type': 'application/json' };
    const hydrate = async () => (await (await api(link.url, '/tool', { method: 'POST', headers,
      body: JSON.stringify({ name: 'get_inspection', args: { panelId: 'panel-1' } }) })).json())._meta[key];

    expect((await hydrate()).density).toBeDefined();
    holding = false;
    expect('density' in await hydrate()).toBe(false);
    // And the route itself now refuses, rather than serving the old bytes.
    expect((await api(link.url, '/density')).status).toBe(409);
  });
});
