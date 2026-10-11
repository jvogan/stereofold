import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createNaturalInput, naturalRayFor, transformNaturalPointer } from './natural-input.mjs';
import { poseFromRay } from './natural-input-emulator.mjs';
import { createXrManipulation } from './xr-manipulate.mjs';

const ray = (x = 0) => ({ origin: [x, 1.4, 0], direction: [0, 0, -1] });
function rig() {
  const poses = new Map(), space = {}, translations = [], scales = [], rotations = [], picks = [], ends = [];
  const frame = () => ({ getPose: key => poses.get(key) });
  const put = (key, x, quality = false, roll = 0) => {
    if (x === null) { poses.delete(key); return; }
    const pose = poseFromRay(ray(x)), matrix = [...pose.transform.matrix];
    matrix[0] = Math.cos(roll); matrix[1] = Math.sin(roll); matrix[4] = -Math.sin(roll); matrix[5] = Math.cos(roll);
    poses.set(key, { emulatedPosition: quality, transform: { ...pose.transform, matrix,
      orientation: { x: 0, y: 0, z: Math.sin(roll / 2), w: Math.cos(roll / 2) } } });
  };
  const manipulation = createXrManipulation({ onTranslate: value => translations.push(value), onScale: value => scales.push(value),
    onRotate: value => rotations.push(value), onGrabEnd: value => ends.push(value), record: () => {}, pulse: () => false });
  const adapter = createNaturalInput({ rayFor: (f, source) => naturalRayFor(f, source, space),
    gripFor: (f, source) => naturalRayFor(f, { targetRaySpace: source.gripSpace }, space),
    onDrive: list => manipulation.update(list), pick: value => picks.push(value), record: () => {} });
  function pinch({ grip = true, x = 0 } = {}) {
    const source = { handedness: 'none', targetRayMode: 'transient-pointer', targetRaySpace: {}, ...(grip ? { gripSpace: {} } : {}) };
    put(source.targetRaySpace, 0); if (grip) put(source.gripSpace, x);
    return { source, start: () => adapter.selectStart({ inputSource: source, frame: frame() }),
      move: (x, quality = false, roll = 0) => put(grip ? source.gripSpace : source.targetRaySpace, x, quality, roll),
      end: () => { adapter.select({ inputSource: source, frame: frame() }); adapter.selectEnd({ inputSource: source, frame: frame() }); adapter.sourcesChange({ removed: [source] }); } };
  }
  return { adapter, manipulation, pinch, translations, rotations, scales, picks, ends, frame: () => adapter.frame(frame()) };
}

test('none-handed pinch carries from grip while its eye ray stays fixed', () => {
  const r = rig(), p = r.pinch(); p.start(); p.move(.04); r.frame();
  assert.equal(r.manipulation.phase(), 'grab'); p.move(.14); r.frame();
  assert.ok(Math.abs(r.translations.at(-1)[0] - .1) < 1e-10);
  assert.deepEqual(r.adapter.pointers()[0].ray.origin, [0, 1.4, 0]);
  p.end(); r.frame(); assert.equal(r.picks.length, 0); assert.equal(r.manipulation.phase(), 'idle');
});

test('two pinches scale from finger spacing despite shared eye-ray origin', () => {
  const r = rig(), a = r.pinch({ x: -.2 }), b = r.pinch({ x: .2 }); a.start(); b.start();
  a.move(-.24); b.move(.24); r.frame(); a.move(-.3); b.move(.3); r.frame(); a.move(-.36); b.move(.36); r.frame();
  assert.equal(r.manipulation.phase(), 'scale'); assert.ok(r.scales.at(-1) > 1);
});

test('pinch wrist roll is carried by grip orientation', () => {
  const r = rig(), p = r.pinch(); p.start(); p.move(0, false, .1); r.frame();
  p.move(0, false, .2); r.frame(); assert.equal(r.rotations.length, 1);
});

test('orientation-only pinch does not translate from emulated origin changes', () => {
  const r = rig(), p = r.pinch({ grip: false }); p.move(0, true); p.start();
  p.move(.1, true, .1); r.frame(); p.move(.2, true, .2); r.frame();
  assert.equal(r.translations.length, 0); assert.equal(r.scales.length, 0);
});

