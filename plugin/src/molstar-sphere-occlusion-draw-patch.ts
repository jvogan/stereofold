/** Compose after the reviewed opaque and Quest single-pass DrawPass patches.
 * The proxy completes for both eyes before the first XR clear or colour draw.
 */
export function patchSphereOcclusionDrawSource(source: string, runtimeModule: string): string {
  const replace = (anchor: string, replacement: string) => {
    if (source.split(anchor).length !== 2) throw Error('Mol* sphere occlusion DrawPass anchor changed.');
    source = source.replace(anchor, replacement);
  };
  replace("import { BloomPass } from './bloom.js';", `import { BloomPass } from './bloom.js';
import { createSphereOcclusionPass } from ${JSON.stringify(runtimeModule)};`);
  replace('    reset() {\n', '    reset() {\n        this.stereofoldSphereOcclusion?.reset();\n        this.stereofoldSphereDestination = null;\n');
  replace('        const { renderer, camera, scene, helper } = ctx;', `        const { renderer, camera, scene, helper } = ctx;
        this.stereofoldSphereCullDepth = null;
        if (!StereoCamera.is(camera)) this.stereofoldSphereOcclusion?.deactivate();`);
  replace('            if (stereofoldSinglePass) {\n                const l = camera.left.viewport, r = camera.right.viewport;', `            if (stereofoldSinglePass) {
                this.stereofoldSphereOcclusion ??= createSphereOcclusionPass(this.webgl);
                const layer = this.webgl.xr.session.renderState.baseLayer;
                let destination = this.stereofoldSphereDestination;
                if (!destination || destination.layer !== layer || destination.width !== layer.framebufferWidth || destination.height !== layer.framebufferHeight) {
                    // One metadata query per native target, before any draw/clear.
                    // Binding alone submits no XR pixels before the proxy pass.
                    this.drawTarget.bind();
                    const gl = this.webgl.gl;
                    destination = this.stereofoldSphereDestination = { layer, width: layer.framebufferWidth, height: layer.framebufferHeight,
                        depthBits: gl.getParameter(gl.DEPTH_BITS), samples: gl.getParameter(gl.SAMPLES),
                        framebufferMatches: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === layer.framebuffer };
                }
                this.stereofoldSphereCullDepth = this.stereofoldSphereOcclusion.prepare(ctx, layer, destination);
                const l = camera.left.viewport, r = camera.right.viewport;`);
  replace('                this.stereofoldSinglePassEye = 1;\n            }\n            try {', `                this.stereofoldSinglePassEye = 1;
            } else {
                this.stereofoldSphereOcclusion?.deactivate();
            }
            try {`);
  replace('                this.stereofoldSinglePassEye = 0;\n', '                this.stereofoldSinglePassEye = 0;\n                this.stereofoldSphereCullDepth = null;\n');
  replace('            renderer.renderOpaque(scene.primitives, camera, true);',
    '            renderer.renderOpaque(scene.primitives, camera, true, this.stereofoldSphereCullDepth);');
  return source;
}
