import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';
import { Shape } from 'molstar/lib/mol-model/shape/shape.js';
import { Spheres } from 'molstar/lib/mol-geo/geometry/spheres/spheres.js';
import { SpheresBuilder } from 'molstar/lib/mol-geo/geometry/spheres/spheres-builder.js';
import { Cylinders } from 'molstar/lib/mol-geo/geometry/cylinders/cylinders.js';
import { CylindersBuilder } from 'molstar/lib/mol-geo/geometry/cylinders/cylinders-builder.js';
import { Visual } from 'molstar/lib/mol-repr/visual.js';
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition.js';
import { unpackRGBToInt } from 'molstar/lib/mol-util/number-packing.js';
import { Color } from 'molstar/lib/mol-util/color/index.js';
import type { SpheresValues } from 'molstar/lib/mol-gl/renderable/spheres.js';
import type { CylindersValues } from 'molstar/lib/mol-gl/renderable/cylinders.js';
import { Sphere3D } from 'molstar/lib/mol-math/geometry/primitives/sphere3d.js';
import { IMPOSTOR_SCALE_GLSL, impostorScaleBuildPlugins, impostorScalePatch, patchMolstarImpostorScaleSource } from '../src/molstar-impostor-scale-patch.js';
// @ts-expect-error Browser module has no declaration file.
import { companionTransform } from '../../lab/browser-roundtrip/companion-structure.mjs';
// @ts-expect-error Browser module has no declaration file.
import { updatePlacementBounds } from '../../lab/browser-roundtrip/placement-bounds.mjs';

const root = new URL('..', import.meta.url).pathname;
const shaderRoot = new URL('../node_modules/molstar/lib/mol-gl/shader/', import.meta.url);
const names = ['spheres.vert', 'spheres.frag', 'cylinders.vert'] as const;
const sources = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL(`${name}.js`, shaderRoot), 'utf8')]))) as Record<typeof names[number], string>;
const moduleShader = async (source: string, field: string): Promise<string> =>
  (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))[field];
const original = Object.fromEntries(await Promise.all(names.map(async name => [name, await moduleShader(sources[name], name.replace('.', '_'))]))) as Record<typeof names[number], string>;
const patched = Object.fromEntries(await Promise.all(names.map(async name => [name, await moduleShader(patchMolstarImpostorScaleSource(sources[name], name, '5.11.0'), name.replace('.', '_'))]))) as Record<typeof names[number], string>;
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => Array.from(a).reduce((v, x, i) => v + x * b[i]!, 0);

/** Execute the actual injected GLSL helper, adapting only type declarations
 * and matrix-column access. Radius/proxy/thickness expressions below are
 * extracted from the installed patched shaders, rather than restated guards.
 */
function scaleFunction(shader: string) {
  const body = shader.slice(shader.indexOf('{', shader.indexOf('float stereofoldImpostorScale(')) + 1,
    shader.indexOf('\n}', shader.indexOf('float stereofoldImpostorScale(')))
    .replace(/\b(?:vec3|float) (\w+) =/g, 'const $1 =')
    .replace(/transform\[(\d)\]\.xyz/g, (_, index) => `transform.slice(${Number(index) * 4}, ${Number(index) * 4 + 3})`);
  const execute = new Function('transform', 'dot', 'abs', 'sqrt', body);
  return (transform: ArrayLike<number>): number => execute(Array.from(transform), dot, Math.abs, Math.sqrt);
}
const scaleOf = scaleFunction(patched['spheres.vert']);
const radiusExpression = patched['spheres.vert'].match(/vRadius = ([^;]+);/)![1]!;
const radiusOf = new Function('size', 'uModelScale', 'vStereofoldImpostorScale', `return ${radiusExpression};`) as (size: number, camera: number, transform: number) => number;
const sizeExpression = patched['cylinders.vert'].match(/vSize = ([^;]+);/)![1]!;
const cylinderSizeOf = new Function('size', 'aScale', 'uModelScale', 'transform', 'stereofoldImpostorScale', `return ${sizeExpression};`) as (...args: any[]) => number;
const proxyExpression = patched['spheres.vert'].match(/quadraticProjection\(position, ([^,]+), mapping, transform\);/)![1]!;
const proxyRadiusOf = new Function('vRadius', 'uModelScale', 'vStereofoldImpostorScale', `return ${proxyExpression};`) as (radius: number, camera: number, transform: number) => number;
const alphaExpression = patched['spheres.frag'].match(/material.a \*= ([^;]+);/)![1]!;
const alphaOf = new Function('vRadius', 'uAlphaThickness', 'uModelScale', 'vStereofoldImpostorScale', 'min', `return ${alphaExpression};`) as (...args: any[]) => number;
function uniform(scale: number) {
  return Mat4.mul(Mat4(), Mat4.fromRotation(Mat4(), .43, Vec3.create(0, 0, 1)),
    Mat4.fromScaling(Mat4(), Vec3.create(scale, scale, scale)));
}
function roundedRotation(axis: [number, number, number], degrees: number, decimalPlaces: number) {
  const matrix = Mat4.fromRotation(Mat4(), degrees * Math.PI / 180, Vec3.create(...axis));
  const factor = 10 ** decimalPlaces;
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) matrix[i] = Math.round(matrix[i]! * factor) / factor;
  return matrix;
}

