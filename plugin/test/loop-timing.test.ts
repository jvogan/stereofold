import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loopTimings, formatLoopTimings } from '../scripts/loop-timing.js';
const diagnostics=JSON.parse(await readFile(new URL('./fixtures/loop-timing/diagnostics.json',import.meta.url),'utf8'));
const receipts=JSON.parse(await readFile(new URL('./fixtures/loop-timing/receipts.json',import.meta.url),'utf8'));

describe('voice loop report',()=>{
  it('joins exact IDs across page records and host receipts',()=>{
    const rows=loopTimings(diagnostics,receipts);
    expect(rows).toHaveLength(2);
    expect(rows[0].times['receipt-rendered']).toEqual({at:1800,clock:'page'});
    const report=formatLoopTimings(rows);
    expect(report).toContain('Total (ms): 1100');
    expect(report).toContain('| host | 200 * |');
    expect(report).toContain('Total (ms): incomplete');
    expect(rows[1].times['receipt-rendered']).toBeUndefined();
  });
  it('keeps retries stable and does not infer missing stages',()=>{
    expect(loopTimings([...diagnostics,...diagnostics],[receipts,receipts])).toEqual(loopTimings(diagnostics,receipts));
    const rows=loopTimings([], [{commandId:'old',status:'rendered',acceptedAt:20}]);
    expect(rows[0].times).toEqual({});
    expect(()=>loopTimings({},receipts)).toThrow('JSON list');
  });
  it('shares capture stages but never guesses a command for ambiguous speech',()=>{
    const rows=loopTimings([...diagnostics,{at:3000,kind:'voice-loop',detail:{stage:'spoken-confirmation-started',utteranceId:'u1'}}],
      [...receipts.commands,{commandId:'c3',utteranceId:'u1',status:'queued'}]);
    expect(rows.find(r=>r.commandId==='c3')?.times['microphone-release']?.at).toBe(1000);
    expect(rows.find(r=>r.commandId==='c3')?.times['spoken-confirmation-started']).toBeUndefined();
  });
  it('prints clock skew instead of clamping negative gaps',()=>{
    const changed=structuredClone(receipts); changed.commands[0].actionPostedAt=1100;
    expect(formatLoopTimings(loopTimings(diagnostics,changed))).toContain('-100 *');
  });
});
