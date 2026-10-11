import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { reloadOutdatedCompanion, rejectsPageBuild, type CompanionReloadState } from '../src/inspector-build-reload.js';
import { inspectionBindingSchema } from '../src/inspection-contract.js';

const idle:CompanionReloadState={dirty:false,presenting:false,enteringXr:false,voice:false,loading:false,rendering:false,
  navigating:false,interacting:false,pendingReceipt:false};

describe('outdated companion reload', () => {
  it('reloads once for a host build and continues when the same mismatch returns', () => {
    const values=new Map<string,string>();
    const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    const reload=vi.fn();
    const first='a'.repeat(64), next='b'.repeat(64);
    expect(reloadOutdatedCompanion(first,idle,storage,reload)).toBe(true);
    expect(reloadOutdatedCompanion(first,idle,storage,reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOutdatedCompanion(next,idle,storage,reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('ignores missing or invalid build replies and blocked storage', () => {
    const reload=vi.fn();
    const storage={getItem:()=>null,setItem:()=>{throw Error('blocked');}};
    expect(reloadOutdatedCompanion(undefined,idle,storage,reload)).toBe(false);
    expect(reloadOutdatedCompanion('a'.repeat(64),idle,storage,reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('finishes a delivered command before reloading the page', () => {
    const values=new Map<string,string>();
    const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    const reload=vi.fn(), build='a'.repeat(64);
    // A delivered command is chained on the page's render chain, so it reads as rendering.
    expect(reloadOutdatedCompanion(build,{...idle,rendering:true},storage,reload)).toBe(false);
    expect(reloadOutdatedCompanion(build,{...idle,pendingReceipt:true},storage,reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(reloadOutdatedCompanion(build,idle,storage,reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits for local work, rendering, and XR to finish', () => {
    const values=new Map<string,string>();
    const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
    const reload=vi.fn(), build='b'.repeat(64);
    for(const field of Object.keys(idle) as (keyof CompanionReloadState)[])
      expect(reloadOutdatedCompanion(build,{...idle,[field]:true},storage,reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(reloadOutdatedCompanion(build,idle,storage,reload)).toBe(true);
    expect(reloadOutdatedCompanion(build,idle,storage,reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('sends the page build on both companion registration and heartbeat', async () => {
    const source=await readFile(new URL('../src/inspector.ts',import.meta.url),'utf8');
    expect(source).toContain("name==='attach_inspection' || name==='poll_inspection'");
    expect(source).toContain('args={...args,pageBuild:document.body.dataset.inspectorBuild}');
    expect(source).toContain('pendingHostBuild=(result as any)?.structuredContent?.outdatedHostBuild');
    expect(source).toContain('void reloadPendingCompanion();');
  });
});

describe('a host from before build checks', () => {
  it('recognises the strict refusal of pageBuild and nothing else', () => {
    // The schema an older host validates attach with: the binding, strict, with no pageBuild.
    const older=inspectionBindingSchema.extend({surface:z.enum(['desktop','companion']).optional()});
    const refused=older.safeParse({sessionId:'a',serverEpoch:'b',baseStateRevision:1,baseInspectionRevision:1,sourceToken:'c',
      surface:'companion',pageBuild:'f'.repeat(64)});
    expect(refused.success).toBe(false);
    expect(rejectsPageBuild(refused.error!.message)).toBe(true);
    expect(rejectsPageBuild(`MCP error -32602: Invalid arguments for tool stereo_structure.attach_inspection: ${refused.error!.message}`)).toBe(true);
    expect(rejectsPageBuild('pageBuild: String must contain exactly 64 character(s)')).toBe(false);
    expect(rejectsPageBuild('The panel must save or load the current inspection before attaching.')).toBe(false);
    expect(rejectsPageBuild(undefined)).toBe(false);
  });

  it('holds the reload through Enter VR and voice on the page', async () => {
    const source=await readFile(new URL('../src/inspector.ts', import.meta.url),'utf8');
    // The check runs on its own timer, after the render chain has settled.
    expect(source).toMatch(/if\(isCompanion\) setInterval\(\(\)=>\{ void reloadPendingCompanion\(\); \},1000\);/u);
    expect(source).toMatch(/rendering:remote \|\| !settled \|\| !snapshot\.ready/u);
    expect(source).toMatch(/enteringXr:workspace\.viewer\.xr\?\.startup\?\.\(\)\?\.pending===true/u);
    expect(source).toMatch(/voice:Boolean\(voiceInteraction\) && !\['idle','error'\]\.includes\(voiceInteraction\.state\(\)\)/u);
  });

  it('retries attach and poll without pageBuild once the host refuses it', async () => {
    const source=await readFile(new URL('../src/inspector.ts', import.meta.url),'utf8');
    expect(source).toMatch(/hostTakesPageBuild=false;[\s\S]{0,200}result=await invoke\(args\)/u);
  });
});
