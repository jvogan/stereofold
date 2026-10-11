import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStereoStructureServer } from '../src/server.js';
import { IMPLICIT_BINDING_NOTE } from '../src/inspection-contract.js';
import { sendAgentCall } from '../scripts/inspection-agent.js';
import { readControlState } from '../scripts/local-agent.js';
import { fakeAgentHost } from './helpers/fake-agent-host.js';
import {
  BINDING_FIELDS, bindingFieldsFor, choosePanel, commandReceiptOf, describeCommandOutcome, fillAgentArguments,
  IN_DETAILED_VIEW_MESSAGE, isPreDispatchRefusal, isReceiptPending, needsInspectionState, PANEL_BLUR_POLL_MS,
  PANEL_BLUR_WAIT_MS, PreDispatchRefusal, RECEIPT_PENDING, sentAfterBlurNote, shouldWaitOutBlur,
  TOOLS_NEEDING_COMMAND_ID, TOOLS_NEEDING_PANEL,
} from '../scripts/agent-arguments.js';

const state = {
  serverEpoch: '11111111-1111-4111-8111-111111111111',
  sourceToken: '22222222-2222-4222-8222-222222222222',
  stateRevision: 7,
  inspectionRevision: 3,
  panels: [
    { panelId: 'desk', surface: 'desktop', availability: 'ready', current: true },
    { panelId: 'quest', surface: 'companion', availability: 'ready', current: true },
  ],
};

/** What the packaged server actually advertises, so the written map cannot rot. */
async function advertisedRequirements() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer('/does-not-need-to-exist.html');
  const client = new Client({ name: 'Agent argument map test', version: '1' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    const requirements = new Map<string, Set<string>>();
    for (const tool of listed.tools) {
      const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, { description?: string }> } | undefined;
      // A field the host fills when it is left out is still one this CLI sends,
      // so an edit made over a stale view keeps being refused.
      const filled = Object.entries(schema?.properties ?? {})
        .filter(([, property]) => property?.description === IMPLICIT_BINDING_NOTE).map(([name]) => name);
      requirements.set(tool.name.replace('stereo_structure.', ''), new Set([...(schema?.required ?? []), ...filled]));
    }
    return requirements;
  } finally { await client.close(); await server.close(); }
}

