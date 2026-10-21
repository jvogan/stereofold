import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';

export interface CanvasSnapshotSettings {
  trackballAnimation: string;
  staticMoving: boolean;
  desktopStereo: string;
  stereo: { eyeSeparation: number; focus: number } | undefined;
  antialiasing: string;
  multiSample: string;
  clipping: number;
}

/** Settings reads must not evaluate scene bounds just to copy unrelated props. */
export function patchMolstarPropsSource(source: string): string {
  const calculation = `            const radius = scene.boundingSphere.radius > 0
                ? 100 - Math.round((camera.transition.target.radius / getSceneRadius()) * 100)
                : 0;`;
  const field = `                cameraClipping: {
                    far: camera.state.clipFar,
                    radius,
                    minNear: camera.state.minNear,
                },`;
  const publicProps = `            get props() {
                return getProps();
            },`;
  for (const anchor of [calculation, field, publicProps]) {
    if (source.split(anchor).length !== 2) throw Error('Mol* props anchor changed; settings accessor patch was not applied.');
  }
  // Preserve stock eager clipping in public props: retained snapshots and
  // setProps must use the bounds and radius factor from the time of the read.
  return source.replace(publicProps, `            getSnapshotSettings(includeClipping) {
                const trackball = controls.props;
                const stereo = p.camera.stereo;
                return {
                    trackballAnimation: trackball.animate.name,
                    staticMoving: trackball.staticMoving,
                    desktopStereo: stereo.name,
                    stereo: stereo.name === 'on'
                        ? { eyeSeparation: stereo.params.eyeSeparation, focus: stereo.params.focus } : undefined,
                    antialiasing: p.postprocessing.antialiasing.name,
                    multiSample: p.multiSample.mode,
                    clipping: !includeClipping || camera.forceFull ? 0 : getProps().cameraClipping.radius,
                };
            },
${publicProps}`);
}

export const propsBuildPatch: Plugin = {
  name: 'stereofold-canvas-snapshot-settings',
  setup(api) {
    api.onLoad({ filter: /mol-canvas3d[/\\]canvas3d\.js$/ }, async ({ path }) => ({
      contents: patchMolstarPropsSource(await readFile(path, 'utf8')), loader: 'js',
    }));
  },
};
