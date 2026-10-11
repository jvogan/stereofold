import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RENDER_CANDIDATES, readRenderSettings, renderSettingsManifest, resolveRenderOutputPath, validateRenderOutput } from '../scripts/render-candidate-settings.js';

const made: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stereofold-render-guard-'));
  made.push(root);
  const served = join(root, 'plugin', 'dist');
  await mkdir(served, { recursive: true });
  await writeFile(join(served, 'viewer.html'), 'served sentinel');
  return { root, served };
}
afterEach(async () => { for (const root of made.splice(0)) await rm(root, { recursive: true, force: true }); });
const defaults = readRenderSettings({});
const controls = [
  ['STEREOFOLD_OPAQUE_DEPTH_PATCH', 'opaqueDepthEnabled'],
  ['STEREOFOLD_ZERO_LIGHT_PATCH', 'zeroLightEnabled'],
  ['STEREOFOLD_MATTE_LIGHT_PATCH', 'matteLightEnabled'],
  ['STEREOFOLD_IMPOSTOR_SCALE_PATCH', 'impostorScaleEnabled'],
  ['STEREOFOLD_XR_SINGLE_PASS', 'xrSinglePassEnabled'],
  ['STEREOFOLD_SPHERE_OCCLUSION', 'sphereOcclusionEnabled'],
  ['STEREOFOLD_XR_SKIP_FINAL_FLUSH', 'xrSkipFinalFlushEnabled'],
] as const;
const diagnostic = readRenderSettings({ STEREOFOLD_OPAQUE_DEPTH_PATCH: '0' });
const validate = (distRoot: string, servedDistRoot: string, settings = diagnostic) => validateRenderOutput({distRoot, servedDistRoot, settings});

