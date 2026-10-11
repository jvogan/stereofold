/** Retry a lost host quickly once, then spread repeated attempts across pages. */
export function createPollBackoff(now=Date.now, random=Math.random) {
  let failures=0, retryAt=0;
  return {
    failed() {
      const ceiling=Math.min(4000,500*2**Math.min(failures++,3));
      retryAt=now()+ceiling*(0.5+0.5*random());
    },
    succeeded() { failures=0;retryAt=0; },
    remaining() { return Math.max(0,retryAt-now()); },
  };
}
