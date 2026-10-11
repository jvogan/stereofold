import { resolveCoordinates, resolveVolumeStructure, type DemoEntry } from './quest-demo.js';

/** Resolve the two source roles a volume lesson needs before opening a host. */
export async function demoInspectionInput(entry:DemoEntry,lessonPath:string,cache:string,log:(message:string)=>void) {
  const coordinates=await resolveCoordinates(entry,cache,log);
  const volume=entry.coordinates.volume;
  // A density tier's indexed coordinates are the map. The inspection session
  // still opens on its accompanying mmCIF model, as the public demo route does.
  const filePath=volume?await resolveVolumeStructure(entry,cache,log):coordinates;
  return {filePath,lessonPath,...(volume?{densityPath:coordinates}:{}),
    ...(entry.coordinates.assemblyId?{assemblyId:entry.coordinates.assemblyId}:{})};
}
