import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// Fixed before measuring: never stop early on success or retry on failure.
export const SOLVE_SAMPLES = 7;

/**
 * One warm-up, then the minimum of seven complete solves of the same fixture.
 * Input construction and result checks stay outside the timed window. Fresh
 * inputs keep a mutating solver from receiving an already-solved arrangement.
 * The minimum reduces isolated GC/scheduler pauses; sustained work over the
 * bound still fails. This measures warm host throughput, not device frame tails.
 */
export function measureSolve(makeInput, solve, now = () => performance.now()) {
  const result = solve(makeInput());
  const samples = [];
  for (let i = 0; i < SOLVE_SAMPLES; i++) {
    const input = makeInput();
    const started = now();
    const repeated = solve(input);
    samples.push(now() - started);
    assert.deepEqual(repeated, result, `solve sample ${i + 1} must retain the warm-up result`);
  }
  return { result, samples, ms: Math.min(...samples) };
}
