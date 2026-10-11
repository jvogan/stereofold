// Browser-only transport for the same inspector that runs through MCP Apps.
// open_companion delivers this sensitive capability to its caller; after the
// browser loads it, the token stays in memory and in this tab's sessionStorage,
// never in a query string, a referrer, localStorage, or — since the page key
// turned out to be legible in headset screen captures — the address bar.
// See inspection-page-key.ts for why the fragment is taken rather than read.
import {readPageKey,keepPageKey,type HeldPageKey} from './inspection-page-key.js';
import {COMPANION_JOURNEY_DEADLINE_MS,MAX_INSPECTION_DENSITY_BYTES,MAX_STRUCTURE_SOURCE_BYTES,headsetSourceDeadlineMs} from './inspection-limits.js';
const PRIVATE_KEY='stereo_structure/inspection';

let held:HeldPageKey|undefined;
/**
 * The page key this tab holds.
 *
 * Memoized because the very first read rewrites the address: a second caller
 * reading `location.hash` would find nothing. Both the transport below and the
 * "Open in Mol*" hop in inspector.ts need the same answer, including whether a
 * same-tab link still has to carry the key.
 */
export function companionPageKey():HeldPageKey {
  if(!held) held=readPageKey((globalThis as any).location,(globalThis as any).history,
    (globalThis as any).sessionStorage,true);
  return held;
}
/** Test seam: the hold is per document, and a test drives several. */
export function forgetCompanionPageKey() { held=undefined; }
async function connectionFetch(url:string,init:RequestInit) {
  let response:Response;
  try { response=await fetch(url,init); }
  catch(error) {
    // Preserve AbortError/TimeoutError so companionFetch can explain a
    // deadline separately from a dropped socket.
    // DOMException.code is read-only, so do not stamp our transport code onto
    // the browser's rejection object even when it is an instanceof Error.
    const cause=new Error('Connection to the desktop was interrupted.');
    // Browser DOMExceptions and errors from another realm need not inherit
    // this realm's Error. Copy only the two known cancellation names.
    const name=(error as {name?:unknown}|null)?.name;
    if(name==='AbortError' || name==='TimeoutError') cause.name=name;
    throw Object.assign(cause,{code:'companion_connection'});
  }
  // Keep the status: a busy or faulting host is transient, and the startup
  // wedge must not read it as the share having closed.
  if(response.status===429 || response.status>=500) throw Object.assign(new Error('The desktop connection is temporarily unavailable.'),{code:'companion_connection',status:response.status});
  return response;
}

function companionReadError(operation:string):Error {
  return Object.assign(new Error(`The companion connection was interrupted while ${operation}. Reconnect from the desktop inspection.`),{code:'companion_connection'});
}

async function readJson(response:Response, operation:string):Promise<any> {
  try { return await response.json(); }
  catch { throw companionReadError(operation); }
}


/** Keep connection failures actionable on a headset, where the desktop UI is
 * not visible. This also makes the client usable in browsers without the
 * newer AbortSignal.timeout helper. */
const deadlines = new Map<AbortController, number>();
/** XR frames enforce the existing fetch deadlines when window timers freeze. */
export function companionConnectionFrame(now = Date.now()) {
  for (const [controller, deadline] of deadlines) if (now >= deadline) { controller.abort();deadlines.delete(controller); }
}

/** Redeem only the remembered device, never retry a scientific mutation. */
let repairing:Promise<boolean>|undefined;
export function recoverCompanionConnection():Promise<boolean> {
  if(repairing)return repairing;
  repairing=(async()=>{
    let device:any;
    try { device=JSON.parse(globalThis.localStorage.getItem('stereofold.device')??'null'); } catch { return false; }
    if(!/^[a-f0-9]{32}$/.test(device?.deviceId) || !/^[a-f0-9]{64}$/.test(device?.deviceKey))return false;
    const response=await companionFetch('/pair',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({deviceId:device.deviceId,deviceKey:device.deviceKey}),credentials:'omit',cache:'no-store'},15_000,'pairing again');
    if(!response.ok)return false;
    const data=await readJson(response,'pairing again');
    if(!/^[a-f0-9]{64}$/.test(data?.token))throw companionReadError('pairing again');
    let storage;
    try { storage=globalThis.sessionStorage; } catch { /* Keep the capability in memory. */ }
    const fragment=keepPageKey(data.token,storage);
    held={key:data.token,stored:!fragment,fragment};
    return true;
  })().finally(()=>{repairing=undefined;});
  return repairing;
}

export function companionResponseMessage(status:number, payload:unknown):string {
  if(status===401 || status===410) return 'This companion link expired. Open a new connection from the desktop inspection.';
  const error=(payload as {error?:unknown;message?:unknown}|null);
  // A 409 body carries the host's own sentence in `message`
  // (`request_failed` is the same code for every tool refusal). The page has
  // to read that sentence to tell a busy panel from a genuine refusal.
  if(typeof error?.message==='string' && error.message.trim()) return error.message.trim();
  return typeof error?.error==='string' ? error.error : 'The companion request failed. Reconnect from the desktop inspection.';
}

