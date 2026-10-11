import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSequenceNavigation,sequencePageSize,SEQUENCE_ROW_BUDGET} from './sequence-navigation.mjs';
import {createToolbarPanel,hitToolbarPanel,SPATIAL_TOOLBAR_LAYOUT} from './spatial-toolbar-geometry.mjs';
import {spatialToolbarRows,MENU_LABEL_BUDGET_CHARACTERS} from './spatial-toolbar-content.mjs';
import {spatialVoiceAction} from './voice-command-runner.mjs';
const residue=(n,copy='one',extra={})=>({key:`${copy}:${n}:${extra.insertionCode??''}`,coordinateState:n===3?'unresolved':'resolved',identity:{modelNumber:1,assemblyId:'1',copyId:copy,entityId:'1',labelChain:'A',authorChain:'X',operatorIds:[copy],componentId:'ALA',authorResidue:n,labelSequenceId:n,insertionCode:'',...extra}});
function fixture(rows=Array.from({length:20},(_,n)=>residue(n+1))) {
  const source={binding:'source:1',rows,available:true,modelNumber:1,assemblyId:'1',selectionKeys:[]};
  const nav=createSequenceNavigation(()=>source);
  const run=(op,extra={})=>nav.act({kind:'sequence',...nav.snapshot(),op,...extra});
  return {source,nav,run};
}
test('controller sequence pages use existing row actions within size budget and retain stable cached state',()=>{
  const {nav,run}=fixture();
  const entry=spatialToolbarRows({collapsed:false,sequence:nav.snapshot()}).find(r=>r.label==='Sequence');
  assert.ok(entry);nav.act(entry.action);
  const a=nav.snapshot();assert.equal(a,nav.snapshot());
  const rows=spatialToolbarRows({sequence:a,voice:{state:'idle'}});
  assert.ok(rows.length<=9);assert.ok(rows.every(r=>r.label.length<=8));
  assert.equal(a.pageSize,sequencePageSize());
  assert.equal(a.rows.filter(r=>r.action.op==='detail').length,sequencePageSize());
  run('page',{delta:1});assert.ok(nav.snapshot().rows.some(r=>r.action.key===`one:${sequencePageSize()+1}:`));
  run('detail',{key:'one:4:'});assert.match(nav.snapshot().caption,/author chain X, label A:4/);
  assert.deepEqual(run('select').selection,['one:4:']);
});
test('missing coordinates remain selectable, focus refuses, and range includes the unresolved sequence position',()=>{
  const {nav,run}=fixture();run('open');run('detail',{key:'one:2:'});run('start');
  run('detail',{key:'one:4:'});assert.deepEqual(run('end').selection,['one:2:','one:3:','one:4:']);
  run('detail',{key:'one:3:'});assert.match(nav.snapshot().caption,/coordinates missing/);
  assert.deepEqual(run('select').selection,['one:3:']);assert.throws(()=>run('focus'),/resolved coordinates/);
});
test('source generation and assembly copy changes cannot reuse stale actions or range anchors',()=>{
  const {source,nav,run}=fixture([...Array.from({length:5},(_,n)=>residue(n+1)),...Array.from({length:5},(_,n)=>residue(n+1,'two'))]);
  run('open');run('detail',{key:'one:1:'});run('start');run('chain');run('detail',{key:'two:3:'});assert.throws(()=>run('end'),/one chain/);
  const stale=nav.snapshot().rows.find(r=>r.action.op==='select').action;
  source.binding='source:2';assert.throws(()=>nav.act(stale),/sequence changed/);assert.equal(nav.snapshot().open,false);
});
test('controller numeric find preserves insertion-code ambiguity and explicit author/sequence numbering',()=>{
  const {nav,run}=fixture([residue(8,'one',{labelSequenceId:1}),residue(8,'one',{insertionCode:'A',labelSequenceId:2}),residue(9)]);
  run('open');run('find');for(let n=0;n<8;n++)run('value',{delta:1});run('search');
  assert.equal(nav.snapshot().rows.filter(r=>r.action.op==='detail').length,2);
  run('detail',{key:'one:8:A'});assert.match(nav.snapshot().caption,/ALA 8A/);assert.deepEqual(run('select').selection,['one:8:A']);
  run('find');run('numbering');run('search');assert.equal(nav.snapshot().rows.filter(r=>r.action.op==='detail').length,0);
});
test('a rendered external pick follows the same canonical selection and visible stage boundaries',()=>{
  const {source,nav,run}=fixture();run('open');source.selectionKeys=['one:17:'];
  assert.ok(nav.snapshot().rows.some(r=>r.action.key==='one:17:'));
  source.visible={entityIds:['other']};assert.equal(nav.snapshot().rows.length,0);
  source.available=false;assert.equal(nav.snapshot().available,false);assert.throws(()=>run('open'),/no residue sequence/);
});
test('find digit editor reaches a distant signed author number without sequential residue paging',()=>{
  const {nav,run}=fixture([residue(-500)]);run('open');run('find');run('digit',{delta:-1});run('digit',{delta:-1});for(let n=0;n<5;n++)run('value',{delta:1});run('sign');run('search');
  assert.ok(nav.snapshot().rows.some(r=>r.action.key==='one:-500:'));
});

