import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { summarizeHostViews } from './named-view-library.mjs';

// Execute the production Saved-views action/message/seam bodies with stubs.
// A callback-free renderer stub would miss a second authority: these tests
// prove host mode never touches the tab-local store and fallback never
// touches the host callbacks.
const source = readFileSync(new URL('./workspace.mjs', import.meta.url), 'utf8');
const seam = source.slice(source.indexOf('// The host library'),
  source.indexOf('const status = $('));
const actionsSource = source.slice(source.indexOf('const actions = {'), source.indexOf('const actionMessages = {'));
const messagesSource = source.slice(source.indexOf('const actionMessages = {'),
  source.indexOf('for (const [name, action] of Object.entries(actions))'));

const home = { sourceSha256:'a'.repeat(64), modelNumber:1, assemblyId:'1' };
const library = (names) => ({ scope:'live-session', maximum:16,
  entries:names.map((name, index) => ({ id:`view-${index}`, name, viewRevision:index + 1, ...home,
    viewIntent:{ selectionCount:1, representation:'cartoon', color:'chain-id', orientation:'not-captured' } })) });

function harness({ options = {}, inputValue = '', tabViews = [] } = {}) {
  const calls = [];
  let synced = 0;
  const viewer = { snapshot:() => ({ ...home, ready:true, inspection:{ savedViews:tabViews } }),
    inspection:{ saveView:(name)=>{ calls.push(['tab-save', name]); return { name }; },
      restoreView:(id)=>{ calls.push(['tab-restore', id]); } } };
  const $ = (selector) => selector === '[data-control="view-name"]' ? { value:inputValue } : {};
  const hooks = new Function('options', 'viewer', '$', 'summarizeHostViews', 'sync',
    `${seam}\n${actionsSource}\n${messagesSource}\nreturn { actions, actionMessages, setNamedViews, hostDriven, hostLibrary:() => hostLibrary };`)(
    options, viewer, $, summarizeHostViews, ()=>{ synced++; });
  return { calls, viewer, hooks, synced:() => synced };
}

test('host save uses the host callback with the typed name, never the tab store', async ()=>{
  const saved = [];
  const { calls, hooks } = harness({ options:{ onSaveNamedView:(name)=>{ saved.push(name); return Promise.resolve({ name }); },
    onRestoreNamedView:()=>{}, onDeleteNamedView:()=>{} }, inputValue:'Lab view' });
  hooks.setNamedViews(library(['First']));
  assert.equal(hooks.hostDriven(), true);
  const result = await hooks.actions['save-view']();
  assert.deepEqual(saved, ['Lab view']);
  assert.deepEqual(result, { name:'Lab view' });
  assert.deepEqual(calls, []);
  assert.equal(hooks.actionMessages['save-view'](result), 'Save sent for “Lab view”');
});

test('host save defaults the name from shared capacity, not the tab count', async ()=>{
  const saved = [];
  const { hooks } = harness({ options:{ onSaveNamedView:(name)=>{ saved.push(name); return Promise.resolve({}); },
    onRestoreNamedView:()=>{}, onDeleteNamedView:()=>{} }, inputValue:'',
    tabViews:[{ id:'t1', name:'Tab 1' }, { id:'t2', name:'Tab 2' }, { id:'t3', name:'Tab 3' }] });
  hooks.setNamedViews(library(['Shared']));
  await hooks.actions['save-view']();
  assert.deepEqual(saved, ['View 2']);
});

test('no-host preview keeps the tab-local save and message untouched', async ()=>{
  const { calls, hooks } = harness({ inputValue:'', tabViews:[{ id:'t1', name:'Tab 1' }] });
  assert.equal(hooks.hostDriven(), false);
  await hooks.actions['save-view']();
  assert.deepEqual(calls, [['tab-save', 'View 2']]);
  assert.equal(hooks.actionMessages['save-view'](), 'Saved “Tab 1” in this tab');
});

test('partial host wiring never enables host mode', ()=>{
  const { hooks } = harness({ options:{ onSaveNamedView:()=>{} } });
  hooks.setNamedViews(library(['Shared']));
  assert.equal(hooks.hostDriven(), false);
});

test('setNamedViews stores a defensive clone and ignores malformed libraries',()=>{
  const { hooks } = harness({ options:{ onSaveNamedView:()=>{}, onRestoreNamedView:()=>{}, onDeleteNamedView:()=>{} } });
  const incoming = library(['Shared']);
  hooks.setNamedViews(incoming);
  incoming.entries.length = 0;
  incoming.maximum = 99;
  assert.equal(hooks.hostLibrary().entries.length, 1);
  assert.equal(hooks.hostLibrary().maximum, 16);
  for (const bad of [null, undefined, {}, { entries:'no' }, { entries:[{ name:'no id' }] }]) hooks.setNamedViews(bad);
  assert.equal(hooks.hostLibrary().entries.length, 1);
});

test('production sync renders the host library with restore and revision deletes',()=>{
  assert.match(source, /summarizeHostViews\(hostLibrary, sourceOf\(snapshot\)\)/);
  assert.match(source, /renderHostViews\(list, summary, \{/);
  assert.match(source, /onRestore: row => ui\(`Restore sent for “\$\{row\.name\}”`, \(\) => options\.onRestoreNamedView\(row\)\)/);
  assert.match(source, /onDelete: row => ui\(`Deleted “\$\{row\.name\}”`, \(\) => options\.onDeleteNamedView\(row\)\)/);
  assert.match(source, /`Saved views · \$\{summary\.capacityText\}`/);
});

test('tab-local undo and fallback restore behavior stay untouched',()=>{
  assert.match(source, /undo: \(\) => viewer\.inspection\.undo\(\), redo: \(\) => viewer\.inspection\.redo\(\),/);
  assert.match(source, /viewer\.inspection\.restoreView\(view\.id\)/);
  assert.equal(source.match(/viewer\.inspection\.saveView/g).length, 1);
  assert.match(source, /setNamedViews,/);
});
