import { readInlineHtml } from '../src/inline-html.js';
/** Standalone host for the actual packaged MCP inspector, with local agent control. */
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {hasLocalControlToken,writeLocalControlState} from './local-host-security.js';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {pushToTalkFromEnv} from '../src/push-to-talk.js';
import {pushToTalkTranscriberFromEnv} from '../src/push-to-talk-transcribe.js';
import {replyAudioFromEnv} from '../src/headset-voice-provider.js';
import {standaloneAgentResponse} from '../src/standalone-agent-response.js';
import {sceneCallTimeoutMs} from '../src/scene-service.js';
import {closeChromeRendererTabs} from '../src/quest-launch.js';
import {pttLaunchEnabled} from '../src/ptt-launch-options.js';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
// --ptt is a mode, not a positional argument; strip it before the rest parses.
const rawArgs=process.argv.slice(2);
const pushToTalkEnabled=pttLaunchEnabled(rawArgs,process.env,false);
// --no-remember turns off remembered headsets for this run: a paired Quest is
// then never handed a device key, and every visit needs the pairing code.
const remembering=!rawArgs.includes('--no-remember');
// --assembly <id> is a mode too: it names a biological assembly the entry
// declares, which Mol* builds from the entry's own operator list.
const assemblyFlag=rawArgs.indexOf('--assembly');
const assemblyId=assemblyFlag>=0?rawArgs[assemblyFlag+1]:undefined;
if(assemblyFlag>=0&&(!assemblyId||!/^[A-Za-z0-9_-]{1,128}$/.test(assemblyId)))throw Error('--assembly needs an assembly identifier the entry declares, such as 1.');
// --density <absolute map> is a mode too. It names the prepared
// CCP4/MRC map a volume lesson draws. The positional source stays the
// coordinates the session opens on, because an inspection session is built on
// coordinates end to end; the map travels beside them on its own hashed route.
const densityFlag=rawArgs.indexOf('--density');
const densityPath=densityFlag>=0?rawArgs[densityFlag+1]:undefined;
if(densityFlag>=0&&(!densityPath||!isAbsolute(densityPath)||!/\.(?:map|ccp4|mrc)$/i.test(densityPath)))throw Error('--density needs an absolute .map/.ccp4/.mrc path.');
const args=rawArgs.filter((argument,index)=>argument!=='--ptt'&&argument!=='--no-ptt'&&argument!=='--no-remember'
  &&(assemblyFlag<0||(index!==assemblyFlag&&index!==assemblyFlag+1))
  &&(densityFlag<0||(index!==densityFlag&&index!==densityFlag+1))),source=args[0]??'1CRN',statePath=args[1];
