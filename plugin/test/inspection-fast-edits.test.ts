import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY, expectedInspection } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { inspectionFailureReceipt } from '../src/inspection-failure-receipt.js';

// A dictated edit has to be one call: no state read first, no binding to copy,
// no residue keys to page through, and the receipt in the same answer. 4HHB is
// the structure one headset run spent four minutes coloring.
const cif = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');

async function setup(options: Parameters<typeof createStereoStructureServer>[1] = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // A running wearer session on this Mac must not change a test's expiry
  // result or receive any synthetic shared-scene work.
  const server = createStereoStructureServer(undefined, { ...options,
    sceneServiceFile: options.sceneServiceFile ?? join(tmpdir(), `stereofold-fast-edits-${randomUUID()}.json`) });
  const client = new Client({ name: 'Stereofold fast edits test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  const privateData = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  // Past the inline bound the catalog rides as a compressed wire.
  const catalog = privateData.catalog ?? await decodeInspectionCatalog(privateData.catalogWire);
  const rows = catalog.rows as any[];
  const scene = {
    sourceSha256: catalog.source.sha256,
    modelNumber: catalog.modelNumbers[0],
    assemblyId: catalog.assemblyId,
    selectionKeys: [] as string[],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const opened = { sessionId, serverEpoch: privateData.serverEpoch, sourceToken: privateData.sourceToken,
    baseStateRevision: privateData.stateRevision, baseInspectionRevision: privateData.inspectionRevision };
  const saved = (await call('sync_inspection', { ...opened, scene })).structuredContent;
  const live = { ...opened, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await call('attach_inspection', { ...live, surface: 'companion' })).structuredContent.panelId as string;
  const advance = (value: any) => {
    if (typeof value?.stateRevision === 'number') live.baseStateRevision = value.stateRevision;
    if (typeof value?.inspectionRevision === 'number') live.baseInspectionRevision = value.inspectionRevision;
    return value;
  };
  let shown: any = scene;
  const heartbeat = () => call('poll_inspection', { ...live, panelId, availability: 'ready' });
  /** Claim the queued command the way the headset page does, waiting for it to be queued. */
  const claim = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const delivery = (await heartbeat())._meta?.[PRIVATE_KEY]?.delivery;
      if (delivery) return delivery;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error('No command reached the panel.');
  };
  /** Draw exactly what the command asked for, then say ready again. */
  const render = async (delivery: any) => {
    shown = expectedInspection(shown, delivery.change);
    const receipt = advance((await call('complete_inspection', { ...live, panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, scene: shown })).structuredContent);
    await heartbeat();
    return receipt;
  };
  /** Refuse the command the way the panel does, with its own sentence. */
  const fail = async (delivery: any, failureReason: string) => {
    await call('complete_inspection', { ...live, panelId, commandId: delivery.commandId,
      claimToken: delivery.claimToken, failure: 'render_failed', failureReason });
    await heartbeat();
  };
  const state = async () => advance((await call('get_inspection_state', { sessionId })).structuredContent);
  const manual = async (change: any) => {
    shown = expectedInspection(shown, change);
    const saved = advance((await call('sync_inspection', { ...live, scene: shown })).structuredContent);
    expect(saved.saved).toBe(true);
    await heartbeat();
  };
  return { call, rows, sessionId, panelId, claim, render, fail, state, manual, heartbeat,
    get binding() { return { ...live }; },
    get scene() { return structuredClone(shown); },
    close: async () => { await client.close(); await server.close(); } };
}

const chainA = (rows: any[]) => rows.filter(row => row.identity.labelChain === 'A'
  && row.identity.modelNumber === rows[0].identity.modelNumber);
const orangeA = { kind: 'appearance', residues: { labelChain: 'A' }, patch: { color: 'uniform', uniformColor: '#ff8800' } };

describe('one-call edits for a dictating agent', () => {
  it('refuses a named headset outside the LAN route before sharing', async () => {
    const t = await setup();
    try {
      for (const args of [
        { headset: 'meta' }, { headset: 'apple' },
        { headset: 'meta', connection: 'https' }, { headset: 'apple', connection: 'https' },
      ]) {
        const answer = await t.call('open_companion', { sessionId: t.sessionId, ...args });
        expect(answer.isError).toBe(true);
        expect(answer.content[0].text).toContain('A named headset needs a LAN connection');
      }
    } finally { await t.close(); }
  });

  it('returns a pending companion result while a hydrated panel is still drawing', async () => {
    const t = await setup();
    try {
      const sessionId = (await t.call('inspect', { structureText: cif })).structuredContent.sessionId;
      await t.call('get_inspection', { sessionId });
      vi.useFakeTimers();
      const args = { sessionId, waitForSceneMs: 130_000 };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const waiting = t.call('open_companion', args);
        await vi.advanceTimersByTimeAsync(40_100);
        const answer = await waiting;
        expect(answer.isError).not.toBe(true);
        expect(answer.structuredContent).toMatchObject({ sharePending: { status: 'rendering', nextCall: 'open_companion' } });
        expect(answer.structuredContent.companion).toBeUndefined();
      }
    } finally { vi.useRealTimers(); await t.close(); }
  });
  it('fills an omitted binding with the current revisions, the wearer panel and a new commandId', async () => {
    const t = await setup();
    try {
      const queued = await t.call('update_inspection', { sessionId: t.sessionId, change: { kind: 'appearance', patch: { opacity: 0.5 } } });
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent.command).toMatchObject({ status: 'queued', panelId: t.panelId });
      expect(queued.structuredContent.command.commandId).toMatch(/^auto-[0-9a-f]{8}$/);
      const delivery = await t.claim();
      expect(delivery.change).toEqual({ kind: 'appearance', patch: { opacity: 0.5 } });
      expect((await t.render(delivery)).command.status).toBe('rendered');
    } finally { await t.close(); }
  });

  it('still refuses a binding the caller sent when it is stale', async () => {
    const t = await setup();
    try {
      const now = await t.state();
      const stale = await t.call('update_inspection', { sessionId: t.sessionId, serverEpoch: now.serverEpoch, sourceToken: now.sourceToken,
        baseStateRevision: now.stateRevision, baseInspectionRevision: now.inspectionRevision - 1, panelId: t.panelId,
        commandId: 'stale', change: { kind: 'appearance', patch: { opacity: 0.5 } } });
      expect(stale.isError).toBe(true);
      expect(stale.content[0].text).toMatch(/current saved revisions/);
    } finally { await t.close(); }
  });

  it('returns the original receipt on an exact retry with omitted bindings after a newer edit', async () => {
    const t = await setup();
    try {
      const request = { sessionId: t.sessionId, commandId: 'retry-implicit', change: orangeA };
      expect((await t.call('update_inspection', request)).isError).not.toBe(true);
      const original = await t.render(await t.claim());
      await t.manual({ kind: 'appearance', patch: { opacity: 0.4 } });
      const before = await t.state();
      const retried = await t.call('update_inspection', request);
      expect(retried.isError).not.toBe(true);
      expect(retried.structuredContent.command).toEqual(original.command);
      expect((await t.state()).inspectionRevision).toBe(before.inspectionRevision);
      expect((await t.state()).pendingCommand).toEqual([]);
      expect((await t.state()).view.appearance.opacity).toBe(0.4);
    } finally { await t.close(); }
  });

  it('keeps retries bound after panel detach, and rejects changed arguments or tool names', async () => {
    const t = await setup();
    try {
      const request = { sessionId: t.sessionId, change: orangeA };
      const accepted = await t.call('update_inspection', request);
      const commandId = accepted.structuredContent.command.commandId;
      const original = await t.render(await t.claim());
      await t.call('detach_inspection', { ...t.binding, panelId: t.panelId });
      const retried = await t.call('update_inspection', { ...request, commandId });
      expect(retried.isError).not.toBe(true);
      expect(retried.structuredContent.command).toEqual(original.command);
      for (const [tool, args] of [
        ['update_inspection', { ...request, commandId, change: { kind: 'appearance', patch: { opacity: 0.3 } } }],
        ['update_inspection', { ...request, commandId, panelId: t.panelId }],
        ['undo_last_change', { sessionId: t.sessionId, commandId }],
      ] as const) {
        const refused = await t.call(tool, args);
        expect(refused.isError).toBe(true);
        expect(refused.content[0].text).toMatch(/different request/);
      }
    } finally { await t.close(); }
  });

  it('does not re-resolve an implicit focus or undo against newer manual work', async () => {
    const t = await setup();
    try {
      await t.manual({ kind: 'selection', patch: { selectionKeys: [t.rows[0].key] } });
      const focus = { sessionId: t.sessionId, commandId: 'retry-focus' };
      await t.call('focus_selection', focus);
      const focused = await t.render(await t.claim());
      await t.manual({ kind: 'selection', patch: { selectionKeys: [] } });
      expect((await t.call('focus_selection', focus)).structuredContent.command).toEqual(focused.command);
      expect((await t.state()).view.selectedResidueCount).toBe(0);
      const undo = { sessionId: t.sessionId, commandId: 'retry-undo' };
      await t.call('undo_last_change', undo);
      const undone = await t.render(await t.claim());
      await t.manual({ kind: 'appearance', patch: { opacity: 0.3 } });
      expect((await t.call('undo_last_change', undo)).structuredContent.command).toEqual(undone.command);
      expect((await t.state()).view.appearance.opacity).toBe(0.3);
      expect((await t.state()).pendingCommand).toEqual([]);
    } finally { await t.close(); }
  });

  it.each([false, true])('keeps a successful no-op undo unchanged after manual work (explicit binding %s)', async explicit => {
    const t = await setup();
    try {
      const request = { ...(explicit ? { ...t.binding, panelId: t.panelId } : { sessionId: t.sessionId }), commandId: 'noop-undo' };
      const first = await t.call('undo_last_change', request);
      expect(first.structuredContent).toMatchObject({ undone: false, commandId: 'noop-undo' });
      await t.manual({ kind: 'appearance', patch: { opacity: 0.3 } });
      const before = await t.state();
      const retry = await t.call('undo_last_change', request);
      expect(retry.isError).not.toBe(true);
      expect(retry.structuredContent.undone).toBe(false);
      expect(retry.structuredContent.command).toBeUndefined();
      const after = await t.state();
      expect(after.inspectionRevision).toBe(before.inspectionRevision);
      expect(after.view.appearance.opacity).toBe(0.3);
      expect(after.pendingCommand).toEqual([]);
      for (const [tool, args] of [
        ['undo_last_change', { ...request, waitForRenderMs: 1 }],
        ['update_inspection', { sessionId: t.sessionId, commandId: 'noop-undo', change: orangeA }],
        ['update_inspection', { sessionId: t.sessionId, commandId: 'noop-undo', change: { kind: 'utterance', patch: { action: 'begin' } } }],
      ] as const) {
        const refused = await t.call(tool, args);
        expect(refused.isError).toBe(true);
        expect(refused.content[0].text).toMatch(/different request/);
      }
      expect((await t.state()).pendingCommand).toEqual([]);
    } finally { await t.close(); }
  });

  it('returns a generated no-op undo ID and refuses to reuse it after pruning', async () => {
    const t = await setup();
    try {
      const request = { sessionId: t.sessionId };
      const first = await t.call('undo_last_change', request), commandId = first.structuredContent.commandId;
      expect(commandId).toMatch(/^auto-/);
      expect((await t.call('undo_last_change', { ...request, commandId })).structuredContent.undone).toBe(false);
      for (let i = 0; i < 33; i++)
        expect((await t.call('undo_last_change', { ...request, commandId: `noop-${i}` })).structuredContent.undone).toBe(false);
      await t.manual({ kind: 'appearance', patch: { opacity: 0.3 } });
      const retry = await t.call('undo_last_change', { ...request, commandId });
      expect(retry.isError).toBe(true);
      expect(retry.content[0].text).toMatch(/receipt has expired from history/);
      expect((await t.state()).pendingCommand).toEqual([]);
      expect((await t.state()).view.appearance.opacity).toBe(0.3);
    } finally { await t.close(); }
  });

  it('never reuses a no-op undo after queue replacement or session expiry', async () => {
    let now = Date.now();
    const t = await setup({ now: () => now, sessionTtlMs: 60_000 });
    try {
      const request = { sessionId: t.sessionId, commandId: 'noop-before-reset' };
      expect((await t.call('undo_last_change', request)).structuredContent.undone).toBe(false);
      const opened = await t.call('open', { sessionId: t.sessionId, source: { kind: 'pasted', text: cif, format: 'mmcif' } });
      expect(opened.isError).not.toBe(true);
      const retry = await t.call('undo_last_change', request);
      expect(retry.isError).toBe(true);
      expect(retry.content[0].text).toMatch(/receipt has expired from history/);
      now += 61_000;
      const expired = await t.call('undo_last_change', request);
      expect(expired.isError).toBe(true);
      expect(expired.content[0].text).toMatch(/session.*expired/i);
    } finally { await t.close(); }
  });

  it('returns the original source receipt after a source replacement without painting the new source', async () => {
    const t = await setup();
    try {
      const request = { sessionId: t.sessionId, commandId: 'before-source-swap', change: orangeA };
      await t.call('update_inspection', request);
      const original = await t.render(await t.claim()), originalToken = t.binding.sourceToken;
      const swapped = await t.call('replace_inspection_source', { sessionId: t.sessionId,
        source: { kind: 'pasted', text: await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8'), format: 'mmcif' } });
      expect(swapped.isError).not.toBe(true);
      expect(swapped.structuredContent.sourceToken).not.toBe(originalToken);
      const retried = await t.call('update_inspection', request);
      expect(retried.isError).not.toBe(true);
      expect(retried.structuredContent.command).toEqual(original.command);
      expect(retried.structuredContent.commandReplay).toMatchObject({ currentSource: false, originalBinding: { sourceToken: originalToken } });
      expect(retried.content[0].text).toContain('earlier source');
      expect((await t.state()).pendingCommand).toEqual([]);
    } finally { await t.close(); }
  });

  it('refuses an old retry after direct same-session open replaces its queue', async () => {
    const t = await setup();
    try {
      const request = { sessionId: t.sessionId, commandId: 'before-direct-open', change: orangeA };
      await t.call('update_inspection', request);
      await t.render(await t.claim());
      const text = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
      const opened = await t.call('open', { sessionId: t.sessionId, source: { kind: 'pasted', text, format: 'mmcif' } });
      expect(opened.isError).not.toBe(true);
      const retried = await t.call('update_inspection', request);
      expect(retried.isError).toBe(true);
      expect(retried.content[0].text).toMatch(/receipt has expired from history/);
      expect((await t.state()).pendingCommand).toEqual([]);
    } finally { await t.close(); }
  });

  it('follows an in-flight retry to the same receipt without duplicating the command', async () => {
    const t = await setup();
    try {
      const request = { sessionId: t.sessionId, commandId: 'retry-wait', change: orangeA, waitForRenderMs: 5000 };
      const first = t.call('update_inspection', request);
      const delivery = await t.claim();
      const retry = t.call('update_inspection', request);
      await t.render(delivery);
      expect((await first).structuredContent.command.status).toBe('rendered');
      const second = await retry;
      expect(second.structuredContent.command.status).toBe('rendered');
      expect(second.content[0].text).not.toMatch(/command queued/);
      expect((await t.state()).commands).toHaveLength(1);
    } finally { await t.close(); }
  });

  it('retains an expired receipt and refuses retries after that receipt is pruned', async () => {
    let now = Date.now();
    const t = await setup({ now: () => now });
    try {
      const request = { sessionId: t.sessionId, commandId: 'expired-retry', change: orangeA };
      await t.call('update_inspection', request);
      for (let i = 0; i < 7; i++) {
        now += 2_000;
        await t.call('poll_inspection', { ...t.binding, panelId: t.panelId, availability: 'busy' });
      }
      now += 2_000;
      expect((await t.call('update_inspection', request)).structuredContent.command.status).toBe('expired');
      await t.heartbeat();
      for (let i = 0; i < 33; i++) {
        await t.call('update_inspection', { sessionId: t.sessionId, commandId: `new-${i}`,
          change: { kind: 'appearance', patch: { opacity: i % 2 ? 0.3 : 0.7 } } });
        await t.render(await t.claim());
      }
      const before = await t.state();
      const pruned = await t.call('update_inspection', request);
      expect(pruned.isError).toBe(true);
      expect(pruned.content[0].text).toMatch(/receipt has expired from history/);
      expect((await t.state()).inspectionRevision).toBe(before.inspectionRevision);
      expect((await t.state()).pendingCommand).toEqual([]);
    } finally { await t.close(); }
  });

  it('keeps command IDs local to their session and refuses an expired session before replay', async () => {
    let now = Date.now();
    const t = await setup({ now: () => now, sessionTtlMs: 60_000 });
    try {
      const request = { sessionId: t.sessionId, commandId: 'session-local', change: orangeA };
      await t.call('update_inspection', request);
      const original = await t.render(await t.claim());
      const sessionId = (await t.call('inspect', { structureText: cif })).structuredContent.sessionId;
      const opened = (await t.call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
      const binding = { sessionId, serverEpoch: opened.serverEpoch, sourceToken: opened.sourceToken,
        baseStateRevision: opened.stateRevision, baseInspectionRevision: opened.inspectionRevision };
      const saved = (await t.call('sync_inspection', { ...binding, scene: t.scene })).structuredContent;
      binding.baseInspectionRevision = saved.inspectionRevision;
      await t.call('attach_inspection', { ...binding, surface: 'desktop' });
      const other = await t.call('update_inspection', { ...request, sessionId });
      expect(other.isError).not.toBe(true);
      expect(other.structuredContent.command.status).toBe('queued');
      expect(other.structuredContent.command.panelId).not.toBe(original.command.panelId);
      expect(other.structuredContent.commandReplay).toBeUndefined();
      now += 61_000;
      const expired = await t.call('update_inspection', request);
      expect(expired.isError).toBe(true);
      expect(expired.content[0].text).toMatch(/session.*expired/i);
    } finally { await t.close(); }
  });

  it('reports a detached pending command as conflict without targeting a replacement panel', async () => {
    const t = await setup();
    try {
      const request = { sessionId: t.sessionId, commandId: 'pending-detach', change: orangeA };
      await t.call('update_inspection', request);
      await t.call('detach_inspection', { ...t.binding, panelId: t.panelId });
      const next = await t.call('attach_inspection', { ...t.binding, surface: 'companion' });
      const retry = await t.call('update_inspection', request);
      expect(retry.isError).not.toBe(true);
      expect(retry.structuredContent.command).toMatchObject({ status: 'conflict', panelId: t.panelId });
      const beat = await t.call('poll_inspection', { ...t.binding, panelId: next.structuredContent.panelId, availability: 'ready' });
      expect(beat._meta[PRIVATE_KEY].delivery).toBeUndefined();
    } finally { await t.close(); }
  });

  it('colors a whole chain from its letter, without the agent handling a key', async () => {
    const t = await setup();
    try {
      const queued = await t.call('update_inspection', { sessionId: t.sessionId, change: orangeA });
      expect(queued.isError).not.toBe(true);
      expect(queued.structuredContent.style.confirmation).toBe(`Colour changed on ${chainA(t.rows).length} residues.`);
      const delivery = await t.claim();
      expect(delivery.change.kind).toBe('styles');
      expect(new Set(delivery.change.patch.selectionKeys)).toEqual(new Set(chainA(t.rows).map(row => row.key)));
      expect(chainA(t.rows).length).toBe(141);
      await t.render(delivery);
      const view = (await t.state()).view;
      // Twenty amino acid types is past the component bound, so only the chain is named.
      expect(view.styles).toEqual([{ color: 'uniform', uniformColor: '#ff8800', residueCount: 141, labelChains: ['A'] }]);
      expect(JSON.stringify(view.styles).length).toBeLessThan(400);
    } finally { await t.close(); }
  });

  it('names a component or a class the way a person does', async () => {
    const t = await setup();
    try {
      const hemes = t.rows.filter(row => row.identity.componentId === 'HEM');
      const waters = t.rows.filter(row => row.entityType === 'water');
      expect(hemes.length).toBe(4);
      expect(waters.length).toBeGreaterThan(0);
      await t.call('update_inspection', { sessionId: t.sessionId, change: { kind: 'appearance', residues: { componentId: 'HEM' },
        patch: { representation: 'sticks' } } });
      const sticks = await t.claim();
      expect([...sticks.change.patch.selectionKeys].sort()).toEqual(hemes.map(row => row.key).sort());
      expect(sticks.change.patch.style).toEqual({ representation: 'ball-and-stick' });
      await t.render(sticks);
      await t.call('update_inspection', { sessionId: t.sessionId, change: { kind: 'appearance', residues: { classes: ['water'] },
        patch: { opacity: 0.2 } } });
      const faded = await t.claim();
      expect(faded.change.patch.selectionKeys).toHaveLength(waters.length);
      await t.render(faded);
      await t.call('update_inspection', { sessionId: t.sessionId, change: { kind: 'selection', patch: { residues: { componentId: 'HEM' } } } });
      const selected = await t.claim();
      expect([...selected.change.patch.selectionKeys].sort()).toEqual(hemes.map(row => row.key).sort());
    } finally { await t.close(); }
  });

  it('folds several region styles into one render and one undo', async () => {
    const t = await setup();
    try {
      const queued = await t.call('update_inspection', { sessionId: t.sessionId, change: { kind: 'compound', patch: { ops: [
        orangeA,
        { kind: 'appearance', residues: { labelChain: 'B' }, patch: { color: 'uniform', uniformColor: '#0088ff' } },
      ] } } });
      expect(queued.isError).not.toBe(true);
      const delivery = await t.claim();
      expect(delivery.change.kind).toBe('styles');
      expect(delivery.change.patch.styles.map((style: any) => [style.uniformColor, style.selectionKeys.length]).sort())
        .toEqual([['#0088ff', 146], ['#ff8800', 141]]);
      await t.render(delivery);
      expect((await t.call('undo_last_change', { sessionId: t.sessionId })).isError).not.toBe(true);
      const undo = await t.claim();
      expect(undo.change).toMatchObject({ kind: 'styles', patch: { styles: [] } });
    } finally { await t.close(); }
  });

  it('refuses a region the model does not have, by name', async () => {
    const t = await setup();
    try {
      const missing = await t.call('update_inspection', { sessionId: t.sessionId,
        change: { kind: 'appearance', residues: { labelChain: 'Z' }, patch: { opacity: 0.5 } } });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toMatch(/No residue in this model matches labelChain Z\./);
    } finally { await t.close(); }
  });

  it('returns the rendered receipt in the same call when asked to wait', async () => {
    const t = await setup();
    try {
      const waiting = t.call('update_inspection', { sessionId: t.sessionId, change: orangeA, waitForRenderMs: 5000 });
      await t.render(await t.claim());
      const answer = await waiting;
      expect(answer.structuredContent.command.status).toBe('rendered');
      expect(answer.content[0].text).toMatch(/rendered and saved/);
      expect(answer.content[0].text).not.toMatch(/Check get_inspection_state/);
      const focus = t.call('focus_selection', { sessionId: t.sessionId, residues: { componentId: 'HEM' }, waitForRenderMs: 5000 });
      await t.render(await t.claim());
      expect((await focus).structuredContent.command.status).toBe('rendered');
    } finally { await t.close(); }
  });

  it('names the panel\'s reason when a waited edit fails to render', async () => {
    // Claude Science shows the model only this text. With `render_failed`
    // alone, one agent had to guess why "color chain A red" failed.
    const t = await setup();
    try {
      const waiting = t.call('update_inspection', { sessionId: t.sessionId, change: orangeA, waitForRenderMs: 5000 });
      await t.fail(await t.claim(), 'This representation does not apply to the selected residues.');
      const answer = await waiting;
      expect(answer.structuredContent.command.status).toBe('rejected');
      expect(answer.content[0].text).toMatch(/It did not render: render_failed\. The panel said: This representation does not apply to the selected residues\.$/);
    } finally { await t.close(); }
  });

  it('returns a typed complete geometry refusal through waited receipts and idempotent confirmation', async () => {
    const t = await setup();
    try {
      const reason = 'Requested ball-and-stick for the complete assembly exceeds the headset geometry budget. '
        + 'The affected authored components are ' + Array.from({length:90},(_,i)=>`custom-chain-${i}`).join(', ')
        + '. Keep the requested scientific assembly; retry this whole view on the desktop, or explicitly choose a cheaper representation.';
      expect(reason.length).toBeGreaterThan(600);
      const refusal=inspectionFailureReceipt(Object.assign(Error(reason),{code:'representation_budget_exceeded'}));
      const waiting=t.call('update_inspection',{sessionId:t.sessionId,change:orangeA,waitForRenderMs:5000});
      const delivery=await t.claim();
      const request={...t.binding,panelId:t.panelId,commandId:delivery.commandId,claimToken:delivery.claimToken,...refusal};
      const oversized=await t.call('complete_inspection',{...request,failureReason:reason.repeat(12)});
      expect(oversized.isError).toBe(true);
      const first=await t.call('complete_inspection',request);
      expect(first.structuredContent.command).toMatchObject({status:'rejected',reason:'representation_budget_exceeded',detail:reason});
      const repeated=await t.call('complete_inspection',request);
      expect(repeated.structuredContent.command).toEqual(first.structuredContent.command);
      const answer=await waiting;
      expect(answer.structuredContent.command).toMatchObject({reason:'representation_budget_exceeded',detail:reason});
      expect(answer.content[0].text).toContain('It did not render: representation_budget_exceeded. The panel said: '+reason);
      await t.heartbeat();
      const following=t.call('update_inspection',{sessionId:t.sessionId,change:orangeA,waitForRenderMs:5000});
      await t.render(await t.claim());
      expect((await following).structuredContent.command.status).toBe('rendered');
    } finally { await t.close(); }
  });

  it('says so when the wait ends before the panel renders', async () => {
    const t = await setup();
    try {
      const answer = await t.call('update_inspection', { sessionId: t.sessionId, change: orangeA, waitForRenderMs: 150 });
      expect(answer.structuredContent.command.status).toMatch(/^(queued|rendering)$/);
      expect(answer.content[0].text).toMatch(/wait ended before the render did/);
    } finally { await t.close(); }
  });

  it('caps a requested edit receipt wait at 40 seconds', async () => {
    const t = await setup();
    vi.useFakeTimers();
    try {
      const waiting = t.call('update_inspection', { sessionId: t.sessionId, change: orangeA, waitForRenderMs: 120_000 });
      await vi.advanceTimersByTimeAsync(40_100);
      const answer = await waiting;
      expect(answer.structuredContent.command.status).toMatch(/^(queued|rendering)$/);
      expect(answer.content[0].text).toMatch(/wait ended before the render did/);
    } finally { vi.useRealTimers(); await t.close(); }
  });
});

describe('what an agent host keeps of each tool', () => {
  // Claude Code keeps the first 2,048 characters of a tool description and
  // drops the rest; one headset run lost update_inspection's chain guidance
  // at character 6,162. Rules that do not fit ride on the input schema.
  it('fits every model-visible description in 2,048 characters', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer();
    const client = new Client({ name: 'Stereofold description bound', version: '1' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const visible = tools.filter(tool => ((tool as any)._meta?.ui?.visibility ?? ['model']).includes('model'));
      expect(visible.length).toBeGreaterThan(30);
      const over = visible.filter(tool => (tool.description ?? '').length > 2048)
        .map(tool => `${tool.name} (${tool.description!.length})`);
      expect(over).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });
});
