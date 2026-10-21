import { patchXrHiddenShaderCanvas } from './molstar-xr-hidden-shader-patch.js';
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'esbuild';
import { patchMolstarPropsSource } from './molstar-props-patch.js';

/** Upload only the changed objects, invalidate aggregate bounds once. */
export function patchMolstarMotionCanvasSource(source: string): string {
  const anchor = '            update: (repr, keepSphere) => {';
  if (source.split(anchor).length !== 2) throw Error('Mol* canvas update changed; motion batch patch was not applied.');
  const renderAnchor = '        function render(force, xrFrame) {';
  const cameraAnchor = '            const activeAnimation = renderer.props.enableAnimation && scene.hasAnimation;';
  for (const hook of [renderAnchor, cameraAnchor])
    if (source.split(hook).length !== 2) throw Error('Mol* render order changed; annotation hook was not applied.');
  source = source.replace(renderAnchor, `        const beforeRender = new Subject();
${renderAnchor}`)
    .replace(cameraAnchor, `            beforeRender.next(xrChanged ? stereoCamera : camera);
${cameraAnchor}`);
  // Scratch belongs to the canvas, not a frame; registered representations only.
  return source.replace(anchor, `            beforeRender,
            updateRepresentations: (() => {
                const objects = [];
                return (representations, keepSphere) => {
                    objects.length = 0;
                    for (const repr of representations) {
                        const registered = reprRenderObjects.get(repr);
                        if (!registered) continue;
                        for (const object of registered) objects.push(object);
                    }
                    if (!objects.length) return;
                    scene.update(objects, !!keepSphere);
                    forceDrawAfterAllCommited = true;
                };
            })(),
${anchor}`);
}
export const motionCanvasPatch: Plugin = {
  name: 'stereofold-motion-canvas',
  setup(api) {
    api.onLoad({ filter: /mol-canvas3d[/\\]canvas3d\.js$/ }, async ({ path }) => ({
      contents: patchXrHiddenShaderCanvas(patchMolstarPropsSource(patchMolstarMotionCanvasSource(await readFile(path, 'utf8')))), loader: 'js',
    }));
  },
};