test('each sequence subpage stays pointable in the existing toolbar geometry',()=>{
  const {nav,run}=fixture();run('open');
  for(const enter of [()=>{},()=>run('detail',{key:'one:3:'}),()=>run('tools'),()=>run('chains'),()=>run('find')]) {
    enter(); const rows=spatialToolbarRows({sequence:nav.snapshot(),voice:{state:'idle'}});
    assert.ok(rows.length<=9); assert.ok(rows.every(r=>r.label.length<=MENU_LABEL_BUDGET_CHARACTERS));
    const panel=createToolbarPanel({rows,head:{position:{x:0,y:1.6,z:0},matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]},constants:SPATIAL_TOOLBAR_LAYOUT});
    for(const button of panel.buttons) {
      const hit=hitToolbarPanel(panel,{origin:[button.point[0],button.point[1],-.3],direction:[0,0,-1]});
      if(button.state) assert.equal(hit,undefined); else assert.equal(hit,button);
    }
  }
});

/**
 * `cap-p1-sequence-left.png` shows three residue rows and a live `Next`. On a
 * hemoglobin chain that puts residue 141 forty-seven presses away. These pin
 * the two things that fix it: a page sized from the plate rather than from a
 * constant, and one action that lands on a named residue.
 */
test('a page is the plate capacity, and Previous and Next carry their own row ids', () => {
  const {nav,run}=fixture(Array.from({length:141},(_,n)=>residue(n+1)));
  run('open');
  const first=nav.snapshot();
  assert.equal(first.pageSize,sequencePageSize(SEQUENCE_ROW_BUDGET));
  assert.equal(first.pageCount,Math.ceil(141/first.pageSize));
  assert.deepEqual(first.rows.filter(r=>r.action.op==='page').map(r=>r.id),['sequence-previous','sequence-next']);
  // Previous is the disabled chip on the first page; Next is pressable.
  assert.equal(first.rows.find(r=>r.id==='sequence-previous').state,true);
  assert.equal(first.rows.find(r=>r.id==='sequence-next').state,undefined);
  assert.ok(first.rows.every(r=>r.id.startsWith('sequence-')));
  assert.equal(new Set(first.rows.map(r=>r.id)).size,first.rows.length);
});

