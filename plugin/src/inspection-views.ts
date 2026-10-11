import { createHash, randomUUID } from 'node:crypto';
import type { InspectionScene, NamedViewIntent } from './inspection-contract.js';

/**
 * Each view keeps its own scene record in server memory, which the 2 MiB scene
 * bound caps at 2 MiB apiece. Sixteen views hold at most 32 MiB, and the desktop
 * Saved views panel lists them as plain rows.
 */
export const MAX_INSPECTION_VIEWS = 16;
export const MAX_INSPECTION_VIEW_NAME = 80;

export type InspectionViewIntent = {
  selectionCount: number;
  representation: string;
  color: string;
  /** Honest until the object-relative capture adapter lands. */
  orientation: 'not-captured' | 'object-relative';
  /**
   * How many chains and component classes this view hides.
   *
   * The hidden set itself rides in `supportedScene` and is restored from there.
   * This is the summary line, so a caller listing saved views can tell the one
   * saved with the water off from the one saved with the whole structure
   * showing without asking for a scene it is not allowed to read.
   */
  hiddenCount: number;
  /** Number of distinct residues carrying scoped appearance. */
  styledCount: number;
  companionStructure?:{sourceSha256:string;modelNumber:number;assemblyId:string};
};

export type InspectionViewRecord = {
  id: string;
  name: string;
  sourceSha256: string;
  modelNumber: number;
  assemblyId: string;
  createdRevision: number;
  viewRevision: number;
  supportedScene: InspectionScene;
  namedViewIntent?: NamedViewIntent;
  viewIntent: InspectionViewIntent;
};

export type InspectionViewSummary = Pick<InspectionViewRecord,'id'|'name'|'sourceSha256'|'modelNumber'|'assemblyId'|'createdRevision'|'viewRevision'|'viewIntent'>;
type CommandResult = Pick<InspectionViewRecord,'id'|'name'|'createdRevision'|'viewRevision'> & {signature:string};

function normalizedName(name: string): string {
  const value = name.trim().replace(/\s+/gu, ' ');
  if (!value || value.length > MAX_INSPECTION_VIEW_NAME) throw Error(`A view name must be 1–${MAX_INSPECTION_VIEW_NAME} characters.`);
  return value;
}

/** Chains plus classes taken off the screen; show-only-selection counts as one. */
const styledCountOf = (scene:InspectionScene) => new Set((scene.inspection.styles ?? []).flatMap(style=>style.selectionKeys)).size;

function comparisonIntent(scene:InspectionScene) {
  const value=scene.inspection.companionStructure;
  return value?{companionStructure:{sourceSha256:value.sourceSha256,modelNumber:value.modelNumber,assemblyId:value.assemblyId}}:{};
}
function hiddenCountOf(scene: InspectionScene): number {
  const visibility = scene.inspection.visibility;
  if (!visibility) return 0;
  return visibility.hiddenChains.length + visibility.hiddenClasses.length + (visibility.showOnlySelection ? 1 : 0);
}

function sameSource(scene: InspectionScene, source: Pick<InspectionScene, 'sourceSha256'|'modelNumber'|'assemblyId'>): boolean {
  return scene.sourceSha256 === source.sourceSha256 && scene.modelNumber === source.modelNumber && scene.assemblyId === source.assemblyId;
}

/** Session-owned bounded library. Scenes never leave app-private responses. */
export class InspectionViews {
  #records = new Map<string, InspectionViewRecord>();
  #commandResults = new Map<string, CommandResult>();

