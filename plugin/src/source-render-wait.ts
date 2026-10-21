import type { GeometryBudgetReceipt } from './inspection-contract.js';
import type { InspectionFailureCode } from './inspection-failure-receipt.js';
/**
 * What the renderer proved about one source replacement.
 *
 * `renderedAt` and `renderedRevision` are here for the reason the
 * command receipts have them. Four `replace_inspection_source`
 * calls came back beside the sentence "The selected panel rendered and saved
 * the new source" while the caller's `rendered` field read false, because the
 * source path answered under a key no receipt reader knew and carried neither
 * the moment nor the revision a command receipt carries. A receipt that cannot
 * be told apart from no receipt is worth nothing to a caller.
 */
export type SourceRenderReceipt = { commandId?:string } & ({
  status:'rendered'; panelId:string; sourceToken:string; inspectionRevision:number;
  /** Host clock at the panel's post-save reattach. */
  renderedAt:number;
  /** The inspection revision the panel saved and reattached on. */
  renderedRevision:number;
  geometryBudget?:GeometryBudgetReceipt;
} | {
  status:'failed'; panelId:string; sourceToken:string; inspectionRevision:number;
  failedAt:number; failure:InspectionFailureCode; failureReason:string;
});

/** One replacement's completion signal. Fed by its renderer's post-save attach or source-bound refusal. */
export class SourceRenderWait {
  commandId?:string;
  private receipt?:SourceRenderReceipt;
  private listeners=new Set<(receipt:SourceRenderReceipt|undefined)=>void>();
  /** The receipt this replacement settled with, for a caller that arrives after the wait. */
  settled():SourceRenderReceipt|undefined { return this.receipt; }
  complete(receipt:SourceRenderReceipt) {
    this.receipt={...receipt,...(this.commandId?{commandId:this.commandId}:{})};
    for(const listener of this.listeners) listener(this.receipt);
    this.listeners.clear();
  }
  wait(timeoutMs:number):Promise<SourceRenderReceipt|undefined> {
    if(this.receipt || timeoutMs<=0) return Promise.resolve(this.receipt);
    return new Promise(resolve=>{
      const done=(receipt:SourceRenderReceipt|undefined)=>{
        clearTimeout(timer);this.listeners.delete(done);resolve(receipt);
      };
      const timer=setTimeout(()=>done(undefined),timeoutMs);
      this.listeners.add(done);
    });
  }
}
