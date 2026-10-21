import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendAgentCall, type AgentCall, type AgentCallTransport } from '../scripts/inspection-agent.js';
import { choosePanel, fillAgentArguments } from '../scripts/agent-arguments.js';
import { InspectionCommands, type InspectionBinding } from '../src/inspection-commands.js';
import type { InspectionScene } from '../src/inspection-contract.js';
// @ts-expect-error Shared production browser transaction.
import { interruptibleCommand } from '../../lab/inspection/interruptible-command.mjs';

afterEach(() => vi.useRealTimers());
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Real queue and rollback transaction; only geometry and the HTTP hop are simulated. */
function fixture(options: { delayedOldHeartbeat?: boolean } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const commands = new InspectionCommands(() => Date.now());
  let binding: InspectionBinding = { serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1, inspectionRevision: 1 };
  let saved: InspectionScene = { sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1', selectionKeys: [],
    camera: { mode: 'perspective', fov: 45, position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], radius: 4,
      radiusMax: 8, fog: 50, clipFar: true, minNear: .1, minFar: 1 },
    inspection: { appearance: { representation: 'ball-and-stick', color: 'chain-id', uniformColor: '#ffffff',
      background: '#000000', highlightColor: '#ffff00', opacity: 1, labels: false, clipping: 0, fog: 0 },
    placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
  let drawn = structuredClone(saved), busy = false, nextHeartbeat = 0;
  const expected = () => ({ serverEpoch: binding.serverEpoch, sourceToken: binding.sourceToken,
    baseStateRevision: binding.stateRevision, baseInspectionRevision: binding.inspectionRevision });
  const desktop = commands.attach({ ...expected(), surface: 'desktop' }, binding);
  const panelId = commands.attach({ ...expected(), surface: 'companion' }, binding);
  const control = { origin: 'http://127.0.0.1:12345', token: 'synthetic', sessionId: 'session' };
  const calls: { name: string; args: any; at: number }[] = [], confirmations: string[] = [], renderErrors: unknown[] = [];
  const summary = (id?: string) => ({ ...binding, ...commands.summary(binding, id) });
  const request: AgentCallTransport = async (_control, name, args = {}) => {
    calls.push({ name, args, at: Date.now() });
    if (name === 'get_inspection_state') return { structuredContent: summary(args.commandId as string) };
    if (name === 'say_to_headset') return { structuredContent: { queued: true } };
    expect(name).toBe('update_inspection');
    // The CLI leaves update_inspection's revisions to the host, which fills
    // them with the binding current on arrival (`fillImplicitBinding`).
    const input = { baseStateRevision: binding.stateRevision, baseInspectionRevision: binding.inspectionRevision, ...args } as any;
    if (input.change.kind === 'utterance') return { structuredContent: { lifecycle: commands.controlUtterance(input, binding) } };
    return { structuredContent: { command: commands.enqueue(input, binding, saved) } };
  };
  const send = (call: AgentCall) => sendAgentCall(control, call, undefined, request);
  const viewer = { snapshot: () => ({ xrPresenting: true }), inspection: {
    capture: () => structuredClone(drawn), beginOperation: () => ({}), endOperation: () => {},
    restore: async (scene: InspectionScene) => { drawn = structuredClone(scene); },
    rollbackOperation: async () => { await pause(20); },
  } };
  async function render(delivery: any) {
    busy = true;
    commands.poll({ ...expected(), panelId, availability: 'busy' }, binding);
    const claim = { ...expected(), panelId, commandId: delivery.commandId, claimToken: delivery.claimToken };
    try {
      await interruptibleCommand(viewer, async () => {
        expect(commands.admit(claim, binding).admitted).toBe(true);
      }, async () => {
        await pause(700);
        Object.assign(drawn.inspection.appearance, delivery.change.patch);
        const complete = commands.complete({ ...claim, scene: drawn }, binding);
        if (!complete.accepted) throw Object.assign(Error('Superseded before publication.'), { code: 'superseded' });
        saved = structuredClone(drawn);
        binding = { ...binding, inspectionRevision: complete.command.renderedRevision! };
        confirmations.push(delivery.commandId);
        if (options.delayedOldHeartbeat && delivery.commandId === 'surface') {
          // A heartbeat sent before completion can arrive after the receipt.
          // The next normal one is a second away, as in inspector.schedulePoll.
          nextHeartbeat = Date.now() + 1000;
          setTimeout(() => commands.poll({ ...claim, availability: 'busy' }, binding), 1);
        }
      }, async () => { commands.settled(claim); });
    } catch (error) { if ((error as any).code !== 'superseded') renderErrors.push(error); }
    finally { busy = false; }
  }
  // The headset continues busy heartbeats during the 700 ms geometry build.
  const timer = setInterval(() => {
    if (Date.now() < nextHeartbeat) return;
    const result = commands.poll({ ...expected(), panelId, availability: busy ? 'busy' : 'ready' }, binding);
    if ('delivery' in result) void render(result.delivery);
  }, 10);
  return { commands, summary, send, calls, confirmations, renderErrors, panelId, desktop, expected,
    get binding() { return binding; }, get saved() { return saved; }, get drawn() { return drawn; },
    stop: () => clearInterval(timer),
  };
}
const appearance = (commandId: string, patch: object, extra: Partial<AgentCall> = {}): AgentCall => ({
  name: 'update_inspection', arguments: { commandId, change: { kind: 'appearance', patch } }, ...extra,
});

describe('agent correction during a 700 ms render', () => {
  it('admits the 200 ms correction before a delayed old heartbeat can cause No panel is showing this inspection', async () => {
    const t = fixture({ delayedOldHeartbeat: true });
    try {
      await t.send(appearance('surface', { representation: 'molecular-surface' }));
      await vi.advanceTimersByTimeAsync(200);
      let outcome: Awaited<ReturnType<typeof sendAgentCall>> | undefined, refusal: unknown;
      const correcting = t.send(appearance('cartoon', { representation: 'cartoon' }, { utterance: 'correct', wait: true }))
        .then(value => { outcome = value; }, error => { refusal = error; });
      await vi.advanceTimersByTimeAsync(2500);
      await correcting;
      expect(refusal).toBeUndefined();
      expect(outcome).toMatchObject({ utterance: { superseded: 1 }, receipt: { status: 'rendered', panelId: t.panelId } });
      expect(t.confirmations).toEqual(['cartoon']);
      expect(t.summary('surface').command).toMatchObject({ status: 'superseded', fenceReleased: 'rolled-back' });
    } finally { t.stop(); }
  });

  it.each([100, 200, 300, 500, 1000])('admits a correction at %i ms on the rendering panel and renders the next utterance', async gap => {
    const t = fixture();
    try {
      await t.send(appearance('surface', { representation: 'molecular-surface' }, { utterance: 'begin' }));
      await vi.advanceTimersByTimeAsync(10); // Claim and start the first render.
      await vi.advanceTimersByTimeAsync(gap - 10);
      let outcome: Awaited<ReturnType<typeof sendAgentCall>> | undefined;
      let refusal: unknown;
      const correcting = t.send(appearance('cartoon', { representation: 'cartoon' }, { utterance: 'correct', wait: true }))
        .then(value => { outcome = value; }, error => { refusal = error; });
      await vi.advanceTimersByTimeAsync(0);
      expect(refusal).toBeUndefined();
      const pending = gap < 700;
      if (pending) {
        expect(t.summary('surface').command).toMatchObject({ status: 'superseded', supersededBy: expect.any(String) });
        expect(t.summary().pendingCommand).toContainEqual(expect.objectContaining({ commandId: 'surface', renderFence: true }));
        expect(t.summary('cartoon').command).toMatchObject({ status: 'queued', panelId: t.panelId });
        expect(t.confirmations).toEqual([]);
      } else {
        expect(t.summary('surface').command).toMatchObject({ status: 'rendered' });
        expect(t.summary('surface').command).not.toHaveProperty('supersededBy');
      }
      expect(outcome).toBeUndefined(); // No acknowledgment before a rendered receipt.
      await vi.advanceTimersByTimeAsync(2500);
      await correcting;
      expect(refusal).toBeUndefined();
      expect(outcome).toMatchObject({ receiptTimedOut: false, blurWaitedMs: 0,
        utterance: { action: 'correct', superseded: pending ? 1 : 0 },
        receipt: { commandId: 'cartoon', panelId: t.panelId, status: 'rendered', renderedAt: expect.any(Number), renderedRevision: expect.any(Number) } });
      if (pending) {
        expect(t.summary('surface').command).toMatchObject({ status: 'superseded', fenceReleased: 'rolled-back',
          supersededBy: outcome!.utterance!.utteranceId });
        expect(t.summary('surface').command).not.toHaveProperty('renderedAt');
      }
      await t.send(appearance('third', { opacity: .8 }, { utterance: 'begin' }));
      await vi.advanceTimersByTimeAsync(750);
      expect(t.summary('third').command).toMatchObject({ status: 'rendered', panelId: t.panelId });
      expect(t.confirmations).toEqual(pending ? ['cartoon', 'third'] : ['surface', 'cartoon', 'third']);
      expect(t.drawn).toEqual(t.saved);
      expect(t.saved.inspection.appearance).toMatchObject({ representation: 'cartoon', opacity: .8 });
      expect(t.summary().pendingCommand).toEqual([]);
      expect(t.renderErrors).toEqual([]);
    } finally { t.stop(); }
  });
});

describe('correction binding refusals and ownership', () => {
  const quest = { panelId: 'quest', surface: 'companion', current: true, availability: 'busy' };
  const desk = { panelId: 'desk', surface: 'desktop', current: true, availability: 'ready' };
  const pendingCommand = [{ panelId: 'quest', status: 'rendering' }];
  const state = { serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 1, inspectionRevision: 1,
    panels: [quest, desk], pendingCommand };
  const lifecycle = (action: string) => ({ change: { kind: 'utterance', patch: { action } } });

  it.each(['correct', 'cancel'])('binds %s to the active render immediately', action => {
    const filled = fillAgentArguments('update_inspection', lifecycle(action), state);
    expect(filled.arguments.panelId).toBe('quest');
    expect(filled.blurred).toBeUndefined();
  });

  it('keeps ordinary edits and begin declarations on the existing blur wait', () => {
    expect(fillAgentArguments('update_inspection', appearance('plain', { opacity: .5 }).arguments, state).blurred).toBe(true);
    expect(fillAgentArguments('update_inspection', lifecycle('begin'), state).blurred).toBe(true);
    expect(fillAgentArguments('update_inspection', lifecycle('correct'), { ...state, pendingCommand: [] }).blurred).toBe(true);
  });

  it('chooses the rendering panel ahead of another ready surface and keeps a rollback owner', () => {
    const panels = [{ ...quest, availability: 'ready' }, { ...desk, availability: 'busy' }];
    expect(choosePanel(panels, { interrupting: true, pendingCommand: [{ panelId: 'desk', status: 'rendering' }] }))
      .toEqual({ panelId: 'desk' });
    expect(choosePanel(panels, { interrupting: true,
      pendingCommand: [{ panelId: 'desk', status: 'superseded', renderFence: true }] })).toEqual({ panelId: 'desk' });
  });

  it.each(['absent', 'stale', 'unsaved', 'ambiguous'])('preserves the %s panel refusal during a correction', condition => {
    const panels = condition === 'absent' ? [desk] : condition === 'stale' ? [{ ...quest, current: false }, desk]
      : condition === 'unsaved' ? [{ ...quest, availability: 'unsaved' }, desk] : [quest, { ...quest, panelId: 'other' }];
    const pending = condition === 'ambiguous' ? [...pendingCommand, { panelId: 'other', status: 'rendering' }] : pendingCommand;
    expect(() => fillAgentArguments('update_inspection', lifecycle('correct'), { ...state, panels, pendingCommand: pending }))
      .toThrow(condition === 'ambiguous' ? /Several panels/ : /will not be retargeted/);
  });

  it('keeps an explicit target and caller-supplied stale revisions for the server to refuse', () => {
    const filled = fillAgentArguments('update_inspection', { ...lifecycle('correct'), panelId: 'wrong',
      sourceToken: 'stale', baseInspectionRevision: 0 }, state);
    expect(filled.arguments).toMatchObject({ panelId: 'wrong', sourceToken: 'stale', baseInspectionRevision: 0 });
  });

  it.each([false, true])('refuses an insecure correction before cancelling work and routes its sentence to the plate (explicit surface: %s)', async explicit => {
    const t = fixture();
    try {
      await t.send(appearance('surface', { representation: 'molecular-surface' }));
      await vi.advanceTimersByTimeAsync(200);
      await expect(t.send({ name: 'replace_inspection_source', utterance: 'correct', ...(explicit ? { panel: 'detailed' as const } : {}),
        arguments: { commandId: 'insecure', utteranceId: 'new-voice-id', source: { kind: 'url', url: 'http://example.test/model.cif' } } }))
        .rejects.toThrow('Insecure URLs and embedded credentials are refused.');
      expect(t.summary('surface').command).toMatchObject({ status: 'rendering' });
      expect(t.calls.filter(call => call.name === 'say_to_headset')).toEqual([expect.objectContaining({ args: {
        commandId: 'insecure', utteranceId: 'new-voice-id', text: expect.stringContaining('Insecure URLs and embedded credentials are refused.'),
        refusal: { tool: 'replace_inspection_source', sessionId: 'session' },
      } })]);
      expect(t.calls.filter(call => call.name === 'update_inspection')).toHaveLength(1);
      expect(t.calls.some(call => call.name === 'replace_inspection_source')).toBe(false);
      await vi.advanceTimersByTimeAsync(750);
      expect(t.confirmations).toEqual(['surface']);
    } finally { t.stop(); }
  });

  it('cancels a busy render through the agent path and releases its fence without a confirmation', async () => {
    const t = fixture();
    try {
      await t.send(appearance('surface', { representation: 'molecular-surface' }));
      await vi.advanceTimersByTimeAsync(200);
      const cancelled = await t.send({ name: 'update_inspection', arguments: lifecycle('cancel') });
      expect(cancelled.result.structuredContent.lifecycle).toMatchObject({ action: 'cancel', rendered: false });
      expect(t.summary('surface').command).toMatchObject({ status: 'superseded', supersededBy: expect.any(String) });
      await vi.advanceTimersByTimeAsync(750);
      expect(t.summary('surface').command).toMatchObject({ fenceReleased: 'rolled-back' });
      expect(t.summary().pendingCommand).toEqual([]);
      expect(t.drawn).toEqual(t.saved);
      expect(t.confirmations).toEqual([]);
    } finally { t.stop(); }
  });
});
