import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'esbuild';

const VERSION = '5.11.0';
const DISPATCH = "    if (props.floodfill === 'off' && props.tryUseGpu && webgl && gpuSupport(webgl) && suitableForGpu(volume, webgl)) {";
const CPU = '            return props.tryUseGpu && !!webgl && suitableForGpu(volumekey.volume, webgl);';
const GPU = "            return props.floodfill !== 'off' || !props.tryUseGpu || !webgl || !suitableForGpu(volumeKey.volume, webgl);";
const HELPER = `function stereofoldIsosurfaceUseGpu(volume, props, webgl) {
    return !!(props.floodfill === 'off' && props.tryUseGpu && webgl && gpuSupport(webgl) && suitableForGpu(volume, webgl));
}
`;

/** Backport Mol* 526c5cc / 9078a3a (included in 5.12): initial selection and
 * recreation must use the same GPU eligibility. Otherwise an unsupported GPU
 * repeatedly destroys a perfectly usable CPU mesh on unchanged style updates.
 * Only selection changes; contour, scalar data and both geometry builders stay
 * byte-for-byte unchanged. https://github.com/molstar/molstar/commit/9078a3a1c68a6b439e8dbb74ad59612b1a59b765
 */
export function patchMolstarIsosurfaceGpuChoiceSource(source: string, version: string): string {
  if (version !== VERSION) throw Error('Mol* isosurface GPU choice patch requires the reviewed 5.11.0 source.');
  if (source.includes('stereofoldIsosurfaceUseGpu')) throw Error('Mol* isosurface GPU choice patch was already applied.');
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const normalize = (text: string) => text.replaceAll('\n', nl);
  let next = source;
  const unique = (anchor: string) => {
    if (next.split(normalize(anchor)).length !== 2) throw Error('Mol* isosurface GPU choice anchor changed; patch was not applied.');
  };
  const replace = (anchor: string, replacement: string) => {
    unique(anchor);
    next = next.replace(normalize(anchor), normalize(replacement));
  };
  unique('function gpuSupport(webgl) {\n    return webgl.extensions.colorBufferFloat && webgl.extensions.textureFloat && webgl.extensions.drawBuffers;\n}');
  const factory = `${source.includes('export function IsosurfaceVisual(') ? 'export ' : ''}function IsosurfaceVisual(materialId, volume, key, props, webgl) {`;
  replace(factory, HELPER + factory);
  replace(DISPATCH, '    if (stereofoldIsosurfaceUseGpu(volume, props, webgl)) {');
  replace(CPU, '            return stereofoldIsosurfaceUseGpu(volumekey.volume, props, webgl);');
  replace(GPU, '            return !stereofoldIsosurfaceUseGpu(volumeKey.volume, props, webgl);');
  return next;
}

/** Supports both installed module layouts without modifying node_modules. */
export function isosurfaceGpuChoicePatch(): Plugin {
  return {
    name: 'stereofold-molstar-isosurface-gpu-choice',
    setup(api) {
      api.onLoad({ filter: /molstar[/\\]lib[/\\](?:commonjs[/\\])?mol-repr[/\\]volume[/\\]isosurface\.js$/ }, async ({ path }) => {
        const commonjs = /[/\\]lib[/\\]commonjs[/\\]/.test(path);
        const { version } = JSON.parse(await readFile(resolve(dirname(path), commonjs ? '../../../../package.json' : '../../../package.json'), 'utf8'));
        return { contents: patchMolstarIsosurfaceGpuChoiceSource(await readFile(path, 'utf8'), version), loader: 'js' };
      });
    },
  };
}
