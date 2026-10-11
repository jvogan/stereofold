import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { patchMolstarOpaqueRendererSource, patchMolstarOpaqueDrawSource, patchMolstarOpaqueRenderItemSource,
  patchMolstarOpaqueMeshSource, opaqueDepthBuildPlugins } from '../src/molstar-opaque-depth-patch.js';
import { patchMolstarBlendedTransparentSource } from '../src/molstar-transparent-mesh-patch.js';
import { forkDrawPassSource } from '../src/molstar-draw-pass-fork.js';
const root = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFileSync(new URL('../node_modules/molstar/lib/' + path, import.meta.url), 'utf8');
const renderer = read('mol-gl/renderer.js'), draw = read('mol-canvas3d/passes/draw.js');
const renderItem = read('mol-gl/webgl/render-item.js'), mesh = read('mol-gl/shader/mesh.frag.js');
const quest = { userAgent: 'OculusBrowser/40.0', xr: {} };
const cell = (value: any) => ({ ref: { value, version: 0 } });
const fields = { alpha: 1, transparencyAverage: 0, dTransparency: false, dGeometryType: 'mesh', dXrayShaded: 'off',
  dClipObjectCount: 0, uDoubleSided: false, hasReflection: false, dFlipSided: false, dTransparentBackfaces: 'off', uLod: [0,0,0,0] };
function object(overrides: Record<string, any> = {}) {
  return { state: { alphaFactor: 1 }, values: Object.fromEntries(Object.entries({ ...fields, ...overrides }).map(([k,v])=>[k,cell(v)])),
    getProgram: (name: string) => name === 'colorOpaqueNoDiscard' ? {} : {} };
}
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)));
function loop(navigator: any) {
  const submissions: any[] = [];
  const context: any = vm.createContext({ navigator, isTimingMode: false,
    clamp: (x: number,lo: number,hi: number)=>Math.max(lo,Math.min(hi,x)), gl: {},
    state: { disable() {}, enable() {}, depthMask() {} }, updateInternal() {}, Mask: { Opaque: 0 }, Flag: { None: 0 },
    renderObject: (_r: any, variant: string) => submissions.push(variant) });
  const patched = patchMolstarOpaqueRendererSource(patchMolstarBlendedTransparentSource(renderer));
  vm.runInContext(between(renderer, '        const checkOpaque = function', '        const checkTransparent = function')
    + between(patched, '        const stereofoldQuestOpaque', '        const renderBlendedTransparent =')
    + '\nglobalThis.draw=renderOpaque;', context);
  return { submissions, draw: (r: any, primary = true) => context.draw({ renderables: [r] }, {}, primary) };
}

function itemHarness(navigator: any, name = 'mesh', patched = true, geometry = name) {
  const programs: any[] = [], vaos: any[] = [], draws: any[] = [];
  const state: any = {};
  const ctx: any = { state, stats: { drawCount:0,instanceCount:0,instancedDrawCount:0 }, gl: { TRIANGLES:4 },
    extensions: { drawBuffers: {}, vertexArrayObject: {}, instancedArrays: { drawArraysInstanced: (...a: any[]) => draws.push(a) } },
    resources: { program: (defines: any) => {
      const p: any = { id: programs.length+1, variant: defines.dRenderVariant.ref.value, fast: !!defines.dStereofoldOpaqueNoDiscard?.ref.value, destroyed: 0,
        use() { state.currentProgramId=p.id; }, setUniforms() {}, bindTextures() {}, bindAttributes() {}, destroy() { p.destroyed++; } };
      programs.push(p); return p;
    }, vertexArray: () => { const v = { destroyed:0, bind() {}, destroy() {v.destroyed++;} }; vaos.push(v); return v; } } };
  const values: any = { dGeometryType:cell(geometry), drawCount: cell(3), instanceCount:cell(1), dProbe:cell(false) };
  const context: any = vm.createContext({ navigator, isDebugMode:false,isTimingMode:false,
    idFactory: () => {let id=0;return ()=>id++;}, ValueCell: {create:cell, update:(c:any,v:any)=>{c.ref.value=v;c.ref.version++;}},
    DefineSpec: () => ({type:'define'}), createAttributeBuffers:()=>[], createTextures:()=>[], cloneUniformValues:()=>({}),
    getValueVersions: (v:any)=>Object.fromEntries(Object.entries(v).map(([k,c]:any)=>[k,c.ref.version])),
    splitValues: (_s:any,v:any)=>({attributeValues:{},defineValues:{dProbe:v.dProbe},textureValues:{},materialTextureValues:{},uniformValues:{},materialUniformValues:{},bufferedUniformValues:{}}),
  });
  const source = (patched ? patchMolstarOpaqueRenderItemSource(renderItem) : renderItem).replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
  vm.runInContext(source + '\nglobalThis.create=createGraphicsRenderItem;',context);
  const item = context.create(ctx,'triangles',{name},{},values,1,'blended');
  return { item, programs, vaos, draws, values };
}

