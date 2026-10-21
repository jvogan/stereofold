import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { produce } from 'molstar/lib/mol-util/produce.js';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { BoundaryHelper } from 'molstar/lib/mol-math/geometry/boundary-helper.js';
import { patchMolstarPropsSource } from '../src/molstar-props-patch.js';

const vendor = readFileSync(new URL('../node_modules/molstar/lib/mol-canvas3d/canvas3d.js', import.meta.url), 'utf8');
const viewer = readFileSync(new URL('../../lab/browser-roundtrip/viewer.mjs', import.meta.url), 'utf8');
function harness(patched: boolean, forceFull = true) {
  let bounds = 0, reads = 0, dirty = true;
  const helper = new BoundaryHelper('98');
  const spheres = Array.from({ length: 100 }, (_, i) => ({ center: Vec3.create(i * 2, i % 7, i % 13), radius: 8 }));
  let sphere = { center: [0, 0, 0], radius: 100 };
  const scene = { setGlobals() {}, get boundingSphere() {
    if (dirty) {
      helper.reset();
      for (const s of spheres) helper.includeSphere(s);
      helper.finishedIncludeStep();
      for (const s of spheres) helper.radiusSphere(s);
      sphere = helper.getSphere(); bounds++; dirty = false;
    }
    return sphere;
  } };
  const props = { props: {}, setProps() {} };
  const camera = { forceFull, state: { mode: 'perspective', fov: 1, fog: 0, radius: 50 }, transition: { target: { radius: 50 } },
    setState(value: object) { Object.assign(this.state, value); Object.assign(this.transition.target, value); } };
  const context: any = { scene, camera, getSceneRadius: () => scene.boundingSphere.radius * context.p.sceneRadiusFactor,
    radToDeg: (v: number) => v * 180 / Math.PI,
    degToRad: (v: number) => v * Math.PI / 180, produce,
    helper: { camera: props, handle: props, pointer: props }, p: { sceneRadiusFactor: 1,
      camera: { stereo: { name: 'off', params: { eyeSeparation: 0.06, focus: 10 } } },
      postprocessing: { antialiasing: { name: 'smaa' } }, marking: {}, illumination: {}, multiSample: { mode: 'temporal' } },
    controls: { props: { animate: { name: 'off' }, staticMoving: true }, setProps() {} },
    hiZ: props, renderer: { props: { light: [] }, setProps() {} }, interactionHelper: props, xrManager: props,
    stereoCamera: { setProps() {} }, shaderManager: { updateRequired() {} },
    requestDraw() {}, syncCanvasBackground() {}, canvas: {},
  };
  const optimized = patchMolstarPropsSource(vendor);
  const source = patched ? optimized : vendor;
  const evaluate = (code: string) => new Function(...Object.keys(context), code)(...Object.values(context));
  context.getProps = evaluate(source.slice(source.indexOf('        function getProps()'), source.indexOf('        const contextLostSub')) + '\nreturn getProps;');
  const canvas = { camera, get props() { reads++; return context.getProps(); },
    setProps: evaluate('return ({' + source.slice(source.indexOf('            setProps: (properties, doNotRequestDraw = false) => {'),
      source.indexOf('            setAttribs: (attribs) => {')) + '}).setProps;'),
    getSnapshotSettings: evaluate('return ({' + optimized.slice(optimized.indexOf('            getSnapshotSettings(includeClipping)'),
      optimized.indexOf('            get props() {\n                return getProps();')) + '}).getSnapshotSettings;'),
  };
  const from = viewer.indexOf('      trackballAnimation:');
  const to = viewer.indexOf('      ...(inspectionState ? { inspectionMotion:', from);
  let fields = viewer.slice(from, to);
  if (!patched) fields = fields.replace('canvasSettings.trackballAnimation', 'canvas.props.trackball.animate.name')
    .replace('canvasSettings.staticMoving', 'canvas.props.trackball.staticMoving')
    .replace('canvasSettings.desktopStereo', 'canvas.props.camera.stereo.name')
    .replace('canvasSettings.clipping', 'canvas.props.cameraClipping.radius');
  const prelude = viewer.slice(viewer.indexOf('    const canvasSettings ='), viewer.indexOf('    return detached({', viewer.indexOf('    const canvasSettings =')));
  const snapshot = new Function('canvas', 'inspectionState', 'inspectionLabel',
    `return () => { ${patched ? prelude : ''} return { ${fields} }; };`)(canvas,
    { snapshot: () => ({}) }, null);
  return { canvas, context, snapshot, invalidate() { dirty = true; },
    setSceneRadius(radius: number) { sphere = { center: [0, 0, 0], radius }; dirty = false; },
    counts: () => ({ bounds, reads }) };
}

