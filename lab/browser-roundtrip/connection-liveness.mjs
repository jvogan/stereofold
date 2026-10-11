// Page-owned connection state, read by the existing XR plate and menu.
// Only a successful inspection heartbeat clears it; captions and PTT successes do not.
export const LINK_LOST = 'Link to the Mac lost. Your view is still here.';
export const TALK_LINK_LOST = 'No link · not listening';
export const PAIR_AGAIN = 'Press Re-pair to exit XR; then tap Enter VR.';
let status = { line: '', voiceLost: false, recovery: false };
let frameHandler, recover, unwired = false;
const listeners = new Set();
export function subscribeConnectionStatus(listener) { listeners.add(listener);return () => listeners.delete(listener); }
function publish(next) {
  if (next.line === status.line && next.voiceLost === status.voiceLost && next.recovery === status.recovery) return;
  status = next;
  for (const listener of listeners) { try { listener(status); } catch { /* A view can be tearing down. */ } }
}
export function connectionStatus() { return status; }
export function setConnectionStatus(line = '', recovery = false) {
  publish({ line, recovery, voiceLost: Boolean(line) && status.voiceLost });
}
export function markTalkLinkLost() {
  publish({ ...status, line: status.line || LINK_LOST, voiceLost: true });
}
export function setConnectionRecovery(handler) { recover = handler; }
export function requestConnectionRecovery() { return recover?.(); }
export function setConnectionFrameHandler(handler) { frameHandler = handler;unwired = false; }
/**
 * Called inside the existing XR frame callback, before pose-dependent work.
 *
 * A frame that finds no handler is the silent failure an earlier run met:
 * window timers are frozen inside an immersive session, so this callback is
 * the only thing that retires a stalled request, and with nothing wired to it
 * a suspended Mac is indistinguishable from a working one. The ring gets one
 * entry for that state, not one per frame -- a wearer holds seventy-two of
 * these a second.
 */
export function connectionFrame() {
  if (frameHandler) { frameHandler();return; }
  if (unwired) return;
  unwired = true;
  try { globalThis.__stereofoldDiagnostics?.record?.('connection', { phase: 'unwired' }); } catch { /* The ring is optional. */ }
}

/** No second XR loop, window timer, scene mutations, or overlapping poll owner. */
export function createConnectionWatchdog({ poll, onMissed, deadlines = () => {},
  active = () => true, now = () => Date.now(), intervalMs = 1000, missedMs = 15_000,
  record = (kind, detail) => { try { globalThis.__stereofoldDiagnostics?.record?.(kind, detail); } catch { /* The ring is optional. */ } } }) {
  let lastSuccess = now(), nextPoll = 0, reported = false, closed = false;
  return {
    succeeded() {
      // One edge each way, never a cycle: an earlier defect was a Talk row that
      // flapped because a fixed timer, not a state change, wrote it.
      if (reported) record('connection', { phase: 'recovered', missedMs: now() - lastSuccess });
      lastSuccess = now(); nextPoll = lastSuccess + intervalMs; reported = false;
    },
    frame() {
      if (closed) return;
      deadlines();
      if (!active()) { lastSuccess = now(); return; }
      const at = now();
      if (!reported && at - lastSuccess >= missedMs) {
        reported = true;
        // The only record that a wearer's link went quiet. Without it a device
        // run cannot tell a watchdog that never fired from one that fired and
        // was ignored, which is the question an earlier run could not answer.
        record('connection', { phase: 'missed', sinceMs: at - lastSuccess });
        onMissed();
      }
      if (at < nextPoll) return;
      nextPoll = at + intervalMs;
      void poll();
    },
    dispose() { closed = true; },
  };
}
