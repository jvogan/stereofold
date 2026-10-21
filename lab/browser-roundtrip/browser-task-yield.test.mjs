import test from 'node:test';
import assert from 'node:assert/strict';
import { yieldBrowserTask } from './browser-task-yield.mjs';
import { freezeOwnedSelectionCatalogAsync, snapshotSelectionCatalog } from './catalog-snapshot.mjs';

test('a browser with scheduler.yield still uses an ordinary task without boosted continuation priority', async () => {
  let resumed = false;
  const pending = yieldBrowserTask({ scheduler: { yield() { throw Error('boosted continuation must not be used'); } },
    MessageChannel, setTimeout() { throw Error('unexpected timer clamp'); },
  }).then(() => { resumed = true; });
  for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(resumed, false);
  await pending; assert.equal(resumed,true);
});

test('MessageChannel fallback crosses a real task boundary, rather than draining microtasks', async () => {
  let resumed = false;
  const pending = yieldBrowserTask({ MessageChannel, setTimeout() { throw Error('unexpected timer'); } })
    .then(() => { resumed = true; });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(resumed, false);
  await pending;
  assert.equal(resumed, true);
});

for (const outcome of ['success', 'messageerror', 'posterror']) test(`channel fallback closes both ports on ${outcome}`, async () => {
  let channel; const closed = [];
  class Channel {
    constructor() {
      channel = this;
      this.port1 = { close: () => closed.push(1) };
      this.port2 = { close: () => closed.push(2), postMessage() { if (outcome === 'posterror') throw Error('post failed'); } };
    }
  }
  const pending = yieldBrowserTask({ MessageChannel: Channel });
  if (outcome === 'success') { channel.port1.onmessage(); await pending; }
  else {
    if (outcome === 'messageerror') channel.port1.onmessageerror();
    await assert.rejects(pending, /failed/);
  }
  assert.deepEqual(closed, [1, 2]);
});

test('a scheduler-only browser retains a real timer boundary rather than a boosted continuation', async () => {
  let resume;
  const pending = yieldBrowserTask({ scheduler:{yield(){throw Error('boosted continuation must not be used');}},setTimeout(fn, delay) { assert.equal(delay, 0); resume = fn; } });
  resume(); await pending;
});

test('cancellation after a channel yield still rejects without publishing a partial owned catalog', async () => {
  const catalog = { rows: Array.from({ length: 1000 }, (_, i) => ({ coordinate: [i, 0, 0] })) };
  let cancelled = false, yielded = 0;
  await assert.rejects(freezeOwnedSelectionCatalogAsync(catalog, { budgetMs: 0,
    yieldTask: async () => { await yieldBrowserTask({ MessageChannel }); yielded++; cancelled = true; },
    check: () => { if (cancelled) throw Error('source replaced'); },
  }), /source replaced/);
  assert.equal(yielded, 1);
  assert.notEqual(snapshotSelectionCatalog(catalog), catalog, 'cancelled work is not branded as complete');
});