describe('the binding fields a local tool call has to carry', () => {
  it('matches what every packaged tool requires, tool for tool', async () => {
    const advertised = await advertisedRequirements();
    const mismatched: string[] = [];
    for (const [name, required] of advertised) {
      const expectedBinding = BINDING_FIELDS.filter(field => required.has(field));
      const actualBinding = [...bindingFieldsFor(name)];
      if (JSON.stringify(expectedBinding) !== JSON.stringify(actualBinding)) mismatched.push(`${name} binding`);
      if (required.has('panelId') !== TOOLS_NEEDING_PANEL.has(name)) mismatched.push(`${name} panelId`);
      if (required.has('commandId') !== TOOLS_NEEDING_COMMAND_ID.has(name)) mismatched.push(`${name} commandId`);
    }
    expect(mismatched).toEqual([]);
  });

  it('reaches the Claude Code route as well as the two MCP hosts', async () => {
    // Codex desktop and Claude Science call dist/server.mjs directly, so a
    // model-visible registration is enough for them. The standalone host keeps
    // its own allowlist, and a tool missing from it is unreachable from a
    // terminal however it is registered.
    const host = await readFile(new URL('../scripts/serve-inspection.ts', import.meta.url), 'utf8');
    const permitted = host.match(/const permitted=new Set\(\[(.+?)\]\);/s)?.[1] ?? '';
    for (const name of ['open_detailed_view', 'import_detailed_view', 'say_to_headset', 'listen_voice',
      'open_companion', 'manage_companion', 'get_inspection_state', 'update_inspection', 'control_tour',
      'focus_selection', 'emphasize', 'get_readiness', 'grow_structure', 'read_headset_browser',
      'undo_last_change', 'redo_last_change']) {
      expect(permitted, name).toContain(`'${name}'`);
    }
  });

  it('names manage_companion as source-scoped rather than revision-scoped', () => {
    expect([...bindingFieldsFor('manage_companion')]).toEqual(['serverEpoch', 'sourceToken']);
    expect([...bindingFieldsFor('open_detailed_view')]).toEqual(BINDING_FIELDS);
    expect([...bindingFieldsFor('say_to_headset')]).toEqual([]);
    expect([...bindingFieldsFor('listen_voice')]).toEqual([]);
  });

  it('admits chunked hydration only through the authenticated panel route', async () => {
    const host = await readFile(new URL('../scripts/serve-inspection.ts', import.meta.url), 'utf8');
    const permitted = new Set([...host.match(/const permitted=new Set\(\[(.+?)\]\);/s)![1].matchAll(/'([^']+)'/g)].map(match => match[1]));
    const panelOnly = new Set([...host.match(/const panelOnly=new Set\(\[(.+?)\]\);/s)![1].matchAll(/'([^']+)'/g)].map(match => match[1]));
    const guard = host.match(/if\(!permitted\.has\(name\).*throw Error\('Tool unavailable'\);/)![0];
    const admit = new Function('req', 'name', 'permitted', 'panelOnly', guard);
    expect(() => admit({url:'/rpc'}, 'get_inspection_bytes', permitted, panelOnly)).not.toThrow();
    expect(() => admit({url:'/agent'}, 'get_inspection_bytes', permitted, panelOnly)).toThrow('Tool unavailable');
    expect(() => admit({url:'/rpc'}, 'unknown_tool', permitted, panelOnly)).toThrow('Tool unavailable');
    expect(() => admit({url:'/agent'}, 'get_inspection_state', permitted, panelOnly)).not.toThrow();
    // Both the desktop panel and a terminal agent must reach shared history.
    // Previously Undo reached MCP, while Redo failed this HTTP admission gate.
    for (const url of ['/rpc', '/agent']) for (const name of ['undo_last_change', 'redo_last_change'])
      expect(() => admit({url}, name, permitted, panelOnly), `${url}: ${name}`).not.toThrow();
  });

  it('asks for state only when something is actually missing', () => {
    expect(needsInspectionState('say_to_headset', {})).toBe(false);
    expect(needsInspectionState('open_detailed_view', {})).toBe(true);
    expect(needsInspectionState('open_detailed_view', {
      serverEpoch: 'a', sourceToken: 'b', baseStateRevision: 1, baseInspectionRevision: 2,
    })).toBe(false);
    expect(needsInspectionState('import_detailed_view', {
      serverEpoch: 'a', sourceToken: 'b', baseStateRevision: 1, baseInspectionRevision: 2,
    })).toBe(true);
  });
});

describe('filling a local tool call in from the current inspection state', () => {
  it('binds redo to the current headset revision and preserves its correction utterance', () => {
    const filled = fillAgentArguments('redo_last_change', { utteranceId: 'spoken-redo' }, state, () => 'redo-current');
    expect(filled.arguments).toEqual({ utteranceId: 'spoken-redo', serverEpoch: state.serverEpoch,
      sourceToken: state.sourceToken, baseStateRevision: 7, baseInspectionRevision: 3,
      panelId: 'quest', commandId: 'redo-current' });
    expect(filled.filled).toEqual([...BINDING_FIELDS, 'panelId', 'commandId']);
  });

  it('copies the four binding fields across under their argument names', () => {
    const filled = fillAgentArguments('open_detailed_view', { open: true }, state);
    expect(filled.arguments).toEqual({
      open: true, serverEpoch: state.serverEpoch, sourceToken: state.sourceToken,
      baseStateRevision: 7, baseInspectionRevision: 3,
    });
    expect(filled.filled).toEqual(BINDING_FIELDS);
  });

  it('leaves every value the caller supplied alone, including a deliberately stale one', () => {
    const filled = fillAgentArguments('open_detailed_view', { baseStateRevision: 1, sourceToken: 'mine' }, state);
    expect(filled.arguments.baseStateRevision).toBe(1);
    expect(filled.arguments.sourceToken).toBe('mine');
    expect(filled.arguments.baseInspectionRevision).toBe(3);
    expect(filled.filled).toEqual(['serverEpoch', 'baseInspectionRevision']);
  });

  it('adds a panel and a fresh command ID for a command that needs them', () => {
    const filled = fillAgentArguments('import_detailed_view', { filePath: '/tmp/x.molj' }, state, () => 'fixed-id');
    expect(filled.arguments.panelId).toBe('quest');
    expect(filled.arguments.commandId).toBe('fixed-id');
    expect(filled.filled).toContain('panelId');
    expect(filled.filled).toContain('commandId');
  });

  it('sends the command to the headset the wearer is looking through, not the desktop', () => {
    expect(choosePanel(state.panels)).toEqual({ panelId: 'quest' });
    expect(choosePanel([state.panels[0]])).toEqual({ panelId: 'desk' });
  });

  it('refuses to guess between two panels of the same surface', () => {
    const twin = [
      { panelId: 'a', surface: 'companion', availability: 'ready', current: true },
      { panelId: 'b', surface: 'companion', availability: 'ready', current: true },
    ];
    expect(choosePanel(twin)).toEqual({ error: expect.stringContaining('Name one with panelId') });
    expect(() => fillAgentArguments('update_inspection', {}, { ...state, panels: twin })).toThrow(/Name one with panelId/);
  });

  it('says what is wrong when no panel can take the command', () => {
    expect(choosePanel([])).toEqual({ error: expect.stringContaining('No panel is showing this inspection') });
    expect(choosePanel([{ panelId: 'a', surface: 'desktop', availability: 'busy', current: true }]))
      .toEqual({ error: expect.stringContaining('desktop busy') });
    expect(choosePanel([{ panelId: 'a', surface: 'desktop', availability: 'ready', current: false }]))
      .toEqual({ error: expect.stringContaining('No panel is showing this inspection') });
  });

  it('refuses to invent a binding the host did not report', () => {
    expect(() => fillAgentArguments('open_detailed_view', {}, { serverEpoch: 'a', sourceToken: 'b', stateRevision: 1 }))
      .toThrow(/did not report inspectionRevision/);
  });
});

describe('a headset panel that is blurred or away in Mol*', () => {
  const blurred = [{ panelId: 'headset', surface: 'companion', availability: 'busy', current: true }];

  it('targets a blurred companion rather than refusing the command', () => {
    expect(choosePanel(blurred)).toEqual({ panelId: 'headset', blurred: true });
    expect(fillAgentArguments('control_tour', { action: 'play' }, { ...state, panels: blurred }))
      .toMatchObject({ arguments: { panelId: 'headset' }, blurred: true });
  });

  it('prefers a ready panel and never targets unsaved work', () => {
    const mixed = [...blurred, { panelId: 'ready-one', surface: 'companion', availability: 'ready', current: true }];
    expect(choosePanel(mixed)).toEqual({ panelId: 'ready-one' });
    expect(choosePanel([{ panelId: 'headset', surface: 'companion', availability: 'unsaved', current: true }]))
      .toEqual({ error: expect.stringContaining('companion unsaved') });
  });

  it('will not guess between two blurred companions', () => {
    expect(choosePanel([...blurred, { panelId: 'second', surface: 'companion', availability: 'busy', current: true }]))
      .toEqual({ error: expect.stringContaining('companion busy, companion busy') });
  });

  it('waits out a blur for eight seconds and no longer', () => {
    expect(shouldWaitOutBlur({ blurred: true, waitedMs: 0 })).toBe(true);
    expect(shouldWaitOutBlur({ blurred: true, waitedMs: PANEL_BLUR_WAIT_MS - PANEL_BLUR_POLL_MS })).toBe(true);
    expect(shouldWaitOutBlur({ blurred: true, waitedMs: PANEL_BLUR_WAIT_MS })).toBe(false);
    expect(shouldWaitOutBlur({ blurred: false, waitedMs: 0 })).toBe(false);
  });

  it('says the command was sent after the blur, and does not claim it landed', () => {
    // It used to read "Applied after the headset view came back", which the
    // CLI could not know: sending a command returns a queued receipt.
    expect(sentAfterBlurNote(2_800)).toBe('Sent after the headset view came back (blurred for 2.8 s).');
    expect(sentAfterBlurNote(2_800)).not.toMatch(/applied/i);
  });
});

describe('command receipts', () => {
  it('keeps one pending vocabulary for the driver and the CLI', () => {
    expect([...RECEIPT_PENDING].sort()).toEqual(['claimed', 'queued', 'rendering']);
    expect(isReceiptPending('rendering')).toBe(true);
    expect(isReceiptPending('rendered')).toBe(false);
    expect(isReceiptPending(undefined)).toBe(false);
  });

  it('reads the receipt a command tool answered with, and nothing else', () => {
    expect(commandReceiptOf({ command: { commandId: 'c1', status: 'queued' } })).toEqual({ commandId: 'c1', status: 'queued' });
    expect(commandReceiptOf({ hasScene: true })).toBeUndefined();
    expect(commandReceiptOf({ command: null })).toBeUndefined();
    expect(commandReceiptOf(undefined)).toBeUndefined();
  });

  it('keeps rich rendered metadata when --wait follows the host receipt', async () => {
    let reads = 0;
    const geometryBudget = { representation: 'ball-and-stick', deviceClass: 'quest2', atoms: 4400,
      budget: 260000, requestedLevel: 'lower', level: 'lowest', estimatedVertices: 242880,
      message: 'Showing sticks at reduced detail so the headset stays smooth.' };
    const appliedTo = { scene: true, capturedAt: 90 };
    const finalReceipt = { commandId: 'rich-command', status: 'rendered', operation: { kind: 'appearance', tool: 'update_inspection' },
      acceptedAt: 100, renderedAt: 180, appliedTo, scaleAppliesOnNextEntry: true, geometryBudget };
    const host = await fakeAgentHost(call => {
      if (call.name === 'get_inspection_state') {
        reads += 1;
        const command = reads === 1 ? undefined
          : reads === 2 ? { ...finalReceipt, status: 'rendering' }
          : finalReceipt;
        return { content: [{ type: 'text', text: 'Stereofold inspection state.' }],
          structuredContent: { kind: 'inspection', sessionId: 'session-1', hasScene: true, ...state, ...(command ? { command } : {}) } };
      }
      return { content: [{ type: 'text', text: 'Inspection command queued.' }],
        structuredContent: { command: { commandId: 'rich-command', status: 'queued', acceptedAt: 100 } } };
    });
    try {
      const control = await readControlState(host.statePath);
      const outcome = await sendAgentCall(control, { name: 'update_inspection', wait: true,
        arguments: { commandId: 'rich-command', change: { kind: 'appearance', patch: { labels: true } } } },
        { pollMs: 1, timeoutMs: 5_000 });
      expect(outcome.receipt).toMatchObject(finalReceipt);
      expect(outcome.result.structuredContent.command).toMatchObject(finalReceipt);
      expect(host.calls.map(call => call.name)).toEqual(['get_inspection_state', 'update_inspection',
        'get_inspection_state', 'get_inspection_state']);
    } finally { await host.close(); }
  });

  it('says applied only for a rendered receipt', () => {
    expect(describeCommandOutcome({ commandId: 'c1', status: 'rendered' })).toBe('Applied: the panel rendered c1.');
  });

  it('never says applied while the panel is still queued or drawing', () => {
    const queued = describeCommandOutcome({ commandId: 'c1', status: 'queued' });
    expect(queued).not.toMatch(/^Applied/);
    expect(queued).toMatch(/Not applied yet/);
    expect(queued).toMatch(/get_inspection_state with commandId c1/);
    expect(describeCommandOutcome({ commandId: 'c1', status: 'rendering' })).toMatch(/the panel is drawing it \(rendering\)/);
  });

  it('says the wait ran out rather than reporting a change nobody saw', () => {
    const waited = describeCommandOutcome({ commandId: 'c1', status: 'rendering', waitedForReceiptMs: 60_000, timedOut: true });
    expect(waited).toMatch(/the wait ran out after 60.0 s/);
    expect(waited).not.toMatch(/^Applied/);
  });

  it('reports a refused or unconfirmed command as what it is', () => {
    expect(describeCommandOutcome({ commandId: 'c1', status: 'rejected', reason: 'no panel' }))
      .toBe('Not applied: the command is rejected c1 (no panel).');
    // `unconfirmed` also covers a panel that detached mid-render, so the copy
    // says "may have drawn" rather than asserting a draw took place.
    expect(describeCommandOutcome({ commandId: 'c1', status: 'unconfirmed' })).toMatch(/may have drawn c1 without confirming the save/);
  });

  it('says nothing at all when the tool returned no receipt', () => {
    expect(describeCommandOutcome({})).toBe('');
  });

  // The wearer is in a headset, looking at Mol*. "Open the printed address in
  // a browser" is an instruction they cannot follow and did not need.
  it('names the Mol* detail view instead of printing desktop instructions', () => {
    expect(choosePanel([], { companionInDetailedView: true }))
      .toEqual({ error: IN_DETAILED_VIEW_MESSAGE });
    expect(() => fillAgentArguments('control_tour', { action: 'play' },
      { ...state, panels: [], companionInDetailedView: true })).toThrow(/press Back to headset view/);
    expect(choosePanel([], { companionInDetailedView: false }))
      .toEqual({ error: expect.stringContaining('Open the printed address in a browser') });
  });

  // A desktop panel is almost always `ready`,
  // because nothing is happening on it. Ranking by readiness first therefore
  // handed the wearer's command to the Mac the moment the headset blurred or
  // stepped into Mol*, and the agent reported success for a change nobody in
  // the headset could see. Waiting for the headset, or saying why not, is the
  // only honest answer while there is a headset in the session.
  const desktopReady = { panelId: 'desk', surface: 'desktop', availability: 'ready' as const, current: true };

  it('waits for a blurred headset instead of applying the command to the Mac', () => {
    const panels = [desktopReady, { panelId: 'headset', surface: 'companion', availability: 'busy', current: true }];
    expect(choosePanel(panels)).toEqual({ panelId: 'headset', blurred: true });
    expect(fillAgentArguments('control_tour', { action: 'play' }, { ...state, panels }))
      .toMatchObject({ arguments: { panelId: 'headset' }, blurred: true });
  });

  it('refuses rather than driving the Mac while the wearer is in Mol*', () => {
    const panels = [desktopReady];
    expect(choosePanel(panels, { companionInDetailedView: true })).toEqual({ error: IN_DETAILED_VIEW_MESSAGE });
    expect(() => fillAgentArguments('focus_selection', {},
      { ...state, panels, companionInDetailedView: true })).toThrow(/press Back to headset view/);
    // A headset panel that is holding unsaved work is not a target either, and
    // the desktop sitting beside it does not become one.
    expect(choosePanel([desktopReady, { panelId: 'headset', surface: 'companion', availability: 'unsaved', current: true }]))
      .toEqual({ error: expect.stringContaining('companion unsaved') });
  });

  /**
   * The wearer asked to
   * load an `http://` URL while the companion panel was unsaved, and heard
   * "No panel is ready for a command right now (companion unsaved, desktop
   * ready)". The panel was consulted before the request, so the insecure-URL
   * refusal was never reached.
   */
  it('refuses an insecure URL by name even when no panel could have drawn it', () => {
    const wedged = [desktopReady, { panelId: 'headset', surface: 'companion', availability: 'unsaved', current: true }];
    // The panel is exactly as stuck as it was on the headset that day.
    expect(choosePanel(wedged)).toEqual({ error: expect.stringContaining('companion unsaved') });
    for (const source of [{ kind: 'url', url: 'http://example.com/model.pdb' },
      { kind: 'url', url: 'https://user:secret@example.com/model.cif' }]) {
      expect(() => fillAgentArguments('replace_inspection_source', { source }, { ...state, panels: wedged }))
        .toThrow(/Insecure URLs and embedded credentials are refused\./);
    }
    // A request this surface would have honoured still reports on the panel.
    expect(() => fillAgentArguments('replace_inspection_source', { pdbId: '4HHB' }, { ...state, panels: wedged }))
      .toThrow(/No panel is ready for a command right now \(desktop ready, companion unsaved\)/);
    // And a valid request on a ready panel is filled exactly as before.
    expect(fillAgentArguments('replace_inspection_source', { pdbId: '4HHB' }, state))
      .toMatchObject({ arguments: { pdbId: '4HHB' } });
  });

  it('still uses the desktop when the session has no headset in it', () => {
    expect(choosePanel([desktopReady])).toEqual({ panelId: 'desk' });
    // Nor does a detail-view flag left over from a closed headset strand a
    // desktop-only session with nothing it can drive.
    expect(choosePanel([desktopReady], { companionInDetailedView: false })).toEqual({ panelId: 'desk' });
  });
});

/**
 * The refusal the wearer never saw.
 *
 * An earlier run made this surface turn an insecure URL down before it consults a panel,
 * so the wearer is told about the URL rather than about a busy panel. On the
 * Quest 2 that refusal reached the agent terminal and nothing
 * else: no card, no outcome record, nothing where the wearer was looking
 */
describe('a refusal raised before dispatch', () => {
  const insecure = { kind: 'url', url: 'http://example.test/model.cif' };

  it('is tagged as a refusal of the request, not of this surface’s state', () => {
    let raised: unknown;
    try { fillAgentArguments('replace_inspection_source', { source: insecure }, state); }
    catch (error) { raised = error; }
    expect(isPreDispatchRefusal(raised)).toBe(true);
    expect((raised as PreDispatchRefusal).tool).toBe('replace_inspection_source');
    expect((raised as Error).message).toMatch(/Insecure URLs and embedded credentials are refused\./);
    // A panel refusal is a different thing and stays untagged.
    let panelError: unknown;
    try {
      fillAgentArguments('replace_inspection_source', { pdbId: '4HHB' },
        { ...state, panels: [{ panelId: 'quest', surface: 'companion', availability: 'unsaved', current: true }] });
    } catch (error) { panelError = error; }
    expect(isPreDispatchRefusal(panelError)).toBe(false);
  });

  it('is told to the headset once, and still refuses the call it was raised for', async () => {
    const host = await fakeAgentHost(call => {
      if (call.name === 'get_inspection_state') {
        return { content: [{ type: 'text', text: 'Stereofold inspection state.' }],
          structuredContent: { kind: 'inspection', sessionId: 'session-1', hasScene: true, ...state } };
      }
      return { content: [{ type: 'text', text: 'Queued for the headset.' }], structuredContent: { queued: true } };
    });
    try {
      const control = await readControlState(host.statePath);
      const utteranceId = '33333333-3333-4333-8333-333333333333';
      await expect(sendAgentCall(control, { name: 'replace_inspection_source',
        arguments: { source: insecure, utteranceId } }, { pollMs: 1, timeoutMs: 50 }))
        .rejects.toThrow(/Insecure URLs and embedded credentials are refused\./);
      const reported = host.calls.filter(call => call.name === 'say_to_headset');
      expect(reported).toHaveLength(1);
      expect(reported[0].arguments).toMatchObject({
        refusal: { tool: 'replace_inspection_source', sessionId: 'session-1' }, utteranceId });
      expect(reported[0].arguments.text).toMatch(/Insecure URLs and embedded credentials are refused\./);
      // The refused request itself never reached the host.
      expect(host.calls.some(call => call.name === 'replace_inspection_source')).toBe(false);
    } finally { await host.close(); }
  });

  it('never lets a reporting failure replace the host’s own sentence', async () => {
    const host = await fakeAgentHost(call => {
      if (call.name === 'get_inspection_state') {
        return { content: [{ type: 'text', text: 'Stereofold inspection state.' }],
          structuredContent: { kind: 'inspection', sessionId: 'session-1', hasScene: true, ...state } };
      }
      throw Error('This host is too old to report a refusal.');
    });
    try {
      const control = await readControlState(host.statePath);
      await expect(sendAgentCall(control, { name: 'replace_inspection_source', arguments: { source: insecure } },
        { pollMs: 1, timeoutMs: 50 })).rejects.toThrow(/Insecure URLs and embedded credentials are refused\./);
      expect(host.calls.map(call => call.name)).toEqual(['get_inspection_state', 'say_to_headset']);
    } finally { await host.close(); }
  });
});