const snapshotMode=args[2]==='--snapshot',lessonPath=snapshotMode?undefined:args[2];
const scenePath=snapshotMode?args[3]:undefined,provenancePath=snapshotMode?args[4]:undefined;
const isPdb=/^[a-z0-9]{4}$/i.test(source);
if(!isPdb && !(isAbsolute(source)&&/\.(?:cif|mmcif)$/i.test(source)))throw Error('Supply a public PDB ID or an absolute local .cif/.mmcif path, optionally followed by an absolute private state-file path.');
if(statePath&&!isAbsolute(statePath))throw Error('The control state-file path must be absolute.');
if(lessonPath&&(!isAbsolute(lessonPath)||isPdb))throw Error('A custom lesson needs an absolute lesson JSON path and a local mmCIF source.');
if(densityPath&&!lessonPath)throw Error('--density needs a lesson: the lesson is what names the map, its digest and its contour.');
if(snapshotMode&&(isPdb||!scenePath||!provenancePath||!isAbsolute(scenePath)||!isAbsolute(provenancePath)))throw Error('Snapshot mode needs a local mmCIF source and --snapshot <absolute scene.json> <absolute provenance.json>.');
if(args.length>(snapshotMode?5:3))throw Error('Unexpected standalone host arguments.');
const client=new Client({name:'Stereofold local desktop host',version:'1'});
// The push-to-talk commands live in this shell's environment and the tool that
// runs them lives in the MCP child, so pass them across explicitly. The default
// environment filter drops every STEREOFOLD_ name.
// Version 2 of push-to-talk records the Quest microphone and transcribes it
// with whisper-cpp on this Mac, so --ptt also turns the transcriber on and
// carries its tool paths and delivery settings across the same filter.
const voiceEnvironment=Object.fromEntries(['STEREOFOLD_WHISPER_BIN','STEREOFOLD_WHISPER_MODEL','STEREOFOLD_FFMPEG_BIN',
  'STEREOFOLD_PTT_TRANSCRIPTS','STEREOFOLD_PTT_TEXT_COMMAND','STEREOFOLD_BRIDGE_DIR',
  // The transcriber choice and the Apple Speech helper travel with the whisper
  // settings: selecting Apple on the launcher must reach the MCP child too.
  'STEREOFOLD_PTT_TRANSCRIBER','STEREOFOLD_APPLESPEECH_BIN',
  // The energy gate that decides a press was silence. It is
  // tunable precisely because 0.012 was set on synthesized speech and has
  // never been measured against a Quest 2 microphone in a real room; without
  // this name on the list the setting exists only in a shell the transcriber
  // cannot see, and the one measurement that matters cannot be acted on.
  'STEREOFOLD_PTT_SILENCE_RMS']
  .filter(name=>process.env[name]).map(name=>[name,process.env[name] as string]));
// OAuth narration is the default. Preserve an explicit provider selection in
// the MCP child, whether or not push-to-talk is on.
// STEREOFOLD_PYTHON3_BIN and STEREOFOLD_CONFIG travel with them: the headset
// microphone runs its helper from the MCP child, and the child is where the
// local config file is read. Without these names the two settings exist only
// in a shell the child cannot see.
const replyAudioEnvironment=Object.fromEntries(['STEREOFOLD_REPLY_AUDIO','STEREOFOLD_SAY_BIN','STEREOFOLD_REPLY_VOICE',
  'STEREOFOLD_REPLY_RATE','STEREOFOLD_FFMPEG_BIN','STEREOFOLD_REPLY_VOICE_PROVIDER','STEREOFOLD_AGENT_VOICE_BIN',
  'STEREOFOLD_PYTHON3_BIN','STEREOFOLD_CONFIG']
  .filter(name=>process.env[name]).map(name=>[name,process.env[name] as string]));
// capture_headset_view reads the headset's display over adb from the MCP
// child. adb is not always on PATH (a platform-tools unzip is enough), and the
// serial picks one headset when several are paired, so both cross the filter.
// Keep the launch selector too: one headset may appear over USB and Wi-Fi,
// and dropping its explicit wireless target makes the child refuse that list.
// The capture scales and black-frame-checks the 3664-wide
// panel with ffmpeg, so every name FFMPEG_ENV_KEYS looks under crosses here
// too — including the documented STEREOFOLD_FFMPEG_BIN, which voiceEnvironment
// carries only when --ptt is on and the capture needs either way. Without them
// a Mac that keeps ffmpeg off PATH returns a 5 MB full-size frame with no
// asleep-headset check and no way to say where the tool is.
const headsetEnvironment=Object.fromEntries(['STEREOFOLD_ADB_BIN','STEREOFOLD_ADB','ADB','STEREOFOLD_ADB_SERIAL','ANDROID_SERIAL','STEREOFOLD_QUEST_SERIAL',
  'STEREOFOLD_FFMPEG_BIN','STEREOFOLD_FFMPEG','FFMPEG']
  .filter(name=>process.env[name]).map(name=>[name,process.env[name] as string]));
