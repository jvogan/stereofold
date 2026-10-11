import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {describe,it,expect} from 'vitest';
import {rendererContextReport,inspectionFailureReceipt} from '../src/inspection-failure-receipt.js';
import {xrStartupSchema,classifyPanelAvailability} from '../src/inspection-contract.js';
import {busyPanelRefusal} from '../scripts/agent-arguments.js';
const source=readFileSync(new URL('../src/inspector.ts',import.meta.url),'utf8');
const reportSource=source.slice(source.indexOf('function xrStartupReport() {'),source.indexOf('\nconst outcome=',source.indexOf('function xrStartupReport() {')));
function page(supported=true){
 const startup={phase:'idle',pending:false,reloadRequired:false,mode:null,gestureActive:null,presenting:false};
 const snapshot={status:'ready',error:null} as {status:string;error:string|null};
 const h={rendererContextSupported:supported,rendererContextReport,workspace:{snapshot:()=>snapshot,viewer:{xr:{startup:()=>startup}}},pageInput:{},document:{body:{dataset:{}},visibilityState:'visible',hasFocus:()=>true},entryClicks:0,pointerDowns:0,trustedClick:null};
 const report=vm.runInNewContext(reportSource+';xrStartupReport',h);
 return {startup,snapshot,report};
}
describe('renderer context diagnostic heartbeat',()=>{
 it.each([false,true])('reports idle and active loss without a pending command, presenting=%s',presenting=>{
  const p=page();p.startup.presenting=presenting;p.snapshot.status='context_lost';p.snapshot.error='The molecular WebGL context was lost.';
  const report=xrStartupSchema.parse(p.report());expect(report.rendererContext).toMatchObject({status:'context_lost',error:p.snapshot.error});
  expect(report.rendererContext?.detail).toContain('reopen this same inspection');expect(classifyPanelAvailability(report)).toBe('context-lost');
  expect(inspectionFailureReceipt(Object.assign(Error(p.snapshot.error),{code:'context_lost'}))).toEqual({failure:'render_failed',failureReason:p.snapshot.error});
 });
 it('reports recovery and terminal error, then explicitly clears stale failure when ready',()=>{
  const p=page();for(const [status,cause] of [['recovering','context-recovering'],['error','renderer-error'],['ready','busy']]){p.snapshot.status=status;p.snapshot.error='prior failure';const r=xrStartupSchema.parse(p.report());expect(classifyPanelAvailability(r)).toBe(cause);if(status==='ready')expect(r.rendererContext).toBeNull();}
 });
 it('omits new telemetry entirely for a host without the capability',()=>{
  const p=page(false);p.snapshot.status='context_lost';expect(p.report()).not.toHaveProperty('rendererContext');expect(xrStartupSchema.parse(p.report()).rendererContext).toBeUndefined();
 });
 it('bounds diagnostics and does not mistake ordinary busy/loading for context loss',()=>{
  expect(rendererContextReport({status:'loading',error:'busy'})).toBeNull();
  expect(rendererContextReport({status:'error',error:'x'.repeat(3000)})?.error).toHaveLength(1024);
  expect(xrStartupSchema.safeParse({...page().report(),rendererContext:{status:'error',detail:'x',sourceToken:'untrusted'}}).success).toBe(false);
 });
 it.each(['context-lost','renderer-error','context-recovering'] as const)('provides actionable agent refusal for %s without granting admission',availabilityCause=>{
  const text=busyPanelRefusal([{panelId:'p',surface:'companion',availability:'busy',current:true,availabilityCause}],'companion busy');
  expect(text).toContain('No panel is ready');expect(text).toMatch(/reopen the same inspection|rebuilding its retained scene/);expect(text).not.toContain('guardian');
 });
});

it.each(['context_lost','recovering','error'] as const)('preserves hidden and blurred lifecycle classification alongside %s',status=>{
 for(const [sessionVisibility,cause,advice] of [['hidden','hidden-session','must clear it'],['visible-blurred','blurred','Dismiss it']] as const){
  const rendererContext=rendererContextReport({status,error:'Original renderer error'});
  const report=xrStartupSchema.parse({...page().report(),presenting:true,sessionVisibility,rendererContext});
  expect(classifyPanelAvailability(report)).toBe(cause);
  expect(report.rendererContext?.error).toBe('Original renderer error');
  const refusal=busyPanelRefusal([{panelId:'p',current:true,availability:'busy',availabilityCause:cause,xrStartup:report}],'companion busy');
  expect(refusal).toContain(advice);expect(refusal).toMatch(/reopen the same inspection|rebuilding its retained scene/);
 }
});
it.each([true,false])('keeps hidden-panel advice with a different failed panel, explicit cause=%s',explicit=>{
 const hidden={panelId:'hidden',current:true,availability:'busy',...(explicit?{availabilityCause:'hidden-session' as const}:{}),xrStartup:{presenting:true,sessionVisibility:'hidden'}};
 const failed={panelId:'failed',current:true,availability:'busy',...(explicit?{availabilityCause:'renderer-error' as const}:{}),xrStartup:{presenting:false,rendererContext:{status:'error'}}};
 for(const panels of [[hidden,failed],[failed,hidden]]){
  const refusal=busyPanelRefusal(panels,'two companion panels busy');expect(refusal).toContain('must clear it');expect(refusal).toContain('reopen the same inspection');expect(refusal.indexOf('must clear it')).toBeLessThan(refusal.indexOf('reopen the same inspection'));
 }
});
it('does not append stale or ready-panel failures to current hidden-panel advice',()=>{
 const refusal=busyPanelRefusal([
  {panelId:'hidden',current:true,availability:'busy',availabilityCause:'hidden-session'},
  {panelId:'stale',current:false,availability:'busy',availabilityCause:'renderer-error'},
  {panelId:'ready',current:true,availability:'ready',xrStartup:{rendererContext:{status:'error'}}},
 ],'companion busy');expect(refusal).toContain('must clear it');expect(refusal).not.toContain('reopen');
});
