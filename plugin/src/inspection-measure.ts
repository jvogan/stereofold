import { createHash } from 'node:crypto';
import { arrayAtMost } from './array-bounds.js';
import { z } from 'zod';
import { inspectionResidueQuerySchema } from './inspection-residues.js';
// @ts-ignore Shared interpolation and geometry also used by the renderer.
import { measurementValues, measurementPosition, measurementTrack } from '../../lab/browser-roundtrip/measurement-math.mjs';

// @ts-ignore Shared renderer visibility at the exact sampled animation time.
import { evaluateTrackVisibility } from '../../packages/motion/src/keyframes.mjs';
// @ts-ignore Shared scene chain/class/selection visibility.
import { hiddenRowKeys } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

const text=z.string().trim().min(1).max(128);
export const measurementTargetSchema=inspectionResidueQuerySchema.omit({classes:true,selectedOnly:true,offset:true,limit:true}).extend({
  part:text.optional().describe('Lesson part id: choose the atom nearest its CA/P centroid, or all-atom centroid if neither exists; the result names the exact atom.'),
  visiblePartsOffset:z.number().int().min(0).optional().describe('Offset into visible part alternatives for this endpoint; repeat at the same sampled time for subsequent pages.'),
  cursor:z.string().max(96).optional().describe('Next candidate page returned for this same target and source.'),
  authorResidue:z.number().int().optional().describe('Exact author residue number; ranges use authorResidueRange.'),
  labelSequenceId:z.number().int().positive().optional(),
  atomName:text.optional().describe('Label atom name, such as CA, OE1 or NH1. Omit only when the other fields resolve exactly one atom.'),
  authorAtomName:text.optional(), insertionCode:z.string().max(16).nullable().optional(),
  alternateSite:z.string().max(16).nullable().optional(), copyId:text.optional().describe('Assembly copy from returned candidates.'),
}).strict();
export const measurementEndpointSchema=z.object({key:z.string().min(1).max(2048),authorChain:z.string().nullable(),
  authorResidue:z.number().int().nullable().optional(),componentId:z.string().nullable().optional(),
  position:z.array(z.number().finite()).refine(v => v.length === 3, 'Expected exactly 3 items.')}).strict();