it.each([false, true])('captures clipping before a retained props snapshot is serialized (patched=%s)', patched => {
  const h = harness(patched, false);
  h.setSceneRadius(100);
  // PluginState retains the props object until the snapshot is serialized.
  const snapshot = { canvas3d: { props: h.canvas.props } };
  h.setSceneRadius(200);
  expect(JSON.parse(JSON.stringify(snapshot)).canvas3d.props.cameraClipping.radius).toBe(50);
  expect(h.canvas.props.cameraClipping.radius).toBe(75);
});

it.each([false, true])('applies captured clipping when sceneRadiusFactor is edited (patched=%s)', patched => {
  const h = harness(patched, false);
  h.setSceneRadius(100);
  const p = h.canvas.props;
  p.sceneRadiusFactor = 2;
  h.canvas.setProps(p);
  expect(h.canvas.camera.state.radius).toBe(100);
  expect(h.context.p.sceneRadiusFactor).toBe(2);
});

it('keeps ordinary settings bounds-free and preserves explicit clipping reads and edits', () => {
  const h = harness(true);
  expect(h.snapshot().inspectionRender.clipping).toBe(0);
  expect(h.counts()).toEqual({ bounds: 0, reads: 0 });
  const p = h.canvas.props;
  expect(p.trackball.staticMoving).toBe(true);
  expect(h.counts().bounds).toBe(1);
  expect(Object.getOwnPropertyDescriptor(p, 'cameraClipping')?.get).toBeUndefined();
  h.context.controls.props.staticMoving = false;
  h.context.p.camera.stereo.name = 'on';
  expect(h.snapshot().staticMoving).toBe(false);
  expect(h.snapshot().desktopStereo).toBe('on');
  const radius = p.cameraClipping.radius;
  expect(h.counts().bounds).toBe(1);
  h.invalidate();
  expect(p.cameraClipping.radius).toBe(radius);
  expect(h.counts().bounds).toBe(1);
  p.cameraClipping.radius = 20;
  expect(p.cameraClipping.radius).toBe(20);
  expect(structuredClone(p).cameraClipping.radius).toBe(20);
  const edited = produce(p, (draft: any) => { draft.cameraClipping.radius = 35; });
  expect(edited.cameraClipping.radius).toBe(35);
  expect(p.cameraClipping.radius).toBe(20);
  const stock = harness(false, false), patched = harness(true, false);
  patched.canvas.getSnapshotSettings(false);
  expect(patched.counts().bounds).toBe(0);
  expect(patched.snapshot()).toEqual(stock.snapshot());
  patched.canvas.camera.transition.target.radius = 30;
  stock.canvas.camera.transition.target.radius = 30;
  patched.invalidate(); stock.invalidate();
  expect(patched.snapshot()).toEqual(stock.snapshot());
  expect(() => patchMolstarPropsSource('changed')).toThrow('anchor changed');
});

it('reads current acceptance snapshot settings without evaluating bounds', () => {
  const h = harness(true);
  expect(h.canvas.getSnapshotSettings(false)).toMatchObject({ stereo: undefined, antialiasing: 'smaa', multiSample: 'temporal' });
  h.context.p.camera.stereo.name = 'on';
  h.context.p.postprocessing.antialiasing.name = 'off';
  h.context.p.multiSample.mode = 'off';
  const settings = h.canvas.getSnapshotSettings(false);
  expect(settings).toMatchObject({ stereo: { eyeSeparation: 0.06, focus: 10 }, antialiasing: 'off', multiSample: 'off' });
  h.context.p.camera.stereo.params.focus = 20;
  expect(settings.stereo.focus).toBe(10);
  expect(h.counts()).toEqual({ bounds: 0, reads: 0 });
});

it('measures the snapshot settings path with dirty real BoundaryHelper bounds', () => {
  const frames = 2000, snapshotsPerFrame = 4;
  const results = [false, true].map(patched => {
    const h = harness(patched);
    const start = performance.now();
    for (let frame = 0; frame < frames; frame++) {
      h.invalidate();
      for (let i = 0; i < snapshotsPerFrame; i++) h.snapshot();
    }
    return { patched, frames, snapshotsPerFrame, ...h.counts(), ms: +(performance.now() - start).toFixed(2) };
  });
  expect(results[0].bounds).toBe(frames);
  expect(results[1].bounds).toBe(0);
  expect(results[0].reads).toBe(frames * snapshotsPerFrame * 4);
  expect(results[1].reads).toBe(0);
  console.log('snapshot settings benchmark', JSON.stringify(results));
});
