import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { DEMO_INDEX_PATH, demoCoordinatePath, readGrowthIndex } from './molecular-growth.js';
import { ensureGrowthCoordinates, growthRecoveryCommand } from './growth-coordinates.js';
import { readAddressedDemoFile } from './addressed-demo-cache.js';
import { readBoundedJsonFile } from './inspection-scene-file.js';
import { parseMolecularLesson } from './molecular-lesson.js';

const demosRoot=dirname(DEMO_INDEX_PATH);
const beneath=(root:string,path:string)=>{const rel=relative(root,path);return rel!=='' && rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);};

/** Both lexical and resolved paths must remain within the shipped demos. */
export async function readBundledLesson(lessonPath:string) {
  const path=resolve(demosRoot,lessonPath);
  if(!beneath(demosRoot,path)) throw Error('lessonPath must be inside the plugin bundled demos directory.');
  const [root,actual]=await Promise.all([realpath(demosRoot),realpath(path)]);
  if(!beneath(root,actual)) throw Error('lessonPath must be inside the plugin bundled demos directory.');
  return parseMolecularLesson(await readBoundedJsonFile(path));
}

/** Resolve only indexed artifacts; reuse growth's verified fetch/derivation policy. */
export async function resolveBundledDemo(name:string,stageId?:string) {
  const index=await readGrowthIndex(),demo=index.demos.find(entry=>entry.name===name);
  if(!demo) throw Error(`Unknown bundled demo "${name}". Available: ${index.demos.map(entry=>entry.name).join(', ')}.`);
  const wanted=stageId??demo.defaultStage;
  const stage=wanted?demo.stages?.find(entry=>entry.id===wanted):undefined;
  if(wanted && !stage) throw Error(`Unknown stage "${wanted}" for ${name}. Available: ${demo.stages?.map(entry=>entry.id).join(', ')||'no stages'}.`);
  const entry=stage??demo,coordinates=entry.coordinates,volume=coordinates.volume;
  const lessonStarted=Date.now();
  const manifest=await readBundledLesson(entry.lesson);
  const lessonParseMs=Date.now()-lessonStarted,coordinatesStarted=Date.now();
  const structure=volume?.structure??coordinates;
  const ensured=await ensureGrowthCoordinates({demo:name,stageId:stage?.id??'default',
    file:structure.file,sha256:structure.sha256,download:structure.download,
    ...(!volume && coordinates.derivation?{derivation:coordinates.derivation}:{}),
  });
  // Prepared density maps are never generated inside a live session.
  const density=volume?await readAddressedDemoFile(demoCoordinatePath,coordinates.file,coordinates.sha256):undefined;
  if(volume && !density) throw Error(`The prepared density map is not cached. Run ${growthRecoveryCommand(name,stage!.id)} on this Mac, then load the demo.`);
  return {name,stage:stage?.id,entry,manifest,structure,source:{kind:'file' as const,path:ensured.path},
    ...(density?{densityPath:density.path}:{}),fetchedAt:ensured.fetchedAt,loadTimings:{lessonParseMs,coordinateVerificationMs:Date.now()-coordinatesStarted}};
}