test('missing pinch pose rebases on recovery before carrying again', () => {
  const r = rig(), p = r.pinch({ grip: false }); p.start(); p.move(.04); r.frame();
  p.move(.06); r.frame(); const count = r.translations.length;
  p.move(null); r.frame(); p.move(.26); r.frame(); assert.equal(r.translations.length, count);
  p.move(.28); r.frame(); assert.ok(Math.abs(r.translations.at(-1)[0] - .02) < 1e-10);
});

test('movement delivered only by release events never becomes a residue pick', () => {
  const r = rig(), p = r.pinch({ grip: false }); p.start(); p.move(.1); p.end(); r.frame();
  assert.equal(r.picks.length, 0);
});

test('a grip tracking gap never falls back to the eye origin', () => {
  const r = rig(), p = r.pinch({ x: .2 }); p.start(); p.move(.24); r.frame(); p.move(.26); r.frame();
  const count = r.translations.length; p.move(null); r.frame(); p.move(.46); r.frame();
  assert.equal(r.translations.length, count); p.move(.48); r.frame();
  assert.ok(Math.abs(r.translations.at(-1)[0] - .02) < 1e-10);
});


test('source replacement between frames starts a fresh pinch baseline', () => {
  const r = rig(), a = r.pinch(); a.start(); a.move(.04); r.frame(); a.move(.06); r.frame();
  const count = r.translations.length; a.end();
  const b = r.pinch({ x: .2 }); b.start(); b.move(.24); r.frame();
  assert.equal(r.translations.length, count);
  b.move(.26); r.frame(); assert.ok(Math.abs(r.translations.at(-1)[0] - .02) < 1e-10);
});

for (const hand of ['left', 'right']) test(`${hand} tracked source replacement ends the old grip and starts a fresh pose baseline`, () => {
  const translations = [], rotations = [], ends = [];
  const manipulation = createXrManipulation({ onTranslate: value => translations.push(value),
    onRotate: value => rotations.push(value), onGrabEnd: value => ends.push(value), record() {}, pulse() {} });
  const a = { targetRayMode: 'tracked-pointer' }, b = { targetRayMode: 'tracked-pointer' };
  const update = (source, x, roll = 0) => manipulation.update([{ handedness: hand, source, buttons: 2,
    ray: { ...ray(x), orientation: [0, 0, Math.sin(roll / 2), Math.cos(roll / 2)] } }]);
  update(a, 0); update(a, .04);
  assert.equal(translations.length, 1);
  update(b, .24, .2);
  assert.equal(translations.length, 1, 'a new controller cannot inherit the old controller’s translation');
  assert.equal(rotations.length, 0, 'a new controller cannot inherit the old controller’s wrist orientation');
  assert.equal(ends.length, 1, 'source replacement closes the old gesture once');
  update(b, .26, .3);
  assert.ok(Math.abs(translations.at(-1)[0] - .02) < 1e-10);
  assert.equal(rotations.length, 1, 'the new source remains able to rotate from its own baseline');
  manipulation.update([]);
});

for (const replacedHand of ['left', 'right']) test(`${replacedHand} tracked source replacement rebases a surviving two-hand scale`, () => {
  const scales = [], translations = [], rotations = [], ends = [];
  const manipulation = createXrManipulation({ onScale: value => scales.push(value),
    onTranslate: value => translations.push(value), onRotate: value => rotations.push(value),
    onGrabEnd: value => ends.push(value), record() {}, pulse() {} });
  const sources = { left: {}, right: {} }, origins = { left: -.2, right: .2 };
  const update = () => manipulation.update(['left', 'right'].map(handedness => ({ handedness,
    source: sources[handedness], buttons: 2, ray: ray(origins[handedness]) })));
  update(); origins.left = -.24; origins.right = .24; update();
  assert.equal(manipulation.phase(), 'scale');
  const before = [scales.length, translations.length, rotations.length];
  sources[replacedHand] = {}; origins[replacedHand] += replacedHand === 'left' ? -.2 : .2;
  update();
  assert.deepEqual([scales.length, translations.length, rotations.length], before,
    'replacement must not translate or scale from the previous source’s span');
  assert.equal(ends.length, 0, 'the surviving controller keeps its gesture');
  origins.left -= .02; origins.right += .02; update();
  assert.equal(scales.length, before[0] + 1, 'a complete new span can scale again');
  manipulation.update([{ handedness: 'left', source: sources.left, buttons: 0, ray: ray(origins.left) },
    { handedness: 'right', source: sources.right, buttons: 0, ray: ray(origins.right) }]);
  assert.equal(ends.length, 1);
});


