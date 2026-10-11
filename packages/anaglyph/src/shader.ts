import {
  BALANCED_MATRICES,
  DUBOIS_MATRICES,
  mat3ColumnMajor,
  type GlassesKind,
  type Variant,
} from './matrices';

export const ANAGLYPH_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

function glslMat3(name: string, values: Float32Array): string {
  const n = (i: number) => values[i].toFixed(6);
  return `const mat3 ${name} = mat3(
    ${n(0)}, ${n(1)}, ${n(2)},
    ${n(3)}, ${n(4)}, ${n(5)},
    ${n(6)}, ${n(7)}, ${n(8)}
);`;
}

const GLASSES_INDEX: Record<GlassesKind, number> = {
  'red-cyan': 0,
  'green-magenta': 1,
  'amber-blue': 2,
};

const VARIANT_INDEX: Record<Variant, number> = {
  balanced: 0,
  dubois: 1,
};

export interface ShaderOptions {
  glasses?: GlassesKind;
  variant?: Variant;
}

function isGlassesKind(value: unknown): value is GlassesKind {
  return value === 'red-cyan' || value === 'green-magenta' || value === 'amber-blue';
}

/**
 * GLSL ES 3.00 composite. Embeds both variants; `uVariant` 0 = balanced
 * (default), 1 = Dubois. `uGlasses` 0/1/2 = red-cyan / green-magenta / amber-blue.
 *
 * Accepts `anaglyphFragmentShader()`, `anaglyphFragmentShader('red-cyan')`,
 * or `anaglyphFragmentShader({ variant: 'dubois' })`.
 */
export function anaglyphFragmentShader(
  glassesOrOptions: GlassesKind | ShaderOptions = 'red-cyan',
  options: ShaderOptions = {},
): string {
  const fromFirst: ShaderOptions = isGlassesKind(glassesOrOptions)
    ? { glasses: glassesOrOptions }
    : glassesOrOptions;
  const glasses = fromFirst.glasses ?? options.glasses ?? 'red-cyan';
  const variant = fromFirst.variant ?? options.variant ?? 'balanced';
  const rcB = BALANCED_MATRICES['red-cyan'];
  const gmB = BALANCED_MATRICES['green-magenta'];
  const abB = BALANCED_MATRICES['amber-blue'];
  const rcD = DUBOIS_MATRICES['red-cyan'];
  const gmD = DUBOIS_MATRICES['green-magenta'];
  const abD = DUBOIS_MATRICES['amber-blue'];
  return `#version 300 es
precision highp float;
// requested glasses=${glasses} variant=${variant}; both variants are inlined for uVariant
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uLeftEye;
uniform sampler2D uRightEye;
uniform bool uSwapEyes;
uniform int uGlasses;
uniform int uVariant;

${glslMat3('ML_BALANCED_RED_CYAN', mat3ColumnMajor(rcB.left))}
${glslMat3('MR_BALANCED_RED_CYAN', mat3ColumnMajor(rcB.right))}
${glslMat3('ML_BALANCED_GREEN_MAGENTA', mat3ColumnMajor(gmB.left))}
${glslMat3('MR_BALANCED_GREEN_MAGENTA', mat3ColumnMajor(gmB.right))}
${glslMat3('ML_BALANCED_AMBER_BLUE', mat3ColumnMajor(abB.left))}
${glslMat3('MR_BALANCED_AMBER_BLUE', mat3ColumnMajor(abB.right))}
${glslMat3('ML_DUBOIS_RED_CYAN', mat3ColumnMajor(rcD.left))}
${glslMat3('MR_DUBOIS_RED_CYAN', mat3ColumnMajor(rcD.right))}
${glslMat3('ML_DUBOIS_GREEN_MAGENTA', mat3ColumnMajor(gmD.left))}
${glslMat3('MR_DUBOIS_GREEN_MAGENTA', mat3ColumnMajor(gmD.right))}
${glslMat3('ML_DUBOIS_AMBER_BLUE', mat3ColumnMajor(abD.left))}
${glslMat3('MR_DUBOIS_AMBER_BLUE', mat3ColumnMajor(abD.right))}

vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 linearToSrgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
    vec3 sL = texture(uLeftEye, vUv).rgb;
    vec3 sR = texture(uRightEye, vUv).rgb;
    vec3 cL = srgbToLinear(uSwapEyes ? sR : sL);
    vec3 cR = srgbToLinear(uSwapEyes ? sL : sR);
    mat3 ML;
    mat3 MR;
    if (uVariant == 1) {
        ML = ML_DUBOIS_RED_CYAN;
        MR = MR_DUBOIS_RED_CYAN;
        if (uGlasses == 1) {
            ML = ML_DUBOIS_GREEN_MAGENTA;
            MR = MR_DUBOIS_GREEN_MAGENTA;
        } else if (uGlasses == 2) {
            ML = ML_DUBOIS_AMBER_BLUE;
            MR = MR_DUBOIS_AMBER_BLUE;
        }
    } else {
        ML = ML_BALANCED_RED_CYAN;
        MR = MR_BALANCED_RED_CYAN;
        if (uGlasses == 1) {
            ML = ML_BALANCED_GREEN_MAGENTA;
            MR = MR_BALANCED_GREEN_MAGENTA;
        } else if (uGlasses == 2) {
            ML = ML_BALANCED_AMBER_BLUE;
            MR = MR_BALANCED_AMBER_BLUE;
        }
    }
    vec3 anaglyphLinear = clamp(ML * cL + MR * cR, 0.0, 1.0);
    fragColor = vec4(linearToSrgb(anaglyphLinear), 1.0);
}
`;
}

