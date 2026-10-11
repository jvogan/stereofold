import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Frustum3D } from 'molstar/lib/mol-math/geometry/primitives/frustum3d.js';
import { Plane3D } from 'molstar/lib/mol-math/geometry/primitives/plane3d.js';
import { Sphere3D } from 'molstar/lib/mol-math/geometry/primitives/sphere3d.js';
import { calcInstanceGrid } from 'molstar/lib/mol-math/geometry/instance-grid.js';
import { calculateTransformBoundingSphere } from 'molstar/lib/mol-gl/renderable/util.js';
import { createRenderable } from 'molstar/lib/mol-gl/renderable.js';
import { patchMolstarXrCullingRendererSource } from '../src/molstar-xr-culling-patch.js';
import { patchMolstarOpaqueRendererSource } from '../src/molstar-opaque-depth-patch.js';
import { patchMolstarBlendedTransparentSource } from '../src/molstar-transparent-mesh-patch.js';

const root = new URL('..', import.meta.url).pathname;
const renderer = readFileSync(new URL('../node_modules/molstar/lib/mol-gl/renderer.js', import.meta.url), 'utf8');
const { version } = JSON.parse(readFileSync(new URL('../node_modules/molstar/package.json', import.meta.url), 'utf8'));
const patched = patchMolstarXrCullingRendererSource(renderer, version);
const RENDER_OBJECT = '        const renderObject = (r, variant, flag) => {';
const UPDATE = '        const update = (camera, scene) => {';
const SCALE_ONE_CULL = '                    r.cull(cameraPlane, frustum, isOccluded, ctx.stats);';
const SIMPLE_CULL = '                    r.cullSimple(d, radius, modelScale);';

const cell = (value: any) => ({ ref: { value, version: 0 } });
type View = { frustum: Frustum3D; plane: Plane3D; scale: number };

/** Run the vendor renderObject, stock or patched, over Mol*'s own math and
 * renderable. Only GL state and program binding are recording seams. */
function harness(source: string) {
  const from = source.includes('stereofoldModelFrustum') ? source.indexOf('        // Stereofold: the camera frustum') : source.indexOf(RENDER_OBJECT);
  const body = source.slice(from, source.indexOf(UPDATE));
  const context: any = vm.createContext({ Frustum3D, Plane3D, Sphere3D,
    Flag: { None: 0, BlendedFront: 1, BlendedBack: 2 }, gl: { CULL_FACE: 1, CW: 2, CCW: 3, FRONT: 4, BACK: 5 },
    state: { currentProgramId: -1, enable() {}, disable() {}, frontFace() {}, cullFace() {} },
    ctx: { stats: { culled: { lod: 0, frustum: 0, occlusion: 0 } } }, globalUniformList: [], sharedTexturesList: [] });
  vm.runInContext(`let globalUniformsNeedUpdate = true, modelScale = 1, isOccluded = null;
    const frustum = Frustum3D(), cameraPlane = Plane3D(), boundingSphere = Sphere3D();
    ${body}
    globalThis.draw = (r, view, occlusion = null) => {
      Frustum3D.copy(frustum, view.frustum); Plane3D.copy(cameraPlane, view.plane);
      modelScale = view.scale; isOccluded = occlusion; renderObject(r, 'color', Flag.None);
    };`, context);
  return context.draw as (r: any, view: View, occlusion?: ((s: Sphere3D) => boolean) | null) => void;
}
const stock = harness(renderer), candidate = harness(patched);

/** The view Mol*'s Camera builds at `scale`: positions, near and far scaled,
 * the same frustum shape. Tangents describe an asymmetric per-eye frustum. */
