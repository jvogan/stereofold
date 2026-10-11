import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {pttLaunchEnabled} from '../src/ptt-launch-options.js';
import {replaceInspectionSourceSchema,SOURCE_RENDER_WAIT_CEILING_MS} from '../src/inspection-contract.js';
import {PANEL_SAVE_WAIT} from '../scripts/panel-wait.js';
it('resolves standalone voice flags and environment without changing the default',()=>{
  expect(pttLaunchEnabled([],{},false)).toBe(false);
  expect(pttLaunchEnabled([],{STEREOFOLD_PTT_TRANSCRIBE:'1'},false)).toBe(true);
  expect(pttLaunchEnabled([],{STEREOFOLD_PTT_TRANSCRIBE:'0'},true)).toBe(false);
  expect(pttLaunchEnabled(['--ptt'],{STEREOFOLD_PTT_TRANSCRIBE:'0'},false)).toBe(true);
  expect(pttLaunchEnabled(['--no-ptt'],{STEREOFOLD_PTT_TRANSCRIBE:'1'},true)).toBe(false);
  expect(pttLaunchEnabled(['--ptt','--no-ptt'],{},true)).toBe(false);
});
it('wires the standalone child environment from the resolved mode',async()=>{
  const source=await readFile(new URL('../scripts/serve-inspection.ts',import.meta.url),'utf8');
  expect(source).toContain('pttLaunchEnabled(rawArgs,process.env,false)');
  expect(source).toContain("STEREOFOLD_PTT_TRANSCRIBE:'1'");
  expect(source).toContain("STEREOFOLD_PTT_TRANSCRIBE:'0'");
  const launcher=await readFile(new URL('../scripts/quest-share.ts',import.meta.url),'utf8');
  expect(launcher).toContain("options.pushToTalk ? ['--ptt'] : ['--no-ptt']");
});
// The ceiling used to be 30 s, which is shorter than the
// host's own budget for loading a structure (130 s for the 4,779 sites of
// 4HHB), so a caller could not ask to be told when the wearer could see it.
// It is now the panel save budget's own cap. The host still clamps what it was
// sent down to the budget for the source actually being loaded.
it(`caps the optional source render wait at the host's own ${SOURCE_RENDER_WAIT_CEILING_MS} ms ceiling`,()=>{
  const base={sessionId:'s',serverEpoch:'e',sourceToken:'t',baseStateRevision:0,baseInspectionRevision:0,
    panelId:'00000000-0000-4000-8000-000000000000',pdbId:'1CRN'};
  expect(SOURCE_RENDER_WAIT_CEILING_MS).toBe(PANEL_SAVE_WAIT.capMs);
  // A wait long enough for the 130 s this host budgets for 4HHB is allowed:
  // whatever else this fixture fails, it no longer fails on the wait itself.
  const long=replaceInspectionSourceSchema.safeParse({...base,waitForRenderMs:130_000});
  if(!long.success)expect(long.error.issues.some(i=>i.path[0]==='waitForRenderMs')).toBe(false);
  // Assert on the named field so binding validation cannot mask an uncapped wait.
  for(const waitForRenderMs of [-1,SOURCE_RENDER_WAIT_CEILING_MS+1,1.5]) {
    const result=replaceInspectionSourceSchema.safeParse({...base,waitForRenderMs});
    expect(result.success).toBe(false);
    if(!result.success)expect(result.error.issues.some(i=>i.path[0]==='waitForRenderMs')).toBe(true);
  }
});
