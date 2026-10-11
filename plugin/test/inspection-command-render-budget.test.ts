import { describe, expect, it } from 'vitest';
import { InspectionCommands } from '../src/inspection-commands.js';
import type { InspectionScene } from '../src/inspection-contract.js';
const binding = { serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 4, inspectionRevision: 7 };
const expected = { serverEpoch: 'epoch', sourceToken: 'source', baseStateRevision: 4, baseInspectionRevision: 7 };
const scene: InspectionScene = { sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1', selectionKeys: [],
  camera: { mode: 'perspective', fov: 45, position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], radius: 4, radiusMax: 8, fog: 50, clipFar: true, minNear: .1, minFar: 1 },
  inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#ffffff', background: '#000000', highlightColor: '#ffff00', opacity: 1, labels: true, clipping: 0, fog: 50 },
    placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
function harness(budget?: number) {
  let now = 1000;
  const commands = new InspectionCommands(() => now);
  if (budget !== undefined) commands.setRenderBudget(budget);
  const panelId = commands.attach({ ...expected, surface: 'companion' }, binding);
  const request = (commandId: string, representation: 'cartoon' | 'molecular-surface' = 'molecular-surface', utteranceId?: string) =>
    ({ ...expected, panelId, commandId, ...(utteranceId ? { utteranceId } : {}),
      change: { kind: 'appearance' as const, patch: { representation } } });
  const poll = () => commands.poll({ ...expected, panelId, availability: 'ready' }, binding);
  const result = (representation: 'cartoon' | 'molecular-surface') => {
    const next = structuredClone(scene); next.inspection.appearance.representation = representation; return next;
  };
  return { commands, panelId, request, poll, result, at: (value: number) => { now = value; },
    claim(commandId: string) {
      const delivered = poll();
      if (!('delivery' in delivered) || !delivered.delivery) throw Error('command not delivered');
      expect(delivered.delivery.commandId).toBe(commandId);
      const claim = { ...expected, panelId, commandId, claimToken: delivered.delivery.claimToken };
      expect(commands.admit(claim, binding).admitted).toBe(true);
      return claim;
    } };
}
describe('captured source allowance on rendering claims', () => {
  it('accepts a large-source render beyond 120 seconds within its advertised allowance', () => {
    const h = harness(300_000);
    expect(h.commands.enqueue(h.request('large'), binding, scene).renderBudgetMs).toBe(300_000);
    h.commands.setRenderBudget(120_000); // A later host setting cannot shorten the queued command.
    const claim = h.claim('large');
    h.at(124_000);
    expect(h.commands.summary(binding, 'large').command).toMatchObject({ status: 'rendering', budgetMs: 177_000, renderBudgetMs: 300_000 });
    expect(h.commands.summary(binding).panels).toHaveLength(1); // Claimed builds can suspend heartbeats.
    expect(h.commands.complete({ ...claim, scene: h.result('molecular-surface') }, binding))
      .toMatchObject({ accepted: true, command: { status: 'rendered', renderBudgetMs: 300_000 } });
  });
  it('keeps the default 120-second bound even if the host budget grows after enqueue', () => {
    const h = harness();
    h.commands.enqueue(h.request('default'), binding, scene);
    h.commands.setRenderBudget(300_000);
    const claim = h.claim('default');
    h.at(120_999);
    expect(h.commands.summary(binding, 'default').command).toMatchObject({ status: 'rendering', budgetMs: 1, renderBudgetMs: 120_000 });
    h.at(121_000);
    expect(h.commands.complete({ ...claim, scene: h.result('molecular-surface') }, binding))
      .toMatchObject({ accepted: false, command: { status: 'unconfirmed' } });
  });
  it('heartbeats and retries do not extend the deadline, and late acknowledgements stay refused', () => {
    const h = harness(300_000), request = h.request('bounded');
    h.commands.enqueue(request, binding, scene);
    const claim = h.claim('bounded');
    h.at(290_000); h.poll();
    expect(h.commands.enqueue(request, binding, scene).status).toBe('rendering');
    h.commands.setRenderBudget(420_000);
    h.at(301_000);
    for (let i = 0; i < 2; i++) expect(h.commands.complete({ ...claim, scene: h.result('molecular-surface') }, binding))
      .toMatchObject({ accepted: false, command: { status: 'unconfirmed', renderBudgetMs: 300_000 } });
  });
  it.each(['rendered', 'late'] as const)('uses the replacement command own captured allowance on superseded render transfer: %s', outcome => {
    const h = harness(130_000);
    h.commands.beginUtterance('first', [h.panelId], binding);
    h.commands.enqueue(h.request('old', 'molecular-surface', 'first'), binding, scene);
    const old = h.claim('old');
    h.at(2000);
    h.commands.beginUtterance('correction', [h.panelId], binding);
    h.commands.controlUtterance({ ...expected, panelId: h.panelId, commandId: 'correct', utteranceId: 'correction',
      change: { kind: 'utterance', patch: { action: 'correct' } } }, binding);
    h.commands.setRenderBudget(300_000);
    h.commands.enqueue(h.request('next', 'cartoon', 'correction'), binding, scene);
    h.commands.setRenderBudget(120_000);
    const transferred = h.commands.complete({ ...old, allowReplacement: true, scene: h.result('molecular-surface') }, binding);
    if (!('replacement' in transferred) || !transferred.replacement) throw Error('replacement was not transferred');
    const replacement = { ...expected, panelId: h.panelId, commandId: 'next', claimToken: transferred.replacement.claimToken };
    expect(h.commands.admit(replacement, binding).admitted).toBe(true);
    h.at(123_000);
    expect(h.commands.summary(binding, 'next').command).toMatchObject({ status: 'rendering', budgetMs: 179_000, renderBudgetMs: 300_000 });
    h.commands.complete({ ...old, allowReplacement: true, scene: h.result('molecular-surface') }, binding);
    if (outcome === 'rendered') {
      expect(h.commands.complete({ ...replacement, scene: h.result('cartoon') }, binding))
        .toMatchObject({ accepted: true, command: { status: 'rendered', renderBudgetMs: 300_000 } });
      return;
    }
    h.at(302_000);
    expect(h.commands.complete({ ...replacement, scene: h.result('cartoon') }, binding))
      .toMatchObject({ accepted: false, command: { status: 'unconfirmed', renderBudgetMs: 300_000 } });
  });
});