test('going to residue 141 takes one action and keeps its neighbours on the page', () => {
  const {nav,run}=fixture(Array.from({length:141},(_,n)=>residue(n+1)));
  run('open');
  const pressesByPaging=Math.floor(140/sequencePageSize());
  assert.ok(pressesByPaging>20, 'the paging route is still the long one');
  run('goto',{residue:141});
  const landed=nav.snapshot();
  assert.ok(landed.rows.filter(r=>r.action.op==='detail').map(r=>r.action.key).includes('one:141:'));
  // Paged, not filtered: the whole chain is still behind the page.
  assert.equal(landed.pageCount,Math.ceil(141/landed.pageSize));
  assert.equal(landed.page,landed.pageCount-1);
  assert.match(landed.caption,/Page \d+ of \d+/);
  run('page',{delta:-1});
  assert.equal(nav.snapshot().rows.filter(r=>r.action.op==='detail').length,landed.pageSize);
  run('detail',{key:'one:141:'});
  assert.deepEqual(run('select').selection,['one:141:']);
});

test('the find dial goes to a residue, and a chain without it refuses by name', () => {
  const {nav,run}=fixture(Array.from({length:141},(_,n)=>residue(n+1)));
  run('open');run('find');
  // 141: hundreds digit, then tens, then units.
  run('digit',{delta:-1});run('digit',{delta:-1});run('value',{delta:1});
  run('digit',{delta:1});for(let n=0;n<4;n++)run('value',{delta:1});
  run('digit',{delta:1});run('value',{delta:1});
  assert.equal(nav.snapshot().rows.find(r=>r.id==='sequence-goto').label,'Go to');
  run('goto');
  assert.ok(nav.snapshot().rows.some(r=>r.action.key==='one:141:'));
  assert.throws(()=>run('goto',{residue:999}),/no author residue 999/);
  // The numbering the caller names is the one the jump reads.
  run('goto',{residue:7,numbering:'sequence'});
  assert.ok(nav.snapshot().rows.some(r=>r.action.key==='one:7:'));
  assert.match(nav.snapshot().rows.find(r=>r.action.op==='numbering')?.label ?? nav.snapshot().caption,/.*/);
});

test('chain tabs name every chain and switch to the one pressed', () => {
  const {nav,run}=fixture([...Array.from({length:5},(_,n)=>residue(n+1,'one')),
    ...Array.from({length:5},(_,n)=>residue(n+1,'two')),
    ...Array.from({length:5},(_,n)=>residue(n+1,'three'))]);
  run('open');run('tools');
  assert.ok(nav.snapshot().rows.some(r=>r.id==='sequence-chains'));
  run('chains');
  const tabs=nav.snapshot().rows.filter(r=>r.action.op==='chain-tab');
  assert.equal(tabs.length,3);
  assert.deepEqual(tabs.map(r=>r.id),['sequence-chain-0','sequence-chain-1','sequence-chain-2']);
  assert.equal(nav.snapshot().rows.length<=9,true);
  nav.act(tabs[2].action);
  assert.ok(nav.snapshot().rows.some(r=>r.action.key==='three:1:'));
  assert.match(nav.snapshot().caption,/Chain A·three/);
  run('chains');
  const live=nav.snapshot().rows.find(r=>r.action.op==='chain-tab').action;
  assert.throws(()=>nav.act({...live,chain:'not a chain'}),/no longer in this scene/);
});

test('the spoken jump is about the browser only while the browser is open', () => {
  // Shut, "go to residue 141" keeps its old meaning: frame residue 141 in the
  // molecule. Open, it pages the browser. Nothing else moves.
  const framed = spatialVoiceAction('go to residue 141');
  assert.equal(framed.action.kind, 'focus-selection');
  assert.deepEqual(framed.action.residues, [141, 141]);
  const paged = spatialVoiceAction('go to residue 141', { sequenceOpen: true });
  assert.deepEqual(paged.action, { kind: 'sequence', op: 'goto', residue: 141, numbering: 'author' });
  assert.equal(spatialVoiceAction('make it bigger', { sequenceOpen: true }).command, 'scale-larger');
  // A spoken action carries no page binding; the browser still lands on 141.
  const {nav, run} = fixture(Array.from({length:141},(_,n)=>residue(n+1)));
  run('open');
  const live = nav.snapshot();
  const landed = nav.act({ ...paged.action, binding: live.binding, version: live.version });
  assert.match(landed.caption, /ALA 141/);
});