// Which browser holds the Meta session is a desktop-wide choice, and
// open_companion opens Web Launch from inside the server rather than from here.
const browserEnvironment:Record<string,string>=process.env.STEREOFOLD_BROWSER?{STEREOFOLD_BROWSER:process.env.STEREOFOLD_BROWSER}:{};
// The Meta relay and the desktop opener are read inside the
// MCP child (inspection-quest-link.ts, quest-launch.ts) from names the default
// filter drops. The Claude Science kit puts both on the daemon's own env block,
// so that host honours them; without this list Claude Code is the one host
// where exporting STEREOFOLD_CLOUDFLARED does nothing and `open_companion`
// with connection https silently falls back to a bare `cloudflared` on PATH.
// STEREOFOLD_SHARE_MAX_HOURS is the wearer session's hard stop (quest-share
// --share-hours); getDefaultEnvironment() drops it, so it is forwarded by name.
const relayEnvironment=Object.fromEntries(['STEREOFOLD_CLOUDFLARED','STEREOFOLD_OPENER','STEREOFOLD_SHARE_MAX_HOURS','STEREOFOLD_SCENE_SERVICE']
  .filter(name=>process.env[name]).map(name=>[name,process.env[name] as string]));
// The child transcribes by itself whenever this Mac can, so the absence of
// --ptt has to be said rather than left unsaid: on this host the flag is the
// switch, and a host started without it must not record the wearer.
const serverEnvironment={...getDefaultEnvironment(),...replyAudioEnvironment,...browserEnvironment,...headsetEnvironment,...relayEnvironment,
  ...(pushToTalkEnabled?{STEREOFOLD_PTT_ENABLED:'1',STEREOFOLD_PTT_TRANSCRIBE:'1',...voiceEnvironment,
    ...(process.env.STEREOFOLD_PTT_DOWN?{STEREOFOLD_PTT_DOWN:process.env.STEREOFOLD_PTT_DOWN}:{}),
    ...(process.env.STEREOFOLD_PTT_UP?{STEREOFOLD_PTT_UP:process.env.STEREOFOLD_PTT_UP}:{})}:{STEREOFOLD_PTT_TRANSCRIBE:'0'}),
  ...(remembering?{}:{STEREOFOLD_LAN_REMEMBER:'0'})};
