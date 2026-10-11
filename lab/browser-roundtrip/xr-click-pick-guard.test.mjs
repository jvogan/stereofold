import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Canvas3dInteractionHelper } from 'molstar/lib/mol-canvas3d/helper/interaction-events.js';
import { RayHelper } from 'molstar/lib/mol-canvas3d/helper/ray-helper.js';
import { XRManager } from 'molstar/lib/mol-canvas3d/helper/xr-manager.js';
import { installXrPointer } from './xr-pointer.mjs';
import { attachXrConsumedTriggerClickGuard } from './xr-click-pick-guard.mjs';

const require = createRequire(import.meta.url);
const canvasSource = readFileSync(require.resolve('molstar/lib/mol-canvas3d/canvas3d.js'), 'utf8');
const identifySource = canvasSource.slice(canvasSource.indexOf('        function identify(target) {'),
  canvasSource.indexOf('        function asyncIdentify(target) {'));
assert.ok(identifySource.includes("shaderManager.finalize(['pick'], true)"));

function harness() {
  const calls = { finalize: 0, prepare: 0, render: 0, read: 0, desktop: 0, hover: 0 }, events = [];
  const result = { id: { objectId: 1 }, position: [1, 2, 3] }, loci = { kind: 'element-loci', sentinel: 'genuine pick' };
  const rayHelper = Object.assign(Object.create(RayHelper.prototype), {
    intersectsScene: () => true, prepare() { calls.prepare++; }, render() { calls.render++; },
    camera: {}, buffers: { read() { calls.read++; } }, getPickData: () => result,
  });
  // Execute the pinned Canvas3D identify closure and real RayHelper method,
  // substituting only the shader/GPU work so the test needs no WebGL context.
  const identify = vm.runInNewContext(`${identifySource}\nidentify`, {
    webgl: {}, shaderManager: { finalize() { calls.finalize++; } }, rayHelper, camera: {},
    p: { camera: { stereo: { name: 'off' } } }, pickHelper: { identify() { calls.desktop++; return result; } },
  });
  const input = Object.fromEntries(['drag', 'move', 'leave', 'click', 'interactionEnd', 'modifiers']
    .map(key => [key, { subscribe: () => ({ unsubscribe() {} }) }]));
  const helper = new Canvas3dInteractionHelper(identify,
    () => { calls.hover++; return { tryGet: () => result }; }, () => ({ loci }), input, {}, {});
  helper.events.click.subscribe(event => events.push(event));
  const ray = { origin: [0, 0, 0], direction: [0, 0, -1] };
  let consumed = true, presenting = true;
  const options = { manager: { interactionHelper: helper }, isPresenting: () => presenting, consumesClick: () => consumed };
  return { helper, ray, calls, events, identify, result, loci, options,
    consume: value => { consumed = value; }, present: value => { presenting = value; } };
}

test('consumed XR trigger clicks skip shader finalization, pick rendering and synchronous read', () => {
  const h = harness(), original = h.helper.handleClick, adapter = attachXrConsumedTriggerClickGuard(h.options);
  try {
    h.helper.click(10, 20, 0, 32, {}, h.ray);
    assert.deepEqual(h.calls, { finalize: 0, prepare: 0, render: 0, read: 0, desktop: 0, hover: 0 });
    assert.equal(h.events.length, 0);
    h.consume(false);
    h.helper.click(10, 20, 0, 32, {}, h.ray);
    assert.equal(h.calls.finalize, 1); assert.equal(h.calls.render, 1); assert.equal(h.calls.read, 1);
    assert.equal(h.events.length, 1); assert.equal(h.events[0].current.loci, h.loci);
    assert.equal(h.events[0].position, h.result.position);
  } finally { adapter.restore(); h.helper.dispose(); }
  assert.equal(h.helper.handleClick, original);
});

test('desktop, non-trigger, programmatic pinch and hover keep their original paths', () => {
  const h = harness(), adapter = attachXrConsumedTriggerClickGuard(h.options);
  try {
    h.present(false); h.helper.click(1, 2, 0, 32, {}, h.ray);
    h.present(true); h.helper.click(1, 2, 0, 1, {}, undefined);
    h.helper.click(1, 2, 0, 1, {}, h.ray);
    h.helper.click(1, 2, 0, 32, {}, undefined);
    assert.equal(h.events.length, 4);
    assert.equal(h.identify(h.ray), h.result, 'a direct pinch ray is not a controller release click');
    h.helper.startX = 0; h.helper.startY = 0;
    h.helper.move(4, 5, 0, 32, {}, h.ray); h.helper.handleMove();
    assert.equal(h.calls.hover, 1);
    assert.equal(h.calls.finalize, 5); assert.equal(h.calls.desktop, 2);
  } finally { adapter.restore(); h.helper.dispose(); }
});