const bundle = await build({ stdin: {contents:"export { MeshShaderCode } from 'molstar/lib/mol-gl/shader-code.js';",resolveDir:root},
  bundle:true,write:false,format:'cjs',platform:'browser',plugins:[{name:'test-mesh',setup(api){api.onLoad({filter:/molstar[/\\]lib[/\\]mol-gl[/\\]shader[/\\]mesh\.frag\.js$/},()=>({contents:patchMolstarOpaqueMeshSource(mesh),loader:'js'}));}}] });
const originalBundle = await build({ stdin: {contents:"export { MeshShaderCode } from 'molstar/lib/mol-gl/shader-code.js';",resolveDir:root},bundle:true,write:false,format:'cjs',platform:'browser' });
function shader(code: string, navigator: any) { const c:any=vm.createContext({module:{exports:{}},exports:{},navigator });vm.runInContext(code,c);return c.module.exports.MeshShaderCode; }
const candidateShader=shader(bundle.outputFiles[0]!.text,quest), stockShader=shader(originalBundle.outputFiles[0]!.text,quest);
// Resolve the actual GLSL conditional directives without adding a platform
// C compiler dependency to the test suite. Leave arithmetic/function macros
// untouched: these assertions compare branch bodies, while GPU probes compile
// and compare complete vertex/fragment shaders on the physical device.
function cpp(text: string, variant: string) {
  const definitions = new Map<string,string>(Object.entries({__VERSION__:'300',dLightCount:'3',dClipObjectCount:'0',
    dColorType_uniform:'1',dGeometryType_mesh:'1',dTransparentBackfaces_off:'1',
    ...(variant==='colorOpaqueNoDiscard'?{dStereofoldOpaqueNoDiscard:'1',dRenderVariant_colorBlended:'1'}:{['dRenderVariant_'+variant]:'1'})}));
  const stack: {parent:boolean;seen:boolean}[] = []; let active=true;const output:string[]=[];
  const evaluate=(expression:string)=>{
    const replaced=expression.replace(/defined\s*\(\s*(\w+)\s*\)/g,(_m,name)=>definitions.has(name)?'1':'0')
      .replace(/\b[A-Za-z_]\w*\b/g,name=>definitions.get(name)||'0');
    if(!/^[0-9.\s!&|<>=()+*\/%-]+$/.test(replaced))throw Error('Unsupported GLSL condition '+expression);
    return !!Function('return ('+replaced+')')();
  };
  for(const line of text.split(/\r?\n/)) {
    const directive=line.match(/^\s*#(\w+)(?:\s+(.*))?$/);
    if(!directive){if(active&&line.trim())output.push(line);continue;}
    const [,kind,arg='']=directive;
    if(kind==='if'||kind==='ifdef'||kind==='ifndef') {
      const value=kind==='if'?evaluate(arg):kind==='ifdef'?definitions.has(arg):!definitions.has(arg);
      stack.push({parent:active,seen:value});active=active&&value;
    } else if(kind==='elif') {
      const frame=stack.at(-1)!;const value=!frame.seen&&evaluate(arg);frame.seen ||= value;active=frame.parent&&value;
    } else if(kind==='else') {
      const frame=stack.at(-1)!;active=frame.parent&&!frame.seen;frame.seen=true;
    } else if(kind==='endif') active=stack.pop()!.parent;
    else if(kind==='define'&&active) {
      const match=arg.match(/^(\w+)(?:\s+(.*))?$/);if(match)definitions.set(match[1]!,match[2]||'1');
    } else if(kind==='undef'&&active) definitions.delete(arg);
    else if(active)output.push(line);
  }
  if(stack.length)throw Error('Unclosed GLSL condition');return output.join('\n').trim();
}

describe('Quest primary opaque mesh depth candidate',()=>{
  it('selects only primary opaque draws and falls back immediately when live eligibility changes',()=>{
    const h=loop(quest),r=object();h.draw(r);expect(h.submissions).toEqual(['colorOpaqueNoDiscard']);
    h.draw(r,false);expect(h.submissions.at(-1)).toBe('color');
    for(const [k,v] of Object.entries({dTransparency:true,transparencyAverage:.1,dHasMaterialOpacity:true,dXrayShaded:'on',dClipObjectCount:1,
      uDoubleSided:true,hasReflection:true,dFlipSided:true,dTransparentBackfaces:'opaque',uLod:[1,2,1,0],lodLevels:[[1,2,1,0]],dGeometryType:'spheres'})) {
      const prior=r.values[k], count=h.submissions.length;r.values[k]=cell(v);h.draw(r);
      if(k==='dXrayShaded')expect(h.submissions).toHaveLength(count);else expect(h.submissions.at(-1),k).toBe('color');
      if(prior)r.values[k]=prior;else delete r.values[k];h.draw(r);expect(h.submissions.at(-1),k+' recovered').toBe('colorOpaqueNoDiscard');
    }
    r.values.alpha=cell(.5);const count=h.submissions.length;h.draw(r);expect(h.submissions).toHaveLength(count);
    r.values.alpha=cell(1);h.draw(r);expect(h.submissions.at(-1)).toBe('colorOpaqueNoDiscard');r.state.alphaFactor=.5;h.draw(r);expect(h.submissions).toHaveLength(count+1);
    r.state.alphaFactor=1;h.draw(r);expect(h.submissions.at(-1)).toBe('colorOpaqueNoDiscard');
    r.state.alphaFactor=1;r.getProgram=()=>undefined as any;h.draw(r);expect(h.submissions.at(-1)).toBe('color');
  });
  it.each([undefined,{userAgent:'Version/26 Safari/605.1.15',xr:{}},{userAgent:'PicoBrowser/1',xr:{}},{userAgent:'OculusBrowser/40'}])('does not select/add shaders or alter GLSL on other browsers %j',nav=>{
    const h=loop(nav);h.draw(object());expect(h.submissions).toEqual(['color']);
    const a=itemHarness(nav),b=itemHarness(nav,'mesh',false);expect(a.programs.map(p=>p.variant)).toEqual(b.programs.map(p=>p.variant));
    expect(shader(bundle.outputFiles[0]!.text,nav)).toMatchObject({vert:stockShader.vert,frag:stockShader.frag});
  });
  it('uses the actual render-item program/VAO lifecycle for the extra variant',()=>{
    const h=itemHarness(quest);expect(h.programs).toHaveLength(7);expect(h.vaos).toHaveLength(7);expect(h.item.getProgram('colorOpaqueNoDiscard').fast).toBe(true);
    h.item.render('colorOpaqueNoDiscard',0);expect(h.draws).toHaveLength(1);
    h.values.dProbe.ref.value=true;h.values.dProbe.ref.version++;h.item.update();
    expect(h.programs).toHaveLength(14);expect(h.programs.slice(0,7).every(p=>p.destroyed===1)).toBe(true);
    expect(h.vaos).toHaveLength(14);expect(h.vaos.slice(0,7).every(p=>p.destroyed===1)).toBe(true);
    h.item.setTransparency('wboit');expect(h.item.getProgram('colorOpaqueNoDiscard').variant).toBe('colorWboit');
    h.item.setTransparency('dpoit');expect(h.item.getProgram('colorOpaqueNoDiscard').variant).toBe('colorDpoit');
    h.item.setTransparency('blended');expect(h.item.getProgram('colorOpaqueNoDiscard').variant).toBe('colorBlended');expect(h.item.getProgram('colorOpaqueNoDiscard').fast).toBe(true);
    h.item.destroy();h.item.destroy();expect(h.programs.every(p=>p.destroyed===1)).toBe(true);expect(h.vaos.every(p=>p.destroyed===1)).toBe(true);
    expect(itemHarness(quest,'spheres').programs).toHaveLength(6);expect(itemHarness(quest,'mesh',true,'textureMesh').programs).toHaveLength(6);
  });
  it('keeps every stock shader variant preprocessor-identical and removes discard only in the extra color variant',()=>{
    for(const variant of ['colorBlended','colorWboit','colorDpoit','pick','depth','marking','emissive','tracing']) {
      expect(cpp(candidateShader.frag,variant),variant).toBe(cpp(stockShader.frag,variant));
      expect(cpp(candidateShader.vert,variant),variant).toBe(cpp(stockShader.vert,variant));
    }
    const fast=cpp(candidateShader.frag,'colorOpaqueNoDiscard');expect(fast).not.toMatch(/\bdiscard\s*;/);
    expect(cpp(candidateShader.vert,'colorOpaqueNoDiscard')).toBe(cpp(stockShader.vert,'colorBlended'));
    expect(fast).toContain('BRDF_GGX');expect(fast).toContain('gl_FragColor');
  });
  it('only opts in the primary blended scene and composes with existing source owners',()=>{
    const original=forkDrawPassSource(draw),patched=patchMolstarOpaqueDrawSource(original);
    expect(patched.replace('renderer.renderOpaque(scene.primitives, camera, true);','renderer.renderOpaque(scene.primitives, camera);')).toBe(original);
    const r=patchMolstarBlendedTransparentSource(renderer),p=patchMolstarOpaqueRendererSource(r);
    expect(p.slice(p.indexOf('        const renderBlendedTransparent ='))).toBe(r.slice(r.indexOf('        const renderBlendedTransparent =')));
  });
  it('executes the actual tsx build serialization without transpiler helpers',()=>{
    const result=execFileSync(process.execPath,['--import','tsx','-e',`
      const fs=require('node:fs'),vm=require('node:vm');
      const p=require('./src/molstar-opaque-depth-patch.ts');
      const r=${JSON.stringify(object())};
      if(!vm.runInNewContext('('+p.canUseOpaqueDepthMesh.toString()+')('+JSON.stringify(r)+')'))throw Error('Gate refused');
      for(const [fn,file] of [[p.patchMolstarOpaqueRendererSource,'renderer.js'],[p.patchMolstarOpaqueRenderItemSource,'webgl/render-item.js'],[p.patchMolstarOpaqueMeshSource,'shader/mesh.frag.js']]) {
        const source=fn(fs.readFileSync('./node_modules/molstar/lib/mol-gl/'+file,'utf8'));
        if(source.includes('__name'))throw Error('Unbound transpiler helper');
      }
    `],{cwd:root,encoding:'utf8'});expect(result).toBe('');
  });
  it('fails closed on changed/repeated anchors, defaults on for Quest, and requires both build modules',async()=>{
    for(const [fn,s] of [[patchMolstarOpaqueRendererSource,renderer],[patchMolstarOpaqueDrawSource,draw],[patchMolstarOpaqueRenderItemSource,renderItem],[patchMolstarOpaqueMeshSource,mesh]] as const) {
      expect(()=>fn('')).toThrow();expect(()=>fn(s+s)).toThrow();expect(()=>fn(fn(s))).toThrow();
    }
    expect(opaqueDepthBuildPlugins(undefined)).toHaveLength(1);expect(opaqueDepthBuildPlugins('0')).toEqual([]);expect(()=>opaqueDepthBuildPlugins('yes')).toThrow();
    const bundled=await build({stdin:{contents:"export { MeshShaderCode } from 'molstar/lib/mol-gl/shader-code.js'; export { createGraphicsRenderItem } from 'molstar/lib/mol-gl/webgl/render-item.js';",resolveDir:root},bundle:true,write:false,format:'cjs',platform:'browser',plugins:opaqueDepthBuildPlugins('1')});
    expect(shader(bundled.outputFiles[0]!.text,quest).frag).toBe(candidateShader.frag);
    await expect(build({stdin:{contents:'export const nothing=true',resolveDir:root},bundle:true,write:false,logLevel:'silent',plugins:opaqueDepthBuildPlugins('1')})).rejects.toThrow('Expected one');
  });
});
