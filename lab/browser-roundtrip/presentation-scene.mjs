import { Scene } from 'molstar/lib/mol-gl/scene.js';
import { ValueCell } from 'molstar/lib/mol-util/index.js';
import { updateTransformData } from 'molstar/lib/mol-geo/geometry/transform-data.js';
import { calculateTransformBoundingSphere } from 'molstar/lib/mol-gl/renderable/util.js';
import { roomToSceneMatrix, ROOM_LOCK_EPSILON } from './room-lock.mjs';
import { holdHeadRotationZero } from './head-rotation-lock.mjs';
import { createQuestMenuDepthReset } from '../../plugin/src/quest-menu-depth-reset.ts';

const ENTRY_NAME = 'stereofold-presentation';

/**
 * Give one render object the room-lock matrix.
 *
 * Mol* composes an object's placement as `aTransform = matrix · transform`,
 * so writing `matrix` moves the whole object without touching a vertex. The
 * bounding sphere has to follow, because the renderer culls against it before
 * it ever looks at the transform; Mol*'s own `Visual.setTransform` computes
 * that sphere from `transform` rather than `aTransform` and so would cull a
 * moved object out of its own frame. This computes it from `aTransform`.
 *
 * Text is the one geometry that needs more than the matrix. A glyph quad is
 * expanded in view space by `size * uModelScale`, which never passes through
 * `aTransform`, so a room-metre glyph would grow and shrink with the model.
 * Handing it the reciprocal scale as its size factor cancels that exactly, so
 * a caption keeps its physical height at any camera scale.
 */
function setRoomTransform(object, matrix, sizeFactor) {
  const values = object?.values;
  if (!values?.matrix?.ref || !values.aTransform?.ref || !values.invariantBoundingSphere?.ref) return false;
  const current = values.matrix.ref.value;
  for (let index = 0; index < 16; index++) current[index] = matrix[index];
  ValueCell.update(values.matrix, current);
  const grid = values.instanceGrid?.ref.value ?? { cellSize: 0, batchSize: 0 };
  updateTransformData(values, values.invariantBoundingSphere.ref.value, grid.cellSize, grid.batchSize);
  ValueCell.update(values.boundingSphere, calculateTransformBoundingSphere(
    values.invariantBoundingSphere.ref.value, values.aTransform.ref.value, values.instanceCount.ref.value, 0));
  if (object.type === 'text' && values.uSizeFactor) ValueCell.updateIfChanged(values.uSizeFactor, sizeFactor);
  return true;
}

/**
 * A stock Canvas3D debug-registry scene used as a production presentation
 * layer. Canvas3D renders registry scenes after the molecular scene with its
 * opaque depth attached, so a control nearer than the structure draws over it,
 * and does not include them in its primary Scene boundary, camera reset, or
 * XR scaling calculations.
 *
 * A representation added with `roomLocked` is authored in XR room metres and
 * carried into scene units by one matrix, refreshed inside the draw. That is
 * where the refresh has to happen: Canvas3D settles `camera.view` in
 * `controls.update`, hands it to the XR manager to build the offset reference
 * space, and only then draws. `syncVisibility` is called from inside that
 * draw, after the camera is final and before a pixel is written, so the
 * matrix a control is drawn with is always the camera it is drawn against.
 * There is no frame of lag to see.
 */