export const ANAGLYPH_FRAGMENT_SHADER = anaglyphFragmentShader('red-cyan');

export interface AnaglyphPass {
  readonly gl: WebGL2RenderingContext;
  readonly leftFramebuffer: WebGLFramebuffer;
  readonly rightFramebuffer: WebGLFramebuffer;
  readonly leftTexture: WebGLTexture;
  readonly rightTexture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  glasses: GlassesKind;
  variant: Variant;
  swapEyes: boolean;
  resize(width: number, height: number): void;
  /**
   * Composite `leftTex` and `rightTex` into the currently bound draw
   * framebuffer (pass `null` to draw to the canvas). Mol* DrawPass renders
   * `camera.left` into `leftFramebuffer` and `camera.right` into
   * `rightFramebuffer`, then calls `render(leftTexture, rightTexture, null)`.
   */
  render(leftTex: WebGLTexture, rightTex: WebGLTexture, target?: WebGLFramebuffer | null): void;
  dispose(): void;
}

export interface AnaglyphPassOptions {
  width?: number;
  height?: number;
  glasses?: GlassesKind;
  variant?: Variant;
  swapEyes?: boolean;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL2 createShader returned null');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'no log';
    gl.deleteShader(shader);
    throw new Error(`Anaglyph shader compile failed: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vert: WebGLShader, frag: WebGLShader): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('WebGL2 createProgram returned null');
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'no log';
    gl.deleteProgram(program);
    throw new Error(`Anaglyph program link failed: ${log}`);
  }
  return program;
}

function makeTexture(gl: WebGL2RenderingContext, width: number, height: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('WebGL2 createTexture returned null');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function makeDepth(gl: WebGL2RenderingContext, width: number, height: number): WebGLRenderbuffer {
  const rb = gl.createRenderbuffer();
  if (!rb) throw new Error('WebGL2 createRenderbuffer returned null');
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  return rb;
}

function makeFbo(
  gl: WebGL2RenderingContext,
  color: WebGLTexture,
  depth: WebGLRenderbuffer,
): WebGLFramebuffer {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('WebGL2 createFramebuffer returned null');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
  gl.framebufferRenderbuffer(
    gl.FRAMEBUFFER,
    gl.DEPTH_STENCIL_ATTACHMENT,
    gl.RENDERBUFFER,
    depth,
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fbo;
}

/**
 * Two colour+depth FBOs plus a fullscreen-quad composite.
 *
 * Mol* 5.11.0 hook: `mol-canvas3d/passes/draw.js:469` (see
 * `docs/molstar-stereo-patch.md`). Stock `_render` binds its own targets at
 * `draw.js:372-391`, so a DrawPass fork must `drawEye` into per-eye colour
 * targets, then `render(leftTex, rightTex, null)`. The owned FBOs can be
 * those targets; otherwise pass Mol*'s textures through.
 */
export function createAnaglyphPass(
  gl: WebGL2RenderingContext,
  options: AnaglyphPassOptions = {},
): AnaglyphPass {
  const glasses = options.glasses ?? 'red-cyan';
  const variant = options.variant ?? 'balanced';
  const vert = compile(gl, gl.VERTEX_SHADER, ANAGLYPH_VERTEX_SHADER);
  const frag = compile(gl, gl.FRAGMENT_SHADER, anaglyphFragmentShader({ glasses, variant }));
  const program = link(gl, vert, frag);
  gl.deleteShader(vert);
  gl.deleteShader(frag);

  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  if (!vao || !vbo) throw new Error('WebGL2 VAO/VBO create returned null');
  // Fullscreen quad as a triangle strip: (x,y,u,v) × 4.
  const quad = new Float32Array([
    -1, -1, 0, 0,
     1, -1, 1, 0,
    -1,  1, 0, 1,
     1,  1, 1, 1,
  ]);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const locLeft = gl.getUniformLocation(program, 'uLeftEye');
  const locRight = gl.getUniformLocation(program, 'uRightEye');
  const locSwap = gl.getUniformLocation(program, 'uSwapEyes');
  const locGlasses = gl.getUniformLocation(program, 'uGlasses');
  const locVariant = gl.getUniformLocation(program, 'uVariant');

  let width = Math.max(1, options.width ?? 1);
  let height = Math.max(1, options.height ?? 1);
  let leftTex = makeTexture(gl, width, height);
  let rightTex = makeTexture(gl, width, height);
  let leftDepth = makeDepth(gl, width, height);
  let rightDepth = makeDepth(gl, width, height);
  let leftFbo = makeFbo(gl, leftTex, leftDepth);
  let rightFbo = makeFbo(gl, rightTex, rightDepth);
  let currentGlasses = glasses;
  let currentVariant = variant;
  let swapEyes = options.swapEyes === true;
  let disposed = false;

  function assertLive(): void {
    if (disposed) throw new Error('AnaglyphPass has been disposed');
  }

  function uploadSelection(): void {
    gl.useProgram(program);
    gl.uniform1i(locGlasses, GLASSES_INDEX[currentGlasses]);
    gl.uniform1i(locVariant, VARIANT_INDEX[currentVariant]);
  }
  uploadSelection();

  const pass: AnaglyphPass = {
    gl,
    get leftFramebuffer() { return leftFbo; },
    get rightFramebuffer() { return rightFbo; },
    get leftTexture() { return leftTex; },
    get rightTexture() { return rightTex; },
    get width() { return width; },
    get height() { return height; },
    get glasses() { return currentGlasses; },
    set glasses(value: GlassesKind) {
      assertLive();
      currentGlasses = value;
      uploadSelection();
    },
    get variant() { return currentVariant; },
    set variant(value: Variant) {
      assertLive();
      currentVariant = value;
      uploadSelection();
    },
    get swapEyes() { return swapEyes; },
    set swapEyes(value: boolean) {
      assertLive();
      swapEyes = value;
    },
    resize(nextWidth: number, nextHeight: number): void {
      assertLive();
      const w = Math.max(1, nextWidth);
      const h = Math.max(1, nextHeight);
      if (w === width && h === height) return;
      gl.deleteTexture(leftTex);
      gl.deleteTexture(rightTex);
      gl.deleteRenderbuffer(leftDepth);
      gl.deleteRenderbuffer(rightDepth);
      gl.deleteFramebuffer(leftFbo);
      gl.deleteFramebuffer(rightFbo);
      width = w;
      height = h;
      leftTex = makeTexture(gl, width, height);
      rightTex = makeTexture(gl, width, height);
      leftDepth = makeDepth(gl, width, height);
      rightDepth = makeDepth(gl, width, height);
      leftFbo = makeFbo(gl, leftTex, leftDepth);
      rightFbo = makeFbo(gl, rightTex, rightDepth);
    },
    render(left: WebGLTexture, right: WebGLTexture, target: WebGLFramebuffer | null = null): void {
      assertLive();
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.uniform1i(locLeft, 0);
      gl.uniform1i(locRight, 1);
      gl.uniform1i(locSwap, swapEyes ? 1 : 0);
      gl.uniform1i(locGlasses, GLASSES_INDEX[currentGlasses]);
      gl.uniform1i(locVariant, VARIANT_INDEX[currentVariant]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, left);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, right);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      gl.deleteTexture(leftTex);
      gl.deleteTexture(rightTex);
      gl.deleteRenderbuffer(leftDepth);
      gl.deleteRenderbuffer(rightDepth);
      gl.deleteFramebuffer(leftFbo);
      gl.deleteFramebuffer(rightFbo);
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
  return pass;
}
