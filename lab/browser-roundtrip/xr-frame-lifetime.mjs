/** Own every XR frame handle, including renderer recovery and auxiliary work. */
export function trackXrFrames(session) {
  const request = session.requestAnimationFrame;
  const cancel = session.cancelAnimationFrame;
  const pending = new Set();
  let stopped = false;
  let callbackErrorRecorded = false;
  session.requestAnimationFrame = function (callback) {
    if (stopped) return 0;
    const handle = request.call(this, (time, frame) => {
      pending.delete(handle);
      if (stopped) return;
      try { callback(time, frame); }
      catch (error) {
        if (callbackErrorRecorded) return;
        callbackErrorRecorded = true;
        try { globalThis.__stereofoldDiagnostics?.record?.('xr-frame-error', {
          phase: 'auxiliary', name: error?.name ?? 'Error', error: error?.message ?? String(error),
        }); } catch { /* Diagnostics must not escape the frame boundary either. */ }
      }
    });
    if (handle) pending.add(handle);
    return handle;
  };
  session.cancelAnimationFrame = function (handle) {
    pending.delete(handle);
    return cancel?.call(this, handle);
  };
  function stop() {
    stopped = true;
    for (const handle of pending) {
      try { cancel?.call(session, handle); } catch { /* Native end may precede cancellation. */ }
    }
    pending.clear();
  }
  return {
    stop,
    snapshot: () => ({ pendingFrames: pending.size, sessionHeld: Boolean(session) }),
    restore() {
      stop();
      if (!session) return;
      session.requestAnimationFrame = request;
      session.cancelAnimationFrame = cancel;
      session = undefined;
    },
  };
}
