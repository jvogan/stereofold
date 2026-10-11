import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';
import { Mat4 } from 'molstar/lib/mol-math/linear-algebra.js';
import { patchMolstarSphereFrustumSource, SPHERE_FRUSTUM_GLSL, SPHERE_FRUSTUM_GATE } from '../src/molstar-sphere-frustum-patch.js';
import { impostorScaleBuildPlugins, patchMolstarImpostorScaleSource } from '../src/molstar-impostor-scale-patch.js';

const root = new URL('..', import.meta.url).pathname;
const source = await readFile(new URL('../node_modules/molstar/lib/mol-gl/shader/spheres.vert.js', import.meta.url), 'utf8');
const fragment = await readFile(new URL('../node_modules/molstar/lib/mol-gl/shader/spheres.frag.js', import.meta.url), 'utf8');
const scaled = patchMolstarImpostorScaleSource(source, 'spheres.vert', '5.11.0');
function shader(module: string, navigator?: unknown): string {
  const ctx = vm.createContext(navigator === undefined ? {} : { navigator });
  return vm.runInContext(module.replace('export const spheres_vert', 'const spheres_vert') + '\nspheres_vert;', ctx);
}
const quest = { userAgent: 'Mozilla/5.0 OculusBrowser/42.0', xr: {} };
const original = shader(scaled), patchedModule = patchMolstarSphereFrustumSource(scaled, '5.11.0');
const patched = shader(patchedModule, quest);
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const add = (a: number[], b: number[]) => a.map((x, i) => x + b[i]!);
const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]!);
const abs = (a: number[] | number) => Array.isArray(a) ? a.map(Math.abs) : Math.abs(a);
// Execute the actual injected helper body; adapt GLSL vector syntax/operators.
function glslFunction(name: string, parameters: string[], adapt: (s: string) => string) {
  const at = SPHERE_FRUSTUM_GLSL.indexOf(name+'('), open = SPHERE_FRUSTUM_GLSL.indexOf('{', at), end = SPHERE_FRUSTUM_GLSL.indexOf('\n}', open);
  const body = adapt(SPHERE_FRUSTUM_GLSL.slice(open+1,end).replace(/\b(?:float|vec4) (\w+) =/g, 'const $1 ='));
  return new Function(...parameters, body);
}
const plane = glslFunction('stereofoldSphereOutsidePlane', ['plane','center','radius','dot','length','abs','max','vec4'], s=>s.replaceAll('plane.xyz','plane.slice(0,3)').replaceAll('plane.w','plane[3]'));
const outsidePlane = (p: number[], c: number[], r: number) => plane(p,c,r,dot,(a:number[])=>Math.hypot(...a),abs,Math.max,(c:number[],w:number)=>[...c,w]) as boolean;
const sides = glslFunction('stereofoldSphereOutsideSides', ['center','radius','uProjection','vec4','stereofoldSphereOutsidePlane','add','sub'], s=>s.replace(/rowW \+ row([XY])/g,'add(rowW,row$1)').replace(/rowW - row([XY])/g,'sub(rowW,row$1)'));
const outsideSides = (p: number[], c: number[], r: number) => sides(c,r,[0,1,2,3].map(i=>p.slice(i*4,i*4+4)),(...v:number[])=>v,outsidePlane,add,sub) as boolean;
const condition = SPHERE_FRUSTUM_GATE.match(/if \(([\s\S]*?)\) \{/)![1]!;
const runGate = new Function('uProjection','uIsAsymmetricProjection','uIsOrtho','mvPosition','vRadius','isnan','isinf','any','stereofoldSphereOutsideSides', 'return '+condition+';');
function gate(p:number[], c:number[], r:number, asymmetric=true, ortho=0, w=1) {
  const nan=(v:any)=>Array.isArray(v)?v.map(Number.isNaN):Number.isNaN(v), inf=(v:any)=>Array.isArray(v)?v.map((x:number)=>!Number.isFinite(x)&&!Number.isNaN(x)):!Number.isFinite(v)&&!Number.isNaN(v);
  const position:any=[...c,w];position.xyz=c;position.w=w;
  return !!runGate([0,1,2,3].map(i=>p.slice(i*4,i*4+4)),asymmetric,ortho,position,r,nan,inf,(v:boolean[])=>v.some(Boolean),(c:number[],r:number)=>outsideSides(p,c,r));
}
const p = Array.from(Mat4.perspective(Mat4.zero(),-.015,.016,.013,-.012,.01,52.35));

describe('Quest sphere four-side frustum adaptation',()=>{
  it('changes only the vertex gate and returns exact stock shader bytes off Quest/WebXR',()=>{
    expect(patched.replace(SPHERE_FRUSTUM_GLSL,'').replace(SPHERE_FRUSTUM_GATE,'')).toBe(original);
    for(const navigator of [undefined,{}, {userAgent:'Mozilla/5.0 Chrome/140',xr:{}}, {userAgent:'Mozilla/5.0 AppleWebKit VisionPro Safari',xr:{}}, {userAgent:'OculusBrowser/42'}, {userAgent:'OculusBrowser/42',xr:null}])expect(shader(patchedModule,navigator)).toBe(original);
    expect(fragment).not.toContain('stereofoldSphere');
    expect(patched.indexOf(SPHERE_FRUSTUM_GATE)).toBeGreaterThan(patched.indexOf('vRadius *= f;'));
    expect(patched.indexOf(SPHERE_FRUSTUM_GATE)).toBeLessThan(patched.lastIndexOf('quadraticProjection(position,'));
    expect(patched).not.toMatch(/uPrivate|sampler.*[Ff]rustum/);
    expect(patchedModule).not.toContain('__name');
  });
  it('fails closed for version/anchor drift, duplicates/repeat and preserves LF/CRLF',()=>{
    expect(()=>patchMolstarSphereFrustumSource(scaled,'5.11.1')).toThrow('5.11.0');
    for(const anchor of ['export const spheres_vert = `','void main(void){','    vec4 mvPosition = uModelView * transform * position4;'])expect(()=>patchMolstarSphereFrustumSource(scaled.replace(anchor,'changed'),'5.11.0')).toThrow('anchor');
    expect(()=>patchMolstarSphereFrustumSource(scaled+scaled,'5.11.0')).toThrow('anchor');
    expect(()=>patchMolstarSphereFrustumSource(patchedModule,'5.11.0')).toThrow('already');
    const lf=scaled.replaceAll('\r\n','\n');expect(shader(patchMolstarSphereFrustumSource(lf,'5.11.0'),quest)).toBe(patched.replaceAll('\r\n','\n'));
    // Composition works when the diagnostic stock-scale setting is explicit.
    expect(shader(patchMolstarSphereFrustumSource(source,'5.11.0'),{userAgent:'Safari',xr:{}})).toBe(shader(source));
  });
  it('executes the actual projection eligibility expression and fails open for unsupported matrices',()=>{
    const center=[3.46,-19.17,-.706],r=1.2;
    expect(gate(p,center,r)).toBe(true);
    for(const [index,value] of [[1,.01],[4,.01],[2,.01],[6,.01],[3,.01],[7,.01],[11,0],[15,1],[12,.01],[13,.01],[0,0],[5,-1],[14,0],[10,-.9],[8,NaN],[9,Infinity]]){
      const bad=[...p];bad[index!]=value!;expect(gate(bad,center,r)).toBe(false);
    }
    expect(gate(p,center,r,false)).toBe(false);expect(gate(p,center,r,true,1)).toBe(false);expect(gate(p,center,r,true,0,2)).toBe(false);
    for(const bad of [0,-1,NaN,Infinity])expect(gate(p,center,bad)).toBe(false);
    expect(gate(p,[NaN,1,-1],1)).toBe(false);expect(gate(p,[1,Infinity,-1],1)).toBe(false);
    const infiniteFar=[...p];infiniteFar[10]=-1;expect(gate(infiniteFar,center,r)).toBe(true);
    expect(SPHERE_FRUSTUM_GATE).toContain('__VERSION__ >= 300');expect(SPHERE_FRUSTUM_GATE).toContain('!defined(dApproximate)');
  });
  it('preserves camera-inside, visible near-crossing and tangent spheres; rejects only entire side-excluded spheres',()=>{
    for(const c of [[0,0,0],[0,0,.1],[0,0,-.001],[0,0,-.1]])expect(gate(p,c,1)).toBe(false);
    expect(gate(p,[3.46,-19.17,-.706],1.2)).toBe(true);
    const cols=[0,1,2,3].map(i=>p.slice(i*4,i*4+4));const rows=[0,1,3].map(row=>cols.map(c=>c[row]!));
    for(const side of [add(rows[2]!,rows[0]!),sub(rows[2]!,rows[0]!),add(rows[2]!,rows[1]!),sub(rows[2]!,rows[1]!)]){
      const n=Math.hypot(...side.slice(0,3)),r=1,tangent=side.slice(0,3).map(x=>-x*r/n);expect(outsidePlane(side,tangent,r)).toBe(false);
    }
    // All six vertices have the exact same scalar inputs; mapping/VertexID
    // occur nowhere in the predicate. Orthographic and approximate paths skip.
    expect(SPHERE_FRUSTUM_GATE).not.toMatch(/mapping|VertexID/);
  });
  it('proves actual helper support bounds over asymmetric eyes, scales and random directions',()=>{
    let seed=123,checked=0;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
    for(const offset of [-.2,.2]){const projection=[...p];projection[8]=offset;const cols=[0,1,2,3].map(i=>projection.slice(i*4,i*4+4)),rows=[0,1,3].map(row=>cols.map(c=>c[row]!)),ps=[add(rows[2]!,rows[0]!),sub(rows[2]!,rows[0]!),add(rows[2]!,rows[1]!),sub(rows[2]!,rows[1]!)];
      for(const scale of [.34,1,7.83,20,30])for(let i=0;i<200;i++){
        const center=[(random()-.5)*80,(random()-.5)*80,(random()-.5)*80].map(v=>v*scale),radius=(.001+random()*4)*scale;
        for(const side of ps)if(outsidePlane(side,center,radius)){
          const n=Math.hypot(...side.slice(0,3)),worst=center.map((x,j)=>x+radius*side[j]!/n);expect(dot(side,[...worst,1])).toBeLessThan(0);
          for(let sample=0;sample<8;sample++){const v=[random()-.5,random()-.5,random()-.5],norm=Math.hypot(...v),q=center.map((x,k)=>x+radius*v[k]!/norm);expect(dot(side,[...q,1])).toBeLessThan(0);checked++;}
        }
      }
    }expect(checked).toBeGreaterThan(20000);
  });
  it('composes the actual esbuild loader once and preserves scale/fragment/desktop build paths',async()=>{
    const extra=(s:string,name:string,version:string)=>name==='spheres.vert'?patchMolstarSphereFrustumSource(s,version):s;
    for(const scale of ['0','1']){
      const b=await build({stdin:{contents:"export { SpheresShaderCode } from 'molstar/lib/mol-gl/shader-code.js';",resolveDir:root},bundle:true,format:'cjs',platform:'browser',write:false,plugins:impostorScaleBuildPlugins(scale,extra)});
      const c=vm.createContext({module:{exports:{}},exports:{},navigator:quest});vm.runInContext(b.outputFiles[0]!.text,c);
      const result=c.module.exports.SpheresShaderCode;expect(result.vert).toContain('stereofoldSphereOutsideSides');expect(result.frag).not.toContain('stereofoldSphereOutsideSides');expect(result.vert.includes('vRadius = size * uModelScale *')).toBe(scale==='1');
    }
    const buildSource=await readFile(new URL('../scripts/build.ts',import.meta.url),'utf8');
    const desktop=buildSource.slice(buildSource.indexOf('const viewer = await build'),buildSource.indexOf('const bundle = viewer'));
    expect(desktop).not.toContain('sphereImpostorTransform');expect(buildSource).toContain("impostorScaleBuildPlugins(impostorScaleEnabled ? '1' : '0', sphereImpostorTransform)");
  });
});
