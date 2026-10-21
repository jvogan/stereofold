// Frozen per-plate pass for counting-GL comparisons with the grouped pass.
export const labelPassBaseline = `
        const renderLessonLabels = (group, camera) => {
            const renderables = group.renderables;
            let ready = false;
            try {
                for (let i = 0; i < renderables.length; ++i) {
                    const r = renderables[i];
                    if (!r.state.stereofoldLessonLabel || !r.state.visible || r.state.disposed
                        || r.values.alpha.ref.value * r.state.alphaFactor <= 0) continue;
                    if (!ready) {
                        updateLessonLabelInternal(group, camera, null, Mask.All, false);
                        state.enable(gl.BLEND);
                        state.enable(gl.DEPTH_TEST);
                        state.depthMask(false);
                        if (transparentBackground) state.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                        else state.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                        ready = true;
                    }
                    // Program/material caches must not carry over from a
                    // different variant of the same text material.
                    state.currentMaterialId = -1;
                    state.currentRenderItemId = -1;
                    state.depthFunc(gl.GREATER);
                    renderObject(r, 'colorLabelOccluded', Flag.None);
                    state.currentMaterialId = -1;
                    state.currentRenderItemId = -1;
                    state.depthFunc(gl.LEQUAL);
                    renderObject(r, 'colorLabelExposed', Flag.None);
                }
            } finally {
                if (ready) {
                    state.depthFunc(gl.LEQUAL);
                    state.currentMaterialId = -1;
                    state.currentRenderItemId = -1;
                }
            }
        };
`;
