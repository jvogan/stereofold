import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const [build, runtime, output] = process.argv.slice(2).map(p => resolve(p));
assert.ok(build && runtime && output, 'Supply build, XR runtime and fresh output paths.');
await mkdir(output, {recursive:false});
const report:any = {status:'failed',cases:[],errors:[],screenshots:[],cleanup:{}};
const passed = (name:string) => { report.cases.push(name); console.log(`Passed: ${name}`); };
const server = spawn(process.execPath, [resolve('../lab/inspection/serve.cjs'), '--build', build, '--xr-runtime', runtime], {stdio:['ignore','pipe','pipe']});
let serverOutput = '', serverError = '';
server.stdout.on('data', chunk => serverOutput += chunk);
server.stderr.on('data', chunk => serverError += chunk);
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try {
  const deadline = Date.now() + 120000;
  while(!serverOutput.includes('\n')) {
    if(server.exitCode!==null) throw Error(serverError || 'Preview server stopped.');
    assert.ok(Date.now()<deadline, 'Preview server did not start.');
    await new Promise(r=>setTimeout(r,50));
  }
  const {preview:origin} = JSON.parse(serverOutput.split('\n')[0]);
  assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1100,height:800},colorScheme:'light',reducedMotion:'no-preference'});
  page.setDefaultTimeout(120000);
  page.on('pageerror', e=>report.errors.push(e.message));
  page.on('console', message=>{if(message.type()==='error')(report.consoleErrors??=[]).push(message.text());});
  await page.route('**/*',route=>route.request().url().startsWith(origin+'/') ? route.continue() : route.abort());
  await page.goto(origin+'/emulation.html');
  const dock=page.getByRole('complementary',{name:'Quest emulation controls'});
  const ar=dock.getByRole('button',{name:'Enter emulated AR',exact:true});
  const vr=dock.getByRole('button',{name:'Enter emulated VR',exact:true});
  const leave=dock.getByRole('button',{name:'Leave XR',exact:true});
  await page.waitForFunction(()=>(window as any).__preview && document.body.dataset.ready==='true');
  await page.waitForFunction(()=>[...document.querySelectorAll<HTMLButtonElement>('aside[aria-label="Quest emulation controls"] button')].some(b=>b.textContent==='Enter emulated AR'&&!b.disabled));
  assert.equal(await leave.isDisabled(),true);
  assert.equal(await dock.getByRole('button',{name:'Head →',exact:true}).isDisabled(),true);
  const colors=await dock.evaluate(e=>({background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color}));
  assert.deepEqual(colors,{background:'rgb(243, 247, 248)',color:'rgb(25, 46, 53)'});
  passed('Served emulator uses the light palette and disables controls that require immersion');

  const state=() => page.evaluate(()=>(window as any).__stereofoldInspection.snapshot());
  const capture=() => page.evaluate(()=>(window as any).__stereofoldInspection.viewer.inspection.capture());
  const hash=async()=>createHash('sha256').update(await page.locator('.stage canvas').screenshot()).digest('hex');
  const original=await capture(), initial=await state();
  assert.equal(initial.inspectionMotion.paused,false);
  const before=await hash();await page.waitForTimeout(1800);const after=await hash();
  assert.notEqual(after,before);assert.deepEqual(await capture(),original);
  assert.equal((await state()).revision,initial.revision);
  passed('New structure rotates by default: pixels change while camera, saved scene and revision stay fixed');

  await page.getByRole('button',{name:'Pause rotation',exact:true}).click();
  await page.waitForFunction(()=>(window as any).__stereofoldInspection.snapshot().ready && (window as any).__stereofoldInspection.snapshot().inspectionMotion.paused);
  const paused=await state(), frozen=await capture();
  assert.equal(paused.inspectionMotion.paused,true);
  assert.notDeepEqual(frozen.inspection.placement.rotation,original.inspection.placement.rotation);
  assert.deepEqual(frozen.camera,original.camera);
  const still=await hash();await page.waitForTimeout(600);assert.equal(await hash(),still);
  assert.deepEqual(await capture(),frozen);
  passed('Pause freezes the displayed orientation once and retains a stable, saved placement');

  await page.getByRole('button',{name:'Rotate structure',exact:true}).click();
  await page.waitForTimeout(600);
  const box=await page.locator('.stage canvas').boundingBox();assert.ok(box);
  await page.mouse.click(box.x+10,box.y+10);
  await page.waitForFunction(()=>(window as any).__stereofoldInspection.snapshot().ready && (window as any).__stereofoldInspection.snapshot().inspectionMotion.paused);
  assert.equal((await state()).inspectionMotion.paused,true);
  const clicked=await capture();await page.waitForTimeout(400);assert.deepEqual(await capture(),clicked);
  passed('Direct canvas input pauses rotation persistently before the interaction');

  await page.getByRole('button',{name:'Rotate structure',exact:true}).click();
  await page.waitForTimeout(600);
  const point=await page.evaluate(() => {
    const app=(window as any).__stereofoldInspection;
    for(const row of app.rows()) {
      if(row.coordinateState!=='resolved')continue;
      try { return app.viewer.pickPoint(row.key); } catch { /* Try another visible residue. */ }
    }
    return null;
  });
  assert.ok(point,'A rotating residue must have a visible point in the actual pick buffer.');
  await page.mouse.click(point.x,point.y);
  await page.waitForFunction(key => {
    const current=(window as any).__stereofoldInspection.snapshot();
    return current.ready && current.lastPick?.status==='rendered' && current.selectionKeys.includes(key);
  },point.key);
  const picked=await state();
  assert.equal(picked.inspectionMotion.paused,true);
  assert.ok(picked.selectedMarkerCount>0);
  assert.deepEqual(await page.locator('.sequence button[aria-pressed="true"]').evaluateAll(buttons=>buttons.map(b=>(b as HTMLElement).dataset.key)),picked.selectionKeys);
  passed('Clicking a moving residue freezes its displayed pose and selects the same canonical sequence identity');

  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.querySelector<HTMLButtonElement>('[data-action="rotation"]')?.disabled);
  assert.equal((await state()).inspectionMotion.reason,'reduced-motion');
  assert.equal(await page.getByRole('button',{name:'Rotate structure',exact:true}).isDisabled(),true);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('[data-action="rotation"]')?.disabled);
  passed('Reduced-motion preference keeps automatic rotation off');

  await page.getByRole('button',{name:'Rotate structure',exact:true}).click();
  await page.waitForTimeout(600);
  await vr.dblclick();
  await page.waitForFunction(()=>(window as any).__preview.snapshot().presenting);
  await page.waitForFunction(()=>[...document.querySelectorAll<HTMLButtonElement>('aside[aria-label="Quest emulation controls"] button')].some(b=>b.textContent==='Enter emulated AR'&&b.disabled));
  assert.equal(await ar.isDisabled(),true);assert.equal(await vr.isDisabled(),true);
  await page.waitForFunction(()=>[...document.querySelectorAll<HTMLButtonElement>('aside[aria-label="Quest emulation controls"] button')].some(b=>b.textContent==='Leave XR'&&!b.disabled));
  assert.equal((await state()).inspectionMotion.paused,true);
  assert.match(await dock.getByRole('status').innerText(),/VR active/);
  await dock.getByRole('button',{name:'Rotate structure',exact:true}).click();
  await page.waitForFunction(()=>!(window as any).__stereofoldInspection.snapshot().inspectionMotion.paused);
  const entered=await capture();
  await dock.getByRole('button',{name:'Head →',exact:true}).click();
  assert.deepEqual(await capture(),entered);
  assert.equal((await state()).inspectionMotion.paused,false);
  const xr=(await page.evaluate(()=>(window as any).__preview.snapshot()));
  assert.equal(xr.active.mode,'immersive-vr');
  assert.equal(xr.sessions.length,0);
  const file='emulated-vr.png';await page.screenshot({path:resolve(output,file)});report.screenshots.push(file);
  passed('Rapid VR entry creates one session; dock can resume rotation during head movement while preserving the saved scene');
  await leave.click();
  await page.waitForFunction(()=>!(window as any).__preview.snapshot().presenting);
  await ar.click();await page.waitForFunction(()=>(window as any).__preview.snapshot().presenting);
  assert.equal((await page.evaluate(()=>(window as any).__preview.snapshot())).active.mode,'immersive-ar');
  await leave.click();
  await page.waitForFunction(()=>!(window as any).__preview.snapshot().presenting);
  assert.doesNotMatch(await dock.getByRole('status').innerText(),/Invalid explicit session request/);
  passed('Leave XR then enter AR works without the invalid-session error');
  await page.emulateMedia({colorScheme:'dark'});
  assert.equal(await dock.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(12, 20, 24)');
  passed('Emulator dock follows a live dark-theme change');
  assert.deepEqual(report.errors,[]);
  report.status='passed';
} catch(error) {report.failure=(error as Error).stack;report.serverError=serverError;throw error;}
finally {
  await browser?.close();report.cleanup.browserClosed=true;
  const stopped=once(server,'exit');server.kill('SIGTERM');if(server.exitCode===null)await stopped;
  report.cleanup.serverClosed=true;
  await writeFile(resolve(output,'browser-report.json'),JSON.stringify(report,null,2)+'\n');
}
