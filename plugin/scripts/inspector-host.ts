import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import {
  applyRendererTabClose, decideRendererTabClose, RENDERER_TAB_NAME, tabIsHostOpened,
} from '../src/renderer-tab.js';
declare global { interface Window { __call:(p:any)=>Promise<any>; __host:any } }

/**
 * This document is the Chrome tab. The inspector lives in a
 * srcdoc iframe, so `window.close()` has to run here. A host-opened tab stamps
 * `window.name` and closes itself once `/alive` fails three times — the path
 * that still works after SIGKILL of the host.
 */
function hostOpenedHere(): boolean {
  return tabIsHostOpened({ opener: window.opener, name: window.name, search: location.search });
}
if (hostOpenedHere()) {
  try { window.name = RENDERER_TAB_NAME; } catch { /* name is a hint, not a requirement */ }
}
let rendererMisses = 0;
const rendererWatch = window.setInterval(() => {
  const opened = hostOpenedHere();
  fetch('/alive', { cache: 'no-store' }).then(() => {
    rendererMisses = 0;
  }, () => {
    rendererMisses++;
    applyRendererTabClose(decideRendererTabClose({
      companion: false, sameOriginTop: true, hostOpened: opened, hostAskedClose: false,
      consecutiveFailedHeartbeats: rendererMisses,
    }), () => { try { window.close(); } catch { /* Chrome ignores close on a user-opened tab */ } });
  });
}, 1_000);
window.addEventListener('pagehide', () => clearInterval(rendererWatch), { once: true });
let bridge:AppBridge|undefined;
let hostContext:any;
function setContext(context:any) {
  hostContext={displayMode:'inline',containerDimensions:{maxWidth:1100,maxHeight:720},...context};
  document.body.style.background=context.theme==='dark'?'#071015':'#ffffff';
  bridge?.setHostContext(hostContext);
}
window.__host={
  connected:false,
  async mount(html:string,opened:any,context:any={theme:'dark'}) {
    if(bridge) await bridge.close();
    bridge=undefined;
    setContext(context);
    window.__host.connected=false;
    const frame=document.querySelector('iframe')!;
    bridge=new AppBridge(null,{name:'Stereofold test host',version:'1'},{serverTools:{},serverResources:{}},
      {hostContext});
    bridge.oncalltool=p=>window.__call(p);
    bridge.onupdatemodelcontext=async()=>({});
    bridge.onsizechange=()=>{};
    bridge.oninitialized=async()=>{window.__host.connected=true;if(opened) await bridge!.sendToolResult(opened);};
    await bridge.connect(new PostMessageTransport(frame.contentWindow!,frame.contentWindow!));
    frame.srcdoc=html;
  },
  setContext,
  async send(result:any) { await bridge!.sendToolResult(result); },
  async close() {await bridge?.close();bridge=undefined;document.querySelector('iframe')!.srcdoc='';},
};
