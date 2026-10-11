import { z } from 'zod';
import type { InspectionScene } from './inspection-contract.js';
// @ts-ignore The page's own class rule, so "the ligands" names the same rows a hide does.
import { VISIBILITY_COMPONENT_CLASSES, componentClassOf } from '../../lab/browser-roundtrip/inspection-visibility.mjs';

const canonicalText = z.string().min(1).max(128);
const residueNumber = z.number().int().min(-1_000_000).max(1_000_000);
const labelSequence = z.number().int().positive().max(1_000_000);
// An array of exactly two rather than a tuple, so OpenAI-hosted agents keep the tool (tuple `items` are dropped).
const inclusiveRange = (item:z.ZodNumber, message:string) => z.array(item).superRefine((v,ctx) => { if(v.length!==2) ctx.addIssue({code:'custom',message:'Expected exactly 2 values.'}); }).transform(v => v as [number,number]).superRefine(([from,to],ctx) => {
  if (from > to) ctx.addIssue({code:'custom',message});
});

/**
 * A bounded, identity-only page over the active saved inspection model.
 * This deliberately contains no atom sites or coordinate values.
 */
export const inspectionResidueQuerySchema = z.object({
  labelChain:canonicalText.optional(),
  authorChain:canonicalText.optional(),
  componentId:canonicalText.optional(),
  // No minItems or maxItems: Codex keeps only plain array shapes, so the bound is a refinement.
  classes:z.array(z.enum(VISIBILITY_COMPONENT_CLASSES as unknown as [string,...string[]]))
    .superRefine((v,ctx) => { if(!v.length || v.length>4) ctx.addIssue({code:'custom',message:'Name one to four classes.'}); }).optional(),
  authorResidueRange:inclusiveRange(residueNumber,'authorResidueRange must be ordered.').optional(),
  labelSequenceRange:inclusiveRange(labelSequence,'labelSequenceRange must be ordered.').optional(),
  selectedOnly:z.boolean().optional(),
  offset:z.number().int().nonnegative().max(20_000).default(0),
  limit:z.number().int().min(1).max(128).default(64),
}).strict();
export type InspectionResidueQuery = z.output<typeof inspectionResidueQuerySchema>;

type CatalogRow = {
  key:string;
  coordinateState:string;
  entityType?:string;
  identity:{
    modelNumber:number; assemblyId:string; copyId:string; entityId:string;
    labelChain:string; authorChain:string|null; labelSequenceId:number|null;
    authorResidue:number|null; insertionCode:string|null; componentId:string;
  };
};
type Catalog = { rows:CatalogRow[] };

function matches(row:CatalogRow, query:InspectionResidueQuery, selected:Set<string>, modelNumber:number) {
  const identity=row.identity;
  if (identity.modelNumber!==modelNumber) return false;
  if (query.labelChain!==undefined && identity.labelChain!==query.labelChain) return false;
  if (query.authorChain!==undefined && identity.authorChain!==query.authorChain) return false;
  if (query.componentId!==undefined && identity.componentId!==query.componentId) return false;
  if (query.classes && !query.classes.includes(componentClassOf(row) ?? '')) return false;
  if (query.authorResidueRange && (identity.authorResidue===null || identity.authorResidue<query.authorResidueRange[0] || identity.authorResidue>query.authorResidueRange[1])) return false;
  if (query.labelSequenceRange && (identity.labelSequenceId===null || identity.labelSequenceId<query.labelSequenceRange[0] || identity.labelSequenceId>query.labelSequenceRange[1])) return false;
  return !query.selectedOnly || selected.has(row.key);
}

/**
 * Page canonical residue identities for an already-saved scene. The caller
 * parses `query` with `inspectionResidueQuerySchema`; accepting the typed value
 * makes query validation reusable by the public tool without broadening this
 * helper into a second command surface.
 */
/**
 * Every canonical key a region query names, rather than one page of them.
 *
 * `focus_selection` has to hand the panel a whole region: a chain that pages
 * out over ten screens is still one thing a wearer asked to see. The rows and
 * the matching are the page's, so the two can never disagree about what a
 * chain or a residue range means; only the bound differs.
 */
export function inspectionResidueKeys(catalog:Catalog, scene:InspectionScene|null,
  query:Omit<InspectionResidueQuery,'offset'|'limit'>, max=20_000):string[] {
  if (!scene) throw Error('Save the inspection before looking up residues.');
  const selected=new Set(scene.selectionKeys);
  const keys:string[]=[];
  for (const row of catalog.rows) {
    if (!matches(row,{...query,offset:0,limit:1},selected,scene.modelNumber)) continue;
    if (keys.length>=max) throw Error(`That region names more than ${max} residues. Narrow it with a residue range.`);
    keys.push(row.key);
  }
  return keys;
}

export function inspectionResiduePage(catalog:Catalog, scene:InspectionScene|null, query:InspectionResidueQuery) {
  if (!scene) throw Error('Save the inspection before looking up residues.');
  const selected=new Set(scene.selectionKeys);
  const rows=catalog.rows.filter(row=>matches(row,query,selected,scene.modelNumber));
  const page=rows.slice(query.offset,query.offset+query.limit).map(row=>({
    key:row.key,
    identity:{
      modelNumber:row.identity.modelNumber,
      assemblyId:row.identity.assemblyId,
      copyId:row.identity.copyId,
      entityId:row.identity.entityId,
      labelChain:row.identity.labelChain,
      authorChain:row.identity.authorChain,
      labelSequenceId:row.identity.labelSequenceId,
      authorResidue:row.identity.authorResidue,
      insertionCode:row.identity.insertionCode,
      componentId:row.identity.componentId,
    },
    coordinateState:row.coordinateState,
    selected:selected.has(row.key),
  }));
  return {total:rows.length,offset:query.offset,limit:query.limit,rows:page};
}
