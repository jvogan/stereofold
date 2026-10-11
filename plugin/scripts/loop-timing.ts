import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const stages = ['microphone-release','transcript-received','action-posted','receipt-rendered','spoken-confirmation-started'] as const;
type Stage = typeof stages[number];
type Sample = { at:number; clock:'page'|'host' };
type Entry = { seq?:number; at:number; kind:string; detail:{stage?:string;commandId?:string;utteranceId?:string} };
type Receipt = { commandId:string; utteranceId?:string; actionPostedAt?:number; acceptedAt?:number; renderedAt?:number; status?:string };
export type LoopRow = { commandId:string; utteranceId?:string; times:Partial<Record<Stage,Sample>> };
const validTime = (v:unknown):v is number => typeof v==='number' && Number.isFinite(v) && v>=0 && v<=8.64e15;

/** Accept a saved state response, its command list, or one receipt. */
function receiptsFrom(value:any):Receipt[] {
  if(Array.isArray(value)) return value.flatMap(receiptsFrom);
  if(!value || typeof value!=='object') return [];
  if(value.structuredContent) return receiptsFrom(value.structuredContent);
  if(value.commands) return receiptsFrom(value.commands);
  if(value.command) return receiptsFrom(value.command);
  return typeof value.commandId==='string' ? [value] : [];
}

/** Join exact IDs only. An utterance may have several host commands. */
export function loopTimings(diagnostics:unknown, hostReceipts:unknown):LoopRow[] {
  if(!Array.isArray(diagnostics)) throw Error('Diagnostics must be a JSON list.');
  const entries=diagnostics.filter((e):e is Entry => e?.kind==='voice-loop' && validTime(e.at) && e.detail && stages.includes(e.detail.stage));
  const receipts=receiptsFrom(hostReceipts);
  const rows=new Map<string,LoopRow>();
  const row=(id:string,utteranceId?:string) => {
    let found=rows.get(id);
    if(!found) { found={commandId:id,times:{}}; rows.set(id,found); }
    if(utteranceId) found.utteranceId=utteranceId;
    return found;
  };
  const put=(r:LoopRow,stage:Stage,at:unknown,clock:'page'|'host') => {
    if(!validTime(at)) return;
    const old=r.times[stage];
    // Prefer a page receipt observation, keeping page-only gaps on one clock.
    if(!old || (old.clock===clock && at<old.at) || (clock==='page' && old.clock==='host')) r.times[stage]={at,clock};
  };
  for(const r of receipts) {
    const target=row(r.commandId,r.utteranceId);
    put(target,'action-posted',r.actionPostedAt,'host');
    if(r.status==='rendered') put(target,'receipt-rendered',r.renderedAt,'host');
  }
  for(const e of entries) if(e.detail.commandId) row(e.detail.commandId,e.detail.utteranceId);
  for(const e of entries) {
    const d=e.detail, stage=d.stage as Stage;
    if(d.commandId) { put(row(d.commandId,d.utteranceId),stage,e.at,'page'); continue; }
    if(!d.utteranceId) continue;
    const matches=[...rows.values()].filter(r=>r.utteranceId===d.utteranceId);
    if(!matches.length) matches.push(row(`utterance:${d.utteranceId}`,d.utteranceId));
    // Only the two capture stages are shared across commands in one utterance.
    if(matches.length>1 && stage!=='microphone-release' && stage!=='transcript-received') continue;
    for(const r of matches) put(r,stage,e.at,'page');
  }
  return [...rows.values()];
}

export function formatLoopTimings(rows:LoopRow[]):string {
  if(!rows.length) return 'No voice loops found.';
  return rows.map(row=>{
    const lines=[`Command: ${row.commandId}${row.utteranceId?` (utterance ${row.utteranceId})`:''}`,
      '| Stage | Time (UTC) | Clock | Gap (ms) |','| --- | --- | --- | --- |'];
    stages.forEach((stage,i)=>{
      const sample=row.times[stage], previous=i?row.times[stages[i-1]]:undefined;
      const gap=sample && previous ? `${sample.at-previous.at}${sample.clock!==previous.clock?' *':''}` : 'n/a';
      lines.push(`| ${stage} | ${sample?new Date(sample.at).toISOString():'missing'} | ${sample?.clock??'n/a'} | ${gap} |`);
    });
    const complete=stages.every(stage=>row.times[stage]);
    const total=complete?row.times[stages[4]]!.at-row.times[stages[0]]!.at:null;
    lines.push(`Total (ms): ${total??'incomplete'}`);
    return lines.join('\n');
  }).join('\n\n')+'\n\n* Cross-clock gap. Check clock sync. Negative gaps remain visible.';
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [diagnostics,receipts]=process.argv.slice(2);
  if(!diagnostics || !receipts) { console.error('Usage: loop-timing.ts diagnostics.json receipts.json'); process.exitCode=1; }
  else {
    try {
      const values=await Promise.all([diagnostics,receipts].map(async path=>JSON.parse(await readFile(path,'utf8'))));
      console.log(formatLoopTimings(loopTimings(values[0],values[1])));
    } catch(error) { console.error(error instanceof Error?error.message:String(error)); process.exitCode=1; }
  }
}
