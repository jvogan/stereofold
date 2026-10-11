const VERSION = '5.11.0';

const SCALED_BLOCK = `            const unscaled = modelScale === 1;
            if (unscaled) {
                if (isOccluded !== null && isOccluded(boundingSphere)) {
                    return;
                }
                const hasInstanceGrid = r.values.instanceGrid.ref.value.cellSize > 0;
                const hasMultipleInstances = r.values.uInstanceCount.ref.value > 1;
                if (hasInstanceGrid && (hasMultipleInstances || r.values.lodLevels)) {
                    r.cull(cameraPlane, frustum, isOccluded, ctx.stats);
                }
                else {
                    r.uncull();
                }
            }
            else {
                if (r.values.lodLevels) {
                    const { center, radius } = boundingSphere;
                    const d = Plane3D.distanceToPoint(cameraPlane, center);
                    r.cullSimple(d, radius, modelScale);
                }
                else {
                    r.uncull();
                }
            }`;

const SCALED_BRANCH = `            else {
                if (r.values.lodLevels) {
                    const { center, radius } = boundingSphere;
                    const d = Plane3D.distanceToPoint(cameraPlane, center);
                    r.cullSimple(d, radius, modelScale);
                }
                else {
                    r.uncull();
                }
            }`;

const MODEL_SPACE_BRANCH = `            else {
                // Stereofold: run the instance-grid cull at every camera scale.
                // Cell spheres and LOD distances are in model units, so test them
                // against the frustum and camera plane expressed in model units.
                const hasInstanceGrid = r.values.instanceGrid.ref.value.cellSize > 0;
                const hasMultipleInstances = r.values.uInstanceCount.ref.value > 1;
                if (hasInstanceGrid && (hasMultipleInstances || r.values.lodLevels)) {
                    for (let i = 0; i < 6; ++i) {
                        Plane3D.copy(stereofoldModelFrustum[i], frustum[i]);
                        stereofoldModelFrustum[i].constant /= modelScale;
                    }
                    Plane3D.copy(stereofoldModelPlane, cameraPlane);
                    stereofoldModelPlane.constant /= modelScale;
                    r.cull(stereofoldModelPlane, stereofoldModelFrustum, null, ctx.stats);
                }
                else {
                    r.uncull();
                }
            }`;

const RENDER_OBJECT = '        const renderObject = (r, variant, flag) => {';

/**
 * Run Mol*'s instance-grid cull at every camera scale.
 *
 * Mol* 5.11 runs the cull in `Renderer.renderObject` only while the camera
 * scale is 1. An immersive session always sets another scale (XRManager
 * scales the scene to `sceneRadiusInMeters`), so every instance of a
 * multi-instance object is drawn in both eyes even when most of them lie
 * behind or beside the wearer.
 *
 * The cull mixes two unit systems. Instance-grid cell and batch spheres and
 * LOD distances are in model units; the frustum and camera plane come from
 * the scaled view. A plane n·x + c = 0 in the
 * scaled frame is n·x + c/s = 0 in model units with the same unit normal, so
 * dividing each plane constant by the scale moves the whole test into model
 * units without touching a sphere. Frustum results are unchanged, and plane
 * distances become the model distances the LOD bounds expect.
 *
 * The scale-1 branch is left byte for byte. Away from scale 1 the occlusion
 * test stays off, as in stock Mol*: Canvas3D disables Hi-Z on every XR frame,
 * and its pyramid holds one mono view of a depth texture the direct XR draw
 * path never writes. The sphere-LOD `cullSimple` fallback is replaced by the
 * per-cell LOD the scale-1 path already uses. That fallback returned early for
 * spheres without LOD levels and left the previous pass's cull list in force,
 * so a desktop frame could decide which sphere instances an XR frame drew.
 */
export function patchMolstarXrCullingRendererSource(source: string, version: string): string {
  if (version !== VERSION) throw Error('Mol* XR culling patch requires the reviewed 5.11.0 source.');
  if (source.includes('stereofoldModelFrustum')) throw Error('Mol* XR culling patch was already applied.');
  const nl = source.includes('\r\n') ? '\r\n' : '\n';
  const normalize = (s: string) => s.replaceAll('\n', nl);
  let next = source;
  const replace = (anchor: string, replacement: string) => {
    anchor = normalize(anchor); replacement = normalize(replacement);
    if (next.split(anchor).length !== 2) throw Error('Mol* renderer culling anchor changed; XR culling patch was not applied.');
    next = next.replace(anchor, () => replacement);
  };
  replace(RENDER_OBJECT, `        // Stereofold: the camera frustum and plane in model units, rebuilt per
        // object when the camera scale is not 1.
        const stereofoldModelFrustum = Frustum3D();
        const stereofoldModelPlane = Plane3D();
${RENDER_OBJECT}`);
  replace(SCALED_BLOCK, SCALED_BLOCK.replace(SCALED_BRANCH, MODEL_SPACE_BRANCH));
  return next;
}
