import { describe, expect, it } from 'vitest';
import { awaitSceneSettled, describeSceneSettled, awaitReceipt, renderContinuationMs, sendAgentCall, stillWaitingLine, SOURCE_RENDER_WAIT_MS,
  type ReceiptWait } from '../scripts/inspection-agent.js';
import { agentTimeoutMs, AGENT_TIMEOUT_MS, type AgentResult, type ControlState } from '../scripts/local-agent.js';
import { InspectionCommands } from '../src/inspection-commands.js';
import { randomUUID } from 'node:crypto';
import { panelWaitMs, PANEL_SAVE_WAIT } from '../scripts/panel-wait.js';

const state = { origin: 'http://127.0.0.1:1', token: 'token', sessionId: 'session' } as ControlState;

/** The binding a caller already holds, so nothing here has to read state first. */
const binding = {
  sessionId: 'session', serverEpoch: 'epoch', sourceToken: 'old',
  baseStateRevision: 1, baseInspectionRevision: 1,
  panelId: '00000000-0000-4000-8000-000000000000',
};

const readyState = (sourceToken: string) => ({
  structuredContent: { sourceToken, hasScene: true, renderBudgetMs: 130_000,
    panels: [{ panelId: binding.panelId, surface: 'companion', current: true, availability: 'ready' }] },
} as AgentResult);

describe('a wait bound the host states', () => {
  it('follows the budget the host stated, minus what the host already spent', () => {
    // 4HHB: 4,779 atom sites, 130 s of panel save budget, 30 s of it spent
    // inside the call. What is left is 100 s, not the caller's own 60.
    expect(panelWaitMs(4_779, PANEL_SAVE_WAIT)).toBe(130_000);
    expect(renderContinuationMs({ budgetMs: 130_000, waitedForMs: 30_000, floorMs: 0 })).toBe(100_000);
  });

  it('keeps the old behaviour for a host that states no budget', () => {
    expect(renderContinuationMs({ budgetMs: undefined, waitedForMs: 30_000, floorMs: 60_000 })).toBe(60_000);
    expect(renderContinuationMs({ budgetMs: 'soon', waitedForMs: 1, floorMs: 0 })).toBe(0);
  });

  it('never invents time past the host budget', () => {
    expect(renderContinuationMs({ budgetMs: 30_000, waitedForMs: 30_000, floorMs: 90_000 })).toBe(0);
    expect(renderContinuationMs({ budgetMs: 30_000, waitedForMs: 45_000, floorMs: 0 })).toBe(0);
  });

  it('says how far into the host budget it is', () => {
    expect(stillWaitingLine('rendering', 42_000, 130_000)).toBe('still rendering, 42 s of a 130 s budget the host stated');
  });

  it('lets one request outlive the wait it asked the host to do', () => {
    expect(agentTimeoutMs({})).toBe(AGENT_TIMEOUT_MS);
    expect(agentTimeoutMs({ waitForRenderMs: 130_000 })).toBe(AGENT_TIMEOUT_MS + 130_000);
    expect(agentTimeoutMs({ waitForRenderMs: -1 })).toBe(AGENT_TIMEOUT_MS);
  });
});

describe('following one command receipt', () => {
  const receiptAfter = (renderedOnPoll: number, budgetMs?: number) => {
    let polls = 0;
    return async (): Promise<AgentResult> => {
      polls += 1;
      return { structuredContent: { command: polls < renderedOnPoll
        ? { commandId: 'c', status: 'rendering', ...(budgetMs === undefined ? {} : { budgetMs }) }
        : { commandId: 'c', status: 'rendered' } } } as AgentResult;
    };
  };

  it('waits past its own timeout when the host says it is still rendering with budget left', async () => {
    const wait: ReceiptWait = { pollMs: 2, timeoutMs: 5 };
    const outcome = await awaitReceipt(state, 'c', wait, receiptAfter(6, 2_000) as never);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.receipt.status).toBe('rendered');
    // The caller's own five milliseconds could not have covered six polls.
    expect(outcome.waitedMs).toBeGreaterThan(wait.timeoutMs);
  });

  it('still gives up on its own timeout when the host states no budget', async () => {
    const outcome = await awaitReceipt(state, 'c', { pollMs: 2, timeoutMs: 20 }, receiptAfter(1_000) as never);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.receipt.status).toBe('rendering');
  });

  it('publishes the host deadline on a pending receipt and names an unknown command', () => {
    let clock = 1_000_000;
    const commands = new InspectionCommands(() => clock);
    const bound = { serverEpoch: randomUUID(), sourceToken: randomUUID(), stateRevision: 4, inspectionRevision: 2 };
    const expected = { serverEpoch: bound.serverEpoch, sourceToken: bound.sourceToken,
      baseStateRevision: bound.stateRevision, baseInspectionRevision: bound.inspectionRevision };
    const panelId = commands.attach({ ...expected, surface: 'companion' } as never, bound as never);
    commands.poll({ ...expected, panelId, availability: 'busy' } as never, bound as never);
    commands.enqueue({ ...expected, panelId, commandId: 'c',
      change: { kind: 'selection', patch: { selectionKeys: [] } } } as never, bound as never, { selectionKeys: [] } as never);
    const queued = commands.summary(bound as never, 'c').command as { status: string; budgetMs?: number };
    expect(queued.status).toBe('queued');
    // The host's own queue deadline, not a number the follower chose.
    expect(queued.budgetMs).toBe(15_000);
    clock += 5_000;
    expect((commands.summary(bound as never, 'c').command as { budgetMs?: number }).budgetMs).toBe(10_000);
    expect((commands.summary(bound as never, 'missing').command as { status: string }).status).toBe('unknown');
  });
});