export function createPresentationScene(canvas) {
  const registry = canvas.debugRegistry;
  if (!registry?.register) throw Error('Pinned Canvas3D debug registry is unavailable.');
  const scene = Scene.create(canvas.webgl, 'blended');
  let disposed = false;
  // Default-off scratch build choice: working foveation can visibly change text
  // and peripheral edges. Never opt in through a live URL or device heuristic.
  const depthReset = typeof __STEREOFOLD_QUEST_MENU_DEPTH_RESET__ !== 'undefined'
    && __STEREOFOLD_QUEST_MENU_DEPTH_RESET__ ? createQuestMenuDepthReset(canvas.webgl) : null;
  // Canvas3D.props derives the camera radius from the full scene boundary.
  // Reading it inside each eye draw repeats that expensive bounds pass after
  // molecular motion. Pinned Canvas3D changes DOF through its public setProps
  // (object patches or functional updaters); it has no props-change observable.
  let depthOfField = canvas.props?.postprocessing?.dof?.name === 'on';
  const originalSetProps = canvas.setProps;
  const observedSetProps = typeof originalSetProps === 'function' ? function(properties, ...args) {
    try { return originalSetProps.call(this, properties, ...args); }
    finally {
      if (!disposed && (typeof properties === 'function' || properties?.postprocessing?.dof !== undefined)) {
        // A setter may throw after applying part of its patch. Observe the
        // resulting setting without replacing the setter's result or error.
        try { depthOfField = canvas.props?.postprocessing?.dof?.name === 'on'; }
        catch { depthOfField = true; } // Never clear depth needed by an unknown DOF state.
      }
    }
  } : undefined;
  if (observedSetProps) canvas.setProps = observedSetProps;
  // Representations that live in the room rather than in the molecule, and
  // the camera the lock was last applied for. A representation added or
  // rebuilt clears the key, so a fresh object is never drawn for one frame
  // with an identity placement.
  const roomLocked = new Set();
  const roomOffsets = new Map();
  let appliedKey;
  // Every glyph on this layer is drawn mirrored once the wearer's head leaves
  // the reference-space identity yaw, unless Mol*'s head-rotation branch is
  // off. `head-rotation-lock.mjs` carries the shader lines and the reasoning.
  // It is held for the life of the layer, which is the life of one immersive
  // session, and released in `dispose`.
  const releaseHeadRotation = holdHeadRotationZero(canvas.camera);
  // The hold declines silently on any camera that is not the plain Mol* one it
  // was written against, and a silently unheld camera is the mirrored menu the
  // owner could not read. Record which way it went, so a headset session says
  // so in its own log instead of only in the pixels.
  globalThis.__stereofoldDiagnostics?.record?.('head-rotation-hold', {
    held: typeof Object.getOwnPropertyDescriptor(canvas.camera ?? {}, 'headRotation')?.get === 'function',
  });

  function sameMatrix(a, b) {
    for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function copyMatrix(into, from) {
    for (let i = 0; i < 16; i++) into[i] = from[i];
    return into;
  }

  function applyRoomLock() {
    if (disposed || !roomLocked.size) return;
    const camera = canvas.camera;
    const cameraScale = camera?.scale;
    if (!Number.isFinite(cameraScale) || Math.abs(cameraScale) <= ROOM_LOCK_EPSILON) return;
    const matrix = roomToSceneMatrix(camera.view, cameraScale);
    if (!matrix) return;
    // This runs on every immersive frame, and head tracking changes the view
    // matrix on almost all of them. Building a string key here allocated a
    // 17-field join per frame per eye for a comparison that 16 float reads
    // answer, which is GC pressure inside the frame the wearer is waiting on.
    if (appliedKey && appliedKey.scale === cameraScale && sameMatrix(appliedKey.matrix, matrix)) return;
    const objects = [];
    for (const representation of roomLocked) {
      const offset = roomOffsets.get(representation);
      let placed = matrix;
      if (offset) {
        placed = copyMatrix(offset.matrix, matrix);
        for (let axis = 0; axis < 3; axis++) placed[12 + axis] +=
          matrix[axis] * offset.value[0] + matrix[4 + axis] * offset.value[1] + matrix[8 + axis] * offset.value[2];
      }
      for (const object of representation.renderObjects ?? []) {
        if (setRoomTransform(object, placed, 1 / cameraScale)) objects.push(object);
      }
    }
    // Value cells only mark the GPU buffers dirty. Nothing re-uploads them
    // until the renderable is updated, and `renderBlended` does not do that.
    if (objects.length) scene.update(objects, true);
    // Copied, not aliased: `roomToSceneMatrix` may hand back a scratch matrix
    // it overwrites on the next frame, which would make every comparison pass.
    if (appliedKey) { appliedKey.scale = cameraScale; copyMatrix(appliedKey.matrix, matrix); }
    else appliedKey = { scale: cameraScale, matrix: copyMatrix(new Float64Array(16), matrix) };
  }

  /**
   * Take the molecular depth off the plates.
   *
   * Canvas3D draws this layer after the molecular scene but attaches the
   * molecular opaque depth to the target first, so `renderBlended` depth-tests
   * the plates against the molecule and every fragment nearer than the glass
   * wins the pixel. On a Quest 2 that put a blue ribbon
   * through the caption card and a grey ghost protofilament across Play, Next
   * and Menu. The stand-off rule keeps the structure behind the plates, but a
   * bounding sphere is a loose fit around a ribbon and the wearer may drag the
   * structure anywhere they like, so geometry alone cannot be the guarantee.
   *
   * Clearing the depth buffer here is the guarantee. This runs inside the draw,
   * after the depth attachment is made and before the first plate pixel is
   * written, so the plates keep depth-testing against EACH OTHER -- the plate
   * slab, its bevels, the hovered row's bias -- while nothing molecular can
   * occlude them. The renderer has already scissored to the eye being drawn, so
   * a stereo frame clears one eye's depth at a time and the other eye is
   * untouched.
   *
   * Depth of field is the one later pass that reads the opaque depth texture.
   * It is off in every headset profile; where it is on, the plates keep the
   * depth test they had rather than the room losing its focus.
   */
  function clearOccludingDepth() {
    if (disposed || scene.count === 0) return false;
    const webgl = canvas.webgl, gl = webgl?.gl;
    if (typeof gl?.clear !== 'function' || typeof webgl?.state?.depthMask !== 'function') return false;
    if (depthOfField) return false;
    try {
      // A masked depth buffer ignores a clear, and the renderer leaves the mask
      // wherever its last pass left it.
      webgl.state.depthMask(true);
      if (!depthReset?.resetDepth()) gl.clear(gl.DEPTH_BUFFER_BIT);
    } catch { return false; }
    if (!depthClearRecorded) {
      depthClearRecorded = true;
      globalThis.__stereofoldDiagnostics?.record?.('presentation', { phase: 'depth-clear', objects: scene.count });
    }
    return true;
  }
  let depthClearRecorded = false;

  const entry = {
    scene,
    get isEnabled() { return !disposed && scene.count > 0; },
    update() { scene.update(undefined, true); scene.commit(); },
    syncVisibility() { applyRoomLock(); clearOccludingDepth(); scene.syncVisibility(); },
    // Canvas3D may forward debug settings to every registry entry. Scientific
    // debug toggles must not hide the user's production controls.
    setProps() {},
    clear() { scene.clear(); },
  };
  registry.register(ENTRY_NAME, entry);

  function requestDraw() { canvas.requestDraw(); }
  return Object.freeze({
    /**
     * @param representation Mol* representation to draw in this layer
     * @param {{roomLocked?: boolean}} [options] `roomLocked` marks geometry
     *   authored in XR room metres; anything else is taken as already being
     *   in scene units and is left where it was put.
     */
    add(representation, { roomLocked: locked = false } = {}) {
      if (disposed) return;
      for (const renderObject of representation.renderObjects) {
        // Opt in room UI text only; ordinary molecular text keeps its shader.
        if (locked && renderObject.type === 'text')
          renderObject.values.dStereofoldUiSdf = ValueCell.create(true);
        scene.add(renderObject);
      }
      if (locked) { roomLocked.add(representation); appliedKey = undefined; }
      scene.commit();
      requestDraw();
    },
    remove(representation) {
      for (const renderObject of representation.renderObjects) scene.remove(renderObject);
      if (roomLocked.delete(representation)) appliedKey = undefined;
      roomOffsets.delete(representation);
      scene.commit();
      requestDraw();
    },
    update(representation) {
      if (disposed) return;
      if (roomLocked.has(representation)) appliedKey = undefined;
      scene.update(representation?.renderObjects, true);
      scene.commit();
      requestDraw();
    },
    /** Move room-authored controls without rebuilding glyphs or molecular geometry. */
    setRoomOffset(representation, value) {
      if (disposed || !roomLocked.has(representation) || value?.length !== 3 || !value.every(Number.isFinite)) return false;
      if (value.every(v => v === 0)) roomOffsets.delete(representation);
      else {
        const offset = roomOffsets.get(representation) ?? { value: [0, 0, 0], matrix: new Float64Array(16) };
        for (let axis = 0; axis < 3; axis++) offset.value[axis] = value[axis];
        roomOffsets.set(representation, offset);
      }
      appliedKey = undefined;
      requestDraw();
      return true;
    },
    /**
     * Show or hide one representation without removing it.
     *
     * A control the wearer is not using should not be drawn over the thing
     * they are: while a structure is held, the menu is glass in front of it.
     * Hiding beats removing, because a rebuild on release would cost a Mol*
     * mesh and text build at the moment the wearer looks back at the panel.
     */
    setVisible(representation, visible) {
      if (disposed || !representation) return;
      for (const renderObject of representation.renderObjects ?? []) renderObject.state.visible = Boolean(visible);
      scene.syncVisibility();
      requestDraw();
    },
    /** Whether this representation is held in the room. Diagnostics only. */
    isRoomLocked(representation) { return roomLocked.has(representation); },
    /**
     * The matrix the layer would draw with right now, or `undefined` when the
     * camera cannot supply one. Diagnostics and tests only; the draw hook
     * computes its own.
     */
    roomMatrix() {
      const camera = canvas.camera;
      return roomToSceneMatrix(camera?.view, camera?.scale);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      depthReset?.dispose();
      if (observedSetProps && canvas.setProps === observedSetProps) canvas.setProps = originalSetProps;
      roomLocked.clear();
      roomOffsets.clear();
      releaseHeadRotation();
      registry.unregister(ENTRY_NAME);
    },
  });
}