function view(eye: number[], target: number[], scale: number, tangents = [-0.6, 0.6, 0.45, -0.45], orthographic = false): View {
  const near = 10 * scale, far = 5000 * scale;
  const [left, right, top, bottom] = orthographic ? tangents.map(t => t * 40 * scale) : tangents.map(t => t * near);
  const projection = orthographic ? Mat4.ortho(Mat4(), left!, right!, top!, bottom!, near, far)
    : Mat4.perspective(Mat4(), left!, right!, top!, bottom!, near, far);
  const position = Vec3.scale(Vec3(), Vec3.create(eye[0]!, eye[1]!, eye[2]!), scale);
  const lookAt = Mat4.lookAt(Mat4(), position, Vec3.scale(Vec3(), Vec3.create(target[0]!, target[1]!, target[2]!), scale), Vec3.create(0, 1, 0));
  const frustum = Frustum3D.fromProjectionMatrix(Frustum3D(), Mat4.mul(Mat4(), projection, lookAt));
  // renderer.js `update`: the near plane moved to pass through the camera.
  const plane = Plane3D.copy(Plane3D(), frustum[Frustum3D.PlaneIndex.Near]);
  plane.constant -= Plane3D.distanceToPoint(plane, position);
  return { frustum, plane, scale };
}

const RADIUS = 25;
/** A 10x10x10 lattice of instances 120 Å apart, centred on the origin. */
function lattice(side = 10, spacing = 120): Float32Array {
  const transforms = new Float32Array(side ** 3 * 16);
  let i = 0;
  for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) for (let z = 0; z < side; z++, i++) {
    const offset = (side - 1) * spacing / 2;
    transforms.set(Mat4.fromTranslation(Mat4(), Vec3.create(x * spacing - offset, y * spacing - offset, z * spacing - offset)), i * 16);
  }
  return transforms;
}

function renderable(transforms: Float32Array, extra: Record<string, any> = {}) {
  const count = transforms.length / 16;
  const invariant = Sphere3D.create(Vec3(), RADIUS);
  const grid = calcInstanceGrid({ instanceCount: count, instance: Float32Array.from({ length: count }, (_, i) => i),
    transform: transforms, invariantBoundingSphere: invariant }, 200, 400);
  const values: any = { drawCount: cell(36), instanceCount: cell(count), uInstanceCount: cell(count), instanceGrid: cell(grid),
    boundingSphere: cell(calculateTransformBoundingSphere(invariant, transforms, count, 0)), uLod: cell([0, 0, 0, 0]),
    dGeometryType: cell('mesh'), uDoubleSided: cell(false), hasReflection: cell(false), dFlipSided: cell(false),
    ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, cell(value)])) };
  const frames: (any[] | undefined)[] = [];
  const item = { materialId: 0, update() {}, getProgram: () => ({ id: 1, use() {}, setUniforms() {}, bindTextures() {} }),
    render: (_variant: string, _textures: number, lists?: any[]) => { frames.push(lists); } };
  const r: any = createRenderable(item as any, values, { disposed: false, visible: true, pickable: true, colorOnly: false,
    alphaFactor: 1, opaque: true, writeDepth: true, noClip: false, colorWriteDisabled: false, depthWriteDisabled: false } as any);
  /** Instance ids drawn per LOD level in the last frame; nothing if the
   * object was culled whole, every instance if the draw was not split. */
  const drawn = (fn: () => void): number[][] => {
    const before = frames.length;
    fn();
    if (frames.length === before) return [];
    const lists = frames[frames.length - 1];
    if (!lists) return [Array.from({ length: count }, (_, i) => i)];
    return lists.map(list => {
      const ids: number[] = [];
      for (let i = 0; i < list.count; i++) for (let k = list.baseInstances[i]; k < list.baseInstances[i] + list.instanceCounts[i]; k++) ids.push(grid.cellInstance[k]!);
      return ids.sort((a, b) => a - b);
    });
  };
  /** Instances whose own sphere meets the view; these must never be culled. */
  const visible = (v: View) => Array.from({ length: count }, (_, i) => i).filter(i => {
    const centre = Vec3.scale(Vec3(), Vec3.create(transforms[i * 16 + 12]!, transforms[i * 16 + 13]!, transforms[i * 16 + 14]!), v.scale);
    return Frustum3D.intersectsSphere3D(v.frustum, Sphere3D.create(centre, RADIUS * v.scale));
  });
  return { r, count, drawn, visible };
}