/**
 * On the Quest 2 the pad drew `Author #`, `Digit ←`, `Digit →`, `Value +`,
 * `Value −`, `Positive`, `Go to` and no digits at all, so one `Value +` press
 * was invisible: nothing on the row, nothing on the plate, nothing the page
 * published. These pin the three things that make the press readable — a row
 * that carries the value, a published reading a driver can compare, and row
 * ids the driver can name.
 */
test('the Find pad draws the number being entered and keeps the plate budget', () => {
  const {nav,run}=fixture(Array.from({length:141},(_,n)=>residue(n+1)));
  run('open');run('find');
  const valueRow=()=>nav.snapshot().rows.find(r=>r.id==='sequence-find-value');
  assert.equal(valueRow().label,'A000000');
  run('value',{delta:1});
  assert.equal(valueRow().label,'A000001');
  // The pad still fits the plate with the Talk row above it, labels and all.
  const rows=spatialToolbarRows({sequence:nav.snapshot(),voice:{state:'idle'}});
  assert.ok(rows.length<=9);
  assert.ok(rows.every(r=>r.label.length<=8));
  // Sequence numbering and a negative value are both legible, and the widest
  // label the pad can draw is still eight characters.
  run('numbering');run('sign');
  assert.equal(valueRow().label,'S-000001');
  run('sign');run('numbering');
  // Every editing row the pad draws is a `sequence-find-` row.
  assert.deepEqual(nav.snapshot().rows.map(r=>r.id),
    ['sequence-find-value','sequence-find-digit-left','sequence-find-digit-right','sequence-find-up',
      'sequence-find-down','sequence-find-sign','sequence-goto','sequence-browse']);
  // Pressing the value row is still the numbering toggle it replaced.
  assert.equal(valueRow().action.op,'numbering');
});

test('the Find pad publishes its value, so a press that moved one digit is an outcome', () => {
  const {nav,run}=fixture(Array.from({length:141},(_,n)=>residue(n+1)));
  run('open');
  // Published before the pad is ever opened, so a reader never has to guess.
  assert.equal(nav.snapshot().find.editing,false);
  run('find');
  const before=nav.snapshot().find;
  assert.deepEqual({...before},{editing:true,numbering:'author',negative:false,digits:'000000',digit:5,value:0,label:'A000000'});
  run('value',{delta:1});
  const after=nav.snapshot().find;
  assert.equal(after.value,1);
  assert.notDeepEqual({...after},{...before});
  // The digit cursor and the sign are published too.
  run('digit',{delta:-1});
  assert.equal(nav.snapshot().find.digit,4);
  run('sign');
  assert.equal(nav.snapshot().find.value,-1);
  assert.equal(nav.snapshot().find.negative,true);
});

test('Go to frames the residue it pages to, and pages to one it cannot frame', () => {
  const {nav,run}=fixture(Array.from({length:141},(_,n)=>residue(n+1)));
  run('open');
  const landed=run('goto',{residue:141});
  assert.deepEqual(landed.focus,['one:141:']);
  assert.ok(nav.snapshot().rows.some(r=>r.action.key==='one:141:'));
  // residue 3 has no resolved coordinates in this fixture: the page turn is
  // still the outcome, and the camera move is the part not delivered.
  const unresolved=run('goto',{residue:3});
  assert.equal(unresolved.focus,undefined);
  assert.ok(nav.snapshot().rows.some(r=>r.action.key==='one:3:'));
});

test('Selected pages to the page the selection is really on', () => {
  const {source,nav,run}=fixture(Array.from({length:141},(_,n)=>residue(n+1)));
  run('open');run('tools');
  source.selectionKeys=['one:100:'];
  run('selected');
  const landed=nav.snapshot();
  assert.equal(landed.page,Math.floor(99/landed.pageSize));
  assert.ok(landed.rows.some(r=>r.action.key==='one:100:'));
});