describe('following a replaced source', () => {
  /** A host that timed out its own slice and stated the budget it would have used. */
  const hostThatTimedOut = (budgetMs: number | undefined, settleOnPoll: number) => {
    let polls = 0;
    const seen: string[] = [];
    const request = async (_state: ControlState, name: string): Promise<AgentResult> => {
      seen.push(name);
      if (name !== 'get_inspection_state') {
        return { content: [{ type: 'text', text: 'timed out' }], structuredContent: {
          sourceToken: 'new', hasScene: false, sourceTransition: { sourceChanged: true },
          sourceRenderReceipt: null,
          renderWait: { timedOut: true, reason: 'Timed out after 30000 ms', waitedForMs: 30_000,
            ...(budgetMs === undefined ? {} : { budgetMs }) },
        } } as AgentResult;
      }
      polls += 1;
      return polls >= settleOnPoll ? readyState('new')
        : { structuredContent: { sourceToken: 'new', hasScene: false, panels: [] } } as AgentResult;
    };
    return { request, seen };
  };

  it('keeps following the render to the budget the host stated, and says so out loud', async () => {
    const lines: string[] = [];
    const { request } = hostThatTimedOut(130_000, 4);
    const outcome = await sendAgentCall(state,
      { name: 'replace_inspection_source', arguments: { ...binding, pdbId: '4HHB' }, wait: true },
      { pollMs: 2, timeoutMs: 60_000, progress: line => lines.push(line) }, request as never);
    expect(outcome.scene?.settled).toBe(true);
    expect(lines.join('\n')).toContain('still rendering, budget 130 s stated by the host');
  });

  it('asks the host for one bounded slice rather than the whole budget', async () => {
    const sent: Record<string, unknown>[] = [];
    const { request } = hostThatTimedOut(130_000, 1);
    const spy = async (s: ControlState, name: string, args: Record<string, unknown> | undefined, phase: string) => {
      if (phase === 'command') sent.push(args ?? {});
      return request(s, name);
    };
    await sendAgentCall(state, { name: 'replace_inspection_source', arguments: { ...binding, pdbId: '4HHB' }, wait: true },
      { pollMs: 2, timeoutMs: 60_000 }, spy as never);
    expect(sent[0]!.waitForRenderMs).toBe(SOURCE_RENDER_WAIT_MS);
  });

  it('answers straight away when the host states no budget, exactly as before', async () => {
    const { request } = hostThatTimedOut(undefined, 1);
    const outcome = await sendAgentCall(state,
      { name: 'replace_inspection_source', arguments: { ...binding, pdbId: '4HHB' }, wait: true },
      { pollMs: 2, timeoutMs: 60_000 }, request as never);
    expect(outcome.scene).toMatchObject({ settled: false, waitedMs: 0 });
  });

  it('reports not-drawn when the whole host budget is spent', async () => {
    const { request } = hostThatTimedOut(30_020, 1_000);
    const outcome = await sendAgentCall(state,
      { name: 'replace_inspection_source', arguments: { ...binding, pdbId: '4HHB' }, wait: true },
      { pollMs: 1, timeoutMs: 60_000 }, request as never);
    expect(outcome.scene?.settled).toBe(false);
  });
});

/**
 * Defect 17 of the device run, in one place.
 *
 * All four `replace_inspection_source` calls came back with `rendered: false`
 * under the sentence "The selected panel rendered and saved the new source".
 * The swaps had rendered; the caller simply had no receipt to read, because a
 * replacement answered under a key `commandReceiptOf` has never looked at. The
 * host now states `sourceRenderStatus` on every replacement, and
 * `get_inspection_state` publishes the rendered one for a caller that outlived
 * the host's own slice of the wait.
 */
