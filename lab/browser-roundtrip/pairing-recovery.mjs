/** Embedded in the LAN pairing page; self-contained so the served copy is tested. */
export function pairingRecovery(location, history, fetch) {
  const match = /(?:^#|&)launch=([a-f0-9]{32})(?:&|$)/.exec(location.hash || '');
  const launchId = match ? match[1] : undefined;
  let reported = false;
  return {
    active: Boolean(launchId),
    clear() {
      if (launchId) try { history.replaceState(null, '', location.pathname + location.search); } catch {}
    },
    async report(reason) {
      if (typeof fetch !== 'function' || !launchId || reported || !['device_key_missing', 'device_not_remembered'].includes(reason)) return false;
      reported = true;
      try {
        const response = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'omit', body: JSON.stringify({ launchId, failure: reason }) });
        return response.ok;
      } catch { return false; }
    },
  };
}
