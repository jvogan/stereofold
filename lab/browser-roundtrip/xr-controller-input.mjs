// Sample inside an active XR callback. Mol* drops the controller altogether
// when its target pose is absent, including the buttons needed to recover.
// This snapshot keeps gamepad controls independent from spatial tracking.
export function createXrControllerInput({ transformPose = pose => pose, record = () => {} } = {}) {
  let lastTime, lastFrame;
  const qualities = new Map();
  return {
    read(frame, space, session) {
      if (!frame || !space || !session) return undefined;
      const time = frame.predictedDisplayTime;
      if (Number.isFinite(time) ? time === lastTime : frame === lastFrame) return undefined;
      lastTime = time; lastFrame = frame;
      const pointers = [];
      for (const source of session.inputSources ?? []) {
        if (source.targetRayMode !== 'tracked-pointer' || !['left', 'right'].includes(source.handedness)) continue;
        let pose, gripPose;
        try { pose = frame.getPose(source.targetRaySpace, space); } catch { /* No usable aim. */ }
        if (source.gripSpace) try { gripPose = frame.getPose(source.gripSpace, space); } catch { /* Optional. */ }
        const readPose = value => {
          const matrix = value?.transform?.matrix, origin = value?.transform?.position;
          if (!matrix || matrix.length < 16 || !origin) return undefined;
          const matrixValues = Array.from(matrix);
          const poseValue = {
            origin: [origin.x, origin.y, origin.z],
            direction: [-matrix[8], -matrix[9], -matrix[10]],
            orientation: value?.transform?.orientation
              ? [value.transform.orientation.x, value.transform.orientation.y, value.transform.orientation.z, value.transform.orientation.w]
              : undefined,
            matrix: matrixValues,
            emulatedPosition: typeof value.emulatedPosition === 'boolean' ? value.emulatedPosition : undefined,
          };
          if (!matrixValues.every(Number.isFinite) || ![...poseValue.origin, ...poseValue.direction].every(Number.isFinite)
              || Math.hypot(...poseValue.direction) <= 1e-9) return undefined;
          const transformed = transformPose(poseValue);
          return transformed?.origin?.length >= 3 && transformed?.direction?.length >= 3
            && [...transformed.origin, ...transformed.direction].every(Number.isFinite)
            ? transformed : undefined;
        };
        const ray = readPose(pose);
        const hasGripSpace = Boolean(source.gripSpace);
        // When a grip space exists but has lost tracking, keep that pose
        // unavailable. Falling back to the target ray would make wrist turns
        // look like hand travel. Sources with no grip space use the target ray
        // as their documented compatibility fallback in the gesture reader.
        const grip = hasGripSpace ? readPose(gripPose) : undefined;
        const gripEmulatedPosition = typeof gripPose?.emulatedPosition === 'boolean' ? gripPose.emulatedPosition : undefined;
        // undefined is unknown, never evidence of measured position.
        const emulatedPosition = typeof pose?.emulatedPosition === 'boolean' ? pose.emulatedPosition : undefined;
        const tracking = !ray ? 'unavailable' : emulatedPosition === true ? 'emulated-position' : emulatedPosition === false ? 'tracked-position' : 'unknown';
        const gripTracking = !hasGripSpace ? tracking : !grip ? 'unavailable'
          : gripEmulatedPosition === true ? 'emulated-position' : gripEmulatedPosition === false ? 'tracked-position' : 'unknown';
        const gamepad = source.gamepad;
        let buttons = 0;
        for (const [index, bit] of [[0, 1], [1, 2], [3, 4], [4, 8], [5, 16]]) if (gamepad?.buttons?.[index]?.pressed) buttons |= bit;
        const pointer = { handedness: source.handedness, source, buttons, axes: Array.from(gamepad?.axes ?? []), ray,
          hasGripSpace, gripPose: grip && { ...grip, emulatedPosition: gripEmulatedPosition },
          emulatedPosition, tracking, gripTracking, poseQualitySource: 'webxr',
          gripEmulatedPosition };
        pointers.push(pointer);
        const qualitySignature = `${tracking}/${gripTracking}`;
        if (qualities.get(source) !== qualitySignature) {
          qualities.set(source, qualitySignature);
          record('xr-tracking', { hand: source.handedness, tracking, gripTracking, gripPose: Boolean(grip), gamepad: Boolean(gamepad) });
        }
      }
      for (const source of qualities.keys()) if (!pointers.some(pointer => pointer.source === source)) qualities.delete(source);
      return pointers;
    },
    reset() { lastTime = lastFrame = undefined; qualities.clear(); },
  };
}
