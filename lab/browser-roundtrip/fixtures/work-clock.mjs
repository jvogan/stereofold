import { performance } from 'node:perf_hooks';

const cpuUsage = typeof process.threadCpuUsage === 'function'
  ? () => process.threadCpuUsage()
  : () => process.cpuUsage();

/**
 * A clock that advances only while this thread works or waits for its own
 * events, in milliseconds. Read it before and after the work; the difference
 * is what the work cost.
 *
 * Elapsed time also counts every slice the scheduler gives another process,
 * so on a busy machine a 0.4 ms frame can read 3 ms. This clock adds the
 * thread's CPU time, which includes its share of garbage collection, to the
 * time its event loop sat idle waiting for a timer or I/O. Being descheduled
 * is neither, so load cannot inflate it, while slower code and a newly
 * awaited timer or read still count in full. Runtimes without a per-thread
 * reading fall back to the whole process's CPU time, which can only read
 * higher.
 *
 * Time the thread spends blocked in a synchronous wait is not on this clock.
 * `fastestPerSample` keeps that cost.
 */
export function workClock() {
  const { user, system } = cpuUsage();
  return (user + system) / 1000 + performance.eventLoopUtilization().idle;
}

/** How many identical runs `fastestPerSample` takes the fastest of. */
export const RUNS = 5;

/**
 * The fastest elapsed time each sample took across identical runs.
 *
 * Load inflates only the samples another process happened to interrupt, and
 * that does not land on the same sample in every run. Anything the work
 * itself costs, a synchronous wait included, recurs at its sample in every
 * run and so is kept.
 */
export function fastestPerSample(runs) {
  return runs[0].map((_, index) => Math.min(...runs.map(run => run[index])));
}