describe('render settings', () => {
  it('enables the shipping patches by default', () => {
    expect(defaults).toEqual({opaqueDepthEnabled:true, zeroLightEnabled:true, matteLightEnabled:true, impostorScaleEnabled:true, xrCulling:false,
      xrSinglePassEnabled:true, conservativeDepthEnabled:false, sphereNormalsEnabled:false, depthPrepassEnabled:false, questMenuDepthResetEnabled:false, xrSkipFinalFlushEnabled:true, sphereOcclusionEnabled:true, impostorSplit:null});
    expect(renderSettingsManifest(defaults)).toEqual({version:1,diagnosticOnly:false,...defaults});
  });
  it.each(controls)('strictly validates %s', (flag) => {
    for (const value of ['', 'true', '2', ' 1', 'false']) expect(() => readRenderSettings({[flag]:value})).toThrow(`${flag} must be 0 or 1.`);
  });
  it.each(controls)('records the %s stock-shader control', (flag, field) => {
    const settings=readRenderSettings({[flag]:'0'});
    const disabledComposition = ['opaqueDepthEnabled','impostorScaleEnabled','xrSinglePassEnabled'].includes(field);
    expect(settings).toEqual({...defaults,[field]:false,...(disabledComposition?{sphereOcclusionEnabled:false}:{})});
    expect(renderSettingsManifest(settings)).toEqual({version:1,diagnosticOnly:true,...settings});
    expect(readRenderSettings({[flag]:'1'})).toEqual(defaults);
  });
  it('allows all stock-shader controls together', () => {
    expect(renderSettingsManifest(readRenderSettings(Object.fromEntries(controls.map(([flag])=>[flag,'0'])))))
      .toEqual({version:1,diagnosticOnly:true,...defaults,opaqueDepthEnabled:false,zeroLightEnabled:false,matteLightEnabled:false,impostorScaleEnabled:false,xrSinglePassEnabled:false,xrCulling:false,sphereOcclusionEnabled:false,xrSkipFinalFlushEnabled:false});
  });
  it('disables sphere occlusion for stock composition controls and rejects an explicitly incompatible candidate', () => {
    for (const flag of ['STEREOFOLD_OPAQUE_DEPTH_PATCH','STEREOFOLD_IMPOSTOR_SCALE_PATCH','STEREOFOLD_XR_SINGLE_PASS']) {
      expect(readRenderSettings({[flag]:'0'}).sphereOcclusionEnabled).toBe(false);
      expect(() => readRenderSettings({[flag]:'0',STEREOFOLD_SPHERE_OCCLUSION:'1'})).toThrow(/Sphere occlusion requires/);
    }
  });
  it('records the opt-in XR culling candidate and requires the opaque-depth composition', () => {
    for (const value of ['', 'true', '2']) expect(() => readRenderSettings({STEREOFOLD_XR_CULLING_PATCH:value})).toThrow('STEREOFOLD_XR_CULLING_PATCH must be 0 or 1.');
    expect(readRenderSettings({STEREOFOLD_XR_CULLING_PATCH:'0'})).toEqual(defaults);
    const xr = readRenderSettings({STEREOFOLD_XR_CULLING_PATCH:'1'});
    expect(xr).toEqual({...defaults, xrCulling:true});
    expect(renderSettingsManifest(xr)).toEqual({version:1,diagnosticOnly:true,...xr});
    expect(() => readRenderSettings({STEREOFOLD_XR_CULLING_PATCH:'1', STEREOFOLD_OPAQUE_DEPTH_PATCH:'0'})).toThrow(/requires.*opaque-depth/);
  });
  it.each(RENDER_CANDIDATES)('reads the %s render candidate as an opt-in scratch setting', (flag, field) => {
    for (const value of ['', 'true', '2', ' 1']) expect(() => readRenderSettings({[flag]:value})).toThrow(`${flag} must be 0 or 1.`);
    expect(readRenderSettings({[flag]:'0'})).toEqual(defaults);
    const settings = readRenderSettings({[flag]:'1'});
    expect(settings).toEqual({...defaults,[field]:true});
    expect(renderSettingsManifest(settings)).toEqual({version:1,diagnosticOnly:true,...settings});
  });
  it('reads the measurement-only impostor split by name', () => {
    for (const split of ['discard', 'depth', 'neither'] as const) {
      const settings = readRenderSettings({STEREOFOLD_IMPOSTOR_SPLIT:split});
      expect(settings).toEqual({...defaults, impostorSplit:split});
      expect(renderSettingsManifest(settings).diagnosticOnly).toBe(true);
    }
    expect(readRenderSettings({STEREOFOLD_IMPOSTOR_SPLIT:'off'})).toEqual(defaults);
    expect(() => readRenderSettings({STEREOFOLD_IMPOSTOR_SPLIT:'1'})).toThrow(/must be discard, depth, neither or off/);
  });
  it('keeps the depth pre-pass tied to the opaque-depth variants it extends', () => {
    expect(() => readRenderSettings({STEREOFOLD_DEPTH_PREPASS:'1', STEREOFOLD_OPAQUE_DEPTH_PATCH:'0'})).toThrow(/keep STEREOFOLD_OPAQUE_DEPTH_PATCH on/);
  });
});

