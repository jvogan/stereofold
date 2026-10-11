import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Page, type Frame } from 'playwright';
const out=resolve(process.argv[2]??'');assert.ok(process.argv[2], 'Supply a fresh artifact directory');await mkdir(out,{recursive:false});
const report:any={status:'failed',host:'controlled official MCP Apps AppBridge with real stdio; actual Codex host not tested',cases:[],screenshots:[],errors:[],externalRequests:[],cleanup:{}};
const passed=(name:string)=>{report.cases.push(name);console.log(`Passed: ${name}`);};
const client=new Client({name:'Stereofold packaged inspector acceptance',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/server.mjs')],cwd:process.cwd(),stderr:'pipe'});
let stderr='';transport.stderr?.on('data',c=>stderr+=String(c));
const hostBundle=await build({entryPoints:[resolve('scripts/inspector-host.ts')],bundle:true,format:'iife',write:false,platform:'browser',target:'es2022'});
const hostHtml=`<!doctype html><html><body style="margin:0;background:#071015"><iframe title="Stereofold" style="border:0;width:100vw;height:100vh"></iframe><script>${hostBundle.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
const http=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(hostHtml);});
await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${(http.address() as any).port}`;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const call=async(name:string,args:any)=>{const r:any=await client.callTool({name:`stereo_structure.${name}`,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r;};
const privateView=async(id:string)=>(await call('get_inspection',{sessionId:id}))._meta['stereo_structure/inspection'];
const waitSaved=async(id:string,predicate:(d:any)=>boolean)=>{
  const until=Date.now()+120000;
  while(Date.now()<until) {const data=await privateView(id);if(predicate(data))return data;await new Promise(r=>setTimeout(r,100));}
  throw Error('Timed out waiting for saved inspection');
};
async function mount(html:string,opened:any,context:any={theme:'dark'}) {
  const page=await browser!.newPage({viewport:{width:1100,height:720},deviceScaleFactor:1});page.setDefaultTimeout(120000);
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.route('**/*',route=>{const url=route.request().url();if(url.startsWith(origin))return route.continue();report.externalRequests.push(url);return route.abort();});
  const intercept:{after?: (request:any,response:any)=>Promise<any>}={};
  await page.exposeFunction('__call',async(p:any)=>{
    const response=await client.callTool({name:p.name,arguments:p.arguments??{}});
    return intercept.after?intercept.after(p,response):response;
  });
  await page.goto(origin);
  await page.evaluate(({html,opened,context})=>(window as any).__host.mount(html,opened,context),{html,opened,context});
  const frame=page.frames().find(f=>f!==page.mainFrame())!;
  return {page,frame,intercept};
}
async function waitState(id:string,predicate:(state:any)=>boolean,commandId?:string) {
  const until=Date.now()+120000;
  while(Date.now()<until) {
    const state=(await call('get_inspection_state',{sessionId:id,...(commandId?{commandId}:{})})).structuredContent;
    report.lastInspectionState=state;
    if(predicate(state)) return state;
    if(commandId && ['rejected','expired','conflict','unconfirmed','cancelled','superseded'].includes(state.command?.status))
      throw Error(`Command ${commandId} ended unexpectedly: ${JSON.stringify(state.command)}`);
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error('Timed out waiting for public inspection state');
}
async function canvasPixels(page:Page,frame:Frame,name:string) {
  const png=await frame.locator('.stage canvas').screenshot();
  assert.ok(png.length<15*1024*1024);assert.ok(report.screenshots.length<12);
  const file=`${name}.png`;await writeFile(resolve(out,file),png);
  const stats=await page.evaluate(async base64=>{
    const img=new Image();img.src=`data:image/png;base64,${base64}`;await img.decode();
    const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
    const ctx=canvas.getContext('2d')!;ctx.drawImage(img,0,0);
    const pixels=ctx.getImageData(0,0,img.width,img.height).data;
    // The rounded canvas corner includes the surrounding panel. These fixed
    // scenes have a large flat background; measure its dominant RGB instead.
    const counts=new Map<number,number>();let common=0,commonCount=0;
    for(let i=0;i<pixels.length;i+=4) {
      const rgb=(pixels[i]<<16)|(pixels[i+1]<<8)|pixels[i+2],count=(counts.get(rgb)??0)+1;
      counts.set(rgb,count);if(count>commonCount){common=rgb;commonCount=count;}
    }
    const background=[common>>>16,(common>>>8)&255,common&255];
    let foreground=0;for(let i=0;i<pixels.length;i+=4) if(background.some((c,k)=>Math.abs(c-pixels[i+k])>10)) foreground++;
    return {background,foreground,width:img.width,height:img.height};
  },png.toString('base64'));
  const sample={file,bytes:png.length,sha256:createHash('sha256').update(png).digest('hex'),...stats};
  report.screenshots.push(sample);return sample;
}
async function shot(page:Page,name:string) {
  const file=`${name}.png`;await page.screenshot({path:resolve(out,file)});const bytes=await readFile(resolve(out,file));
  assert.ok(bytes.length<15*1024*1024);assert.ok(report.screenshots.length<12);
  report.screenshots.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
async function change(frame:Frame,key:string,value:string) {await frame.locator(`[data-control="${key}"]`).fill(value);await frame.locator(`[data-control="${key}"]`).press('Tab');}
async function checkContrast(frame:Frame) {
  const result=await frame.evaluate<{theme:string;checked:number;failures:unknown[];body:string}>(`(()=>{
    const rgb=(s)=>s.match(/[\\d.]+/g).map(Number);
    const luminance=(c)=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    const failures=[];let checked=0;
    for(const element of document.querySelectorAll('#app *')) {
      if(!element.getClientRects().length || element.closest('button:disabled,input:disabled,select:disabled,[aria-hidden=true]'))continue;
      const text=[...element.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim();
      if(!text && !element.matches('input:not([type=color]):not([type=range]):not([type=checkbox]),select'))continue;
      const style=getComputedStyle(element);if(style.visibility!=='visible')continue;
      const foreground=rgb(style.color);let background=[255,255,255];
      const ancestors=[];for(let node=element;node;node=node.parentElement)ancestors.unshift(node);
      for(const node of ancestors){const c=rgb(getComputedStyle(node).backgroundColor),a=c[3]??1;background=background.map((v,i)=>v*(1-a)+c[i]*a);}
      const l1=luminance(foreground),l2=luminance(background),ratio=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
      checked++;if(ratio<4.5)failures.push({text:text.slice(0,70)||element.getAttribute('aria-label'),ratio,color:style.color,background});
    }
    return {theme:document.documentElement.dataset.theme,checked,failures,body:getComputedStyle(document.body).backgroundColor};
  })()`);
  assert.ok(result.checked>20);assert.deepEqual(result.failures,[],JSON.stringify(result));
  (report.contrast??=[]).push(result);
}
try {
  await client.connect(transport);
  const cif=await readFile(resolve('../fixtures/1CRN.cif'),'utf8');
  const opened=await call('inspect',{structureText:cif}), id=opened.structuredContent.sessionId;
  assert.ok(!JSON.stringify(opened).includes('_atom_site'));
  const resource=await client.readResource({uri:'ui://stereo-structure/inspector'});
  const html=(resource.contents[0] as any).text as string;
  assert.ok(html.includes('data:font/ttf;base64,') || html.includes('data:application/octet-stream;base64,'),'Fonts must be embedded');
  assert.ok(!html.includes('__ROUNDTRIP_CATALOGS__'));assert.ok(!html.includes('__stereofoldInspection'));
  assert.ok(!html.includes('stereofold-viewer-build-unstamped'));
  browser=await chromium.launch({headless:true});report.browserVersion=browser.version();
  let first=await mount(html,null,{});
  await first.page.waitForFunction(()=>(window as any).__host.connected);
  await first.frame.locator('html[data-theme="light"]').waitFor({state:'attached'});
  await checkContrast(first.frame);
  await first.page.emulateMedia({colorScheme:'dark'});
  await first.frame.locator('html[data-theme="dark"]').waitFor({state:'attached'});
  await checkContrast(first.frame);
  await first.page.evaluate(()=>(window as any).__host.setContext({theme:'light'}));
  await first.frame.locator('html[data-theme="light"]').waitFor({state:'attached'});
  passed('Panel follows system theme when unspecified; explicit light host theme overrides a dark OS');
  assert.equal(await first.frame.locator('.scene-heading h1').innerText(),'Loading structure…');
  assert.equal(await first.frame.locator('[data-fact="atoms"]').innerText(),'0');
  assert.equal(await first.frame.locator('[data-action="fit"]').isDisabled(),true);
  let hydrationCalls=0;
  first.intercept.after=async(p,response)=>{
    if(p.name==='stereo_structure.get_inspection') {
      hydrationCalls++;
      if(hydrationCalls===1) throw Error('MCP error -32600: thread not found: test-retired-task');
      if(hydrationCalls===2) return {isError:true,content:[{type:'text',text:'Test session transport unavailable.'}]};
    }
    return response;
  };
  await first.page.evaluate(result=>(window as any).__host.send(result),opened);
  await first.frame.locator('body[data-ready="error"]').waitFor({state:'attached'});
  assert.equal(await first.frame.locator('.scene-heading h1').innerText(),'Couldn’t load structure');
  assert.equal(await first.frame.locator('.last-action').innerText(),'No structure loaded');
  assert.equal(await first.frame.locator('.confirmation-dot').isVisible(),false);
  assert.match((await first.frame.locator('.session-notice:not([data-scene-preflight]) pre').textContent())!,/thread not found/);
  assert.match(await first.frame.locator('.session-notice:not([data-scene-preflight])').innerText(),/Structure load failed\. Choose Retry loading\./);
  assert.equal(await first.frame.getByRole('button',{name:'Load saved view',exact:true}).isVisible(),false);
  assert.equal(await first.frame.locator('[data-action="fit"]').isDisabled(),true);
  assert.equal((await call('get_inspection_state',{sessionId:id})).structuredContent.hasScene,false);
  await checkContrast(first.frame);await shot(first.page,'10-light-host-loading-error');
  await first.frame.getByRole('button',{name:'Retry loading',exact:true}).click();
  await first.frame.locator('.session-notice:not([data-scene-preflight])').filter({hasText:'Test session transport unavailable.'}).waitFor();
  assert.equal(await first.frame.locator('.scene-heading h1').innerText(),'Couldn’t load structure');
  assert.equal(await first.frame.locator('.last-action').innerText(),'No structure loaded');
  assert.equal(await first.frame.locator('.confirmation-dot').isVisible(),false);
  await first.frame.getByRole('button',{name:'Retry loading',exact:true}).click();
  await first.frame.locator('body[data-ready="true"]').waitFor();
  assert.equal(hydrationCalls,3);first.intercept.after=undefined;
  await first.frame.locator('.session-notice:not([data-scene-preflight])[hidden]').waitFor({state:'attached'});
  passed('Failed initial hydration keeps the actual MCP error, reports no loaded scene, and Retry loading recovers the same session');
  passed('Delayed host result shows an honest empty state and keeps scene controls disabled until hydration');
  const baseline=await waitSaved(id,d=>d.scene!==null);
  assert.equal(baseline.scene.inspection.appearance.representation,'cartoon');
  assert.equal(await first.frame.locator('.sequence button').count(),46);
  passed('Packaged inspector mounts, privately hydrates arbitrary mmCIF, renders 46 canonical sequence positions and saves its initial fitted camera');
  await checkContrast(first.frame);await shot(first.page,'08-light-host-loaded');
  await first.page.evaluate(()=>(window as any).__host.setContext({theme:'dark'}));
  await first.frame.locator('html[data-theme="dark"]').waitFor({state:'attached'});
  await checkContrast(first.frame);await shot(first.page,'09-dark-host-loaded');
  await first.page.emulateMedia({colorScheme:'light'});
  assert.equal(await first.frame.locator('html').getAttribute('data-theme'),'dark');
  for(const theme of ['light','dark']) {
    await first.page.evaluate(theme=>(window as any).__host.setContext({theme}),theme);
    await first.frame.locator(`html[data-theme="${theme}"]`).waitFor({state:'attached'});
    for(const tab of ['view','move','look']) {await first.frame.locator(`[data-tab="${tab}"]`).click();await checkContrast(first.frame);}
  }
  const themed=await privateView(id);
  assert.equal(themed.inspectionRevision,baseline.inspectionRevision);
  assert.deepEqual(themed.scene,baseline.scene);
  passed('Light and dark host changes keep all enabled workspace text at 4.5:1 contrast without changing molecular background, pose, selection or saved revision');
  assert.equal(await first.frame.getByRole('button',{name:'Pause rotation',exact:true}).isVisible(),true);
  await first.page.waitForTimeout(1200);
  const rotating=await privateView(id);
  assert.equal(rotating.inspectionRevision,baseline.inspectionRevision);
  assert.deepEqual(rotating.scene,baseline.scene);
  await first.frame.getByRole('button',{name:'Pause rotation',exact:true}).click();
  const pausedRotation=await waitSaved(id,d=>d.inspectionRevision>baseline.inspectionRevision);
  assert.notDeepEqual(pausedRotation.scene.inspection.placement.rotation,baseline.scene.inspection.placement.rotation);
  assert.deepEqual(pausedRotation.scene.camera,baseline.scene.camera);
  await first.page.waitForTimeout(600);
  assert.equal((await privateView(id)).inspectionRevision,pausedRotation.inspectionRevision);
  passed('Default rotation does not churn persisted revisions; Pause saves the visible orientation once without moving the camera');
  await first.frame.locator('[data-control="search"]').fill('8');await first.frame.locator('[data-control="search"]').press('Enter');
  await waitSaved(id,d=>d.scene.selectionKeys.length>0);
  await first.frame.locator('[data-control="labels"]').check();await waitSaved(id,d=>d.scene.inspection.appearance.labels);
  await first.frame.locator('[data-control="representation"]').selectOption('molecular-surface');await waitSaved(id,d=>d.scene.inspection.appearance.representation==='molecular-surface');
  await change(first.frame,'opacity','0.4');await waitSaved(id,d=>d.scene.inspection.appearance.opacity===.4);
  await change(first.frame,'background','#192734');await waitSaved(id,d=>d.scene.inspection.appearance.background==='#192734');
  await first.frame.locator('[data-tab="move"]').click();await change(first.frame,'scale','1.25');
  await waitSaved(id,d=>d.scene.inspection.placement.scale===1.25);
  await first.frame.locator('[data-vector="translation"][data-axis="x"]').fill('0.4');await first.frame.locator('[data-vector="translation"][data-axis="x"]').press('Tab');
  await waitSaved(id,d=>d.scene.inspection.placement.translation[0]===.4);
  await first.frame.locator('[data-tab="view"]').click();await first.frame.locator('[data-orbit="y,15"]').click();
  const changed=await waitSaved(id,d=>JSON.stringify(d.scene.camera)!==JSON.stringify(baseline.scene.camera));
  await shot(first.page,'01-inspector-edited');passed('Real controls save labels, transparent surface, background, molecule placement and independent viewpoint');
  await first.page.evaluate(()=>(window as any).__host.close());await first.page.close();
  const reopened=await call('inspect',{sessionId:id});first=await mount(html,reopened);await first.frame.locator('body[data-ready="true"]').waitFor();
  await first.frame.locator('#status').filter({hasText:'saved'}).waitFor();
  const restored=await privateView(id);assert.deepEqual(restored.scene,changed.scene);
  assert.equal(await first.frame.locator('[data-control="opacity"]').inputValue(),'0.4');
  assert.equal(await first.frame.locator('[data-control="background"]').inputValue(),'#192734');
  assert.equal(await first.frame.locator('[data-control="labels"]').isChecked(),true);
  await shot(first.page,'02-inspector-remounted');passed('New panel remount restores the exact complete current view without replaying a default pose');
  const second=await mount(html,await call('inspect',{sessionId:id}));await second.frame.locator('body[data-ready="true"]').waitFor();
  await second.frame.locator('#status').filter({hasText:'saved'}).waitFor();
  await change(first.frame,'background','#eee9dd');await waitSaved(id,d=>d.scene.inspection.appearance.background==='#eee9dd');
  await change(second.frame,'background','#445566');await second.frame.locator('.session-notice:not([data-scene-preflight]):not([hidden])').waitFor();
  assert.match(await second.frame.locator('.session-notice:not([data-scene-preflight])').innerText(),/unsaved/);
  assert.equal((await privateView(id)).scene.inspection.appearance.background,'#eee9dd');
  assert.equal(await second.frame.locator('[data-control="background"]').inputValue(),'#445566');
  await shot(second.page,'03-conflict-preserves-visible-work');
  await second.frame.getByRole('button',{name:'Load saved view',exact:true}).click();
  await second.frame.locator('.session-notice:not([data-scene-preflight])[hidden]').waitFor({state:'attached'});
  assert.equal(await second.frame.locator('[data-control="background"]').inputValue(),'#eee9dd');
  passed('Two live panels reject stale saves, preserve visible unsaved work, and recover through explicit Load saved view');
  const target=await first.frame.locator('body').getAttribute('data-panel-id');assert.ok(target);
  const request=async(commandId:string,change:any)=>{
    const state=await waitState(id,s=>s.panels.some((p:any)=>p.panelId===target && p.current && p.availability==='ready'));
    return {sessionId:id,serverEpoch:state.serverEpoch,sourceToken:state.sourceToken,baseStateRevision:state.stateRevision,
      baseInspectionRevision:state.inspectionRevision,panelId:target,commandId,change};
  };
  const beforeCommand=await privateView(id);
  const pixelsBefore=await canvasPixels(first.page,first.frame,'05-before-tool-command');
  const appearanceRequest=await request('browser-appearance',{kind:'appearance',patch:{representation:'ball-and-stick',color:'uniform',
    uniformColor:'#ee55bb',highlightColor:'#aaccff',background:'#0b2233',opacity:.55,labels:true,clipping:20,fog:25}});
  assert.equal((await call('update_inspection',appearanceRequest)).structuredContent.command.status,'queued');
  const appearanceState=await waitState(id,s=>s.command.status==='rendered','browser-appearance');
  const appearanceScene=(await privateView(id)).scene;
  assert.equal(appearanceState.view.appearance.background,'#0b2233');
  assert.deepEqual(appearanceScene.camera.position,beforeCommand.scene.camera.position);
  assert.deepEqual(appearanceScene.selectionKeys,beforeCommand.scene.selectionKeys);
  assert.equal(await first.frame.locator('[data-control="background"]').inputValue(),'#0b2233');
  const pixelsAfter=await canvasPixels(first.page,first.frame,'06-tool-appearance');
  assert.notEqual(pixelsAfter.sha256,pixelsBefore.sha256);assert.deepEqual(pixelsAfter.background,[11,34,51]);assert.ok(pixelsAfter.foreground>100);
  // The other mounted panel is never chosen implicitly or silently hydrated.
  assert.equal(await second.frame.locator('[data-control="background"]').inputValue(),'#eee9dd');
  passed('Public appearance tool changes actual molecule pixels, labels, colors, opacity and depth in only the explicitly targeted panel; receipt confirms the rendered revision');
  const placementRequest=await request('browser-placement',{kind:'placement',patch:{translation:[-.3,.2,0],rotation:[0,45,0],scale:1.1}});
  await call('update_inspection',placementRequest);await waitState(id,s=>s.command.status==='rendered','browser-placement');
  const placed=(await privateView(id)).scene;
  assert.deepEqual(placed.camera,appearanceScene.camera);assert.deepEqual(placed.inspection.placement,placementRequest.change.patch);
  assert.equal((await call('update_inspection',placementRequest)).structuredContent.command.renderedRevision,(await privateView(id)).inspectionRevision);
  const placementPixels=await canvasPixels(first.page,first.frame,'07-tool-placement');assert.notEqual(placementPixels.sha256,pixelsAfter.sha256);
  passed('Public placement tool moves and rotates rendered geometry while preserving the exact viewpoint; duplicate request does not replay');

  let releaseDelivery:()=>void=()=>{}, observedDelivery:()=>void=()=>{};
  const claimedDelivery=new Promise<void>(r=>observedDelivery=r);
  first.intercept.after=async(p,response)=>{
    if(p.name==='stereo_structure.poll_inspection' && (response as any)._meta?.['stereo_structure/inspection']?.delivery) {
      observedDelivery();await new Promise<void>(r=>releaseDelivery=r);
    }
    return response;
  };
  await call('update_inspection',await request('browser-manual-race',{kind:'appearance',patch:{background:'#ffffff'}}));
  await claimedDelivery;
  await first.frame.locator('[data-tab="look"]').click();await change(first.frame,'background','#334455');
  await waitSaved(id,d=>d.scene.inspection.appearance.background==='#334455');
  releaseDelivery();first.intercept.after=undefined;
  await waitState(id,s=>s.command.status==='unconfirmed','browser-manual-race');
  assert.equal(await first.frame.locator('[data-control="background"]').inputValue(),'#334455');
  assert.equal((await privateView(id)).scene.inspection.appearance.background,'#334455');
  passed('Delayed command delivery preserves a newer manual edit in both the rendered panel and saved scene');

  let heldRelease:()=>void=()=>{}, heldObserved:()=>void=()=>{};
  const heldClaim=new Promise<void>(r=>heldObserved=r);
  first.intercept.after=async(p,response)=>{
    if(p.name==='stereo_structure.poll_inspection' && (response as any)._meta?.['stereo_structure/inspection']?.delivery) {
      heldObserved();await new Promise<void>(r=>heldRelease=r);
    }
    return response;
  };
  await call('update_inspection',await request('browser-held-input',{kind:'placement',patch:{scale:1.5}}));await heldClaim;
  const box=await first.frame.locator('.stage canvas').boundingBox();assert.ok(box);
  await first.page.mouse.move(box.x+10,box.y+10);await first.page.mouse.down();heldRelease();first.intercept.after=undefined;
  await waitState(id,s=>s.command.status==='rejected','browser-held-input');await first.page.mouse.up();
  assert.equal((await privateView(id)).scene.inspection.placement.scale,1.1);
  passed('A held unmoved pointer blocks a delayed remote mutation through the same renderer admission guard');

  let dropped=false;
  first.intercept.after=async(p,response)=>{
    // Admission also uses this tool. Lose only the post-render receipt response.
    if(p.name==='stereo_structure.complete_inspection' && p.arguments?.scene && !dropped) {dropped=true;throw Error('Acceptance test: lost completion response');}
    return response;
  };
  const lostRequest=await request('browser-lost-receipt',{kind:'appearance',patch:{background:'#192734'}});
  await call('update_inspection',lostRequest);const confirmed=await waitState(id,s=>s.command.status==='rendered','browser-lost-receipt');
  const retryReceipt=first.frame.locator('.session-notice:not([data-scene-preflight])').getByRole('button',{name:'Retry',exact:true});
  await retryReceipt.waitFor();
  assert.equal(dropped,true,'The completion response must actually have been lost');
  await retryReceipt.click();
  await first.frame.locator('.session-notice:not([data-scene-preflight])[hidden]').waitFor({state:'attached'});first.intercept.after=undefined;
  assert.equal((await privateView(id)).inspectionRevision,confirmed.inspectionRevision);
  assert.equal(await first.frame.locator('[data-control="background"]').inputValue(),'#192734');
  passed('Lost completion receipt is retried without re-rendering or incrementing the saved revision again');
  let attachCalls=0;
  first.intercept.after=async(p,response)=>{
    if(p.name==='stereo_structure.attach_inspection') {attachCalls++;if(attachCalls===1)await new Promise(r=>setTimeout(r,1500));}
    return response;
  };
  for(let i=0;i<9;i++) {
    const oldPanel=await first.frame.locator('body').getAttribute('data-panel-id');
    await first.page.evaluate(result=>(window as any).__host.send(result),await call('inspect',{sessionId:id}));
    await first.frame.waitForFunction(old=>Boolean(document.body.dataset.panelId) && document.body.dataset.panelId!==old,oldPanel);
  }
  const panels=(await call('get_inspection_state',{sessionId:id})).structuredContent.panels;
  report.reopenedPanels=panels;report.reopenAttachCalls=attachCalls;first.intercept.after=undefined;
  assert.equal(attachCalls,9);assert.ok(panels.length<=2);assert.equal((await privateView(id)).inspectionRevision,confirmed.inspectionRevision);
  passed('Repeated source-free opens retire prior panel capabilities without filling the live-panel limit or changing the saved scene');
  await first.page.setViewportSize({width:440,height:720});await first.frame.getByRole('button',{name:'Sequence',exact:true}).click();
  const sequenceSheet=first.frame.locator('#sequence-sheet');
  await sequenceSheet.waitFor({state:'visible'});
  assert.equal(await sequenceSheet.getByRole('button',{name:'Focus selection',exact:true}).isVisible(),true);
  assert.equal(await sequenceSheet.getByRole('button',{name:'Focus selection',exact:true}).isEnabled(),true);
  assert.equal(await sequenceSheet.locator('.sequence button').count(),46);
  await shot(first.page,'04-narrow-panel');
  await first.page.evaluate(()=>(window as any).__host.setContext({theme:'light'}));
  await first.frame.locator('html[data-theme="light"]').waitFor({state:'attached'});
  await checkContrast(first.frame);await shot(first.page,'11-narrow-light-host');
  passed('Narrow embedded panel retains sequence navigation and selected-residue actions');
  const old=await call('open',{fixture:'three-depth-markers'}), oldResource=await client.readResource({uri:'ui://stereo-structure/viewer'});
  const legacy=await mount((oldResource.contents[0] as any).text,old);
  await legacy.frame.locator('#stereo-app canvas').first().waitFor({state:'visible'});
  const legacyUntil=Date.now()+120000;
  while(Date.now()<legacyUntil) {const state=(await call('get_state',{sessionId:old.structuredContent.sessionId})).structuredContent;if(state.diagnostics?.state?.structureLoaded){passed('Legacy stereo resource still mounts and reports a loaded structure');break;}await new Promise(r=>setTimeout(r,200));}
  assert.ok(report.cases.includes('Legacy stereo resource still mounts and reports a loaded structure'));
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);
  report.status='passed';
} catch(error) {report.failure=(error as Error).stack;report.stderr=stderr;throw error;}
finally {
  await browser?.close();report.cleanup.browserClosed=true;
  await client.close();report.cleanup.mcpClosed=true;
  await new Promise<void>(r=>http.close(()=>r()));report.cleanup.listenerClosed=true;
  await writeFile(resolve(out,'browser-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
