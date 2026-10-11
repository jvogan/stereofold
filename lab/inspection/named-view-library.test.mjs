import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeHostViews, renderHostViews, hostViewSourceLabel } from './named-view-library.mjs';

const home = { sourceSha256:'a'.repeat(64), modelNumber:1, assemblyId:'1' };
const entry = (extra = {}) => ({ id:'view-1', name:'Active site', viewRevision:1, ...home,
  viewIntent:{ selectionCount:9, representation:'cartoon', color:'chain-id', orientation:'not-captured' }, ...extra });
const library = (entries, maximum = 16) => ({ scope:'live-session', maximum, entries });

test('summarize reports capacity and restorable home entries with detail',()=>{
  const summary = summarizeHostViews(library([entry()]), home);
  assert.equal(summary.available, true);
  assert.equal(summary.used, 1);
  assert.equal(summary.maximum, 16);
  assert.equal(summary.capacityText, '1 of 16 saved');
  assert.deepEqual(summary.rows, [{ id:'view-1', name:'Active site', viewRevision:1, foreign:false,
    sourceLabel:undefined, detail:'Cartoon · 9 residues', canRestore:true }]);
});

test('foreign entries are labeled by source with restore disabled',()=>{
  const away = entry({ id:'view-2', name:'Other copy', sourceSha256:'b'.repeat(64), modelNumber:2, assemblyId:'2' });
  const summary = summarizeHostViews(library([entry(), away]), home);
  assert.equal(summary.rows[1].foreign, true);
  assert.equal(summary.rows[1].sourceLabel, 'Model 2 · assembly 2');
  assert.equal(summary.rows[1].canRestore, false);
  assert.equal(hostViewSourceLabel(away), 'Model 2 · assembly 2');
});

test('entries are foreign while no current source is known',()=>{
  const summary = summarizeHostViews(library([entry()]), undefined);
  assert.equal(summary.rows[0].foreign, true);
  assert.equal(summary.rows[0].canRestore, false);
});

test('malformed entries are ignored and counted, never rendered',()=>{
  const summary = summarizeHostViews(library([entry(), { name:'no id' }, null, { ...entry(), id:'x', viewRevision:0 }]), home);
  assert.equal(summary.used, 1);
  assert.equal(summary.ignored, 3);
});

test('a missing library reports unavailable with fallback capacity',()=>{
  for (const bad of [undefined, null, {}, { entries:'no' }]) {
    const summary = summarizeHostViews(bad, home);
    assert.equal(summary.available, false);
    assert.deepEqual(summary.rows, []);
    assert.match(summary.capacityText, /0 of 16 saved/);
  }
});

// Micro-DOM stub supporting exactly the operations renderHostViews uses.
function element(tag) {
  const listeners = {};
  return { tag, children:[], textContent:'', className:'', disabled:false, title:'', dataset:{},
    setAttribute(){}, append(...nodes){ this.children.push(...nodes); },
    replaceChildren(){ this.children = []; },
    addEventListener(type, fn){ (listeners[type] ??= []).push(fn); },
    click(){ for (const fn of listeners.click ?? []) fn(); } };
}
function installDom() {
  const created = [];
  globalThis.document = { createElement:(tag)=>{ const el = element(tag); created.push(el); return el; } };
  return created;
}
test('render lists entries with detail, source labels and working callbacks',()=>{
  installDom();
  const list = element('div');
  const away = entry({ id:'view-2', name:'Other copy', sourceSha256:'b'.repeat(64), modelNumber:2, assemblyId:'2',
    viewIntent:{ selectionCount:1, representation:'ball-and-stick', color:'uniform', orientation:'object-relative' } });
  const summary = summarizeHostViews(library([entry(), away]), home);
  const calls = [];
  renderHostViews(list, summary, { onRestore:(row)=>calls.push(['restore', row]), onDelete:(row)=>calls.push(['delete', row]) });
  assert.equal(list.children.length, 2);
  const [first, second] = list.children;
  // Home entry: enabled restore, detail line, delete carrying viewRevision.
  assert.equal(first.children[0].disabled, false);
  assert.equal(first.children[1].textContent, 'Cartoon · 9 residues');
  first.children[0].click();
  first.children.at(-1).click();
  assert.deepEqual(calls, [[ 'restore', { id:'view-1', name:'Active site' } ],
    [ 'delete', { id:'view-1', name:'Active site', viewRevision:1 } ]]);
  // Foreign entry: disabled restore with reason, visible source label.
  assert.equal(second.children[0].disabled, true);
  assert.match(second.children[0].title, /Model 2 · assembly 2/);
  assert.equal(second.children.find(child => child.className === 'saved-view-source').textContent, 'Model 2 · assembly 2');
  assert.equal(second.children[1].textContent, 'Ball and stick · 1 residue');
});

test('render of an empty library invites a first save without callbacks',()=>{
  installDom();
  const list = element('div');
  renderHostViews(list, summarizeHostViews(library([]), home), { onRestore:()=>assert.fail(), onDelete:()=>assert.fail() });
  assert.equal(list.children.length, 1);
  assert.match(list.children[0].textContent, /No shared views yet/);
});
