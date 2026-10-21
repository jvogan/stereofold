import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';
import {extractInspectionCatalogBytes} from '../src/inspection-catalog.js';
import {parseMolecularLesson} from '../src/molecular-lesson.js';
import {molecularLessonToTour} from '../src/molecular-lesson-tour.js';
import {validateLessonSource} from '../src/lesson-source-validation.js';
import {CIF} from '../src/compatible-cif.js';
import {trajectoryFromMmCIF} from 'molstar/lib/commonjs/mol-model-formats/structure/mmcif.js';
const root=new URL('../demos/',import.meta.url);
const load=async(path:string)=>JSON.parse(await readFile(new URL(path,root),'utf8'));
type BatchStage={id:string;lesson:string;coordinates:{derivation:{path:string};sha256:string;bytes:number;atomSites:number}};
const entry:{stageMode:string;defaultStage:string;stages:BatchStage[]}=await load('binder-gallery/extended/demo-index-entry.json');
describe('extended public binder gallery batches',()=>{
 it('connects all 211 examples through bounded stages with one shared coordinate frame',async()=>{
  expect(entry.stageMode).toBe('sequence');expect(entry.defaultStage).toBe('selected17');expect(entry.stages).toHaveLength(11);
  let total=0;const ids:string[]=[];
  for(const [index,stage]of entry.stages.entries()){
   const lesson=parseMolecularLesson(await load(stage.lesson));total+=lesson.chapters.length;
   expect(lesson.presentation?.coordinateFrame).toBe('binder-gallery-extended-aligned-v1');
   expect(lesson.presentation?.continueToStage).toBe(entry.stages[index+1]?.id);
   expect(lesson.chapters.length).toBeLessThanOrEqual(24);
   const tour=molecularLessonToTour(lesson);for(const step of tour.steps)expect(step.durationMs).toBe(3000);
   ids.push(...lesson.chapters.map(chapter=>chapter.id));
   for(const chapter of lesson.chapters)for(const label of chapter.immersive!.figure!.labels!)expect(label.text.length).toBeLessThanOrEqual(60);
  }
  expect(total).toBe(211);expect(new Set(ids).size).toBe(211);
  const selected=await load('binder-gallery/extended/selected17/lesson.json'),original=await load('binder-gallery/lesson.json');
  expect(selected.chapters.map((c:any)=>c.id)).toEqual(original.chapters.map((c:any)=>c.id));
  expect(selected.chapters.map((c:any)=>c.immersive)).toEqual(original.chapters.map((c:any)=>c.immersive));
 });
 it.each(entry.stages.slice(1))('parses and resolves every authored target in $id',async(stage)=>{
  const bytes=await readFile(new URL(stage.coordinates.derivation.path,root));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(stage.coordinates.sha256);expect(bytes.length).toBe(stage.coordinates.bytes);
  const parsed=await CIF.parse(bytes.toString()).run();if(parsed.isError)throw Error(String(parsed));
  const trajectory=await trajectoryFromMmCIF(parsed.result.blocks[0]).run();expect(trajectory.frameCount).toBe(1);
  expect(trajectory.representative.atomicHierarchy.atoms._rowCount).toBe(stage.coordinates.atomSites);expect(stage.coordinates.atomSites).toBeLessThanOrEqual(30_000);
  const lesson=parseMolecularLesson(await load(stage.lesson));const catalog:any=await extractInspectionCatalogBytes(bytes);
  expect(()=>validateLessonSource(lesson,catalog,catalog.modelNumbers[0])).not.toThrow();
  for(const chapter of lesson.chapters){
   const text=chapter.immersive!.figure!.labels!.find(label=>label.id==='binder-label')!.text;
   expect(text).toMatch(/^Design \d{3} · /u);
   expect(text.includes('not selected')||(text.includes('Pred. score')&&text.includes('Adaptyv'))).toBe(true);
   expect(chapter.immersive).not.toHaveProperty('view');expect(chapter.immersive).not.toHaveProperty('placement');
  }
 },120_000);
});
