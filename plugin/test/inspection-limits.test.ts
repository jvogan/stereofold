import { describe,it,expect } from 'vitest';
import { assertInspectionBudget, headsetSourceDeadlineMs, HEADSET_TRANSFER_BASE_MS, INSPECTION_SIZE_GUIDE,
  INSPECTION_SIZE_GUIDE_CAPTION, MAX_INSPECTION_HYDRATION_BYTES, MAX_STRUCTURE_SOURCE_BYTES } from '../src/inspection-limits.js';
import { inspectionRefusalCaption } from '../src/inspection-refusal-caption.js';
import { SOURCE_DESCRIPTION, SOURCE_LIMIT } from '../src/structure-sources.js';
import { QUEST2_ATOM_SITE_CEILING } from '../src/molecular-growth.js';
describe('private inspection payload budgets',()=>{
  it('measures encoded UTF-8 bytes, including JSON escaping, instead of string characters',()=>{
    expect(()=>assertInspectionBudget({text:'é'.repeat(100)},150,'Catalog')).toThrow(/keeps inline/);
    expect(()=>assertInspectionBudget({text:'a'.repeat(100)},150,'Catalog')).not.toThrow();
    expect(()=>assertInspectionBudget({text:'\n'.repeat(100)},150,'Catalog')).toThrow(/keeps inline/);
  });
});
/**
 * A limit may refuse a person only when it was measured.
 * The 6 MB source bound and the 4 MiB compressed-catalog bound were neither,
 * and between them they refused 1AON, 1XCK and 1S5L. These tests hold the
 * replacement text to what is actually known.
 */
describe('what the size bounds tell whoever is choosing the next structure',()=>{
  const oversized=()=>assertInspectionBudget({scene:'a'.repeat(9_000_000)},MAX_INSPECTION_HYDRATION_BYTES,'Inspection hydration');
  it('distinguishes the tested growth tier from source policy and device capacity',()=>{
    expect(INSPECTION_SIZE_GUIDE).toContain(QUEST2_ATOM_SITE_CEILING.toLocaleString('en-US'));
    expect(INSPECTION_SIZE_GUIDE).toContain('no measured ceiling');
    expect(INSPECTION_SIZE_GUIDE).toContain('64 MiB');
    expect(INSPECTION_SIZE_GUIDE).toContain('policy');
    expect(INSPECTION_SIZE_GUIDE).toContain('not a universal arbitrary-structure limit');
  });
  it('no longer quotes a 6 MB source bound or a 4 MiB compressed catalog anywhere',()=>{
    for(const text of [INSPECTION_SIZE_GUIDE,INSPECTION_SIZE_GUIDE_CAPTION,SOURCE_LIMIT,SOURCE_DESCRIPTION]) {
      expect(text).not.toContain('6 MB');
      expect(text).not.toContain('6,275,072');
      expect(text).not.toMatch(/\b4 MiB/);
      expect(text).not.toMatch(/compressed catalog|catalog at most/);
    }
  });
  it('says what the remaining inline budget actually is, and adds the guide',()=>{
    expect(oversized).toThrow('Inspection hydration exceeds the 8.4 MB this plugin keeps inline in one hydration response.');
    expect(oversized).toThrow('It is 9.0 MB.');
    expect(oversized).toThrow(INSPECTION_SIZE_GUIDE);
  });
  it('gives the wearer the size and not the bounds',()=>{
    let refusal='';
    try { oversized(); } catch(error) { refusal=(error as Error).message; }
    const caption=inspectionRefusalCaption(refusal);
    expect(caption).toContain('It is 9.0 MB.');
    expect(caption).toContain(INSPECTION_SIZE_GUIDE_CAPTION);
    expect(caption).not.toContain('desktop viewer');
  });
  it('puts the one download policy and the one measured ceiling in the source tool text',()=>{
    expect(SOURCE_DESCRIPTION).toContain(`${MAX_STRUCTURE_SOURCE_BYTES.toLocaleString('en-US')} bytes (64 MiB)`);
    expect(SOURCE_DESCRIPTION).toContain('own download policy rather than a viewer ceiling');
    expect(SOURCE_DESCRIPTION).toContain(INSPECTION_SIZE_GUIDE);
    expect(SOURCE_DESCRIPTION).toContain('1AON and other entries that earlier builds refused now open');
    expect(SOURCE_LIMIT).toContain(`${MAX_STRUCTURE_SOURCE_BYTES.toLocaleString('en-US')} bytes (64 MiB)`);
  });
});

/**
 * The headset's `/source` deadline was a fixed 30 s whatever the source size.
 * It now follows the declared bytes, and still ends for a stalled request.
 */
describe('the headset source deadline follows the declared bytes',()=>{
  const MiB=1024*1024;
  it('keeps the base for a tiny source and adds a second per MiB at the floor rate',()=>{
    expect(headsetSourceDeadlineMs(0)).toBe(HEADSET_TRANSFER_BASE_MS);
    expect(headsetSourceDeadlineMs(1)).toBe(31_000);
    expect(headsetSourceDeadlineMs(10*MiB)).toBe(40_000);
    expect(headsetSourceDeadlineMs(28_840_575)).toBe(58_000);
  });
  it('never shrinks as the source grows, and stops at the source policy so a stall still ends',()=>{
    let previous=0;
    for(const bytes of [0,1,MiB-1,MiB,MiB+1,8*MiB,28_840_575,MAX_STRUCTURE_SOURCE_BYTES]) {
      const deadline=headsetSourceDeadlineMs(bytes);
      expect(deadline).toBeGreaterThanOrEqual(previous);
      previous=deadline;
    }
    expect(headsetSourceDeadlineMs(MAX_STRUCTURE_SOURCE_BYTES)).toBe(94_000);
    expect(headsetSourceDeadlineMs(MAX_STRUCTURE_SOURCE_BYTES*10)).toBe(94_000);
    expect(headsetSourceDeadlineMs(Infinity)).toBe(94_000);
    expect(headsetSourceDeadlineMs(NaN)).toBe(94_000);
    expect(headsetSourceDeadlineMs(-5)).toBe(HEADSET_TRANSFER_BASE_MS);
  });
});