describe('render output safety', () => {
  it('allows default served output and permits diagnostic scratch siblings', async () => {
    const {root, served} = await fixture();
    expect((await validate(served, served, defaults)).scratchDist).toBe(false);
    await expect(validate(served, served)).rejects.toThrow(/requires a scratch output/);
    const scratch = join(root,'scratch','new','dist');
    const result = await validate(scratch, served);
    expect(result.scratchDist).toBe(true);
    expect(result.resolvedDistRoot.endsWith('/scratch/new/dist')).toBe(true);
    await expect(lstat(scratch)).rejects.toMatchObject({code:'ENOENT'});
    expect(await readFile(join(served,'viewer.html'),'utf8')).toBe('served sentinel');
  });
  it.each(controls)('refuses %s=0 in served output and permits it in scratch output', async (flag) => {
    const {root,served}=await fixture();
    const settings=readRenderSettings({[flag]:'0'});
    await expect(validate(served,served,settings)).rejects.toThrow(`${flag}=0 requires a scratch output directory`);
    expect((await validate(join(root,'scratch'),served,settings)).scratchDist).toBe(true);
    expect(await readFile(join(served,'viewer.html'),'utf8')).toBe('served sentinel');
  });
  it('refuses the XR culling candidate in served output and permits it in scratch output', async () => {
    const {root,served}=await fixture();
    const settings=readRenderSettings({STEREOFOLD_XR_CULLING_PATCH:'1'});
    await expect(validate(served,served,settings)).rejects.toThrow('STEREOFOLD_XR_CULLING_PATCH=1 requires a scratch output directory');
    expect((await validate(join(root,'scratch'),served,settings)).scratchDist).toBe(true);
  });
  it.each(RENDER_CANDIDATES)('refuses %s=1 in served output and permits it in scratch output', async (flag) => {
    const {root,served}=await fixture();
    const settings=readRenderSettings({[flag]:'1'});
    await expect(validate(served,served,settings)).rejects.toThrow(`${flag}=1 requires a scratch output directory`);
    expect((await validate(join(root,'scratch'),served,settings)).scratchDist).toBe(true);
    expect(await readFile(join(served,'viewer.html'),'utf8')).toBe('served sentinel');
  });
  it('refuses an impostor split in served output', async () => {
    const {served}=await fixture();
    await expect(validate(served,served,readRenderSettings({STEREOFOLD_IMPOSTOR_SPLIT:'depth'}))).rejects.toThrow(/IMPOSTOR_SPLIT requires a scratch output/);
  });
  it('rejects existing and absent served descendants even with flags disabled', async () => {
    const {served} = await fixture();
    await mkdir(join(served,'existing'));
    for(const settings of [defaults,diagnostic])for(const path of [join(served,'existing'),join(served,'new','diagnostic')])
      await expect(validate(path,served,settings)).rejects.toThrow(/inside the served/);
  });
  it('resolves existing symlink ancestors before checking nonexistent output tails', async () => {
    const {root,served} = await fixture();
    const alias = join(root,'alias'); await symlink(served,alias,'dir');
    await expect(validate(alias,served)).rejects.toThrow(/alias of the served/);
    await expect(validate(join(alias,'not-created','diagnostic'),served)).rejects.toThrow(/inside the served/);
    await expect(validate(alias,served,defaults)).rejects.toThrow(/alias of the served/);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(served,'viewer.html'),'utf8')).toBe('served sentinel');
    await expect(lstat(join(served,'not-created'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('protects a symlinked served root and refuses lexical descendants escaping via symlink', async () => {
    const {root,served} = await fixture();
    const servedAlias=join(root,'served-alias'); await symlink(served,servedAlias,'dir');
    await expect(validate(join(served,'diagnostic'),servedAlias)).rejects.toThrow(/inside the served/);
    const outside=join(root,'outside'); await mkdir(outside);
    const escape=join(served,'escape'); await symlink(outside,escape,'dir');
    await expect(validate(join(escape,'diagnostic'),served)).rejects.toThrow(/inside the served/);
  });
  it('rejects scratch ancestors of served dist but does not confuse similarly prefixed siblings', async () => {
    const {root,served} = await fixture();
    await expect(validate(root,served)).rejects.toThrow(/contains the served/);
    expect((await validate(`${served}-diagnostic`,served)).scratchDist).toBe(true);
    expect((await validate(join(root,'plugin','other'),served)).scratchDist).toBe(true);
  });
  it('fails closed for dangling symlinks and relative paths', async () => {
    const {root,served} = await fixture();
    const dangling=join(root,'dangling');await symlink(join(root,'missing'),dangling,'dir');
    await expect(validate(join(dangling,'diagnostic'),served)).rejects.toMatchObject({code:'ENOENT'});
    await expect(resolveRenderOutputPath('relative')).rejects.toThrow(/absolute/);
  });
});
