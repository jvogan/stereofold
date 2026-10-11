/**
 * Smooth shading for spacefill drawn as meshes on Quest.
 *
 * Quest spacefill drawn as a mesh keeps early depth rejection, because the
 * shader neither discards nor writes depth, but a low-detail icosphere shades
 * as visible facets. This patch shades each fragment with the exact sphere
 * normal instead.
 *
 * Every vertex of an element-sphere mesh lies on its sphere, so with radial
 * vertex normals the interpolated view position and normal satisfy
 * `p = c + r * n` across each triangle. Screen-space derivatives of `p` and
 * `n` recover `r`, and with it the centre `c`. The fragment then intersects its
 * view ray with that sphere and shades with the hit point's normal: the same
 * normal a ray-cast impostor computes. Depth still comes from the mesh, so the
 * silhouette and the seams between atoms keep the mesh's subdivision.
 *
 * Only element-sphere meshes on Quest Browser take the new define; their
 * primitive also gets radial normals there. Other meshes and browsers compile
 * the stock shader.
 */

/** Keep self-contained: embedded in vendor modules by the build transform. */
export function isQuestSphereNormalsBrowser(): boolean {
  try {
    return typeof navigator !== 'undefined' && 'xr' in navigator && /\bOculusBrowser\//.test(navigator.userAgent || '');
  } catch { return false; }
}

export const SPHERE_NORMAL_GLSL = `#ifdef dStereofoldSphereNormals
// p = c + r * n holds across a sphere-mesh triangle with radial vertex normals.
vec3 stereofoldSphereNormal(const in vec3 p, const in vec3 n) {
    vec3 dpx = dFdx(p), dpy = dFdy(p), dnx = dFdx(n), dny = dFdy(n);
    float nn = dot(dnx, dnx) + dot(dny, dny);
    float pp = dot(dpx, dpx) + dot(dpy, dpy);
    if (!(nn > 0.0) || !(pp > 0.0)) return normalize(n);
    float r = sqrt(pp / nn);
    vec3 c = p - r * n;
    vec3 origin = uIsOrtho == 1.0 ? vec3(p.xy, 0.0) : vec3(0.0);
    vec3 dir = uIsOrtho == 1.0 ? vec3(0.0, 0.0, -1.0) : normalize(p);
    vec3 oc = c - origin;
    float b = dot(dir, oc);
    float disc = b * b - dot(oc, oc) + r * r;
    if (!(disc >= 0.0)) return normalize(n);
    vec3 hit = origin + dir * (b - sqrt(disc));
    return normalize(hit - c);
}
#endif
`;

function replaceOnce(source: string, anchor: string, replacement: string): string {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  anchor = anchor.replaceAll('\n', nl); replacement = replacement.replaceAll('\n', nl);
  if (source.split(anchor).length !== 2) throw Error('Mol* sphere-normal source anchor changed; patch was not applied.');
  return source.replace(anchor, replacement);
}

/** mol-gl/shader/mesh.frag.js; compose before the opaque-depth transform. */
export function patchMolstarSphereNormalsMeshFragSource(source: string): string {
  source = replaceOnce(source, 'uniform vec4 uInteriorColor;', `${SPHERE_NORMAL_GLSL}\nuniform vec4 uInteriorColor;`);
  return replaceOnce(source, `            vec3 normal = -normalize(vNormal);
            if (uDoubleSided) normal *= float(gl_FrontFacing) * 2.0 - 1.0;`, `            #ifdef dStereofoldSphereNormals
                vec3 normal = -stereofoldSphereNormal(vViewPosition, vNormal);
            #else
                vec3 normal = -normalize(vNormal);
            #endif
            if (uDoubleSided) normal *= float(gl_FrontFacing) * 2.0 - 1.0;`);
}

/** mol-geo/primitive/sphere.js: radial normals, which the identity needs. */
export function patchMolstarSpherePrimitiveSource(source: string): string {
  return replaceOnce(source, `export function Sphere(detail) {
    return Polyhedron(vertices, indices, { detail, radius: 1 });
}`, `export function Sphere(detail) {
    const sphere = Polyhedron(vertices, indices, { detail, radius: 1 });
    // Stereofold: every vertex lies on the unit sphere, so its position is its exact normal.
    if ((${isQuestSphereNormalsBrowser.toString()})()) sphere.normals.set(sphere.vertices);
    return sphere;
}`);
}

/** mol-repr/structure/visual/util/element.js: mark element-sphere meshes. */
export function patchMolstarElementSphereSource(source: string): string {
  const start = 'export function createElementSphereMesh(ctx, unit, structure, theme, props, mesh) {';
  const at = source.indexOf(start);
  if (at < 0 || source.split(start).length !== 2) throw Error('Mol* element-sphere mesh source changed; patch was not applied.');
  const anchor = '    const m = MeshBuilder.getMesh(builderState);';
  const local = source.indexOf(anchor, at);
  if (local < 0) throw Error('Mol* element-sphere mesh builder changed; patch was not applied.');
  return source.slice(0, local) + `${anchor}\n    m.meta.stereofoldSphere = true;` + source.slice(local + anchor.length);
}

/** mol-gl/renderable/mesh.js: the define, fixed for the render object's life. */
export function patchMolstarMeshRenderableSource(source: string): string {
  source = replaceOnce(source, '    const schema = { ...GlobalUniformSchema, ...GlobalTextureSchema, ...GlobalDefineSchema, ...InternalSchema, ...MeshSchema };',
    '    const schema = { ...GlobalUniformSchema, ...GlobalTextureSchema, ...GlobalDefineSchema, ...InternalSchema, ...MeshSchema, dStereofoldSphereNormals: DefineSpec(\'boolean\') };');
  return replaceOnce(source, '        dColorMarker: ValueCell.create(globals.dColorMarker),\n    };',
    `        dColorMarker: ValueCell.create(globals.dColorMarker),
        dStereofoldSphereNormals: ValueCell.create(!!values.meta?.ref.value?.stereofoldSphere && (${isQuestSphereNormalsBrowser.toString()})()),
    };`);
}

/** Off unless requested; the switch is a scratch-build candidate until measured. */
export function sphereNormalsEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw Error('STEREOFOLD_SPHERE_NORMALS must be 0 or 1.');
}