test('a completed pinch bakes once before a fresh source starts in its slot', () => {
  const r = rig(), a = r.pinch(); a.start(); a.move(.04); r.frame(); a.move(.06); r.frame(); a.end();
  const b = r.pinch({ x: .2 }); b.start(); b.move(.24); r.frame();
  assert.equal(r.ends.length, 1); assert.equal(r.ends[0].moved, .02);
  b.end(); r.frame(); assert.equal(r.ends.length, 2);
});

test('persistent hands can fill a released pinch slot before the next pinch', () => {
  const r = rig(), a = r.pinch(); a.start(); a.move(.04); r.frame(); a.move(.06); r.frame();
  a.end(); const persistent = { handedness: 'right', targetRayMode: 'tracked-pointer' };
  r.manipulation.update([{ handedness: 'right', source: persistent, buttons: 0, ray: ray(.8) }]);
  assert.equal(r.manipulation.phase(), 'idle'); assert.equal(r.ends.length, 1);
  const b = r.pinch({ x: .2 }); b.start(); b.move(.24); r.frame();
  assert.equal(r.translations.length, 1); assert.equal(r.manipulation.phase(), 'grab');
  b.move(.26); r.frame(); assert.ok(Math.abs(r.translations.at(-1)[0] - .02) < 1e-10);
});

for (const held of [false, true]) test(`visibility suspension drops ${held ? 'held' : 'pending'} pinch until a new source`, () => {
  const r = rig(), a = r.pinch(); a.start();
  if (held) { a.move(.04); r.frame(); }
  r.manipulation.suspend(); r.adapter.reset();
  a.move(.3); r.frame(); a.end(); r.frame();
  assert.equal(r.picks.length, 0); assert.equal(r.translations.length, 0);
  const b = r.pinch({ x: .2 }); b.start(); b.move(.24); r.frame();
  assert.equal(r.manipulation.phase(), 'grab'); b.move(.26); r.frame();
  assert.ok(Math.abs(r.translations.at(-1)[0] - .02) < 1e-10);
});

test('viewer transforms pinch and controller poses through the same rotated view', () => {
  const require = createRequire(import.meta.url);
  const { Mat4 } = require('../../plugin/node_modules/molstar/lib/commonjs/mol-math/linear-algebra.js');
  const viewer = readFileSync(new URL('./viewer.mjs', import.meta.url), 'utf8');
  const start = viewer.indexOf('  function xrRenderPose(pose) {');
  const end = viewer.indexOf('  function beginXrManipulation()', start);
  const view = Mat4.fromRotation(Mat4(), Math.PI / 2, [0, 1, 0]);
  const transform = new Function('Mat4', 'canvas', viewer.slice(start, end) + '; return xrRenderPose;')(Mat4, { camera: { view } });
  const roomPose = naturalRayFor({ getPose: () => poseFromRay(ray(.1)) }, { targetRaySpace: {} }, {});
  const roomGrip = naturalRayFor({ getPose: () => poseFromRay(ray(.2)) }, { targetRaySpace: {} }, {});
  const transformed = transformNaturalPointer({ ray: roomPose, gripPose: roomGrip }, transform);
  assert.ok(Math.abs(transformed.gripPose.origin[0]) < 1e-10);
  assert.ok(Math.abs(transformed.gripPose.origin[2] - .2) < 1e-10);
  assert.deepEqual(transformed.ray, transform(roomPose));
  assert.deepEqual(roomPose.origin, [.1, 1.4, 0], 'room-space pick ray remains unchanged');
  assert.ok(viewer.includes('transformPose: xrRenderPose'));
  assert.ok(viewer.includes('natural.map(pointer => transformNaturalPointer(pointer, xrRenderPose))'));
  assert.ok(viewer.includes('xrManipulation?.suspend();\n    naturalInput?.reset();'));
});

