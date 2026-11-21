import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {pageFunction} from './fixtures/label-action-harness.mjs';
const viewer=readFileSync(new URL('./viewer.mjs',import.meta.url),'utf8');
function harness() {
  let reads=0;
  const rows=['A','B'].flatMap(chain=>[1,2,3].map(authorResidue=>({key:chain+authorResidue,
    get identity(){reads++;return {authorChain:chain,labelChain:chain.toLowerCase(),authorResidue};}})));
  const h=vm.createContext({selection:{rows},spokenSelectionCache:undefined});
  vm.runInContext(pageFunction(viewer,'spokenSelectionKeys'),h);
  return {h,reads:()=>reads};
}
test('repeated lesson targets resolve once per source and return independently editable keys',()=>{
  const {h,reads}=harness();
  const keys=h.spokenSelectionKeys({chain:'A',residues:[1,2]});
  assert.deepEqual(Array.from(keys),['A1','A2']);
  const first=reads();keys.pop();
  assert.deepEqual(Array.from(h.spokenSelectionKeys({chain:'A',residues:[1,2]})),['A1','A2']);
  assert.equal(reads(),first,'repeated targets must not scan the source again');
  assert.deepEqual(Array.from(h.spokenSelectionKeys({chain:'a',residues:[2,3]})),['A2','A3']);
  h.selection={rows:[{key:'new',identity:{authorChain:'A',labelChain:'a',authorResidue:1}}]};
  assert.deepEqual(Array.from(h.spokenSelectionKeys({chain:'A',residues:[1,2]})),['new']);
  assert.throws(()=>h.spokenSelectionKeys({chain:'B'}),/no chain B/);
  assert.throws(()=>h.spokenSelectionKeys({chain:'A',residues:[8,9]}),/Nothing at residues/);
  assert.equal(h.spokenSelectionKeys({}),undefined);
});
test('a lesson chain names its author chain when the label IDs are the author IDs shifted along',()=>{
  // 8OUE's chains: author C is label A, author E is label C, author G is label E.
  // NHP2 is author E 23-152; label E is dyskerin, author G 43-395.
  const rows=[['C','A',[23,24]],['E','C',[23,24]],['G','E',[43,44]]].flatMap(([authorChain,labelChain,residues])=>
    residues.map(authorResidue=>({key:`${authorChain}${authorResidue}`,identity:{authorChain,labelChain,authorResidue}})));
  const h=vm.createContext({selection:{rows},spokenSelectionCache:undefined});
  vm.runInContext(pageFunction(viewer,'spokenSelectionKeys'),h);
  assert.deepEqual(Array.from(h.spokenSelectionKeys({chain:'E',residues:[23,152]})),['E23','E24']);
  assert.deepEqual(Array.from(h.spokenSelectionKeys({chain:'C',residues:[23,421]})),['C23','C24']);
  assert.deepEqual(Array.from(h.spokenSelectionKeys({chain:'G'})),['G43','G44']);
  // A name that only a label chain carries still finds that chain.
  assert.deepEqual(Array.from(h.spokenSelectionKeys({chain:'A'})),['C23','C24']);
  // So does an author chain with nothing in the range a label chain covers.
  assert.deepEqual(Array.from(h.spokenSelectionKeys({chain:'E',residues:[43,44]})),['G43','G44']);
});
