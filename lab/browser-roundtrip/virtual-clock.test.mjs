import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { virtualClock } from './fixtures/virtual-clock.mjs';

test('virtual deadlines drain VM continuations between serial and parallel timers', async () => {
  const clock = virtualClock(), events = [];
  const context = vm.createContext({ ...clock, events });
  const done = vm.runInContext(`(async () => {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    await delay(300); events.push('capture');
    await Promise.all([delay(300), delay(300)]); events.push('audio');
  })()`, context);
  await clock.advance(599);
  assert.deepEqual(events, ['capture']);
  assert.equal(clock.pending(), 2);
  await clock.advance(1);
  assert.deepEqual(events, ['capture', 'audio']);
  assert.equal(clock.pending(), 0);
  await done;
});

test('virtual deadlines preserve pending work beyond a bound and cancel settled timers', async () => {
  const clock = virtualClock(), events = [];
  clock.setTimeout(() => events.push('late'), 601);
  const cancelled = clock.setTimeout(() => assert.fail('cancelled timer ran'), 300);
  Promise.resolve().then(() => clock.clearTimeout(cancelled));
  await clock.advance(600);
  assert.deepEqual(events, [], 'a too-late finalizer cannot appear to satisfy the budget');
  assert.equal(clock.pending(), 1);
  await clock.advance(1);
  assert.deepEqual(events, ['late']);
  assert.equal(clock.pending(), 0);
});