async function companionFetch(url:string, init:RequestInit, timeout:number, operation:string):Promise<Response> {
  const controller=new AbortController();
  deadlines.set(controller,Date.now()+timeout);
  const expire=()=>{controller.abort();deadlines.delete(controller);};
  if(typeof AbortSignal.timeout==='function') AbortSignal.timeout(timeout).addEventListener('abort',expire,{once:true});
  else { const timer=setTimeout(expire,timeout);(timer as any).unref?.(); }
  try {
    return await connectionFetch(url,{...init,signal:controller.signal});
  } catch(error) {
    const name=(error as {name?:unknown})?.name;
    if(name==='AbortError' || name==='TimeoutError')
      throw Object.assign(Error(`The companion timed out while ${operation}. Reconnect from the desktop inspection.`),{code:'companion_connection'});
    const status=(error as {status?:unknown})?.status;
    if(typeof status==='number')
      throw Object.assign(Error(`The desktop connection is temporarily unavailable while ${operation}. Try again in a moment.`),{code:'companion_connection',status});
    throw Object.assign(Error(`The companion connection was lost while ${operation}. Reconnect from the desktop inspection.`),{code:'companion_connection'});
  }
}

export function createCompanionClient() {
  const token=companionPageKey().key;
  if(!/^[a-f0-9]{64}$/.test(token)) throw Object.assign(Error('Open the complete companion link from the desktop inspection.'),{code:'companion_key_missing'});
  // Retain only this client's last verified source. Every hydration still reads
  // the authenticated host state; a Done token change does not change its bytes.
  let coordinatesCache:{authorization:string;sessionId:unknown;sha256:string;bytes:number;text:string}|undefined;
  return async(name:string,args:Record<string,unknown>)=>{
    const authorization=`Bearer ${companionPageKey().key}`;
    // A first open_detailed_view reads the multi-megabyte Mol* bundle and
    // digests the coordinates before the host answers, so it needs the long
    // deadline too; 15 s failed the caption while the browser was still opening.
    // The heartbeat gets the short deadline, and it is short on
    // purpose. It is a kilobyte of JSON on a LAN, it is the only place a queued
    // command is claimed, and the command's own deadline is fifteen seconds —
    // so a beat that waits the full fifteen for an answer has already cost the
    // wearer the command. Failing at eight and beating again a second later is
    // strictly better than waiting.
    // A cold journey checks several declared sources before returning its
    // first scene: each download allows 20 s, followed by catalog and geometry
    // validation. Give that preparation a bounded two minutes; it is not a
    // heartbeat or an ordinary edit, and timing it out never retries it.
    const timeout=name==='navigate_experience'?COMPANION_JOURNEY_DEADLINE_MS
      :name==='voice_command'||name==='voice_acknowledgement'||name==='open_detailed_view'?55_000
      :name==='poll_inspection'?8_000:15_000;
    // The goodbye has to outlive the page that says it.
    // `detach_inspection` is sent from `pagehide`, and a plain fetch started
    // there is cancelled with the document, so a reloaded or closed companion
    // tab left its panel attached and `current` for the whole companion
    // heartbeat grace — sixty seconds since that grace was raised for a
    // headset being taken off. An agent command in that window is accepted by
    // a panel that no longer exists and never renders. `keepalive` is what a
    // browser offers for exactly this: the request is handed to the network
    // stack and completes after the document is gone. The body is a few
    // hundred bytes, far inside the 64 KB keepalive cap.
    const leaving=name==='detach_inspection';
    const response=await companionFetch('/tool',{method:'POST',headers:{authorization,'Content-Type':'application/json'},
      body:JSON.stringify({name,args}),cache:'no-store',credentials:'omit',...(leaving?{keepalive:true}:{})},timeout,'sending the request');
    if(!response.ok) {
      // An expired endpoint may close without a JSON body; retain the
      // capability-specific message in that case. Other body truncation is a
      // reconnectable transport failure.
      let error:null|unknown=null;
      try { error=await response.json(); }
      catch { if(response.status!==401 && response.status!==410) throw companionReadError('reading the server response'); }
      // The HTTP status rides with the message. `request_failed` is the same
      // body for every refusal, so without it a failing speak call is
      // indistinguishable in the headset log from a lost connection.
      // `session_changed` gets its own code: the page recovers from it alone.
      const code=response.status===401 || response.status===410?'companion_expired'
        :(error as {error?:unknown}|null)?.error==='session_changed'?'companion_session_changed':'companion_request';
      throw Object.assign(Error(companionResponseMessage(response.status,error)),{code,status:response.status});
    }
    const result=await readJson(response,'reading the server response');
    const data=result._meta?.[PRIVATE_KEY];
    if(name==='get_inspection' && data?.source) {
      const source=data.source;
      if(source.url!=='/source' || !/^[a-f0-9]{64}$/.test(source.sha256)
        || !Number.isSafeInteger(source.bytes) || source.bytes<1 || source.bytes>MAX_STRUCTURE_SOURCE_BYTES)
        throw Error('The companion returned an invalid coordinate descriptor.');
      const catalogSourceSha256=data.catalogWire?.sourceSha256 ?? data.catalog?.source?.sha256;
      if(catalogSourceSha256!==source.sha256)
        throw Error('The coordinates changed during delivery. Reconnect before continuing.');
      if(typeof data.sessionId==='string' && coordinatesCache?.authorization===authorization && coordinatesCache.sessionId===data.sessionId
        && coordinatesCache.sha256===source.sha256 && coordinatesCache.bytes===source.bytes) {
        data.structureText=coordinatesCache.text;
      } else {
        try { (globalThis as any).__stereofoldDiagnostics?.record?.('first-pixel',{stage:'headset-source-requested',at:Date.now(),bytes:source.bytes}); } catch { /* Timing must not interrupt hydration. */ }
        // The deadline follows the declared size; see headsetSourceDeadlineMs.
        const coordinates=await companionFetch(source.url,{headers:{authorization},cache:'no-store',credentials:'omit'},headsetSourceDeadlineMs(source.bytes),'loading coordinates');
        if(!coordinates.ok) {
          // A live share always serves `/source`: `inspection-lan.ts` answers 404
          // only for a path it does not route, so a 404 here is the share itself
          // gone between `get_inspection` and the fetch — the half-hour window
          // closing, or `open_companion` reopening on another listener. It rode
          // out as `companion_request` with no status, which startup read as "the
          // viewer failed" and put a Reload button on a closed door.
          const ended=coordinates.status===401 || coordinates.status===404 || coordinates.status===410;
          let error:null|unknown=null;
          try { error=await coordinates.json(); }
          catch { if(!ended) throw companionReadError('reading coordinate response'); }
          throw Object.assign(Error(ended && coordinates.status!==404
            ? companionResponseMessage(coordinates.status,error)
            : 'The coordinates are no longer available. Reconnect from the desktop inspection.'),
            {code:ended?'companion_expired':'companion_request',status:coordinates.status});
        }
        let bytes:ArrayBuffer;
        try { bytes=await coordinates.arrayBuffer(); }
        catch { throw companionReadError('reading coordinates'); }
        const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
        if(bytes.byteLength!==source.bytes || digest!==source.sha256 || catalogSourceSha256!==digest)
          throw Error('The coordinates changed during delivery. Reconnect before continuing.');
        data.structureText=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
        coordinatesCache={authorization,sessionId:data.sessionId,sha256:digest,bytes:bytes.byteLength,text:data.structureText};
      }
    }
    // The density map, on its own route, for the tiers that have
    // one. It is fetched after the coordinates rather than instead of them: the
    // catalog the panel runs on still describes the session's structure, and
    // the map is the thing the wearer actually sees drawn.
    if(name==='get_inspection' && data?.density) {
      const density=data.density;
      if(density.url!=='/density' || !/^[a-f0-9]{64}$/.test(density.sha256)
        || !Number.isSafeInteger(density.bytes) || density.bytes<1 || density.bytes>MAX_INSPECTION_DENSITY_BYTES
        || typeof density.contour!=='number' || !Number.isFinite(density.contour))
        throw Error('The companion returned an invalid density descriptor.');
      // 8.4 MB is several times anything /source has ever carried, and the
      // wearer's wait for a grow is this transfer. The coordinate deadline is
      // 30 s for a file a tenth the size, so scale rather than share it.
      const map=await companionFetch(density.url,{headers:{authorization},cache:'no-store',credentials:'omit'},120000,'loading the density map');
      if(!map.ok) {
        const ended=map.status===401 || map.status===404 || map.status===410;
        let error:null|unknown=null;
        try { error=await map.json(); }
        catch { if(!ended) throw companionReadError('reading the density response'); }
        throw Object.assign(Error(ended && map.status!==404
          ? companionResponseMessage(map.status,error)
          : 'The density map is no longer available. Reconnect from the desktop inspection.'),
          {code:ended?'companion_expired':'companion_request',status:map.status});
      }
      let mapBytes:ArrayBuffer;
      try { mapBytes=await map.arrayBuffer(); }
      catch { throw companionReadError('reading the density map'); }
      const mapDigest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',mapBytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
      // Three things have to agree: the descriptor in the hydration, the header
      // on the response that carried the bytes, and the bytes themselves.
      if(mapBytes.byteLength!==density.bytes || mapDigest!==density.sha256
        || map.headers.get('X-Stereofold-Density-SHA256')!==density.sha256)
        throw Error('The density map changed during delivery. Reconnect before continuing.');
      const servedContour=Number(map.headers.get('X-Stereofold-Density-Contour'));
      if(!Number.isFinite(servedContour) || servedContour!==density.contour)
        throw Error('The density map was served at a different contour than the lesson names.');
      data.mapBytes=new Uint8Array(mapBytes);
      data.mapContour=density.contour;
      data.mapSha256=density.sha256;
    }
    return result;
  };
}
