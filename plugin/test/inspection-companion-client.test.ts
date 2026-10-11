import {afterEach,expect,it,vi} from 'vitest';
import {createCompanionClient,forgetCompanionPageKey} from '../src/inspection-companion-client.js';

afterEach(()=>{vi.unstubAllGlobals();forgetCompanionPageKey();});
it('classifies a restored viewer tab without a key for explicit re-pairing',()=>{
  forgetCompanionPageKey();
  vi.stubGlobal('location',{hash:''});
  vi.stubGlobal('sessionStorage',{getItem:()=>null});
  expect(()=>createCompanionClient()).toThrow(expect.objectContaining({code:'companion_key_missing'}));
});
function client(fetchMock:ReturnType<typeof vi.fn>) {
  vi.stubGlobal('location',{hash:'#'+'a'.repeat(64)});
  vi.stubGlobal('fetch',fetchMock);
  return createCompanionClient();
}
it('surfaces the host sentence on a 409 so a busy panel is distinguishable from a generic failure',async()=>{
  const fetchMock=vi.fn(async()=>Response.json(
    {error:'request_failed',message:'The requested panel is unavailable, dirty, stale, or rendering another command.'},
    {status:409}));
  const call=client(fetchMock);
  await expect(call('grow_structure',{})).rejects.toMatchObject({
    status:409,
    message:'The requested panel is unavailable, dirty, stale, or rendering another command.',
  });
});
it('classifies dropped connections and server outages without replaying an uncertain write',async()=>{
  for(const result of [()=>Promise.reject(new TypeError('Failed to fetch')),()=>Promise.resolve(new Response('',{status:503})),()=>Promise.resolve(new Response('',{status:429}))]) {
    const fetchMock=vi.fn(result),call=client(fetchMock);
    await expect(call('sync_inspection',{})).rejects.toMatchObject({code:'companion_connection'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
});
it.each(['AbortError','TimeoutError'])('preserves native and cross-realm %s without mutating the rejection',async name=>{
  for(const error of [new DOMException('Cancelled',name),Object.freeze({name})]) {
    const fetchMock=vi.fn(async()=>{throw error;});
    await expect(client(fetchMock)('navigate_experience',{})).rejects.toMatchObject({
      code:'companion_connection',message:expect.stringContaining('timed out'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
});
it('keeps expired capability errors distinct from reconnectable failures',async()=>{
  for(const status of [401,410]) {
    const fetchMock=vi.fn(async()=>new Response('',{status})),call=client(fetchMock);
    await expect(call('poll_inspection',{})).rejects.toThrow('link expired');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
});
it('tells a link that now shares another session apart from a malformed request',async()=>{
  const fetchMock=vi.fn()
    .mockResolvedValueOnce(Response.json({error:'session_changed',message:'This link shares a different session.'},{status:400}))
    .mockResolvedValueOnce(Response.json({error:'invalid_request'},{status:400}));
  const call=client(fetchMock);
  await expect(call('poll_inspection',{sessionId:'old'})).rejects.toMatchObject({
    code:'companion_session_changed',status:400,message:'This link shares a different session.'});
  await expect(call('poll_inspection',{sessionId:'old'})).rejects.toMatchObject({code:'companion_request',status:400,message:'invalid_request'});
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('can make the next normal poll after a failed heartbeat and preserves semantic rejection',async()=>{
  const fetchMock=vi.fn()
    .mockRejectedValueOnce(new TypeError('Network unavailable'))
    .mockResolvedValueOnce(Response.json({structuredContent:{attached:true}}))
    .mockResolvedValueOnce(Response.json({error:'wrong_revision'},{status:409}));
  const call=client(fetchMock);
  await expect(call('poll_inspection',{})).rejects.toMatchObject({code:'companion_connection'});
  expect(await call('poll_inspection',{})).toEqual({structuredContent:{attached:true}});
  await expect(call('poll_inspection',{})).rejects.toThrow('wrong_revision');
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
it('classifies an abort after response headers as a reconnectable read failure',async()=>{
  const abort=Object.assign(new Error('body aborted'),{name:'AbortError'});
  const response={ok:true,json:async()=>{throw abort;}} as unknown as Response;
  const call=client(vi.fn(async()=>response));
  await expect(call('poll_inspection',{})).rejects.toMatchObject({code:'companion_connection'});
  await expect(call('poll_inspection',{})).rejects.toThrow('interrupted while reading the server response');
});
/**
 * The coordinate fetch is a second request, sent after
 * `get_inspection` has already answered, and the share can close in between:
 * the Mac's window runs out, or `open_companion` reopens on another listener.
 * That 404 left here as `companion_request` with no status at all, which
 * `companion-startup.ts` could only read as the viewer's own failure — a Reload
 * button on a closed door.
 */
function inspectionBody(){
  const sha256='a'.repeat(64);
  return Response.json({_meta:{'stereo_structure/inspection':{source:{url:'/source',sha256,bytes:12},catalogWire:{sourceSha256:sha256}}}});
}
it('classifies a 404 on the coordinate fetch as a share that has closed',async()=>{
  const fetchMock=vi.fn()
    .mockResolvedValueOnce(inspectionBody())
    .mockResolvedValueOnce(new Response('',{status:404}));
  const call=client(fetchMock);
  await expect(call('get_inspection',{})).rejects.toMatchObject({code:'companion_expired',status:404,
    message:expect.stringContaining('no longer available')});
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('keeps the status on every coordinate refusal, so nothing downstream has to guess',async()=>{
  for(const status of [401,410]) {
    const fetchMock=vi.fn().mockResolvedValueOnce(inspectionBody()).mockResolvedValueOnce(new Response('',{status}));
    await expect(client(fetchMock)('get_inspection',{})).rejects.toMatchObject({code:'companion_expired',status,message:expect.stringContaining('link expired')});
  }
  // A 503 mid-delivery is the share still there and briefly unwell. The
  // transport catches that one before this branch and stamps it reconnectable,
  // which is what keeps the Reload button in front of the wearer.
  const faulting=vi.fn().mockResolvedValueOnce(inspectionBody()).mockResolvedValueOnce(Response.json({error:'busy'},{status:503}));
  await expect(client(faulting)('get_inspection',{})).rejects.toMatchObject({code:'companion_connection',status:503});
});
it('keeps the status on a busy or faulting host so startup does not read it as a closed share',async()=>{
  for(const status of [429,503]) {
    const fetchMock=vi.fn(async()=>new Response('',{status})),call=client(fetchMock);
    await expect(call('get_inspection',{})).rejects.toMatchObject({code:'companion_connection',status,message:expect.stringContaining('temporarily unavailable')});
  }
  const refused=client(vi.fn(()=>Promise.reject(new TypeError('Failed to fetch'))));
  await expect(refused('get_inspection',{})).rejects.toMatchObject({code:'companion_connection',message:expect.stringContaining('connection was lost')});
});
/**
 * The goodbye has to outlive the page that says it.
 *
 * `detach_inspection` is the only call this client makes from `pagehide`. A
 * plain fetch started there is cancelled with the document, so a reloaded or
 * closed companion tab left its panel attached and `current` for the whole
 * companion heartbeat grace — sixty seconds since that grace was raised for a
 * headset being taken off — and an agent command in that window is accepted by
 * a panel that no longer exists and never renders — a stale panel that will
 * not retire. This keeps the flag on.
 */
it('sends the pagehide detach with keepalive, and sends nothing else with it',async()=>{
  const fetchMock=vi.fn(async()=>Response.json({structuredContent:{}}));
  const call=client(fetchMock);
  await call('detach_inspection',{panelId:'p'});
  const calls=fetchMock.mock.calls as unknown as Array<[unknown,RequestInit|undefined]>;
  expect(calls[0]?.[1]).toMatchObject({keepalive:true,method:'POST'});
  await call('poll_inspection',{});
  expect(calls[1]?.[1]?.keepalive).toBeUndefined();
});

/**
 * The beat's deadline is shorter than the command's.
 *
 * A command the agent enqueues expires fifteen seconds after it is accepted,
 * and the only place the page can claim one is a `poll_inspection` answer. A
 * beat that waits the full fifteen seconds for that answer has therefore
 * already cost the wearer the command, which is what the wearer run
 * showed: every first command expired, the retry rendered in seven seconds.
 * The beat now fails at eight and the page beats again a second later. The
 * spoken-line and detailed-view deadlines are untouched.
 */
it('fails a stalled heartbeat well before the command deadline it has to beat',async()=>{
  const {companionConnectionFrame}=await import('../src/inspection-companion-client.js');
  const fetchMock=vi.fn((_url:string,init:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
    init.signal!.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));
  }));
  const call=client(fetchMock as any);
  const opened=Date.now();
  const beat=call('poll_inspection',{}),spoken=call('voice_acknowledgement',{message:'Done.'});
  const outcomes:string[]=[];
  void beat.catch(()=>outcomes.push('beat'));void spoken.catch(()=>outcomes.push('spoken'));
  companionConnectionFrame(opened+7_999);
  await Promise.resolve();await Promise.resolve();
  expect(outcomes).toEqual([]);
  companionConnectionFrame(opened+8_001);
  await expect(beat).rejects.toThrow('timed out');
  // Fifteen seconds in — the old heartbeat deadline — the spoken line is still
  // being rendered on the Mac and must not be cut off with it.
  companionConnectionFrame(opened+15_001);
  await Promise.resolve();await Promise.resolve();
  expect(outcomes).toEqual(['beat']);
  companionConnectionFrame(opened+55_001);
  await expect(spoken).rejects.toThrow('timed out');
});

it('allows cold journey preparation beyond 15 seconds while retaining heartbeat and mutation deadlines',async()=>{
  const {companionConnectionFrame}=await import('../src/inspection-companion-client.js');
  let completeNavigation!:(response:Response)=>void;
  let navigationSignal!:AbortSignal;
  const fetchMock=vi.fn((_url:string,init:RequestInit)=>new Promise<Response>((resolve,reject)=>{
    const {name}=JSON.parse(String(init.body));
    if(name==='navigate_experience'){completeNavigation=resolve;navigationSignal=init.signal!;}
    init.signal!.addEventListener('abort',()=>reject({name:'AbortError'}));
  }));
  const call=client(fetchMock as any),opened=Date.now();
  const navigation=call('navigate_experience',{experienceId:'tubulin-eb3-lattice',stepIndex:0});
  const beat=call('poll_inspection',{}).catch(error=>error);
  const mutation=call('sync_inspection',{}).catch(error=>error);
  // Attach a handler before driving deadlines: an early rejection is the bug.
  const navigationResult=navigation.catch(error=>error);
  companionConnectionFrame(opened+8_001);
  expect(await beat).toMatchObject({code:'companion_connection',message:expect.stringContaining('timed out')});
  expect(navigationSignal.aborted).toBe(false);
  companionConnectionFrame(opened+15_001);
  expect(await mutation).toMatchObject({code:'companion_connection',message:expect.stringContaining('timed out')});
  companionConnectionFrame(opened+30_000);
  expect(navigationSignal.aborted).toBe(false);
  const result={structuredContent:{experienceTransition:{sourceChanged:true}}};
  completeNavigation(Response.json(result));
  expect(await navigationResult).toEqual(result);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('bounds a stalled journey preparation at 120 seconds without replaying it',async()=>{
  const {companionConnectionFrame}=await import('../src/inspection-companion-client.js');
  let signal!:AbortSignal;
  const fetchMock=vi.fn((_url:string,init:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
    signal=init.signal!;
    signal.addEventListener('abort',()=>reject({name:'AbortError'}));
  }));
  const call=client(fetchMock as any),opened=Date.now();
  const outcome=call('navigate_experience',{}).catch(error=>error);
  companionConnectionFrame(opened+119_999);
  expect(signal.aborted).toBe(false);
  companionConnectionFrame(opened+120_001);
  expect(await outcome).toMatchObject({code:'companion_connection',message:expect.stringContaining('timed out')});
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('reuses verified coordinates for Done while still reading the authenticated host scene', async () => {
  const { createHash } = await import('node:crypto');
  const text = 'data_verified_coordinates\n';
  const sha256 = createHash('sha256').update(text).digest('hex');
  let revision = 1;
  const fetchMock = vi.fn(async (url: string) => url === '/source' ? new Response(text) : Response.json({
    _meta: { 'stereo_structure/inspection': { sessionId: 'same-session', sourceToken: `binding-${revision}`,
      scene: { revision: revision++ }, source: { url: '/source', sha256, bytes: Buffer.byteLength(text) },
      catalogWire: { sourceSha256: sha256 } } },
  }));
  const call = client(fetchMock);
  for (let expected = 1; expected <= 3; expected++) {
    const data = (await call('get_inspection', {}))._meta['stereo_structure/inspection'];
    expect(data.structureText).toBe(text); expect(data.scene.revision).toBe(expected);
  }
  expect(fetchMock.mock.calls.filter(([url]) => url === '/source')).toHaveLength(1);
  expect(fetchMock.mock.calls.filter(([url]) => url === '/tool')).toHaveLength(3);
});

it('verifies a changed source and rejects a mismatched catalog after caching coordinates', async () => {
  const { createHash } = await import('node:crypto');
  let text = 'data_first\n';
  const digest = () => createHash('sha256').update(text).digest('hex');
  let catalogMismatch = false;
  const fetchMock = vi.fn(async (url: string) => url === '/source' ? new Response(text) : Response.json({
    _meta: { 'stereo_structure/inspection': { sessionId: 'same-session',
      source: { url: '/source', sha256: digest(), bytes: Buffer.byteLength(text) },
      catalogWire: { sourceSha256: catalogMismatch ? '0'.repeat(64) : digest() } } },
  }));
  const call = client(fetchMock);
  await call('get_inspection', {});
  text = 'data_other\n';
  expect((await call('get_inspection', {}))._meta['stereo_structure/inspection'].structureText).toBe(text);
  expect(fetchMock.mock.calls.filter(([url]) => url === '/source')).toHaveLength(2);
  catalogMismatch = true;
  await expect(call('get_inspection', {})).rejects.toThrow('coordinates changed during delivery');
});

/**
 * The `/source` fetch no longer gives every file the same 30 s. A 28.8 MB
 * source gets 58 s, a tiny one stays close to the old figure, and neither
 * waits forever.
 */
it('gives the coordinate fetch a deadline that grows with the declared bytes',async()=>{
  const {companionConnectionFrame}=await import('../src/inspection-companion-client.js');
  const sha256='a'.repeat(64);
  const run=async(bytes:number)=>{
    const signals:AbortSignal[]=[];
    const fetchMock=vi.fn((url:string,init:RequestInit)=>{
      if(url!=='/source') return Promise.resolve(Response.json({_meta:{'stereo_structure/inspection':{
        source:{url:'/source',sha256,bytes},catalogWire:{sourceSha256:sha256}}}}));
      signals.push(init.signal!);
      return new Promise<Response>((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>reject({name:'AbortError'}));});
    });
    const call=client(fetchMock as any);
    const loading=call('get_inspection',{}).catch(error=>error);
    for(let turn=0;turn<20 && !signals.length;turn++) await Promise.resolve();
    expect(signals).toHaveLength(1);
    return {signal:signals[0],loading};
  };
  const opened=Date.now();
  const large=await run(28_840_575);
  companionConnectionFrame(opened+30_500);
  expect(large.signal.aborted).toBe(false);
  companionConnectionFrame(opened+57_500);
  expect(large.signal.aborted).toBe(false);
  companionConnectionFrame(opened+58_500);
  expect(large.signal.aborted).toBe(true);
  expect(await large.loading).toMatchObject({code:'companion_connection',message:expect.stringContaining('loading coordinates')});
  forgetCompanionPageKey();
  const small=await run(12);
  const started=Date.now();
  companionConnectionFrame(started+30_500);
  expect(small.signal.aborted).toBe(false);
  companionConnectionFrame(started+31_500);
  expect(small.signal.aborted).toBe(true);
  expect(await small.loading).toMatchObject({code:'companion_connection'});
});
