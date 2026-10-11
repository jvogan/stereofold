// Tracking can be temporarily unavailable while Quest changes presentation.
// Keep sampling inside XR callbacks and copy only the pose needed by the menu.
export function nextViewerPose(session, space, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false, frameId;
    const finish = (error, pose) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session.removeEventListener('end', end); } catch { /* A torn-down session may reject cleanup. */ }
      if (frameId !== undefined) {
        try { session.cancelAnimationFrame?.(frameId); } catch { /* The UA may have cancelled it already. */ }
      }
      error ? reject(error) : resolve(pose);
    };
    const request = () => {
      try {
        frameId = session.requestAnimationFrame(sample);
        // The WebXR contract returns 0 when the session is already ended.
        // Do not leave the caller waiting for a delayed end event; XRSession
        // does not expose its internal ended flag as a public IDL attribute.
        if (frameId === 0) finish(Error('The immersive session ended before the toolbar could anchor.'));
      }
      catch { finish(Error('Unable to request an immersive toolbar frame.')); }
    };
    const sample = (_time, frame) => {
      if (settled) return;
      frameId = undefined;
      try {
        const pose = frame.getViewerPose(space);
        if (!pose) { request(); return; }
        const { x, y, z } = pose.transform.position;
        const matrix = Array.from(pose.transform.matrix);
        if (![x, y, z, ...matrix].every(Number.isFinite)) throw Error('The headset provided an invalid local viewer pose.');
        finish(null, { position: { x, y, z }, matrix });
      } catch (error) { finish(error); }
    };
    const end = () => finish(Error('The immersive session ended before the toolbar could anchor.'));
    const timer = setTimeout(() => finish(Error('Timed out waiting for headset tracking to place the menu.')), timeoutMs);
    session.addEventListener('end', end, { once: true });
    request();
  });
}
