/** Remove pathological offscreen analytic-sphere quads on Quest. The four
 * inward clip-side planes bound the entire actual sphere, including instances
 * crossing the near plane. No near/far cutoff, ray/depth/material changes,
 * offscreen pass, extra uniforms or renderer schema are introduced.
 */
const VERSION = '5.11.0';
export const SPHERE_FRUSTUM_ROUTE = "typeof navigator !== 'undefined' && !!navigator.xr && /\\bOculusBrowser\\//.test(navigator.userAgent || '')";

export const SPHERE_FRUSTUM_GLSL = `#define stereofoldSphereFrustum
bool stereofoldSphereOutsidePlane(vec4 plane, vec3 center, float radius) {
    float support = radius * length(plane.xyz);
    float signedCenter = dot(plane, vec4(center, 1.0));
    float magnitude = dot(abs(plane.xyz), abs(center)) + abs(plane.w) + support;
    float margin = max(0.00001, magnitude * 0.00001);
    return signedCenter + support < -margin;
}
bool stereofoldSphereOutsideSides(vec3 center, float radius) {
    vec4 rowW = vec4(uProjection[0][3], uProjection[1][3], uProjection[2][3], uProjection[3][3]);
    vec4 rowX = vec4(uProjection[0][0], uProjection[1][0], uProjection[2][0], uProjection[3][0]);
    vec4 rowY = vec4(uProjection[0][1], uProjection[1][1], uProjection[2][1], uProjection[3][1]);
    return stereofoldSphereOutsidePlane(rowW + rowX, center, radius)
        || stereofoldSphereOutsidePlane(rowW - rowX, center, radius)
        || stereofoldSphereOutsidePlane(rowW + rowY, center, radius)
        || stereofoldSphereOutsidePlane(rowW - rowY, center, radius);
}
`;
export const SPHERE_FRUSTUM_GATE = `
    #if __VERSION__ >= 300 && defined(stereofoldSphereFrustum) && !defined(dApproximate)
        // Only the reviewed asymmetric perspective path. Other projection
        // conventions retain Mol*'s original bounds and clipping behavior.
        if (uIsAsymmetricProjection && uIsOrtho == 0.0
            && uProjection[0][1] == 0.0 && uProjection[1][0] == 0.0
            && uProjection[0][2] == 0.0 && uProjection[1][2] == 0.0
            && uProjection[0][3] == 0.0 && uProjection[1][3] == 0.0
            && uProjection[2][3] == -1.0 && uProjection[3][3] == 0.0
            && uProjection[3][0] == 0.0 && uProjection[3][1] == 0.0
            && uProjection[0][0] > 0.0 && uProjection[1][1] > 0.0
            && uProjection[3][2] < 0.0 && uProjection[2][2] <= -1.0
            && !any(isnan(uProjection[0])) && !any(isinf(uProjection[0]))
            && !any(isnan(uProjection[1])) && !any(isinf(uProjection[1]))
            && !any(isnan(uProjection[2])) && !any(isinf(uProjection[2]))
            && !any(isnan(uProjection[3])) && !any(isinf(uProjection[3]))
            && !any(isnan(mvPosition)) && !any(isinf(mvPosition))
            && mvPosition.w == 1.0 && vRadius > 0.0 && !isinf(vRadius)
            && stereofoldSphereOutsideSides(mvPosition.xyz, vRadius)) {
            // All six vertices use the same center/radius and decision.
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
        }
    #endif
`;

/** Transform the JS shader module, not a live program. Conditional template
 * insertions produce a byte-identical upstream shader on non-Quest browsers
 * and without WebXR. No serialized functions or external closure helpers.
 * Compose after impostor scaling; the gate reads final vRadius after LOD.
 */
export function patchMolstarSphereFrustumSource(source: string, version: string): string {
  if (version !== VERSION) throw Error('Mol* sphere frustum patch requires reviewed 5.11.0.');
  if (source.includes('stereofoldSphereFrustum')) throw Error('Mol* sphere frustum patch already applied.');
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const normalize = (s: string) => s.replaceAll('\n', nl);
  let next = source;
  const replace = (anchor: string, value: string) => {
    anchor = normalize(anchor);
    if (next.split(anchor).length !== 2) throw Error('Mol* sphere frustum source anchor changed; patch not applied.');
    next = next.replace(anchor, value);
  };
  replace('export const spheres_vert = `', `const stereofoldSphereFrustumRoute = ${SPHERE_FRUSTUM_ROUTE};${nl}export const spheres_vert = \``);
  // JSON literals inside template expressions preserve both JS/GLSL escapes.
  const insertion = (text: string) => '${stereofoldSphereFrustumRoute ? ' + JSON.stringify(text) + " : ''}";
  replace('void main(void){', insertion(SPHERE_FRUSTUM_GLSL) + 'void main(void){');
  const center = '    vec4 mvPosition = uModelView * transform * position4;';
  replace(center, center + insertion(SPHERE_FRUSTUM_GATE));
  return next;
}