test('a stationary finger pinch still picks through its eye ray', () => {
  const r = rig(), p = r.pinch({ x: .3 }); p.start(); p.end(); r.frame();
  assert.equal(r.picks.length, 1); assert.deepEqual(r.picks[0].ray.origin, [0, 1.4, 0]);
  assert.equal(r.translations.length, 0);
});

test('plain no-grip callers retain their legacy ray-drag behavior', () => {
  let current = ray(), list;
  const source = { handedness: 'none', targetRayMode: 'transient-pointer' };
  const adapter = createNaturalInput({ rayFor: () => current, record() {}, onDrive: value => { list = value; } });
  adapter.selectStart({ inputSource: source }); current = ray(.04); adapter.frame({});
  assert.equal(list.length, 1); assert.equal(list[0].poseQualitySource, undefined);
  const translations = [], manipulation = createXrManipulation({ record() {}, pulse() {}, onTranslate: value => translations.push(value) });
  manipulation.update(list); current = ray(.06); adapter.frame({}); manipulation.update(list);
  assert.ok(Math.abs(translations[0][0] - .02) < 1e-10);
});

test('replacing one pinch while the other holds rebases scale without ending its grab', () => {
  const r = rig(), a = r.pinch({ x: -.2 }), b = r.pinch({ x: .2 }); a.start(); b.start();
  a.move(-.24); b.move(.24); r.frame(); r.frame();
  a.move(-.3); b.move(.3); r.frame(); const count = r.scales.length;
  a.end(); const c = r.pinch({ x: -.4 }); c.start(); c.move(-.44); r.frame();
  assert.equal(r.ends.length, 0); assert.equal(r.scales.length, count);
  c.move(-.46); b.move(.32); r.frame(); assert.ok(r.scales.length > count);
  b.end(); c.end(); r.frame(); assert.equal(r.ends.length, 1);
});

for (const held of [false, true]) test(`fresh pinch clears the expired ${held ? 'held' : 'released'} controller source guard`, () => {
  let time = 0;
  const manipulation = createXrManipulation({ now: () => time, record() {}, pulse() {} });
  const controller = { handedness: 'right', targetRayMode: 'tracked-pointer' };
  manipulation.update([{ handedness: 'right', source: controller, buttons: held ? 2 : 0, ray: ray() }]);
  for (let i = 0; i < 12; i++) { time += 100; manipulation.update([]); }
  assert.equal(manipulation.requiresRelease('right'), held, 'only an actually held source needs release');
  const source = { handedness: 'none', targetRayMode: 'transient-pointer' };
  manipulation.update([{ handedness: 'right', source, transient: true, buttons: 2, ray: ray(.2) }]);
  assert.equal(manipulation.requiresRelease('right'), false);
  assert.equal(manipulation.phase(), 'grab');
});

test('the same still-held transient source remains blocked after a tracking timeout', () => {
  let time = 0;
  const manipulation = createXrManipulation({ now: () => time, record() {}, pulse() {} });
  const source = { handedness: 'none', targetRayMode: 'transient-pointer' };
  const pointer = { handedness: 'right', source, transient: true, buttons: 2, ray: ray() };
  manipulation.update([pointer]);
  for (let i = 0; i < 12; i++) { time += 100; manipulation.update([{ ...pointer, ray: undefined }]); }
  manipulation.update([pointer]);
  assert.equal(manipulation.requiresRelease('right'), true);
  assert.equal(manipulation.phase(), 'idle');
  manipulation.update([{ ...pointer, source: { ...source } }]);
  assert.equal(manipulation.requiresRelease('right'), false);
  assert.equal(manipulation.phase(), 'grab');
});
