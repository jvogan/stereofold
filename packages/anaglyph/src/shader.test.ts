import { describe, expect, it } from 'vitest';
import {
  ANAGLYPH_FRAGMENT_SHADER,
  ANAGLYPH_VERTEX_SHADER,
  BALANCED_K_RED_CYAN,
  BALANCED_MATRICES,
  DUBOIS_MATRICES,
  anaglyphFragmentShader,
  createAnaglyphPass,
  mat3ColumnMajor,
  rec709Weights,
} from './index';

function fakeGl(): WebGL2RenderingContext {
  const handles: object[] = [];
  const alloc = (): object => {
    const h = { id: handles.length };
    handles.push(h);
    return h;
  };
  const noop = () => {};
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812f,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    RENDERBUFFER: 0x8d41,
    DEPTH24_STENCIL8: 0x88f0,
    FRAMEBUFFER: 0x8d40,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_STENCIL_ATTACHMENT: 0x821a,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TRIANGLE_STRIP: 0x0005,
    createShader: () => alloc(),
    shaderSource: noop,
    compileShader: noop,
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: noop,
    createProgram: () => alloc(),
    attachShader: noop,
    linkProgram: noop,
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: noop,
    createVertexArray: () => alloc(),
    createBuffer: () => alloc(),
    bindVertexArray: noop,
    bindBuffer: noop,
    bufferData: noop,
    enableVertexAttribArray: noop,
    vertexAttribPointer: noop,
    getUniformLocation: (program: object, name: string) => ({ program, name }),
    createTexture: () => alloc(),
    bindTexture: noop,
    texParameteri: noop,
    texImage2D: noop,
    createRenderbuffer: () => alloc(),
    bindRenderbuffer: noop,
    renderbufferStorage: noop,
    createFramebuffer: () => alloc(),
    bindFramebuffer: noop,
    framebufferTexture2D: noop,
    framebufferRenderbuffer: noop,
    useProgram: noop,
    uniform1i: noop,
    uniformMatrix3fv: noop,
    viewport: noop,
    activeTexture: noop,
    drawArrays: noop,
    deleteTexture: noop,
    deleteRenderbuffer: noop,
    deleteFramebuffer: noop,
    deleteBuffer: noop,
    deleteVertexArray: noop,
  };
  return gl as unknown as WebGL2RenderingContext;
}

describe('WebGL2 anaglyph shader source', () => {
  it('is GLSL ES 3.00 and samples two eye textures', () => {
    expect(ANAGLYPH_VERTEX_SHADER.startsWith('#version 300 es')).toBe(true);
    expect(ANAGLYPH_FRAGMENT_SHADER.startsWith('#version 300 es')).toBe(true);
    expect(ANAGLYPH_FRAGMENT_SHADER).toContain('uniform sampler2D uLeftEye');
    expect(ANAGLYPH_FRAGMENT_SHADER).toContain('uniform sampler2D uRightEye');
    expect(ANAGLYPH_FRAGMENT_SHADER).toContain('uniform int uVariant');
    expect(ANAGLYPH_FRAGMENT_SHADER).toContain('srgbToLinear');
    expect(ANAGLYPH_FRAGMENT_SHADER).toContain('linearToSrgb');
    expect(ANAGLYPH_FRAGMENT_SHADER).toContain('clamp(ML * cL + MR * cR, 0.0, 1.0)');
  });

  it('balanced shader string contains the balanced coefficients', () => {
    const src = anaglyphFragmentShader({ variant: 'balanced' });
    expect(src).toContain('variant=balanced');
    const w = rec709Weights();
    expect(src).toContain(w[0].toFixed(6));
    expect(src).toContain(w[1].toFixed(6));
    expect(src).toContain(w[2].toFixed(6));
    const kw0 = (BALANCED_K_RED_CYAN * w[0]).toFixed(6);
    expect(src).toContain(kw0);
    expect(src).toContain('ML_BALANCED_RED_CYAN');
    expect(src).toContain('MR_BALANCED_GREEN_MAGENTA');
    expect(src).toContain('ML_BALANCED_AMBER_BLUE');
    const col = mat3ColumnMajor(BALANCED_MATRICES['red-cyan'].left);
    expect(src).toContain(col[0].toFixed(6));
  });

  it('embeds the red-cyan Dubois coefficients under variant dubois', () => {
    const src = anaglyphFragmentShader({ variant: 'dubois' });
    expect(src).toContain('variant=dubois');
    const col = mat3ColumnMajor(DUBOIS_MATRICES['red-cyan'].left);
    expect(src).toContain(col[0].toFixed(6));
    expect(src).toContain(mat3ColumnMajor(DUBOIS_MATRICES['red-cyan'].right)[8].toFixed(6));
    expect(src).toContain('ML_DUBOIS_GREEN_MAGENTA');
    expect(src).toContain('MR_DUBOIS_AMBER_BLUE');
  });

  it('default fragment shader contains both balanced and Dubois sets', () => {
    expect(ANAGLYPH_FRAGMENT_SHADER).toContain('ML_BALANCED_RED_CYAN');
    expect(ANAGLYPH_FRAGMENT_SHADER).toContain('ML_DUBOIS_RED_CYAN');
    expect(ANAGLYPH_FRAGMENT_SHADER).toContain('uVariant == 1');
  });
});

describe('createAnaglyphPass', () => {
  it('owns two FBOs and a fullscreen quad, and render() binds both eye textures', () => {
    const gl = fakeGl();
    const created: string[] = [];
    const origFbo = gl.createFramebuffer.bind(gl);
    gl.createFramebuffer = () => {
      created.push('fbo');
      return origFbo();
    };
    const pass = createAnaglyphPass(gl, { width: 64, height: 48 });
    expect(created.length).toBe(2);
    expect(pass.leftFramebuffer).toBeTruthy();
    expect(pass.rightFramebuffer).toBeTruthy();
    expect(pass.leftTexture).not.toBe(pass.rightTexture);
    expect(pass.width).toBe(64);
    expect(pass.height).toBe(48);
    expect(pass.variant).toBe('balanced');
    pass.render(pass.leftTexture, pass.rightTexture, null);
    pass.glasses = 'amber-blue';
    pass.variant = 'dubois';
    expect(pass.variant).toBe('dubois');
    pass.swapEyes = true;
    pass.resize(128, 96);
    expect(pass.width).toBe(128);
    pass.dispose();
    expect(() => pass.render(pass.leftTexture, pass.rightTexture)).toThrow(/disposed/);
  });
});
