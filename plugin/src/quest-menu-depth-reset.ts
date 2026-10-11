/** Opt-in native Quest 2 presentation-depth reset. No renderer/global GL hooks.
 * A depth draw avoids the measured driver clear heuristic, which can reactivate
 * fixed foveation and change peripheral pixels. This is NOT quality neutral.
 */
export function createQuestMenuDepthReset(webgl: any) {
  const gl = webgl?.gl;
  let disposed = false, failed = false, program: any, vao: any;
  let shaders: any[] = [], session: any, layer: any;
  let draws = 0, error: string | null = null;
  const flags = gl ? [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.STENCIL_TEST, gl.DITHER,
    gl.RASTERIZER_DISCARD, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE, gl.POLYGON_OFFSET_FILL] : [];
  const invalidate = () => {
    if (webgl?.state) webgl.state.currentProgramId = webgl.state.currentRenderItemId = webgl.state.currentMaterialId = -1;
  };
  function release() {
    try { if (vao) gl.deleteVertexArray(vao); } catch { /* Continue releasing the owner. */ }
    try { if (program) gl.deleteProgram(program); } catch { /* Continue. */ }
    for (const shader of shaders) try { gl.deleteShader(shader); } catch { /* Continue. */ }
    vao = program = undefined; shaders = [];
  }
  function reset() { release(); failed = false; }
  function ended() { reset(); session?.removeEventListener?.('end', ended); session = layer = undefined; }
  function initialize() {
    program = gl.createProgram(); vao = gl.createVertexArray();
    if (!program || !vao) throw Error('Presentation depth-reset allocation failed.');
    const sources = [`#version 300 es
precision highp float;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,1.0,1.0);}`,
      `#version 300 es
precision highp float;
out vec4 color;
void main(){gl_FragDepth=1.0;color=vec4(0.0);}`];
    for (let i = 0; i < 2; i++) {
      const shader = gl.createShader(i ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER);
      if (!shader) throw Error('Presentation depth-reset shader allocation failed.');
      shaders.push(shader); gl.shaderSource(shader, sources[i]); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error('Presentation depth-reset shader compile failed.');
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error('Presentation depth-reset shader link failed.');
  }
  function tryResetDepth(): boolean {
    // Eligibility is evaluated lazily: presentation is created before XR starts.
    const nav = globalThis.navigator as (Navigator & { xr?: unknown }) | undefined;
    if (disposed || !gl?.createVertexArray || !nav?.xr || !/OculusBrowser/i.test(nav.userAgent)
      || !/\bQuest 2\b/i.test(nav.userAgent) || gl.isContextLost() || webgl.isContextLost === true) return false;
    const currentSession = webgl.xr?.session, currentLayer = currentSession?.renderState?.baseLayer;
    if (!currentLayer || ![0, 1].includes(currentLayer.fixedFoveation)) return false;
    const width = currentLayer.framebufferWidth, height = currentLayer.framebufferHeight;
    if (![width, height].every(n => Number.isSafeInteger(n) && n > 0)) return false;
    if (session !== currentSession || layer !== currentLayer) {
      session?.removeEventListener?.('end', ended); reset(); session = currentSession; layer = currentLayer;
      session?.addEventListener?.('end', ended);
    }
    if (failed) return false;
    // A helper may be rendering to an offscreen target (DOF, AA, capture). Never
    // substitute its clear. Rasterizer-discard and a false depth mask make the
    // original clear a no-op; likewise do not force a draw in either case.
    if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== currentLayer.framebuffer
      || gl.isEnabled(gl.RASTERIZER_DISCARD) || !gl.getParameter(gl.DEPTH_WRITEMASK)
      || gl.getParameter(gl.DEPTH_CLEAR_VALUE) !== 1 || !gl.isEnabled(gl.SCISSOR_TEST)) return false;
    const range = Array.from(gl.getParameter(gl.DEPTH_RANGE)) as number[];
    const scissor = Array.from(gl.getParameter(gl.SCISSOR_BOX)) as number[];
    if (range[0] !== 0 || range[1] !== 1 || !scissor.every(Number.isSafeInteger)
      || scissor[0] < 0 || scissor[1] < 0 || scissor[2] <= 0 || scissor[3] <= 0
      || scissor[0] + scissor[2] > width || scissor[1] + scissor[3] > height) return false;
    const old = { program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      mask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)) as boolean[], depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
      depthFunc: gl.getParameter(gl.DEPTH_FUNC), viewport: Array.from(gl.getParameter(gl.VIEWPORT)) as number[],
      enabled: flags.map(f => gl.isEnabled(f)) };
    try {
      if (!program) initialize();
      // A synchronous raw transaction restores actual state exactly and leaves
      // Mol*'s cached state untouched. Cache-skip setters cannot omit a needed
      // change after an earlier raw GL call. Program cache IDs are invalidated.
      for (const f of flags) if (f !== gl.DEPTH_TEST) gl.disable(f);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS); gl.depthMask(true);
      gl.colorMask(false, false, false, false); gl.viewport(0, 0, width, height);
      gl.useProgram(program); gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, 3); draws++; error = null;
      return true;
    } catch (e) {
      error = String(e); failed = true; release(); return false;
    } finally {
      for (let i = 0; i < flags.length; i++) if (old.enabled[i]) gl.enable(flags[i]); else gl.disable(flags[i]);
      gl.colorMask(...old.mask); gl.depthMask(old.depthMask); gl.depthFunc(old.depthFunc);
      gl.viewport(...old.viewport); gl.useProgram(old.program); gl.bindVertexArray(old.vao); invalidate();
    }
  }
  function resetDepth(): boolean {
    try { return tryResetDepth(); }
    catch (e) {
      // An unavailable native-state query must still use the normal clear.
      error = String(e); failed = true; release(); return false;
    }
  }
  // Context events retire raw resources; the next accepted draw recompiles.
  gl?.canvas?.addEventListener?.('webglcontextlost', reset);
  gl?.canvas?.addEventListener?.('webglcontextrestored', reset);
  return {
    resetDepth, reset,
    facts: () => ({ draws, failed, error, disposed, resources: !!program }),
    dispose() {
      if (disposed) return; disposed = true; release(); session?.removeEventListener?.('end', ended);
      gl?.canvas?.removeEventListener?.('webglcontextlost', reset);
      gl?.canvas?.removeEventListener?.('webglcontextrestored', reset);
    },
  };
}