  list(source?: Pick<InspectionScene, 'sourceSha256'|'modelNumber'|'assemblyId'>): InspectionViewSummary[] {
    return [...this.#records.values()].filter(record => !source || sameSource(record.supportedScene, source))
      .map(record => structuredClone({id:record.id,name:record.name,sourceSha256:record.sourceSha256,modelNumber:record.modelNumber,
        assemblyId:record.assemblyId,createdRevision:record.createdRevision,viewRevision:record.viewRevision,viewIntent:record.viewIntent}));
  }

  assertCanSave(input:{name:string;scene:InspectionScene;replaceViewId?:string}):void {
    const name=normalizedName(input.name);
    const duplicate=[...this.#records.values()].find(record=>record.name.toLowerCase()===name.toLowerCase()
      && sameSource(record.supportedScene,input.scene));
    if(duplicate&&input.replaceViewId!==duplicate.id)
      throw Error(`A view named “${name}” already exists. Pass its viewId as replaceViewId to replace it explicitly.`);
    if(input.replaceViewId&&duplicate?.id!==input.replaceViewId)
      throw Error('replaceViewId does not identify the same-source view with this name.');
    if(!duplicate&&this.#records.size>=MAX_INSPECTION_VIEWS)
      throw Error(`This session already has ${MAX_INSPECTION_VIEWS} named views. Delete one before saving another.`);
  }

  assertCanCommit(input:{commandId:string;name:string;scene:InspectionScene;replaceViewId?:string;namedViewIntent?:NamedViewIntent}):void {
    const name=normalizedName(input.name);
    if(input.namedViewIntent&&!sameSource(input.scene,input.namedViewIntent)) throw Error('The named-view orientation belongs to a different structure, model, or assembly.');
    const signature=createHash('sha256').update(JSON.stringify({name,scene:input.scene,replaceViewId:input.replaceViewId??null,namedViewIntent:input.namedViewIntent??null})).digest('hex');
    const repeated=this.#commandResults.get(input.commandId);
    if(repeated) { if(repeated.signature!==signature) throw Error('This commandId was already used to save a different view.'); return; }
    this.assertCanSave(input);
  }

  save(input: { commandId: string; name: string; scene: InspectionScene; inspectionRevision: number; replaceViewId?: string; namedViewIntent?:NamedViewIntent }): InspectionViewRecord {
    this.assertCanCommit(input);
    const name = normalizedName(input.name);
    const signature=createHash('sha256').update(JSON.stringify({name,scene:input.scene,replaceViewId:input.replaceViewId??null,namedViewIntent:input.namedViewIntent??null})).digest('hex');
    const repeated = this.#commandResults.get(input.commandId);
    if (repeated) {
      if (repeated.signature!==signature)
        throw Error('This commandId was already used to save a different view.');
      const live=this.#records.get(repeated.id);
      if(live) return structuredClone(live);
      return {...repeated,sourceSha256:input.scene.sourceSha256,modelNumber:input.scene.modelNumber,
        assemblyId:input.scene.assemblyId,supportedScene:structuredClone(input.scene),...(input.namedViewIntent?{namedViewIntent:structuredClone(input.namedViewIntent)}:{}),
        viewIntent:{selectionCount:input.scene.selectionKeys.length,representation:input.scene.inspection.appearance.representation,
          color:input.scene.inspection.appearance.color,orientation:input.namedViewIntent?'object-relative':'not-captured',
          ...comparisonIntent(input.scene),hiddenCount:hiddenCountOf(input.scene),styledCount:styledCountOf(input.scene)}};
    }
    const duplicate = [...this.#records.values()].find(record => record.name.toLowerCase() === name.toLowerCase()
      && sameSource(record.supportedScene, input.scene));
    const id = duplicate?.id ?? randomUUID();
    const record: InspectionViewRecord = {
      id, name, sourceSha256: input.scene.sourceSha256, modelNumber: input.scene.modelNumber,
      assemblyId: input.scene.assemblyId, createdRevision: duplicate?.createdRevision ?? input.inspectionRevision,
      viewRevision: (duplicate?.viewRevision ?? 0) + 1, supportedScene: structuredClone(input.scene),
      ...(input.namedViewIntent?{namedViewIntent:structuredClone(input.namedViewIntent)}:{}),viewIntent: { selectionCount: input.scene.selectionKeys.length,
        representation: input.scene.inspection.appearance.representation,
        color: input.scene.inspection.appearance.color, orientation: input.namedViewIntent?'object-relative':'not-captured',
        ...comparisonIntent(input.scene),hiddenCount: hiddenCountOf(input.scene), styledCount: styledCountOf(input.scene) },
    };
    this.#records.set(id, record);
    this.#commandResults.set(input.commandId,{id,name,createdRevision:record.createdRevision,viewRevision:record.viewRevision,signature});
    while(this.#commandResults.size>32) this.#commandResults.delete(this.#commandResults.keys().next().value!);
    return structuredClone(record);
  }

  restore(viewId: string, source: Pick<InspectionScene, 'sourceSha256'|'modelNumber'|'assemblyId'>): InspectionViewRecord {
    const record = this.#records.get(viewId);
    if (!record) throw Error('That named view is not in this live inspection session.');
    if (!sameSource(record.supportedScene, source)) throw Error('That named view belongs to a different structure, model, or assembly.');
    return structuredClone(record);
  }

  delete(input: { viewId: string; source: Pick<InspectionScene, 'sourceSha256'|'modelNumber'|'assemblyId'>; viewRevision: number }): boolean {
    const record = this.#records.get(input.viewId);
    if (!record) return false;
    if (!sameSource(record.supportedScene, input.source)) throw Error('That named view belongs to a different structure, model, or assembly.');
    if (record.viewRevision !== input.viewRevision) throw Error('That named view changed. List the session views and try again.');
    this.#records.delete(input.viewId);
    return true;
  }
}