describe('pinned Mol* impostor placement scaling', () => {
  it.each(names)('fails closed on %s version, anchor drift, duplicates and repeat application', name => {
    const source = sources[name];
    expect(() => patchMolstarImpostorScaleSource(source, name, '5.11.1')).toThrow('5.11.0');
    expect(() => patchMolstarImpostorScaleSource('', name, '5.11.0')).toThrow('anchor');
    expect(() => patchMolstarImpostorScaleSource(source + source, name, '5.11.0')).toThrow('anchor');
    const anchor = name === 'cylinders.vert' ? '    vSize = size * aScale * uModelScale;' : 'varying float vRadius;';
    expect(() => patchMolstarImpostorScaleSource(source.replace(anchor, 'changed'), name, '5.11.0')).toThrow('anchor');
    expect(() => patchMolstarImpostorScaleSource(patchMolstarImpostorScaleSource(source, name, '5.11.0'), name, '5.11.0')).toThrow('already');
  });
  it('changes only radius scaling, proxy conversion and local alphaThickness normalization', () => {
    const sphere = patched['spheres.vert'].replace('varying float vStereofoldImpostorScale;\n', '')
      .replace(`${IMPOSTOR_SCALE_GLSL}\n\n`, '')
      .replace('    vStereofoldImpostorScale = stereofoldImpostorScale(transform);\n', '')
      .replace('vRadius = size * uModelScale * vStereofoldImpostorScale;', 'vRadius = size * uModelScale;')
      .replace('vRadius / (uModelScale * vStereofoldImpostorScale)', 'vRadius / uModelScale');
    expect(sphere).toBe(original['spheres.vert']);
    expect(patched['spheres.frag'].replace('varying float vStereofoldImpostorScale;\n', '')
      .replace('uAlphaThickness * uModelScale * vStereofoldImpostorScale', 'uAlphaThickness * uModelScale')).toBe(original['spheres.frag']);
    expect(patched['cylinders.vert'].replace(`${IMPOSTOR_SCALE_GLSL}\n\n`, '')
      .replace('uModelScale * stereofoldImpostorScale(transform)', 'uModelScale')).toBe(original['cylinders.vert']);
    const lf = sources['spheres.vert'].replaceAll('\r\n', '\n');
    expect(patchMolstarImpostorScaleSource(lf, 'spheres.vert', '5.11.0')).not.toContain('\r');
  });
  it('executes shader scaling at .34, 1, 7.83, 20 and 26 with rotation, LOD and camera scale', () => {
    const cylinderScale = scaleFunction(patched['cylinders.vert']);
    for (const scale of [.34, 1, 7.83, 20, 26]) {
      const transform = Array.from(new Float32Array(uniform(scale)));
      const actualScale = scaleOf(transform);
      expect(actualScale).toBeCloseTo(scale, 5);
      expect(cylinderScale(transform)).toBe(actualScale);
      for (const camera of [1, .0201368895]) for (const lod of [.5, 1, 2]) {
        const radius = radiusOf(1.7, camera, actualScale) * lod;
        expect(radius).toBeCloseTo(1.7 * camera * scale * lod, 5);
        // The asymmetric proxy transforms this local radius once, not twice.
        expect(proxyRadiusOf(radius, camera, actualScale)).toBeCloseTo(1.7 * lod, 10);
        expect(cylinderSizeOf(1.7, .75, camera, transform, cylinderScale)).toBeCloseTo(1.7 * .75 * camera * scale, 5);
        expect(alphaOf(radius, 4, camera, actualScale, Math.min)).toBeCloseTo(Math.min(1, 1.7 * lod / 4), 12);
      }
    }
    const identity = Mat4.identity();
    expect(scaleOf(identity)).toBe(1);
    expect(radiusOf(1.7, .02, scaleOf(identity))).toBe(1.7 * .02);
    expect(proxyRadiusOf(1.7 * .02, .02, 1)).toBe(1.7 * .02 / .02);
  });
  it('accepts rounded rigid assembly operators while keeping the accepted residual bounded', () => {
    const cylinderScale = scaleFunction(patched['cylinders.vert']);
    const cases = [[60, 4], [72, 4], [120, 4], [144, 5]] as const;
    for (const [degrees, decimalPlaces] of cases) {
      const transform = new Float32Array(Mat4.mul(Mat4(), uniform(7.83), roundedRotation([0, 0, 1], degrees, decimalPlaces)));
      // 4-decimal 60/72/120 degree and 5-decimal 144 degree operators are
      // close to orthogonal but exceed the former 1e-5 gate after composition.
      expect(scaleOf(transform)).toBeGreaterThan(7.829);
      expect(scaleOf(transform)).toBeLessThan(7.831);
      expect(cylinderScale(transform)).toBeCloseTo(scaleOf(transform), 7);
    }
  });
  it('accepts a deterministic grid of arbitrary-axis 4-decimal rigid operators after uniform placement', () => {
    const axes: Array<[number, number, number]> = [[1, 2, 3], [3, -2, 7], [1, 1, 1], [-5, 2, 1]];
    const angles = [1, 17, 60, 120, 144, 167, 179];
    for (const axis of axes) for (const degrees of angles) {
      const transform = new Float32Array(Mat4.mul(Mat4(), uniform(7.83), roundedRotation(axis, degrees, 4)));
      expect(scaleOf(transform)).toBeGreaterThan(7.829);
      expect(scaleOf(transform)).toBeLessThan(7.831);
    }
  });
  it('handles compound companion/source transforms and reverses without cumulative radius drift', () => {
    const primarySphere = { center: [1, 2, 3], radius: 8 }, companionSphere = { center: [-2, 1, -4], radius: 4 };
    const sourceOperator = Mat4.fromRotation(Mat4(), -.72, Vec3.create(0, 1, 0));
    for (const primaryScale of [.34, 20, 26, .34]) {
      const companion = companionTransform(Mat4, Vec3, uniform(primaryScale), primarySphere, companionSphere,
        { scale: 1.7, rotation: [30, -10, 42], translation: [.3, .2, -.4] });
      const transform = new Float32Array(Mat4.mul(Mat4(), companion, sourceOperator));
      const actualScale = scaleOf(transform);
      expect(actualScale).toBeCloseTo(primaryScale * 1.7, 5);
      expect(radiusOf(.4, .02, actualScale)).toBeCloseTo(.4 * .02 * primaryScale * 1.7, 7);
      expect(proxyRadiusOf(radiusOf(.4, .02, actualScale), .02, actualScale)).toBeCloseTo(.4, 12);
    }
  });
  it('preserves upstream fallback for nonuniform, sheared and degenerate transforms', () => {
    const nonuniform = Mat4.fromScaling(Mat4(), Vec3.create(2, 3, 2));
    const shear = Mat4.identity(); shear[4] = .1;
    const degenerate = Mat4.fromScaling(Mat4(), Vec3.create(0, 0, 0));
    for (const transform of [nonuniform, shear, degenerate]) {
      expect(scaleOf(transform)).toBe(1);
      expect(radiusOf(.4, .02, scaleOf(transform))).toBe(.4 * .02);
      expect(proxyRadiusOf(.4 * .02, .02, scaleOf(transform))).toBe(.4);
    }
    // A 0.06% axis-size difference and a 1.1e-3 shear exceed the 1e-3
    // squared-column/dot-product tolerance and keep the upstream fallback.
    const nearNonuniform = Mat4.mul(Mat4(), uniform(7.83), Mat4.fromScaling(Mat4(), Vec3.create(1, 1.0006, 1)));
    const nearShear = Mat4.identity(); nearShear[4] = .0011;
    const placedNearShear = Mat4.mul(Mat4(), uniform(7.83), nearShear);
    for (const transform of [nearNonuniform, placedNearShear]) {
      expect(scaleOf(new Float32Array(transform))).toBe(1);
      expect(scaleFunction(patched['cylinders.vert'])(new Float32Array(transform))).toBe(1);
    }
    for (const scale of [1e-6, 1e6]) expect(scaleOf(new Float32Array(uniform(scale))) / scale).toBeCloseTo(1, 6);
    const reflection = uniform(20); for (let i = 0; i < 3; i++) reflection[i] *= -1;
    expect(scaleOf(reflection)).toBeCloseTo(20, 10);
  });
  it('makes actual sphere and cylinder ray equations agree with uniformly transformed geometry', async () => {
    const sphereDet = original['spheres.frag'].match(/float det = ([^;]+);/)![1]!;
    const sphereHit = new Function('B', 'vRadius', 'cameraSphereDir', 'dot', `return ${sphereDet};`) as (...args: any[]) => number;
    const cylinderFrag = await moduleShader(await readFile(new URL('cylinders.frag.js', shaderRoot), 'utf8'), 'cylinders_frag');
    const k0Expression = cylinderFrag.match(/float k0 = ([^;]+);/)![1]!;
    const k0Of = new Function('baba', 'oc', 'baoc', 'radius', 'dot', `return ${k0Expression};`) as (...args: any[]) => number;
    const camera = .02, scale = 20, radius = radiusOf(1, camera, scaleOf(uniform(scale)));
    const center = [0, 0, -4], direction = Vec3.normalize(Vec3(), Vec3.create(.1, 0, -1));
    const B = dot(direction, center);
    // This off-axis ray intersects the correct 40 cm sphere but misses the
    // stock 2 cm sphere. Center and radius are in the same camera coordinates.
    expect(sphereHit(B, radius, center, dot)).toBeGreaterThan(0);
    expect(sphereHit(B, camera, center, dot)).toBeLessThan(0);
    const stockK0 = k0Of(4, [.1, 1, 0], 2, camera, dot);
    const patchedK0 = k0Of(4, [.1, 1, 0], 2, radius, dot);
    expect(stockK0).toBeGreaterThan(0);
    expect(patchedK0).toBeLessThan(0);
  });
  it('corrects actual Mol* sphere/cylinder render objects without editing authored size cells and stays in placement bounds', () => {
    const spheres = SpheresBuilder.create(); spheres.add(-2, 0, -5, 0); spheres.add(2, 0, -5, 1);
    const cylinders = CylindersBuilder.create(); cylinders.add(0, -2, -5, 0, 2, -5, 1, true, true, 2, 0);
    const cylinderGeometry = cylinders.getCylinders();
    // Structure bond builders explicitly supply the radius-padded molecular
    // boundary via setBoundingSphere; raw CylindersBuilder covers endpoints only.
    cylinderGeometry.setBoundingSphere(Sphere3D.create(Vec3.create(0, 0, -5), 3));
    const objects = [Shape.createRenderObject(Shape.create('s', {}, spheres.getSpheres(), () => Color(0xff0000), () => 1, () => ''), PD.getDefaultValues(Spheres.Params)),
      Shape.createRenderObject(Shape.create('c', {}, cylinderGeometry, () => Color(0xff0000), () => 1, () => ''), PD.getDefaultValues(Cylinders.Params))];
    for (const object of objects) {
      if (object.type !== 'spheres' && object.type !== 'cylinders') throw Error('Expected an impostor.');
      const v = object.values as SpheresValues | CylindersValues;
      const sizeFactor = v.uSizeFactor.ref.value, packedSize = Array.from(v.tSize.ref.value.array);
      const size = unpackRGBToInt(packedSize[0]!, packedSize[1]!, packedSize[2]!) / 100;
      for (const scale of [.34, 1, 7.83, 20, 26, .34]) {
        Visual.setTransform(object, uniform(scale)); updatePlacementBounds({ renderObjects: [object] });
        const transform = v.aTransform.ref.value, radius = radiusOf(size * sizeFactor, 1, scaleOf(transform));
        expect(radius).toBeCloseTo(size * sizeFactor * scale, 5);
        for (const point of object.type === 'spheres' ? [[-2, 0, -5], [2, 0, -5]] : [[0, -2, -5], [0, 2, -5]]) {
          const p = Vec3.transformMat4(Vec3(), Vec3.create(...point as [number, number, number]), Mat4.fromArray(Mat4(), transform, 0));
          expect(Vec3.distance(p, v.boundingSphere.ref.value.center) + radius).toBeLessThanOrEqual(v.boundingSphere.ref.value.radius + 1e-5);
        }
        expect(v.uSizeFactor.ref.value).toBe(sizeFactor);
        expect(Array.from(v.tSize.ref.value.array)).toEqual(packedSize);
      }
    }
  });
  it('defaults to the patch, offers a stock scratch switch and rejects ambiguous settings', () => {
    expect(impostorScaleBuildPlugins(undefined)).toHaveLength(1);
    expect(impostorScaleBuildPlugins('0')).toEqual([]);
    expect(impostorScaleBuildPlugins('1')).toHaveLength(1);
    expect(() => impostorScaleBuildPlugins('true')).toThrow('0 or 1');
  });
  it.each(['0', '1'])('keeps composed shader transforms active with radius switch %s', async value => {
    const contents = names.map(name => `export { ${name.replace('.', '_')} } from 'molstar/lib/mol-gl/shader/${name}.js';`).join('\n');
    const seen: string[] = [];
    const result = await build({ stdin: { contents, resolveDir: root }, bundle: true, format: 'esm', platform: 'node', write: false,
      plugins: impostorScaleBuildPlugins(value, (source, shader) => { seen.push(shader); return source.replace('varying float vRadius;', 'varying float vRadius; // composed-candidate'); }) });
    const bundled = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`);
    expect(seen.sort()).toEqual([...names].sort());
    for (const name of names) {
      const expected = (value === '1' ? patched : original)[name].replace('varying float vRadius;', 'varying float vRadius; // composed-candidate');
      expect(bundled[name.replace('.', '_')]).toBe(expected);
    }
  });
  it('bundles all actual shaders with matching vertex/fragment scale varyings and rejects incomplete bundles', async () => {
    const contents = names.map(name => `export { ${name.replace('.', '_')} } from 'molstar/lib/mol-gl/shader/${name}.js';`).join('\n');
    const result = await build({ stdin: { contents, resolveDir: root }, bundle: true, format: 'esm', platform: 'node', write: false, plugins: [impostorScalePatch()] });
    const bundled = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`);
    for (const name of names) expect(bundled[name.replace('.', '_')]).toBe(patched[name]);
    await expect(build({ stdin: { contents: `export { spheres_vert } from 'molstar/lib/mol-gl/shader/spheres.vert.js';`, resolveDir: root }, bundle: true, write: false,
      logLevel: 'silent', plugins: [impostorScalePatch()] })).rejects.toThrow('Expected exactly one');
  });
});
