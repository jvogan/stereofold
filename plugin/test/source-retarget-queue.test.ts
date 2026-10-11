import { describe, expect, it, vi } from 'vitest';
import { SourceRetargetQueue } from '../src/source-retarget-queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('source retarget admission', () => {
  it('joins concurrent exact pairs and serializes different transitions', async () => {
    const queue = new SourceRetargetQueue(), owner = {}, gate = deferred(), calls: string[] = [];
    const first = queue.run(owner, 'a', 'b', async () => { calls.push('ab'); await gate.promise; });
    expect(queue.run(owner, 'a', 'b', async () => { throw Error('duplicate'); })).toBe(first);
    const second = queue.run(owner, 'b', 'c', async () => { calls.push('bc'); });
    await Promise.resolve(); expect(calls).toEqual(['ab']);
    gate.resolve(); await Promise.all([first, second]); expect(calls).toEqual(['ab', 'bc']);
    const checkStale = vi.fn(async () => { throw Error('older source'); });
    await expect(queue.run(owner, 'a', 'b', checkStale)).rejects.toThrow('older source');
    expect(checkStale).toHaveBeenCalledOnce();
  });

  it('retries failed retargets without wedging successors and does not reuse a reopened share', async () => {
    const queue = new SourceRetargetQueue(), owner = {};
    const failed = queue.run(owner, 'a', 'b', async () => { throw Error('LAN failed after loopback'); });
    await expect(failed).rejects.toThrow('LAN failed');
    const retry = vi.fn(async () => {});
    await queue.run(owner, 'a', 'b', retry);
    await queue.run(owner, 'a', 'b', retry);
    expect(retry).toHaveBeenCalledOnce();
    await queue.run({}, 'a', 'b', retry);
    expect(retry).toHaveBeenCalledTimes(2);
    await queue.run(owner, 'b', 'c', retry);
    expect(retry).toHaveBeenCalledTimes(3);
  });
});
