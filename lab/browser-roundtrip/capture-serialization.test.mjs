import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pageFunction } from './fixtures/label-action-harness.mjs';

const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
const workspace = readFileSync(new URL('../inspection/workspace.mjs', import.meta.url), 'utf8');
const inspector = readFileSync(new URL('../../plugin/src/inspector.ts', import.meta.url), 'utf8');
const animation = readFileSync(new URL('./molecular-animation.mjs', import.meta.url), 'utf8');
const definition = JSON.parse(readFileSync(new URL('../../plugin/demos/kinesin-walk/motion.json', import.meta.url), 'utf8')).chapters[0].animation;

function harness() {
  let clones = 0;
  const clone = value => { clones++; return structuredClone(value); };
  const c = vm.createContext({
    published: { definition, playback: { id: 'clip', timeSeconds: 0, state: 'paused' } },
    source: { sourceSha256: 'fixture', modelNumber: 1, assemblyId: '1', camera: { position: [0, 0, 12], target: [0, 0, 0] } },
    shape: { appearance: { representation: 'cartoon' }, placement: { scale: 1 },
      history: { undo: 3 }, savedViews: [{ id: 'saved' }], styles: [{ keys: ['A'], color: '#abcd12' }] },
    figure: { layers: [{ id: 'ligand', selector: { chain: 'A' } }] },
    figureAnimation: { tracks: [] }, emphasis: { focus: ['A'], origin: 'lesson' }, visibility: { hiddenKeys: ['B'] },
    lines: [{ from: 'A', to: 'B' }], lessonSelection: ['A'], lessonPlayback: { index: 2, state: 'paused' },
    state: { selectionKeys: ['A'] }, desktopPreviewCamera: undefined,
    assertReady() {}, failure: (code, message) => Object.assign(Error(message), { code }),
    detached: clone, cameraSnapshot: value => value, lessonMotionHold: { presented: value => value },
  });
  vm.runInContext(`
    liveScene = () => source;
    inspectionSnapshot = () => ({ ...shape });
    savedEmphasis = () => emphasis;
    savedVisibility = () => visibility;
    lessonFigure = { definition: () => figure, animationContext: () => figureAnimation };
    measurementLines = { count: () => lines.length, definition: () => lines };
    molecularAnimation = { capture: () => detached(published),
      ${animation.match(/serializeCapture: format => JSON.stringify\(format\(published\)\)/)[0]} };
  `, c);
  vm.runInContext(pageFunction(viewer, 'completeInspectionCapture'), c);
  const api = vm.runInContext(`({ ${viewer.match(/serializeCapture: options => completeInspectionCapture\([^\n]+/)[0]} })`, c);
  const adapter = vm.runInNewContext(`({ ${workspace.match(/serializeCapture:\(\) => viewer.inspection.serializeCapture\([^\n]+/)[0]} })`, { viewer: { inspection: api } });
  const capture = () => {
    const result = c.completeInspectionCapture();
    delete result.inspection.history; delete result.inspection.savedViews;
    return result;
  };
  return { c, capture, serialize: adapter.serializeCapture, clones: () => clones };
}

test('heartbeat serialization preserves exact capture bytes without cloning the large clip', () => {
  const h = harness(), before = h.clones(), encoded = h.serialize();
  assert.equal(h.clones(), before, 'comparison does not clone animation or assembled scene');
  assert.equal(encoded, JSON.stringify(h.capture()));
  assert.equal(h.clones() - before, 2, 'public capture keeps both existing detach boundaries');
  const parsed = JSON.parse(encoded);
  assert.equal(parsed.inspection.history, undefined);
  assert.equal(parsed.inspection.savedViews, undefined);
  assert.equal(parsed.inspection.lessonFigureAnimation, undefined, 'running clip carries figure motion');
  const captured = h.capture();
  captured.inspection.animation.definition.tracks[0].keyframes[0].translation[0] = 999;
  captured.inspection.styles[0].color = '#ffffff'; captured.camera.position[0] = 999;
  assert.equal(h.serialize(), encoded, 'editing a returned public capture cannot mutate the live scene');
});

test('comparison observes every live scene change and preserves omitted fields, maps and clockless figures', () => {
  const edits = [
    c => { c.source.sourceSha256 = 'replacement'; }, c => { c.source.modelNumber = 2; },
    c => { c.source.assemblyId = '2'; }, c => { c.state.selectionKeys.push('C'); },
    c => { c.source.camera.position[0]++; }, c => { c.shape.placement.scale++; },
    c => { c.shape.appearance.representation = 'spacefill'; }, c => { c.shape.styles[0].color = '#ffffff'; },
    c => { c.visibility.hiddenKeys.push('C'); }, c => { c.emphasis.focus.push('C'); },
    c => { c.lessonSelection = ['C']; }, c => { c.lessonPlayback.index++; },
    c => { c.figure.layers[0].selector.chain = 'C'; }, c => { c.lines.push({ from: 'A', to: 'C' }); },
    c => { c.published = { ...c.published, playback: { ...c.published.playback, timeSeconds: 1 } }; },
    c => { c.published = undefined; }, c => { c.published = undefined; c.figure = undefined; c.figureAnimation = undefined; c.lines = []; c.lessonSelection = undefined; c.lessonPlayback = undefined; c.source.assemblyId = 'map'; },
  ];
  for (const edit of edits) {
    const h = harness(), before = h.serialize(); edit(h.c);
    assert.notEqual(h.serialize(), before);
    assert.equal(h.serialize(), JSON.stringify(h.capture()), edit.toString());
  }
  const h = harness(), before = h.serialize();
  h.c.shape.history.undo++; h.c.shape.savedViews.push({ id: 'second' });
  assert.equal(h.serialize(), before, 'workspace history and saved views remain excluded');
  h.c.source.assemblyId = null;
  assert.throws(h.serialize, { code: 'unsupported_scene' });
  assert.throws(h.capture, { code: 'unsupported_scene' });
});

test('production heartbeat uses serialization and still saves only an eligible changed scene', () => {
  const from = inspector.indexOf('    if(!failedSourceLoad && !dirty && !blocked && snapshot.ready && workspace.serializeCapture()');
  assert.ok(from >= 0);
  const condition = inspector.slice(from, inspector.indexOf('scheduleSave();', from) + 'scheduleSave();'.length);
  const h = harness(); let saves = 0;
  const c = vm.createContext({ failedSourceLoad: undefined, dirty: false, blocked: false, snapshot: { ready: true },
    workspace: { serializeCapture: h.serialize, capture() { throw Error('heartbeat cloned scene'); } },
    savedScene: h.capture(), tourPlayer: { getState: () => ({ navigating: false }) }, scheduleSave() { saves++; } });
  vm.runInContext(condition, c); assert.equal(saves, 0);
  h.c.shape.placement.scale = 2; vm.runInContext(condition, c); assert.equal(saves, 1);
  c.blocked = true; vm.runInContext(condition, c); assert.equal(saves, 1);
  c.blocked = false; c.tourPlayer.getState = () => ({ navigating: true });
  vm.runInContext(condition, c); assert.equal(saves, 1);
});
