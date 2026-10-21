/** Yield to an ordinary browser task without nested zero-delay timer clamping.
 * scheduler.yield() intentionally boosts continuations ahead of other tasks;
 * chaining it through catalog chunks can starve native XR frames. MessageChannel
 * gives rendering/input a normal scheduling opportunity without a frame wait.
 * Never substitute a resolved Promise: rendering needs a task boundary. */
export function yieldBrowserTask(scope = globalThis) {
  if (typeof scope.MessageChannel === 'function') return new Promise((resolve, reject) => {
    const channel = new scope.MessageChannel();
    const close = () => { channel.port1.close(); channel.port2.close(); };
    channel.port1.onmessage = () => { close(); resolve(); };
    channel.port1.onmessageerror = () => { close(); reject(new Error('Browser task yield failed.')); };
    try { channel.port2.postMessage(null); }
    catch (error) { close(); reject(error); }
  });
  return new Promise(resolve => scope.setTimeout(resolve, 0));
}
