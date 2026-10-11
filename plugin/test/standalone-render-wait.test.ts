import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { SourceRenderWait } from '../src/source-render-wait.js';
import { standaloneHostCall } from './fixtures/standalone-host-call.js';

it('allows source preparation before the standalone host starts its requested render wait', async () => {
  const server = new McpServer({ name: 'prepared-render-fixture', version: '1' });
  const wait = new SourceRenderWait();
  let started!: () => void;
  const preparing = new Promise<void>(resolve => { started = resolve; });
  server.registerTool('stereo_structure.replace_inspection_source', {
    inputSchema: { waitForRenderMs: z.number() },
  }, async input => {
    started();
    await new Promise(resolve => setTimeout(resolve, 80_000));
    const receipt = await wait.wait(input.waitForRenderMs);
    return { content: [], structuredContent: { sourceRenderReceipt: receipt ?? null } };
  });
  const client = new Client({ name: 'prepared-host-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  vi.useFakeTimers();
  try {
    let failure: unknown;
    const pending = standaloneHostCall(client)('replace_inspection_source', { waitForRenderMs: 130_000 })
      .catch(error => { failure = error; });
    await preparing;
    await vi.advanceTimersByTimeAsync(80_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(failure, 'a valid draw must outlive the old 190 s total transport limit').toBeUndefined();
    const receipt = { status: 'rendered' as const, panelId: 'owner', sourceToken: 'prepared-source',
      inspectionRevision: 1, renderedAt: 200_000, renderedRevision: 1 };
    wait.complete(receipt);
    expect((await pending)?.structuredContent.sourceRenderReceipt).toEqual(receipt);
  } finally { vi.useRealTimers(); await client.close(); await server.close(); }
});

for (const renderAt of [61_000, 129_999, 140_000]) {
  it(`host delivers the source receipt after ${renderAt} ms against a 130000 ms render budget`, async () => {
    const server = new McpServer({ name: 'render-wait-fixture', version: '1' });
    const receipt = { status: 'rendered' as const, panelId: 'owner', sourceToken: 'new-source',
      inspectionRevision: 1, renderedAt: renderAt, renderedRevision: 1 };
    const wait = new SourceRenderWait();
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    server.registerTool('stereo_structure.replace_inspection_source', {
      inputSchema: { waitForRenderMs: z.number() },
    }, async input => {
      const pending = wait.wait(Math.min(input.waitForRenderMs, 130_000));
      started();
      const rendered = await pending;
      return { content: [], structuredContent: { sourceRenderReceipt: rendered ?? null,
        renderWait: { timedOut: !rendered, budgetMs: 130_000 } } };
    });
    server.registerTool('stereo_structure.get_inspection_state', {}, async () => ({ content: [],
      structuredContent: { sourceRenderReceipt: wait.settled() ?? null } }));
    const client = new Client({ name: 'host-fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    vi.useFakeTimers();
    try {
      const raw = standaloneHostCall(client);
      let answer: any, failure: unknown;
      const pending = raw('replace_inspection_source', { waitForRenderMs: 130_000 })
        .then(result => { answer = result; }, error => { failure = error; });
      await waiting;
      await vi.advanceTimersByTimeAsync(Math.min(renderAt, 130_000));
      expect(failure).toBeUndefined();
      if (renderAt < 130_000) {
        expect(answer).toBeUndefined();
        wait.complete(receipt);
      }
      await pending;
      expect(answer.structuredContent).toMatchObject({ sourceRenderReceipt: renderAt < 130_000 ? receipt : null,
        renderWait: { timedOut: renderAt >= 130_000, budgetMs: 130_000 } });
      if (renderAt >= 130_000) {
        await vi.advanceTimersByTimeAsync(renderAt - 130_000);
        wait.complete(receipt);
        expect((await raw('get_inspection_state', {})).structuredContent.sourceRenderReceipt).toEqual(receipt);
      }
    } finally { vi.useRealTimers(); await client.close(); await server.close(); }
  });
}