// Inside the lattice (the giant view), outside it (tabletop), per-eye
// off-axis frusta, and the thin orthographic box a ray pick renders.
const scenes = [
  { name: 'standing inside', eye: [10, 5, 3], target: [200, 30, -50] },
  { name: 'tabletop, half in view', eye: [0, 40, 1500], target: [700, 0, 0] },
  { name: 'left eye, off-axis', eye: [-5, 0, 120], target: [-5, 0, -400], tangents: [-0.7, 0.5, 0.5, -0.4] },
  { name: 'right eye, off-axis', eye: [5, 0, 120], target: [5, 0, -400], tangents: [-0.5, 0.7, 0.5, -0.4] },
  { name: 'pick ray box', eye: [30, 30, 600], target: [30, 30, 0], tangents: [-0.05, 0.05, 0.05, -0.05], orthographic: true },
];
const scales = [0.006, 0.12, 2.5];

describe('Mol* XR culling patch', () => {
  it('patches only the scaled branch and leaves the scale-1 path byte for byte', () => {
    expect(patched).not.toBe(renderer);
    expect(patched.startsWith(renderer.slice(0, renderer.indexOf(RENDER_OBJECT)))).toBe(true);
    expect(patched.endsWith(renderer.slice(renderer.indexOf(UPDATE)))).toBe(true);
    const scaleOne = renderer.slice(renderer.indexOf('            const unscaled'), renderer.indexOf('            else {\n                if (r.values.lodLevels)'));
    expect(scaleOne).toContain(SCALE_ONE_CULL);
    expect(patched).toContain(scaleOne);
    expect(patched).not.toContain(SIMPLE_CULL);
  });

  it('fails closed for version, drift, duplicate and repeated patching', () => {
    expect(() => patchMolstarXrCullingRendererSource(renderer, '5.11.1')).toThrow('5.11.0');
    expect(() => patchMolstarXrCullingRendererSource('', '5.11.0')).toThrow('anchor changed');
    expect(() => patchMolstarXrCullingRendererSource(renderer + renderer, '5.11.0')).toThrow('anchor changed');
    for (const [from, to] of [[SIMPLE_CULL, '                    r.cullSimple(d, radius, 1);'], [SCALE_ONE_CULL, '                    r.cull(cameraPlane, frustum, null, ctx.stats);'],
      ['            const unscaled = modelScale === 1;', '            const unscaled = modelScale > 0.99;'], [RENDER_OBJECT, '        const renderObject = (r, variant) => {']]) {
      expect(renderer.split(from!).length).toBe(2);
      expect(() => patchMolstarXrCullingRendererSource(renderer.replace(from!, to!), '5.11.0')).toThrow('anchor changed');
    }
    expect(() => patchMolstarXrCullingRendererSource(patched, '5.11.0')).toThrow('already applied');
    const crlf = patchMolstarXrCullingRendererSource(renderer.replaceAll('\n', '\r\n'), '5.11.0');
    expect(crlf).toBe(patched.replaceAll('\n', '\r\n'));
  });

  it('composes after the renderer patches the build already applies, and the result bundles', async () => {
    const inspector = patchMolstarXrCullingRendererSource(
      patchMolstarOpaqueRendererSource(patchMolstarBlendedTransparentSource(renderer)), version);
    const viewer = patchMolstarXrCullingRendererSource(patchMolstarOpaqueRendererSource(renderer), version);
    for (const source of [inspector, viewer]) {
      expect(source).toContain('stereofoldModelFrustum');
      expect(source).toContain('stereofoldQuestOpaque');
      const result = await build({ stdin: { contents: "export { Renderer } from 'molstar/lib/mol-gl/renderer.js';", resolveDir: root },
        bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
        plugins: [{ name: 'renderer', setup(api) { api.onLoad({ filter: /mol-gl[/\\]renderer\.js$/ }, () => ({ contents: source, loader: 'js' })); } }] });
      expect(result.errors).toEqual([]);
    }
  });

  it.each(scenes)('culls at XR scales exactly as Mol* culls at scale 1: $name', scene => {
    const object = renderable(lattice());
    const reference = object.drawn(() => stock(object.r, view(scene.eye, scene.target, 1, scene.tangents, scene.orthographic)));
    expect(reference.length).toBe(1);
    expect(reference[0]!.length).toBeGreaterThan(0);
    expect(reference[0]!.length).toBeLessThan(object.count);
    for (const scale of scales) {
      const scaled = view(scene.eye, scene.target, scale, scene.tangents, scene.orthographic);
      const result = object.drawn(() => candidate(object.r, scaled));
      expect(result).toEqual(reference);
      expect(object.visible(scaled).filter(id => !result[0]!.includes(id))).toEqual([]);
      // Stock Mol* draws the whole object at the same scaled view.
      expect(object.drawn(() => stock(object.r, scaled))).toEqual([Array.from({ length: object.count }, (_, i) => i)]);
    }
  });

  it('matches scale-1 LOD bounds in model units, per cell and per sphere LOD level', () => {
    const lod = renderable(lattice(), { uLod: [0, 520, 0, 0] });
    const levels = renderable(lattice(), { lodLevels: [[0, 300, 0, 36, 1], [300, 1e6, 0, 12, 3]] });
    for (const scene of scenes.slice(0, 2)) for (const object of [lod, levels]) {
      const reference = object.drawn(() => stock(object.r, view(scene.eye, scene.target, 1)));
      for (const scale of scales) expect(object.drawn(() => candidate(object.r, view(scene.eye, scene.target, scale)))).toEqual(reference);
    }
    const near = levels.drawn(() => stock(levels.r, view(scenes[0]!.eye, scenes[0]!.target, 1)));
    expect(near.map(ids => ids.length).every(length => length > 0)).toBe(true);
  });

  it('replaces the stale draw list stock Mol* keeps for sphere objects after a scale-1 frame', () => {
    // Spheres carry a lodLevels cell even when it is empty, so stock Mol*
    // calls cullSimple away from scale 1, which returns before resetting the
    // previous frame's cull. A desktop frame before XR entry leaves its list.
    const desktop = view([0, 0, 1500], [900, 0, 0], 1), immersive = view([0, 0, 1500], [-900, 0, 0], 0.006);
    const run = (draw: typeof stock) => {
      const object = renderable(lattice(), { lodLevels: [] });
      object.drawn(() => draw(object.r, desktop));
      return { object, ids: object.drawn(() => draw(object.r, immersive))[0]! };
    };
    const before = run(stock), after = run(candidate);
    const missing = before.object.visible(immersive).filter(id => !before.ids.includes(id));
    expect(missing.length).toBeGreaterThan(0);
    expect(after.object.visible(immersive).filter(id => !after.ids.includes(id))).toEqual([]);
    expect([after.ids]).toEqual(after.object.drawn(() => stock(after.object.r, view([0, 0, 1500], [-900, 0, 0], 1))));
  });

  it('keeps occlusion exactly as stock: tested at scale 1 only', () => {
    const scene = scenes[1]!;
    const calls = { stock: 0, candidate: 0 };
    const occluder = (key: keyof typeof calls, result: (s: Sphere3D) => boolean) => (s: Sphere3D) => { calls[key]++; return result(s); };
    const half = (s: Sphere3D) => s.center[0]! > 100;
    for (const result of [() => true, half]) {
      const a = renderable(lattice()), b = renderable(lattice());
      expect(b.drawn(() => candidate(b.r, view(scene.eye, scene.target, 1), occluder('candidate', result))))
        .toEqual(a.drawn(() => stock(a.r, view(scene.eye, scene.target, 1), occluder('stock', result))));
    }
    expect(calls.candidate).toBe(calls.stock);
    expect(calls.stock).toBeGreaterThan(0);
    const object = renderable(lattice());
    const before = calls.candidate;
    object.drawn(() => candidate(object.r, view(scene.eye, scene.target, 0.006), occluder('candidate', () => true)));
    expect(calls.candidate).toBe(before);
  });
});