const transport=new StdioClientTransport({command:process.execPath,args:[resolve(root,'dist/server.mjs')],cwd:root,stderr:'pipe',env:serverEnvironment});
let clientConnected=false;
let childLifecycle:'starting'|'connected'|'disconnected'|'closing'='starting';
let childFailure='';
let childStderr='';
let closing=false;
transport.stderr?.on('data',chunk=>{childStderr=(childStderr+String(chunk)).slice(-4_000);});
transport.onerror=error=>{
  childFailure=error instanceof Error?error.message:String(error);
  if(childLifecycle!=='closing') console.error(`Stereofold MCP child error: ${childFailure}`);
};
transport.onclose=()=>{
  clientConnected=false;
  if(childLifecycle!=='closing') {
    childLifecycle='disconnected';
    childFailure=childFailure||'The MCP child process exited.';
    console.error(`Stereofold MCP child disconnected: ${childFailure}${childStderr.trim()?`\n${childStderr.trim()}`:''}`);
  }
};
const childUnavailable=()=>Error(childFailure?`Stereofold MCP child disconnected: ${childFailure}`:'Stereofold MCP child is not connected.');
let server:ReturnType<typeof createServer>|undefined;
const raw=async(name:string,arguments_:any)=>{
  if(!clientConnected)throw childUnavailable();
  // The render wait starts after source preparation in the child. Preserve
  // the shared owner's preparation allowance around that requested wait so its
  // rendered receipt (or its timed-out response) can reach the agent.
  const r:any=await client.callTool({name:`stereo_structure.${name}`,arguments:arguments_},undefined,
    {timeout:sceneCallTimeoutMs(name,arguments_??{})});
  if(r.isError)throw Error(r.content?.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join(' ')||'MCP request failed');
  return r;
};
const page=`<!doctype html><html><head><meta charset="utf-8"><title>Stereofold · ${isPdb?source.toUpperCase():'Local structure'}</title></head><body style="margin:0;background:#071015;height:100vh;overflow:hidden"><div id="host-bar" style="display:flex;gap:10px;align-items:center;padding:6px 10px;font:13px/1.4 system-ui,sans-serif;color:#dceaf0;background:#0d1a21"><button id="host-detailed" type="button" style="font:inherit;padding:4px 10px;cursor:pointer">Detailed view</button><span id="host-status"></span></div><iframe title="Stereofold inspector" allow="xr-spatial-tracking" style="display:block;border:0;width:100%;height:calc(100% - 33px)"></iframe><script src="/host.js"></script><script src="/boot.js"></script></body></html>`;
let token=randomBytes(32).toString('hex');let port=0;
// The browser gets its own bearer so a recovered session's rotated agent
// token cannot silently lock out an already-open page. It travels in the URL
// fragment, which browsers never send, so no HTTP response ever carries it
// and another local user cannot read it back off the loopback port.
const browserToken=randomBytes(32).toString('hex');
const SESSIONLESS_TOOLS=new Set(['listen_voice','say_to_headset','continue_session']);
// Chunked hydration is private renderer data. The authenticated panel needs
// this route to finish loading; the model-facing agent route must not expose it.
const panelOnly=new Set(['get_inspection_bytes']);
// This list, not the MCP registration, is what a terminal host
// can reach. A model-visible tool missing from here answers "Tool unavailable"
// however plainly it is registered, and two were: the Claude Code kit promises
// `read_headset_browser` over the debugging cable, and `grow_structure` is the
// whole point of "grow it" on the one route that has no panel of its own.
const permitted=new Set(['get_inspection','resolve_scene_import','sync_inspection','attach_inspection','poll_inspection','complete_inspection','report_source_failure','detach_inspection','open_companion','open_detailed_view','import_detailed_view','get_inspection_state','get_readiness','update_inspection','focus_selection','emphasize','control_tour','manage_companion','navigate_experience','acknowledge_experience_step','replace_inspection_source','push_to_talk_audio','poll_voice_transcripts','voice_command','voice_acknowledgement','speak_to_headset','say_to_headset','listen_voice','claim_voice_intent','acknowledge_voice_intent','acknowledge_voice_playback','read_headset_log','recall_headset','capture_headset_view','read_headset_browser','grow_structure','continue_session','switch_assistant','undo_last_change','redo_last_change','manage_inspection_view']);
const expiredSessionMessage='Stereofold session was not found or has expired. Open a structure to create a new session and use its returned sessionId.';
const isExpiredSessionError=(error:unknown)=>error instanceof Error&&error.message===expiredSessionMessage;
if(assemblyId&&!lessonPath)throw Error('--assembly needs a lesson: the assembly is opened with the lesson that describes it.');
const openSource=async()=>snapshotMode?raw('inspect_scene',{coordinatePath:source,scenePath,provenancePath}):lessonPath?raw('inspect_lesson',{filePath:source,lessonPath,...(densityPath?{densityPath}:{}),...(assemblyId?{assemblyId}:{})}):isPdb?raw('inspect',{pdbId:source}):raw('inspect_file',{filePath:source});
const closeHttpServer=async(host:ReturnType<typeof createServer>)=>{
  host.closeAllConnections();
  if(!host.listening)return;
  await new Promise<void>((resolve,reject)=>host.close(error=>error?reject(error):resolve()));
};
const cleanup=async()=>{
  const tasks:Promise<unknown>[]=[];
  if(server)tasks.push(closeHttpServer(server));
  if(clientConnected)tasks.push(client.close());
  else tasks.push(transport.close());
  await Promise.allSettled(tasks);
};
let opened:any;
let sessionId='';
let html='';
let hostJs='';
let bootstrap='';
let recovery:Promise<void>|undefined;
const localOrigin=()=>`http://127.0.0.1:${port}`;
const writeControlState=async(id=sessionId,controlToken=token)=>{
  if(statePath)await writeLocalControlState(resolve(statePath),{origin:localOrigin(),token:controlToken,sessionId:id});
};
const requireSessionId=(response:any,operation:string)=>{
  const id=response?.structuredContent?.sessionId;
  if(typeof id!=='string'||id.length===0)throw Error(`${operation} did not return a session ID.`);
  return id;
};
const recoverExpiredSession=async(expiredId:string)=>{
  if(sessionId!==expiredId)return;
  if(recovery)return recovery;
  recovery=(async()=>{
    const nextOpened=await openSource();
    const nextSessionId=requireSessionId(nextOpened,'Stereofold session recovery');
    const nextToken=randomBytes(32).toString('hex');
    await writeControlState(nextSessionId,nextToken);
    opened=nextOpened;
    sessionId=nextSessionId;
    token=nextToken;
  })();
  try{await recovery;}finally{recovery=undefined;}
};
const ensureBootstrapSession=async()=>{
  const observedId=sessionId;
  try{await raw('get_inspection',{sessionId:observedId});}
  catch(error){
    if(!isExpiredSessionError(error))throw error;
    await recoverExpiredSession(observedId);
  }
};
try{
  await client.connect(transport);clientConnected=true;
  opened=await openSource();
  sessionId=requireSessionId(opened,'Stereofold inspect');
  html=await readInlineHtml(resolve(root,'dist/inspector.html'));
  // The host page is built into dist beside the inspector, so this script
  // and the server's own `open_inspector` serve the same bytes.
  hostJs=await readFile(resolve(root,'dist/inspector-host.js'),'utf8');
  bootstrap=`const bearer=location.hash.slice(1);window.__call=async p=>{if(!bearer)throw Error('Open the exact address printed by the local host, including the part after #.');const r=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+bearer},body:JSON.stringify(p)});if(!r.ok)throw Error('Local host request failed');return r.json();};fetch('/bootstrap').then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||'Local host request failed');return d;}).then(d=>{if(!bearer)throw Error('Open the exact address printed by the local host, including the part after #.');return window.__host.mount(d.html,d.opened,{theme:'dark'});}).catch(e=>document.querySelector('#host-status').textContent=e.message);const detailed=document.querySelector('#host-detailed'),say=t=>{document.querySelector('#host-status').textContent=t;};detailed.addEventListener('click',async()=>{detailed.disabled=true;say('Opening the full Mol* viewer.');try{const state=await window.__call({name:'get_inspection_state',arguments:{}});const c=state.structuredContent;if(!c||!c.hasScene)throw Error('Save the inspection in the panel first, then open the detailed view.');const opened=await window.__call({name:'open_detailed_view',arguments:{serverEpoch:c.serverEpoch,sourceToken:c.sourceToken,baseStateRevision:c.stateRevision,baseInspectionRevision:c.inspectionRevision}});const view=opened.structuredContent&&opened.structuredContent.detailedView;if(!view||!view.url)throw Error('The detailed view did not open.');window.open(view.url,'_blank','noopener');say('Full Mol* viewer opened in a new tab.');}catch(e){say(e&&e.message?e.message:'The detailed view could not open.');}finally{detailed.disabled=false;}});`;
  server=createServer(async(req,res)=>{
  // A client that aborts mid-request leaves a socket that cannot take another
  // response. Writing one anyway throws out of an unawaited handler promise
  // and takes the whole standalone host down with it.
  const send=(n:number,data:any,type='application/json')=>{
    if(res.writableEnded||res.destroyed)return;
    if(res.headersSent){res.destroy();return;}
    res.writeHead(n,{'Content-Type':type,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
    res.end(typeof data==='string'?data:JSON.stringify(data));
  };
  const origin=localOrigin();
  if(req.headers.host!==`127.0.0.1:${port}`||req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==origin)){send(403,{});return;}
  if(req.method==='GET'){
    const path=(req.url??'/').split('?')[0];
    if(path==='/')send(200,page,'text/html');
    else if(path==='/alive')send(204,'','text/plain');
    else if(path==='/host.js')send(200,hostJs,'text/javascript');
    else if(path==='/boot.js')send(200,bootstrap,'text/javascript');
    else if(path==='/bootstrap'){
      try{await ensureBootstrapSession();send(200,{html,opened});}
      catch(error){send(409,{error:(error as Error).message});}
    }
    else send(404,{});return;
  }
  // An Origin header is only meaningful inside a browser; any local process can
  // send it verbatim. Both POST routes therefore need a real bearer, and only
  // the agent token reaches the agent route.
  const admin=hasLocalControlToken(req.headers.authorization,token);
  const panel=admin||hasLocalControlToken(req.headers.authorization,browserToken);
  if(req.method!=='POST'||!['/rpc','/agent'].includes(req.url??'')||req.headers['content-type']!=='application/json'
    ||(req.url==='/agent'?!admin:!panel||req.headers.origin!==origin)){send(403,{});return;}
  try{
    // Chunks are Buffers. Concatenating them as strings decodes each chunk in
    // isolation, so a UTF-8 code point split across a boundary is destroyed.
    const chunks:Buffer[]=[];let size=0;
    for await(const c of req){size+=c.length;if(size>3*1024*1024)throw Error('Request too large');chunks.push(Buffer.from(c));}
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8')),name=String(input.name).replace(/^stereo_structure\./,'');
    if(!permitted.has(name)&&!(req.url==='/rpc'&&panelOnly.has(name)))throw Error('Tool unavailable');
    const args=input.arguments??{};if(args.sessionId&&args.sessionId!==sessionId)throw Error('Wrong session');
    // The voice tools take no sessionId at all (strict schemas), so the stamp stays off them.
    const result=await raw(name,SESSIONLESS_TOOLS.has(name)?args:{...args,sessionId});
    send(200,req.url==='/agent'?standaloneAgentResponse(name,result):result);
  }catch(e){send(409,{error:(e as Error).message});}
  });
  server.requestTimeout=20000;server.headersTimeout=5000;
  await new Promise<void>((resolveListen,reject)=>{
    const onError=(error:Error)=>{server?.off('listening',onListening);reject(error);};
    const onListening=()=>{server?.off('error',onError);resolveListen();};
    server?.once('error',onError);server?.once('listening',onListening);server?.listen(0,'127.0.0.1');
  });
  port=(server.address() as any).port;
  await writeControlState();
}catch(error){
  await cleanup();
  throw error;
}
console.log(`Open the real Stereofold inspector: http://127.0.0.1:${port}/#${browserToken}`);
console.log('The part after # is this page\u2019s key. Open the whole address, and do not paste it into anything else.');
console.log('Choose Open on Quest after the structure saves. Keep this process running. Ctrl-C closes the session and private Wi-Fi listener.');
console.log(replyAudioFromEnv(serverEnvironment).describe());
if(pushToTalkEnabled)console.log(pushToTalkFromEnv(serverEnvironment).describe());
if(pushToTalkEnabled){
  console.log(pushToTalkTranscriberFromEnv(serverEnvironment).describe());
  console.log(statePath?`Stream what the wearer says: pnpm --dir plugin run listen ${statePath}`:'Add an absolute state-file path to this command to stream transcripts with pnpm --dir plugin run listen.');
}
if(!remembering)console.log('Remembered headsets are off for this run; every visit needs the pairing code.');
async function close(){
  if(closing)return;closing=true;childLifecycle='closing';
  // Close the renderer tab this process opened before the listener goes away.
  // The page also self-closes on failed heartbeats, which is what survives SIGKILL.
  if(port) try{await Promise.race([closeChromeRendererTabs({origin:localOrigin()}),new Promise(done=>setTimeout(done,2_000))]);}catch{/* best-effort */}
  await cleanup();process.exit(0);
}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
