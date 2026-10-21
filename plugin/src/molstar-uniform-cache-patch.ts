import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

/** Each linked program owns its locations and their last uploaded values.
 * Wrap all setters, including uniform() and sampler bindings. Re-finalization
 * after context restoration installs fresh closures with empty caches.
 */
export function patchMolstarUniformCacheSource(source: string): string {
  const anchor = '        uniformSetters = getUniformSetters(schema);';
  if (source.split(anchor).length !== 2) throw Error('Mol* uniform cache anchor changed; patch was not applied.');
  return source.replace(anchor, `${anchor}
        for (const k of Object.keys(uniformSetters)) {
            // Keep eye/camera uploads explicit, including identical eye values.
            if (/View|Projection|Camera|HeadRotation/.test(k) || k === 'uIsOrtho') continue;
            const upload = uniformSetters[k];
            let initialized = false, lastLocation, scalar, saved;
            uniformSetters[k] = (gl, location, value) => {
                const array = value != null && typeof value !== 'number' && typeof value !== 'boolean';
                if (array) {
                    const length = value.length;
                    let equal = initialized && lastLocation === location && saved !== undefined && saved.length === length;
                    if (equal) for (let i = 0; i < length; i++) {
                        if (!Object.is(saved[i], value[i])) { equal = false; break; }
                    }
                    if (equal) return;
                    upload(gl, location, value);
                    if (saved === undefined || saved.length !== length) saved = new Array(length);
                    for (let i = 0; i < length; i++) saved[i] = value[i];
                } else {
                    if (initialized && lastLocation === location && saved === undefined && Object.is(scalar, value)) return;
                    upload(gl, location, value);
                    saved = undefined;
                    scalar = value;
                }
                initialized = true;
                lastLocation = location;
            };
        }`);
}

export function uniformCacheBuildPlugins(enabled: boolean): Plugin[] {
  return enabled ? [{
    name: 'stereofold-program-uniform-cache',
    setup(api) {
      api.onLoad({ filter: /mol-gl[/\\]webgl[/\\]program\.js$/ }, async ({ path }) => ({
        contents: patchMolstarUniformCacheSource(await readFile(path, 'utf8')), loader: 'js',
      }));
    },
  }] : [];
}