export const measurementLineSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  a:measurementEndpointSchema,b:measurementEndpointSchema,color:z.string().regex(/^#[0-9a-f]{6}$/iu)}).strict();
export const measurementLinesSchema=z.array(measurementLineSchema).superRefine(arrayAtMost(32));
export type MeasurementTarget=z.output<typeof measurementTargetSchema>;

function identity(atom:any) {
  const i=atom.identity;
  return {key:atom.key,labelChain:i.labelChain,authorChain:i.authorChain,labelSequenceId:i.labelSequenceId,
    authorResidue:i.authorResidue,insertionCode:i.insertionCode,componentId:i.componentId,
    atomName:i.atomName,authorAtomName:i.authorAtomName,alternateSite:i.alternateSite,copyId:i.copyId,
    label:`${i.componentId} ${i.authorChain ?? i.labelChain}:${i.authorResidue ?? i.labelSequenceId}${i.insertionCode ?? ''} ${i.atomName}`};
}
function matches(atom:any,target:MeasurementTarget,skip?:string) {
  const i=atom.identity;
  return Object.entries(target).every(([field,value])=> field===skip || field==='part' || field==='cursor' || field==='visiblePartsOffset' || value===undefined ||
    (field==='authorResidueRange' && Array.isArray(value) ? i.authorResidue!==null && i.authorResidue>=value[0] && i.authorResidue<=value[1]
      : field==='labelSequenceRange' && Array.isArray(value) ? i.labelSequenceId!==null && i.labelSequenceId>=value[0] && i.labelSequenceId<=value[1]
      : (i[field] ?? '')===(value ?? '')));
}
const PAGE_SIZE=8;
const inPart=(atom:any,part:any)=> (!part.chain || atom.identity.authorChain===part.chain || atom.identity.labelChain===part.chain)
  && (!part.residues || (atom.identity.authorResidue!==null && atom.identity.authorResidue>=part.residues.from && atom.identity.authorResidue<=part.residues.to));
function representative(atoms:any[]) {
  const backbone=atoms.filter(atom=>['CA','P'].includes(atom.identity.atomName));
  const pool=backbone.length?backbone:atoms;
  if(!pool.length) return undefined;
  const center=[0,1,2].map(i=>pool.reduce((sum,atom)=>sum+atom.assemblyCoordinatesAngstrom[i],0)/pool.length);
  const distance=(atom:any)=>center.reduce((sum,v,i)=>sum+(v-atom.assemblyCoordinatesAngstrom[i])**2,0);
  return pool.reduce((best,atom)=>distance(atom)<distance(best)?atom:best);
}
function candidate(atom:any,parts:any[]) {
  const i=atom.identity;
  const memberships=parts.filter(part=>inPart(atom,part)).map(part=>({id:part.id,label:part.label}));
  return {label:`${identity(atom).label}${memberships.length?' — '+memberships.map(part=>part.label).join(', '):''}`,
    labelChain:i.labelChain,authorResidue:i.authorResidue,atomName:i.atomName,
    ...(i.insertionCode?{insertionCode:i.insertionCode}:{}),
    alternateSite:i.alternateSite??null,copyId:i.copyId,
    ...(i.authorResidue==null?{labelSequenceId:i.labelSequenceId,componentId:i.componentId}:{}),
    ...(memberships.length?{parts:memberships}:{} )};
}
/** Pure readback over the exact active model and assembly catalog. */
export function measureAtoms(catalog:any,scene:any,targets:MeasurementTarget[],sample:any,parts:any[]=[]) {
  const atoms=catalog.rows.filter((r:any)=>r.identity.modelNumber===scene.modelNumber).flatMap((r:any)=>r.atomSites);
  const resolved:any[]=[], errors:any[]=[];
  const pageSize=Math.min(PAGE_SIZE,Math.floor(16/targets.length));
  targets.forEach((target,index)=>{
    const part=target.part?parts.find(p=>p.id===target.part):undefined;
    if(target.part && !part) {
      errors.push({field:`targets.${index}.part`,code:'missing',message:'Unknown lesson part; read lesson.parts.',
        candidates:parts.slice(0,PAGE_SIZE).map(p=>({label:p.label,target:{part:p.id}}))});
      return;
    }
    const scope=part?atoms.filter((atom:any)=>inPart(atom,part)):atoms;
    const found=scope.filter((atom:any)=>matches(atom,target));
    const chosen=part?representative(found):found.length===1?found[0]:undefined;
    if(chosen) { resolved.push(chosen); return; }
    let candidates=found, field=`targets.${index}`;
    if(!found.length) {
      // One bounded page per endpoint, even when several fields are wrong.
      const near=Object.keys(target).filter(key=>!['part','cursor','visiblePartsOffset'].includes(key))
        .map(key=>({key,atoms:scope.filter((atom:any)=>matches(atom,target,key))})).find(v=>v.atoms.length);
      candidates=near?.atoms??scope;
      if(near) field+='.'+near.key;
    }
    const {cursor,visiblePartsOffset,...query}=target;
    const fingerprint=createHash('sha256').update(JSON.stringify([catalog.source?.sha256,scene.modelNumber,scene.assemblyId,query,candidates.map((a:any)=>a.key)])).digest('hex').slice(0,16);
    const page=cursor?.match(/^(\d+):([a-f0-9]{16})$/);
    const offset=page?Number(page[1]):0;
    if(cursor && (!page || page[2]!==fingerprint || !Number.isSafeInteger(offset) || offset>=candidates.length)) {
      errors.push({field:`targets.${index}.cursor`,code:'stale_cursor',message:'Repeat the target without cursor for a fresh page.',candidates:[]}); return;
    }
    const relevant=parts.filter(p=>candidates.some((atom:any)=>inPart(atom,p)));
    errors.push({field,code:found.length?'ambiguous':'missing',message:found.length?'Choose an atom selector or representative part.':'No atom matches this target.',
      candidateCount:candidates.length,cursor:offset+pageSize<candidates.length?`${offset+pageSize}:${fingerprint}`:null,
      candidates:candidates.slice(offset,offset+pageSize).map((atom:any)=>candidate(atom,parts)),
      ...(relevant.length?{representativeOptions:relevant.slice(0,PAGE_SIZE).map(p=>({label:p.label,target:{part:p.id}}))}:{})});
  });
  if(errors.length) return {ok:false,errors};
  const animation=scene.inspection.animation;
  if(animation && sample && (sample.id!==animation.playback.id || sample.chapterId!==animation.playback.chapterId))
    return {ok:false,errors:[{field:'sessionId',code:'animation_sample_mismatch',message:'The panel and saved scene name different animated chapters. Read current state and retry.',candidates:[]}]};
  const playback=sample ?? animation?.playback;
  const definition=animation?.definition;
  const timeSeconds=playback?.timeSeconds ?? 0;
  const hiddenRows=new Set(hiddenRowKeys(catalog.rows,scene.inspection.visibility,scene.selectionKeys));
  const hiddenAtoms=new Set(catalog.rows.filter((row:any)=>hiddenRows.has(row.key)).flatMap((row:any)=>row.atomSites.map((atom:any)=>atom.key)));
  const visible=(atom:any)=>{
    const track=measurementTrack({authorChain:atom.identity.authorChain,authorResidue:atom.identity.authorResidue,componentId:atom.identity.componentId},definition);
    return !hiddenAtoms.has(atom.key) && (!track || evaluateTrackVisibility(track,timeSeconds));
  };
  // A part alternative resolves to the same representative that measure(part) uses.
  const visiblePartIds=parts.filter(part=>{const atom=representative(atoms.filter((a:any)=>inPart(a,part)));return atom && visible(atom);}).map(part=>part.id);
  const visibility=resolved.map((atom,index)=>{
    const offset=targets[index].visiblePartsOffset??0;
    return {visible:visible(atom),visiblePartIds:visiblePartIds.slice(offset,offset+pageSize),
      visibleParts:{offset,total:visiblePartIds.length,nextOffset:offset+pageSize<visiblePartIds.length?offset+pageSize:null}};
  });
  const endpoints=resolved.map(atom=>({key:atom.key,authorChain:atom.identity.authorChain,authorResidue:atom.identity.authorResidue,componentId:atom.identity.componentId,position:atom.assemblyCoordinatesAngstrom}));
  const positions=endpoints.map(endpoint=>measurementPosition(endpoint,definition,timeSeconds));
  const bodies=endpoints.map(endpoint=>measurementTrack(endpoint,definition)?.id ?? null);
  try {
    return {ok:true,atoms:resolved.map((atom,index)=>({...identity(atom),...visibility[index],...(targets[index].part?{part:targets[index].part,representative:'atom nearest CA/P centroid; all atoms if neither exists'}:{}),positionAngstrom:positions[index],movingBodyId:bodies[index]})),
      ...measurementValues(positions),animation:{moving:bodies.some(Boolean),changesWithAnimation:new Set(bodies).size>1,
        ...(animation?{id:playback.id,chapterId:playback.chapterId,timeSeconds,state:playback.state,
          sample:sample?'latest reported panel time; no host extrapolation':'saved animation time; no host extrapolation'}:{})},endpoints};
  } catch(error) { return {ok:false,errors:[{field:'targets',code:'degenerate',message:(error as Error).message,candidates:[]}]}; }
}