describe('a replacement that reports what it proved', () => {
  const RENDERED = { status: 'rendered', rendered: true, panelId: binding.panelId, sourceToken: 'new',
    inspectionRevision: 1, renderedAt: 1_700_000_000_000, renderedRevision: 1, renderBudgetMs: 130_000 };

  const hostThat = (answer: Record<string, unknown>, settledState?: Record<string, unknown>) => {
    const request = async (_state: ControlState, name: string): Promise<AgentResult> => {
      if (name !== 'get_inspection_state') return { content: [{ type: 'text', text: 'answered' }],
        structuredContent: { sourceToken: 'new', sourceTransition: { sourceChanged: true }, ...answer } } as AgentResult;
      return { structuredContent: { ...readyState('new').structuredContent, ...(settledState ?? {}) } } as AgentResult;
    };
    return request;
  };

  it('reports rendered from the receipt the host stated, not from the sentence', async () => {
    const outcome = await sendAgentCall(state,
      { name: 'replace_inspection_source', arguments: { ...binding, pdbId: '4HHB' }, wait: true },
      { pollMs: 2, timeoutMs: 60_000 },
      hostThat({ sourceRenderReceipt: RENDERED, sourceRenderStatus: RENDERED,
        renderWait: { timedOut: false, reason: null, budgetMs: 130_000, waitedForMs: 30_000, askedMs: 30_000 } }) as never);
    expect(outcome.receipt?.status).toBe('rendered');
    expect(outcome.receipt?.rendered).toBe(true);
    expect(outcome.receipt?.renderedRevision).toBe(1);
    expect(outcome.receipt?.renderBudgetMs).toBe(130_000);
  });

  it('leaves rendered false, with a status and a reason, when nothing proved a render', async () => {
    const outcome = await sendAgentCall(state,
      { name: 'replace_inspection_source', arguments: { ...binding, pdbId: '4HHB' }, wait: true },
      { pollMs: 2, timeoutMs: 60_000 },
      hostThat({ sourceRenderReceipt: null, sourceRenderStatus: { status: 'timed_out', rendered: false,
        renderBudgetMs: 30_000, askedMs: 30_000, waitedForMs: 30_000, panelId: binding.panelId,
        reason: 'Timed out after 30000 ms waiting for the selected panel to render, save and reattach.' },
      renderWait: { timedOut: true, reason: 'Timed out after 30000 ms', budgetMs: 30_000, waitedForMs: 30_000, askedMs: 30_000 } },
      { hasScene: false, panels: [] }) as never);
    expect(outcome.receipt?.status).toBe('timed_out');
    expect(outcome.receipt?.rendered).toBe(false);
    expect(String(outcome.receipt?.reason)).toContain('Timed out after 30000 ms');
  });

  it('picks up the rendered receipt the state publishes after the host slice ran out', async () => {
    const outcome = await sendAgentCall(state,
      { name: 'replace_inspection_source', arguments: { ...binding, pdbId: '4HHB' }, wait: true },
      { pollMs: 2, timeoutMs: 60_000 },
      hostThat({ sourceRenderReceipt: null, sourceRenderStatus: { status: 'timed_out', rendered: false,
        renderBudgetMs: 130_000, askedMs: 30_000, waitedForMs: 30_000, panelId: binding.panelId, reason: 'Timed out.' },
      renderWait: { timedOut: true, reason: 'Timed out.', budgetMs: 130_000, waitedForMs: 30_000, askedMs: 30_000 } },
      { sourceRenderReceipt: RENDERED }) as never);
    expect(outcome.scene?.settled).toBe(true);
    expect(outcome.receipt?.status).toBe('rendered');
    expect(outcome.receipt?.rendered).toBe(true);
  });

  it('a failed receipt ends both immediate and continuation waits without claiming drawn',async()=>{
    const failure={status:'failed',rendered:false,sourceToken:'new',failure:'representation_budget_exceeded',failureReason:'Need 269832 vertices; budget 260000.'};
    const outcome=await sendAgentCall(state,{name:'replace_inspection_source',arguments:{...binding,pdbId:'4HHB'},wait:true},
      {pollMs:1,timeoutMs:60_000},hostThat({sourceRenderReceipt:failure,sourceRenderStatus:failure,
        renderWait:{budgetMs:130_000,waitedForMs:100}}, {hasScene:false,sourceRenderReceipt:failure}) as never);
    expect(outcome.scene).toMatchObject({settled:false,waitedMs:0});
    expect(outcome.receipt).toMatchObject(failure);
    expect(describeSceneSettled({settled:false,waitedMs:0,structured:{sourceRenderReceipt:failure}})).toContain(failure.failureReason);
    let calls=0;
    const stopped=await awaitSceneSettled(state,{pollMs:1,timeoutMs:60_000},{expected:'new'},async()=>{
      calls++;return {structuredContent:{sourceToken:'new',hasScene:false,sourceRenderReceipt:failure}};
    });
    expect(stopped.settled).toBe(false);expect(calls).toBe(1);
  });

  it('states no receipt at all for a host that publishes none', async () => {
    const outcome = await sendAgentCall(state,
      { name: 'replace_inspection_source', arguments: { ...binding, pdbId: '4HHB' }, wait: true },
      { pollMs: 2, timeoutMs: 60_000 },
      hostThat({ sourceRenderReceipt: null,
        renderWait: { timedOut: true, reason: 'Timed out.', budgetMs: 30_000, waitedForMs: 30_000 } }) as never);
    expect(outcome.receipt).toBeUndefined();
  });
});
