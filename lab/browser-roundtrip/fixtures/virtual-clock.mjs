import { setImmediate as flush } from 'node:timers/promises';

// Give each timer's promise continuations (including VM promises) a full turn
// before advancing to the next deadline. Host scheduling cannot move this clock.
export function virtualClock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    setTimeout(callback, ms) {
      const id = ++next;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const until = now + ms;
      await flush();
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        await flush();
      }
      now = until;
    },
  };
}
