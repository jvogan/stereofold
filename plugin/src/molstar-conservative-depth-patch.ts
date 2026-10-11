/**
 * Early depth rejection for sphere impostors on Quest.
 *
 * A sphere impostor writes `gl_FragDepth`, so the GPU must run the whole
 * lighting shader before it can depth-test a fragment. On a giant spacefill
 * view that is every rasterized fragment of every overlapping quad.
 *
 * `EXT_conservative_depth` lets the shader promise which way its depth moves.
 * Mol* rasterizes the quad at the sphere centre, and the visible surface is in
 * front of it, so this patch moves the quad to the sphere's nearest depth plane
 * and declares `depth_greater`: every written depth is at or behind the
 * rasterized one. A fragment whose quad is already behind the depth buffer
 * cannot pass, and the GPU may reject it before shading. The written depth,
 * the ray direction (`vPoint` is computed before the move) and the shading are
 * unchanged. A sphere crossing the near plane rasterizes at the near plane.
 *
 * The change applies only on Quest Browser with the extension available. Every
 * other browser compiles the stock code: the added lines are preprocessor
 * branches behind a define that only the Quest path inserts.
 */

const REQUEST = '#define stereofoldConservativeDepthRequest';

/** Keep self-contained and free of nested functions: its source text is
 * embedded in the vendor module by the build transform. */
export function stereofoldShaderSource(gl: WebGL2RenderingContext, type: string, source: string): string {
  try {
    if (!source.includes('#define stereofoldConservativeDepthRequest') || !/^#version 300 es\r?\n/.test(source)) return source;
    if (typeof navigator === 'undefined' || !('xr' in navigator) || !/\bOculusBrowser\//.test(navigator.userAgent || '')) return source;
    if (!gl.getExtension('EXT_conservative_depth')) return source;
    const lines = type === 'frag' ? '#extension GL_EXT_conservative_depth : enable\n#define stereofoldConservativeDepth\n' : '#define stereofoldConservativeDepth\n';
    const header = source.startsWith('#version 300 es\r\n') ? '#version 300 es\r\n' : '#version 300 es\n';
    return header + lines + source.slice(header.length);
  } catch { return source; }
}

function replaceOnce(source: string, anchor: string, replacement: string, nl: string): string {
  anchor = anchor.replaceAll('\n', nl); replacement = replacement.replaceAll('\n', nl);
  if (source.split(anchor).length !== 2) throw Error('Mol* conservative-depth source anchor changed; patch was not applied.');
  return source.replace(anchor, replacement);
}

/** Composes after the impostor scale transform of the same module. */
export function patchMolstarConservativeDepthSphereSource(source: string, shader: 'spheres.vert' | 'spheres.frag'): string {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  if (shader === 'spheres.vert') {
    source = replaceOnce(source, 'varying float vRadius;', `${REQUEST}\nvarying float vRadius;`, nl);
    source = replaceOnce(source, `    if (gl_Position.z < -gl_Position.w) {
        mvPosition.z -= 2.0 * vRadius; // avoid clipping
        gl_Position.z = (uProjection * vec4(mvPosition.xyz, 1.0)).z;
    }
`, `    #if defined(stereofoldConservativeDepth) && !defined(dApproximate)
        // The nearest depth plane of the sphere, clamped to the near plane.
        vec4 stereofoldFront = uProjection * vec4(mvPosition.xy, mvPosition.z + vRadius * 1.0001, 1.0);
        float stereofoldFrontZ = stereofoldFront.w > 0.0 ? max(stereofoldFront.z / stereofoldFront.w, -1.0) : -1.0;
    #endif

    if (gl_Position.z < -gl_Position.w) {
        mvPosition.z -= 2.0 * vRadius; // avoid clipping
        gl_Position.z = (uProjection * vec4(mvPosition.xyz, 1.0)).z;
    }

    #if defined(stereofoldConservativeDepth) && !defined(dApproximate)
        if (gl_Position.w > 0.0) gl_Position.z = stereofoldFrontZ * gl_Position.w;
    #endif
`, nl);
    return source;
  }
  source = replaceOnce(source, 'varying float vRadius;', `${REQUEST}
#ifdef stereofoldConservativeDepth
    layout (depth_greater) out highp float gl_FragDepth;
#endif
varying float vRadius;`, nl);
  return source;
}

/** Route Mol*'s shader compilation through `stereofoldShaderSource`. */
export function patchMolstarShaderModuleSource(source: string): string {
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  source = replaceOnce(source, 'export function getShader(gl, props) {',
    `const stereofoldShaderSource = ${stereofoldShaderSource.toString()};\nexport function getShader(gl, props) {`, nl);
  return replaceOnce(source, '    gl.shaderSource(shader, source);', '    gl.shaderSource(shader, stereofoldShaderSource(gl, type, source));', nl);
}

/** Off unless requested; the switch is a scratch-build candidate until measured. */
export function conservativeDepthEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw Error('STEREOFOLD_CONSERVATIVE_DEPTH must be 0 or 1.');
}
