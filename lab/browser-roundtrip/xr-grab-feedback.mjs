/** Admission failures are not all pending work. Keep terminal failures honest
 * and speak each outcome once until a molecular grab actually succeeds. */
export function createXrGrabFeedback({ readState, speak, record = () => {} }) {
  const announced = new Set();
  return {
    admitted() { announced.clear(); },
    refuse() {
      const state = readState();
      const status = state.contextLost ? 'context_lost' : state.status;
      const error = typeof state.error === 'string'
        ? state.error.replace(/(?:https?|wss?):\/\/[^\s)]+/gu, '<runtime>').slice(0, 500) : undefined;
      const key = JSON.stringify([status, error]);
      if (announced.has(key)) return false;
      announced.add(key);
      const text = status === 'error'
        ? 'The molecular view failed. Ask your connected agent to recover it.'
        : status === 'context_lost' || status === 'recovering'
          ? 'The molecular view lost graphics. Wait for recovery.'
          : status === 'updating'
            ? 'The molecular view is updating. Try again when it finishes.'
          : status === 'loading'
            ? 'The molecule is loading. Try again when it appears.'
            : 'The molecular view is not ready. Ask your connected agent to check it.';
      record('xr-grab-feedback', { status, ...(error ? { error } : {}), text });
      // Feedback must not break controller input if speech is unavailable.
      try { Promise.resolve(speak(text)).catch(() => {}); } catch { /* Accessory outcome. */ }
      return true;
    },
  };
}
