import assert from 'node:assert/strict';
import test from 'node:test';
import { measureSolve, SOLVE_SAMPLES } from './fixtures/solve-timing.mjs';

test('solve timing runs a fixed sample count with fresh inputs and excludes setup work', () => {
  let clock = 0, calls = 0;
  const measured = measureSolve(() => { clock += 100; return { solved: false }; }, input => {
    assert.equal(input.solved, false);
    input.solved = true;
    clock += calls++ === 2 ? 50 : 5; // One isolated pause among timed solves.
    return input;
  }, () => clock);
  assert.equal(calls, 1 + SOLVE_SAMPLES, 'warm-up plus every sample, even after a fast solve');
  assert.equal(measured.samples.length, SOLVE_SAMPLES);
  assert.equal(measured.samples.filter(ms => ms === 50).length, 1);
  assert.equal(measured.ms, 5);
});

test('solve timing retains sustained work over the unchanged 20 ms bound', () => {
  let clock = 0, calls = 0;
  const measured = measureSolve(() => ({}), () => { calls++; clock += 25; return { placed: true }; }, () => clock);
  assert.equal(calls, 1 + SOLVE_SAMPLES, 'no extra attempts after a slow solve');
  assert.equal(measured.ms, 25);
  assert.ok(measured.samples.every(ms => ms >= 20));
});

test('solve timing rejects a fast sample that changes the solver result', () => {
  let calls = 0;
  assert.throws(() => measureSolve(() => ({}), () => ({ placed: ++calls === 1 }), () => 0),
    /solve sample 1 must retain the warm-up result/);
});