test('genuine clicks preserve the original receiver, arguments, return and thrown error', () => {
  const calls = [], result = {}, helper = { button: 32, ray: {}, handleClick(...args) {
    calls.push({ receiver: this, args }); if (args[0] === 'throw') throw Error('original failure'); return result;
  } };
  const original = helper.handleClick;
  const adapter = attachXrConsumedTriggerClickGuard({ manager: { interactionHelper: helper },
    isPresenting: () => true, consumesClick: () => false });
  try {
    const argument = {};
    assert.equal(helper.handleClick(argument, 7), result);
    assert.equal(calls[0].receiver, helper); assert.deepEqual(calls[0].args, [argument, 7]);
    const other = { button: 32, ray: {} };
    assert.equal(helper.handleClick.call(other, argument), result);
    assert.equal(calls[1].receiver, other);
    assert.throws(() => helper.handleClick('throw'), /original failure/);
  } finally { adapter.restore(); }
  assert.equal(helper.handleClick, original);
});

test('restoring owners out of order retains active guards and never overwrites a later wrapper', () => {
  const h = harness(), original = h.helper.handleClick;
  const first = attachXrConsumedTriggerClickGuard(h.options), second = attachXrConsumedTriggerClickGuard(h.options);
  first.restore(); first.restore();
  h.helper.click(1, 2, 0, 32, {}, h.ray); assert.equal(h.calls.read, 0);
  second.restore(); assert.equal(h.helper.handleClick, original);
  const third = attachXrConsumedTriggerClickGuard(h.options), guard = h.helper.handleClick;
  const later = function (...args) { return guard.apply(this, args); };
  h.helper.handleClick = later;
  third.restore(); assert.equal(h.helper.handleClick, later);
  h.helper.click(1, 2, 0, 32, {}, h.ray); assert.equal(h.calls.read, 1, 'the retained restored guard is inert');
  h.helper.handleClick = guard;
  h.helper.click(1, 2, 0, 32, {}, h.ray); assert.equal(h.calls.read, 2);
  h.helper.dispose();
});

test('unsupported helpers and failed predicates retain picking', () => {
  assert.equal(attachXrConsumedTriggerClickGuard({ manager: {} }).applied, false);
  const h = harness(), adapter = attachXrConsumedTriggerClickGuard({ ...h.options,
    consumesClick: () => { throw Error('guard unavailable'); } });
  try { h.helper.click(1, 2, 0, 32, {}, h.ray); assert.equal(h.calls.read, 1); }
  finally { adapter.restore(); h.helper.dispose(); }
});

test('shared discovery attaches before the first update and isolates concurrent canvases', () => {
  const a = harness(), b = harness(), original = XRManager.prototype.update;
  const discovered = [], canvases = [{ webgl: {} }, { webgl: {} }];
  const managers = [a, b].map((h, index) => ({ ...h.options.manager, webgl: canvases[index].webgl }));
  XRManager.prototype.update = function () { this.interactionHelper.click(1, 2, 0, 32, {}, a.ray); return 'drawn'; };
  const baseline = XRManager.prototype.update;
  const install = (h, index) => installXrPointer({ canvas: canvases[index], onManager: manager => {
    discovered.push(manager); return attachXrConsumedTriggerClickGuard({ ...h.options, manager });
  } });
  const first = install(a, 0), second = install(b, 1);
  try {
    assert.equal(XRManager.prototype.update.call(managers[0]), 'drawn');
    assert.equal(a.calls.read, 0); assert.equal(discovered.length, 1);
    first.restore();
    XRManager.prototype.update.call(managers[1]);
    assert.equal(b.calls.read, 0); assert.equal(discovered.length, 2);
    assert.equal(XRManager.prototype.update, baseline);
    XRManager.prototype.update.call(managers[0]);
    assert.equal(a.calls.read, 1); assert.equal(b.calls.read, 0);
    second.restore(); second.restore();
    XRManager.prototype.update.call(managers[1]); assert.equal(b.calls.read, 1);
  } finally { first.restore(); second.restore(); XRManager.prototype.update = original; a.helper.dispose(); b.helper.dispose(); }
});

test('disposal before discovery restores the shared hook without attaching a guard', () => {
  const original = XRManager.prototype.update;
  let attached = 0;
  const adapter = installXrPointer({ canvas: { webgl: {} }, onManager: () => { attached++; } });
  adapter.restore(); adapter.restore();
  assert.equal(XRManager.prototype.update, original); assert.equal(attached, 0);
});
