import { beforeEach, expect, it, vi } from 'vitest';
import { demoInspectionInput } from '../scripts/demo-inspection-input.js';
import { readDemoIndex, resolveDemoStage } from '../scripts/quest-demo.js';

const sources=vi.hoisted(()=>({coordinates:vi.fn(),structure:vi.fn()}));
vi.mock('../scripts/quest-demo.js',async original=>{
  const module=await original<any>();
  return {...module,resolveCoordinates:sources.coordinates,resolveVolumeStructure:sources.structure};
});
beforeEach(()=>{
  sources.coordinates.mockReset();sources.structure.mockReset();
  sources.coordinates.mockImplementation(async(entry:any,cache:string)=>`${cache}/${entry.coordinates.file}`);
  sources.structure.mockImplementation(async(entry:any,cache:string)=>`${cache}/${entry.coordinates.volume.structure.file}`);
});
const index=await readDemoIndex();
const arrival=index.demos.find(entry=>entry.name==='microtubule-arrival')!;

it('opens the shipped density stage on its reference model and passes the prepared map separately',async()=>{
  const {entry}=resolveDemoStage(arrival,'density'),log=vi.fn(),cache='/tmp/demo-cache';
  const input=await demoInspectionInput(entry,'/tmp/lesson/density.json',cache,log);
  expect(input).toEqual({filePath:`${cache}/3JAK.cif`,lessonPath:'/tmp/lesson/density.json',densityPath:`${cache}/emd_6347-4x.map`});
  expect(sources.coordinates).toHaveBeenCalledExactlyOnceWith(entry,cache,log);
  expect(sources.structure).toHaveBeenCalledExactlyOnceWith(entry,cache,log);
});

it('keeps atomic stage coordinates as filePath without supplying a density map',async()=>{
  const {entry}=resolveDemoStage(arrival,'build'),log=vi.fn(),cache='/tmp/demo-cache';
  const input=await demoInspectionInput(entry,'/tmp/lesson/build.json',cache,log);
  expect(input).toEqual({filePath:`${cache}/${entry.coordinates.file}`,lessonPath:'/tmp/lesson/build.json',
    ...(entry.coordinates.assemblyId?{assemblyId:entry.coordinates.assemblyId}:{})});
  expect(sources.structure).not.toHaveBeenCalled();
});

it('preserves an explicit biological assembly on an atomic demo',async()=>{
  const entry=index.demos.find(entry=>entry.coordinates.assemblyId)!;
  expect(entry).toBeDefined();
  const input=await demoInspectionInput(entry,'/tmp/lesson/assembly.json','/tmp/demo-cache',()=>{});
  expect(input.assemblyId).toBe(entry.coordinates.assemblyId);
  expect(input).not.toHaveProperty('densityPath');
});

it('refuses a density run when its accompanying structure cannot be verified',async()=>{
  const {entry}=resolveDemoStage(arrival,'density');
  sources.structure.mockRejectedValue(Error('Reference structure digest mismatch.'));
  await expect(demoInspectionInput(entry,'/tmp/lesson/density.json','/tmp/demo-cache',()=>{})).rejects.toThrow('digest mismatch');
});
