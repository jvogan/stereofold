/** A hidden replacement must not suspend head-tracked rendering of the retained
 * scene. Only programs exclusively owned by hidden scene objects are exempt;
 * unknown/pass programs and programs shared by any visible helper stay gated. */
export function hiddenSceneProgramIds(scene: any, helper: any, variants: string[]): Set<number> {
  const hidden = new Set<number>();
  for (const renderable of scene.renderables) {
    if (renderable.state.visible || renderable.state.disposed) continue;
    for (const variant of variants) {
      const program = renderable.getProgram(variant);
      if (program) hidden.add(program.id);
    }
  }
  const scenes = [scene, helper.camera?.scene, helper.handle?.scene, helper.pointer?.scene,
    ...(helper.debug?.scenes ?? [])];
  for (const candidate of scenes) for (const renderable of candidate?.renderables ?? []) {
    // Helpers may update visibility during the draw (debug sync/pointer camera).
    if (renderable.state.disposed || (candidate === scene && !renderable.state.visible)) continue;
    for (const variant of variants) {
      const program = renderable.getProgram(variant);
      if (program) hidden.delete(program.id);
    }
  }
  return hidden;
}

function replaceOnce(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw Error('Mol* hidden-shader frame gate changed; patch was not applied.');
  return source.replace(anchor, replacement);
}

export function patchXrHiddenShaderCanvas(source: string): string {
  return replaceOnce(source,
    '                forceNextRender = true;\n                return;\n            }\n            if (render(!!(options',
    `                forceNextRender = true;
                // Continue fresh stereo frames while only hidden staged programs compile.
                // Finalization above still advances those programs on every frame.
                if (!(options && options.xrFrame) || !webgl.resources.programsReadyExcept(shaderManager.required,
                    (${hiddenSceneProgramIds.toString()})(scene, helper, shaderManager.required))) return;
            }
            if (render(!!(options`);
}

export function patchXrHiddenShaderResources(source: string): string {
  return replaceOnce(source, '        finalizePrograms: (variants, isSynchronous) => {',
    `        programsReadyExcept: (variants, ignoredIds) => {
            for (const program of pendingPrograms) {
                if ((!variants || variants.includes(program.variant)) && !program.isReady()
                    && !ignoredIds.has(program.id)) return false;
            }
            return true;
        },
        finalizePrograms: (variants, isSynchronous) => {`);
}
