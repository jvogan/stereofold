import { EventEmitter } from 'node:events';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { announceHostReadiness, closeOnSignal, createStereoStructureServer, hostReadinessLines, isDirectServerEntryPoint,
  type StereoStructureServerOptions } from '../src/server.js';
import { PRIVATE_STRUCTURE_META_KEY } from '../src/structure-result.js';
import { MINIMAL_DIAGNOSTICS } from './fixtures/diagnostics.js';

const pluginRoot = new URL('..', import.meta.url);
const SESSION_A_TEXT = 'ATOM      1  N   GLY A   1       1.000   2.000   3.000  1.00 10.00           N\nEND\n';
const SESSION_B_TEXT = 'ATOM      1  N   ALA B   2       9.000   8.000   7.000  1.00 11.00           N\nEND\n';
const MMCIF_A_TEXT = 'data_slow\n#\nloop_\n_atom_site.group_PDB\nATOM\n#\n';
const MMCIF_B_TEXT = 'data_fast\n#\nloop_\n_atom_site.group_PDB\nATOM\n#\n';

type ToolResult = {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
};

type PrivateStructure = {
  kind: 'structure';
  sessionId: string;
  empty: boolean;
  structureText?: string;
  format?: 'pdb' | 'mmcif';
  pdbId?: string;
  fixture?: 'three-depth-markers';
  [key: string]: unknown;
};

function sessionId(result: ToolResult): string {
  const value = (result.structuredContent as { sessionId?: unknown } | undefined)?.sessionId;
  expect(typeof value).toBe('string');
  return value as string;
}

/** Server-issued ordering marker for a structure-bearing render result. */
function renderToken(result: ToolResult): number {
  const value = (result.structuredContent as { renderToken?: unknown } | undefined)?.renderToken;
  expect(typeof value).toBe('number');
  expect(Number.isSafeInteger(value)).toBe(true);
  expect((value as number) > 0).toBe(true);
  return value as number;
}

/** Per-session safe-state freshness marker on every render-affecting snapshot. */
function stateRevision(result: ToolResult): number {
  const value = (result.structuredContent as { stateRevision?: unknown } | undefined)?.stateRevision;
  expect(typeof value).toBe('number');
  expect(Number.isSafeInteger(value)).toBe(true);
  expect((value as number) >= 0).toBe(true);
  return value as number;
}

/** Random server lifecycle UUID scopes render/state counters across restarts. */
function serverEpoch(result: ToolResult): string {
  const value = (result.structuredContent as { serverEpoch?: unknown } | undefined)?.serverEpoch;
  expect(typeof value).toBe('string');
  expect(value).toMatch(/^[0-9a-f-]{36}$/i);
  return value as string;
}

function actionId(result: ToolResult): string {
  const value = (result.structuredContent as { actionId?: unknown } | undefined)?.actionId;
  expect(typeof value).toBe('string');
  return value as string;
}

/** The only coordinate-bearing payload is component-private MCP metadata. */
function privateStructure(result: ToolResult): PrivateStructure {
  const payload = result._meta?.[PRIVATE_STRUCTURE_META_KEY];
  expect(payload).toBeTypeOf('object');
  expect(payload).not.toBeNull();
  return payload as PrivateStructure;
}

function expectNoCoordinatesInPublicResult(result: ToolResult, coordinates: string): void {
  expect((result.structuredContent as { structureText?: unknown } | undefined)?.structureText).toBeUndefined();
  expect(JSON.stringify(result.content) ?? '').not.toContain(coordinates);
  expect(JSON.stringify(result.structuredContent) ?? '').not.toContain(coordinates);
}

async function connectedServer(options: StereoStructureServerOptions = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(new URL('./does-not-need-to-exist.html', pluginRoot).pathname, options);
  const client = new Client({ name: 'Stereofold server contract test', version: '0.1.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

async function openPasted(client: Client, structureText = SESSION_A_TEXT): Promise<{ result: ToolResult; sessionId: string }> {
  const result = await client.callTool({
    name: 'stereo_structure.open',
    arguments: { structureText, format: 'pdb' },
  }) as ToolResult;
  expect(result.isError).not.toBe(true);
  return { result, sessionId: sessionId(result) };
}

function uiResourceUri(tool: { _meta?: Record<string, unknown> }): unknown {
  const ui = tool._meta?.ui as { resourceUri?: unknown } | undefined;
  return ui?.resourceUri ?? tool._meta?.['ui/resourceUri'];
}

describe('Stereofold server contracts', () => {
  it('recognizes a direct server launch through a symlinked parent directory', async () => {
    const sourcePath = fileURLToPath(new URL('../src/server.ts', import.meta.url));
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'stereofold-entry-'));
    try {
      const linkedParent = join(temporaryRoot, 'linked-src');
      await symlink(dirname(sourcePath), linkedParent, 'dir');
      const argvAlias = join(linkedParent, 'server.ts');
      expect(isDirectServerEntryPoint(argvAlias, pathToFileURL(sourcePath).href)).toBe(true);
      expect(isDirectServerEntryPoint(undefined, pathToFileURL(sourcePath).href)).toBe(false);
      expect(isDirectServerEntryPoint(join(temporaryRoot, 'missing.mjs'), pathToFileURL(sourcePath).href)).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('closes the server before a signal ends it, once, and gives a hung close a grace', async () => {
    vi.useFakeTimers();
    try {
      const target = new EventEmitter(), raised: string[] = [];
      let finish!: () => void;
      const close = vi.fn(() => new Promise<void>(done => { finish = done; }));
      closeOnSignal(close, { target: target as any, raise: signal => { raised.push(signal); } });
      target.emit('SIGTERM', 'SIGTERM');
      // A host's follow-up SIGTERM, or a Ctrl-C, must not start a second close or cut this one short.
      target.emit('SIGTERM', 'SIGTERM');
      target.emit('SIGINT', 'SIGINT');
      expect(close).toHaveBeenCalledTimes(1);
      expect(raised).toEqual([]);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(raised).toEqual(['SIGTERM']);
      expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map(name => target.listenerCount(name))).toEqual([0, 0, 0]);

      const hung = new EventEmitter(), late: string[] = [];
      closeOnSignal(() => new Promise(() => undefined), { target: hung as any, graceMs: 3_000, raise: signal => { late.push(signal); } });
      hung.emit('SIGINT', 'SIGINT');
      await vi.advanceTimersByTimeAsync(2_999);
      expect(late).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(late).toEqual(['SIGINT']);
    } finally { vi.useRealTimers(); }
  });

  it('isolates two explicit sessions and refuses unknown-session reads', async () => {
    const { client, server } = await connectedServer();
    try {
      const first = await openPasted(client, SESSION_A_TEXT);
      const second = await openPasted(client, SESSION_B_TEXT);
      expect(first.sessionId).not.toBe(second.sessionId);
      expect(renderToken(second.result)).toBeGreaterThan(renderToken(first.result));

      await client.callTool({
        name: 'stereo_structure.sync_view',
        arguments: { sessionId: first.sessionId, mode: 'cross', depthBudgetArcmin: 41, color: 'element-symbol' },
      });

      const firstState = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: first.sessionId } }) as ToolResult;
      const secondState = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: second.sessionId } }) as ToolResult;
      expect(firstState.structuredContent).toMatchObject({ sessionId: first.sessionId, mode: 'cross', depthBudgetArcmin: 41, color: 'element-symbol' });
      expect(secondState.structuredContent).toMatchObject({ sessionId: second.sessionId, mode: 'off', depthBudgetArcmin: 20, color: 'chain-id' });

      const firstStructure = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: first.sessionId } }) as ToolResult;
      const secondStructure = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: second.sessionId } }) as ToolResult;
      expect(firstStructure.structuredContent).toMatchObject({ kind: 'structure', sessionId: first.sessionId, empty: false, stateRevision: 1 });
      expect(secondStructure.structuredContent).toMatchObject({ kind: 'structure', sessionId: second.sessionId, empty: false, stateRevision: 0 });
      expect(privateStructure(firstStructure)).toMatchObject({ sessionId: first.sessionId, structureText: SESSION_A_TEXT });
      expect(privateStructure(secondStructure)).toMatchObject({ sessionId: second.sessionId, structureText: SESSION_B_TEXT });

      const unknown = await client.callTool({
        name: 'stereo_structure.get_structure',
        arguments: { sessionId: '00000000-0000-4000-8000-000000000000' },
      }) as ToolResult;
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown)).not.toContain(SESSION_A_TEXT);
      expect(JSON.stringify(unknown)).not.toContain(SESSION_B_TEXT);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('does not expose coordinates through model-visible results and hydrates them only app-side', async () => {
    const { client, server } = await connectedServer();
    try {
      const { result: opened, sessionId: id } = await openPasted(client, SESSION_A_TEXT);
      const epoch = serverEpoch(opened);
      const control = await client.callTool({ name: 'stereo_structure.control', arguments: { sessionId: id, action: 'set_look', color: 'sequence-id' } }) as ToolResult;
      const state = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: id } }) as ToolResult;
      const mode = await client.callTool({ name: 'stereo_structure.set_mode', arguments: { sessionId: id, mode: 'parallel' } }) as ToolResult;
      const motion = await client.callTool({ name: 'stereo_structure.set_motion', arguments: { sessionId: id, mode: 'spin' } }) as ToolResult;
      const view = await client.callTool({
        name: 'stereo_structure.sync_view',
        arguments: { sessionId: id, depthBudgetArcmin: 31 },
      }) as ToolResult;
      const diagnostics = await client.callTool({
        name: 'stereo_structure.report_diagnostics',
        arguments: { sessionId: id, diagnostics: MINIMAL_DIAGNOSTICS },
      }) as ToolResult;

      // App-only access control is not a confidentiality boundary: test every
      // result shape, including app calls, for public coordinate exposure.
      for (const result of [opened, control, state, mode, motion, view, diagnostics]) {
        expectNoCoordinatesInPublicResult(result, SESSION_A_TEXT);
        expect(serverEpoch(result)).toBe(epoch);
      }

      // A rejected model-visible call must not reflect its supplied coordinate
      // text through a Zod/MCP validation error either.
      const rejected = await client.callTool({
        name: 'stereo_structure.open',
        arguments: { structureText: SESSION_A_TEXT, fixture: 'three-depth-markers' },
      }) as ToolResult;
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected.content) ?? '').not.toContain(SESSION_A_TEXT);
      expect(JSON.stringify(rejected.structuredContent) ?? '').not.toContain(SESSION_A_TEXT);

      const hydrated = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: id } }) as ToolResult;
      expectNoCoordinatesInPublicResult(hydrated, SESSION_A_TEXT);
      expect(hydrated.structuredContent).toMatchObject({ kind: 'structure', sessionId: id, serverEpoch: epoch, empty: false, stateRevision: expect.any(Number) });
      expect(privateStructure(hydrated)).toMatchObject({ sessionId: id, serverEpoch: epoch, structureText: SESSION_A_TEXT });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('publishes monotonic state revisions and rejects stale full-state sync writes', async () => {
    const { client, server } = await connectedServer();
    try {
      const opened = await openPasted(client);
      const initialRevision = stateRevision(opened.result);
      const parallel = await client.callTool({
        name: 'stereo_structure.set_mode',
        arguments: { sessionId: opened.sessionId, mode: 'parallel' },
      }) as ToolResult;
      const parallelRevision = stateRevision(parallel);
      expect(parallelRevision).toBeGreaterThan(initialRevision);

      // This delayed panel payload was captured before the model’s parallel
      // mutation. Reject it rather than merging a whole stale view snapshot.
      const conflict = await client.callTool({
        name: 'stereo_structure.sync_view',
        arguments: {
          sessionId: opened.sessionId,
          baseStateRevision: initialRevision,
          mode: 'off',
          color: 'element-symbol',
        },
      }) as ToolResult;
      expect(conflict.structuredContent).toMatchObject({
        kind: 'view',
        conflict: true,
        mode: 'parallel',
        stateRevision: parallelRevision,
      });

      const current = await client.callTool({
        name: 'stereo_structure.sync_view',
        arguments: {
          sessionId: opened.sessionId,
          baseStateRevision: parallelRevision,
          mode: 'off',
        },
      }) as ToolResult;
      expect(current.structuredContent).toMatchObject({ kind: 'view', mode: 'off' });
      expect(current.structuredContent).not.toHaveProperty('conflict');
      expect(stateRevision(current)).toBeGreaterThan(parallelRevision);
      const currentState = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: opened.sessionId } }) as ToolResult;
      expect(currentState.structuredContent).toMatchObject({ mode: 'off', stateRevision: stateRevision(current) });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('advertises the runtime union schemas exactly and gives a resourceUri only to open', async () => {
    const { client, server } = await connectedServer();
    try {
      const listed = await client.listTools();
      const open = listed.tools.find((tool) => tool.name === 'stereo_structure.open');
      const control = listed.tools.find((tool) => tool.name === 'stereo_structure.control');
      const claimAction = listed.tools.find((tool) => tool.name === 'stereo_structure.claim_action');
      const completeAction = listed.tools.find((tool) => tool.name === 'stereo_structure.complete_action');
      const inspect = listed.tools.find((tool) => tool.name === 'stereo_structure.inspect');
      const replace = listed.tools.find((tool) => tool.name === 'stereo_structure.replace_inspection_source');
      expect(open).toBeDefined();
      expect(control).toBeDefined();
      expect(claimAction).toBeDefined();
      expect(completeAction).toBeDefined();
      expect(inspect?.annotations).toMatchObject({ destructiveHint: false, openWorldHint: true });
      expect(replace?.annotations).toMatchObject({ destructiveHint: true });
      expect(open?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(control?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });

      // Runtime refuses surrounding whitespace, and the actual descriptor
      // advertises the same four-character accession pattern to planners.
      const openPdbId = (open?.inputSchema as { properties?: { pdbId?: unknown } }).properties?.pdbId;
      const controlPdbId = (control?.inputSchema as { properties?: { pdbId?: unknown } }).properties?.pdbId;
      for (const schema of [openPdbId, controlPdbId]) {
        expect(schema).toMatchObject({ type: 'string', pattern: '^[0-9A-Za-z]{4}$' });
      }

      const openAlternatives = (open?.inputSchema as { anyOf?: Array<{ required?: string[]; additionalProperties?: unknown }> }).anyOf;
      expect(openAlternatives).toHaveLength(5);
      expect(openAlternatives?.map((branch) => branch.required)).toEqual(expect.arrayContaining([
        ['source'],
        ['pdbId'],
        ['structureText'],
        ['fixture'],
        ['sessionId'],
      ]));
      expect(openAlternatives?.every((branch) => branch.additionalProperties === false)).toBe(true);

      const controlAlternatives = (control?.inputSchema as { anyOf?: Array<{ required?: string[]; additionalProperties?: unknown }> }).anyOf;
      expect(controlAlternatives).toHaveLength(7);
      expect(controlAlternatives?.every((branch) => branch.required?.includes('sessionId') && branch.required.includes('action') && branch.additionalProperties === false)).toBe(true);
      expect(controlAlternatives?.some((branch) => branch.required?.includes('pdbId'))).toBe(true);
      expect(controlAlternatives?.some((branch) => branch.required?.includes('color'))).toBe(true);
      expect(controlAlternatives?.some((branch) => branch.required?.includes('style'))).toBe(true);

      const { sessionId: id } = await openPasted(client);
      const badOpen = await client.callTool({
        name: 'stereo_structure.open',
        arguments: { pdbId: '1CRN', fixture: 'three-depth-markers' },
      }) as ToolResult;
      const badControl = await client.callTool({
        name: 'stereo_structure.control',
        arguments: { sessionId: id, action: 'fit', pdbId: '1CRN' },
      }) as ToolResult;
      expect(badOpen.isError).toBe(true);
      expect(badControl.isError).toBe(true);

      const renderTools = listed.tools.filter((tool) => uiResourceUri(tool) != null).map((tool) => tool.name);
      expect(renderTools).toEqual(['stereo_structure.open', 'stereo_structure.inspect_file', 'stereo_structure.inspect_scene', 'stereo_structure.inspect_lesson', 'stereo_structure.inspect', 'stereo_structure.inspect_experience']);
      const syncView = listed.tools.find((tool) => tool.name === 'stereo_structure.sync_view');
      expect((syncView?.inputSchema as { properties?: { baseStateRevision?: unknown } }).properties?.baseStateRevision)
        .toMatchObject({ type: 'integer', minimum: 0 });
      for (const actionTool of [claimAction, completeAction]) {
        expect((actionTool?.inputSchema as { additionalProperties?: unknown; required?: string[]; properties?: { renderToken?: unknown } })).toMatchObject({
          additionalProperties: false,
          required: ['sessionId', 'actionId', 'renderToken'],
          properties: { renderToken: { type: 'integer', minimum: 1 } },
        });
      }

      for (const name of ['stereo_structure.control', 'stereo_structure.get_state', 'stereo_structure.set_mode', 'stereo_structure.set_motion', 'stereo_structure.claim_action', 'stereo_structure.complete_action']) {
        const tool = listed.tools.find((candidate) => candidate.name === name);
        expect(uiResourceUri(tool ?? {})).toBeUndefined();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps reset/fit pending through concurrent opens until the latest leased action is acknowledged', async () => {
    const { client, server } = await connectedServer();
    try {
      const { sessionId: id } = await openPasted(client);
      const reset = await client.callTool({
        name: 'stereo_structure.control',
        arguments: { sessionId: id, action: 'reset_camera' },
      }) as ToolResult;
      expect(reset.structuredContent).toMatchObject({ kind: 'control', action: 'reset_camera', sessionId: id });
      expect((await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: id } }) as ToolResult).structuredContent)
        .not.toHaveProperty('action');
      const resetStructure = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: id } }) as ToolResult;
      expect(resetStructure.structuredContent).not.toHaveProperty('action');
      expect(privateStructure(resetStructure)).not.toHaveProperty('action');

      // Both concurrent render results carry the same action identity. Merely
      // constructing an open never consumes it. A newer render lease wins
      // even if the host delivers B before A; completion, not claim, clears it.
      const [resetA, resetB] = await Promise.all([
        client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: id } }) as Promise<ToolResult>,
        client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: id } }) as Promise<ToolResult>,
      ]);
      expect(resetA.structuredContent).toMatchObject({ kind: 'open', action: 'reset_camera', sessionId: id });
      expect(resetB.structuredContent).toMatchObject({ kind: 'open', action: 'reset_camera', sessionId: id });
      const resetActionId = actionId(resetA);
      expect(actionId(resetB)).toBe(resetActionId);
      const resetLow = renderToken(resetA) < renderToken(resetB) ? resetA : resetB;
      const resetHigh = resetLow === resetA ? resetB : resetA;
      // A render token is not a caller-chosen capability. It must be one that
      // this action actually advertised with an open result.
      const forgedResetClaim = await client.callTool({
        name: 'stereo_structure.claim_action',
        arguments: { sessionId: id, actionId: resetActionId, renderToken: Number.MAX_SAFE_INTEGER },
      }) as ToolResult;
      expect(forgedResetClaim.structuredContent).toMatchObject({ kind: 'action_claim', claimed: false });
      const resetClaimHigh = await client.callTool({
        name: 'stereo_structure.claim_action',
        arguments: { sessionId: id, actionId: resetActionId, renderToken: renderToken(resetHigh) },
      }) as ToolResult;
      const resetClaimLow = await client.callTool({
        name: 'stereo_structure.claim_action',
        arguments: { sessionId: id, actionId: resetActionId, renderToken: renderToken(resetLow) },
      }) as ToolResult;
      expect(resetClaimHigh.structuredContent).toMatchObject({ kind: 'action_claim', claimed: true, action: 'reset_camera', actionId: resetActionId });
      expect(resetClaimLow.structuredContent).toMatchObject({ kind: 'action_claim', claimed: false });
      const stillPendingReset = await client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: id } }) as ToolResult;
      expect(stillPendingReset.structuredContent).toMatchObject({ action: 'reset_camera', actionId: resetActionId });
      const resetComplete = await client.callTool({
        name: 'stereo_structure.complete_action',
        arguments: { sessionId: id, actionId: resetActionId, renderToken: renderToken(resetHigh) },
      }) as ToolResult;
      expect(resetComplete.structuredContent).toMatchObject({ kind: 'action_complete', completed: true, action: 'reset_camera', actionId: resetActionId });
      const afterReset = await client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: id } }) as ToolResult;
      expect(afterReset.structuredContent).not.toHaveProperty('action');

      await client.callTool({
        name: 'stereo_structure.control',
        arguments: { sessionId: id, action: 'fit' },
      });
      const fitState = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: id } }) as ToolResult;
      const fitStructure = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: id } }) as ToolResult;
      expect(fitState.structuredContent).not.toHaveProperty('action');
      expect(fitStructure.structuredContent).not.toHaveProperty('action');
      expect(privateStructure(fitStructure)).not.toHaveProperty('action');
      // A source-bearing replacement advertises the same claimable action too.
      const replayFit = await client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId: id, fixture: 'three-depth-markers' },
      }) as ToolResult;
      expect(replayFit.structuredContent).toMatchObject({ kind: 'open', action: 'fit', sessionId: id });
      const fitActionId = actionId(replayFit);
      // These source-free opens overlap at their await boundary. Each token
      // must be registered before a claim, even if one completion reaches the
      // session store after the other. A claims first; B later supersedes it.
      const [replayFitA, replayFitB] = await Promise.all([
        client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: id } }) as Promise<ToolResult>,
        client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: id } }) as Promise<ToolResult>,
      ]);
      expect(actionId(replayFitA)).toBe(fitActionId);
      expect(actionId(replayFitB)).toBe(fitActionId);
      const fitLow = renderToken(replayFitA) < renderToken(replayFitB) ? replayFitA : replayFitB;
      const fitHigh = fitLow === replayFitA ? replayFitB : replayFitA;
      const fitClaimLow = await client.callTool({
        name: 'stereo_structure.claim_action',
        arguments: { sessionId: id, actionId: fitActionId, renderToken: renderToken(fitLow) },
      }) as ToolResult;
      const fitClaimHigh = await client.callTool({
        name: 'stereo_structure.claim_action',
        arguments: { sessionId: id, actionId: fitActionId, renderToken: renderToken(fitHigh) },
      }) as ToolResult;
      expect(fitClaimLow.structuredContent).toMatchObject({ kind: 'action_claim', claimed: true, action: 'fit', actionId: fitActionId });
      expect(fitClaimHigh.structuredContent).toMatchObject({ kind: 'action_claim', claimed: true, action: 'fit', actionId: fitActionId });
      const staleFitComplete = await client.callTool({
        name: 'stereo_structure.complete_action',
        arguments: { sessionId: id, actionId: fitActionId, renderToken: renderToken(fitLow) },
      }) as ToolResult;
      expect(staleFitComplete.structuredContent).toMatchObject({ kind: 'action_complete', completed: false });
      const stillPendingFit = await client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: id } }) as ToolResult;
      expect(stillPendingFit.structuredContent).toMatchObject({ action: 'fit', actionId: fitActionId });
      const fitComplete = await client.callTool({
        name: 'stereo_structure.complete_action',
        arguments: { sessionId: id, actionId: fitActionId, renderToken: renderToken(fitHigh) },
      }) as ToolResult;
      expect(fitComplete.structuredContent).toMatchObject({ kind: 'action_complete', completed: true, action: 'fit', actionId: fitActionId });
      const afterFit = await client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: id } }) as ToolResult;
      expect(afterFit.structuredContent).not.toHaveProperty('action');

      // If the higher result never reaches a viewer, the lower valid lease is
      // still allowed to finish and clear the action rather than stranding it.
      await client.callTool({
        name: 'stereo_structure.control',
        arguments: { sessionId: id, action: 'reset_camera' },
      });
      const [fallbackA, fallbackB] = await Promise.all([
        client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: id } }) as Promise<ToolResult>,
        client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: id } }) as Promise<ToolResult>,
      ]);
      const fallbackActionId = actionId(fallbackA);
      expect(actionId(fallbackB)).toBe(fallbackActionId);
      const fallbackLow = renderToken(fallbackA) < renderToken(fallbackB) ? fallbackA : fallbackB;
      const fallbackClaim = await client.callTool({
        name: 'stereo_structure.claim_action',
        arguments: { sessionId: id, actionId: fallbackActionId, renderToken: renderToken(fallbackLow) },
      }) as ToolResult;
      expect(fallbackClaim.structuredContent).toMatchObject({ kind: 'action_claim', claimed: true, action: 'reset_camera', actionId: fallbackActionId });
      const fallbackComplete = await client.callTool({
        name: 'stereo_structure.complete_action',
        arguments: { sessionId: id, actionId: fallbackActionId, renderToken: renderToken(fallbackLow) },
      }) as ToolResult;
      expect(fallbackComplete.structuredContent).toMatchObject({ kind: 'action_complete', completed: true, action: 'reset_camera', actionId: fallbackActionId });
      const afterFallback = await client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: id } }) as ToolResult;
      expect(afterFallback.structuredContent).not.toHaveProperty('action');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps a previous structure/state intact when injected PDB fetch fails', async () => {
    const requested: string[] = [];
    const { client, server } = await connectedServer({
      fetchPdbText: async (pdbId) => {
        requested.push(pdbId);
        throw new Error(`test fetch failed for ${pdbId}`);
      },
    });
    try {
      const { sessionId: id } = await openPasted(client, SESSION_A_TEXT);
      await client.callTool({
        name: 'stereo_structure.sync_view',
        arguments: { sessionId: id, mode: 'anaglyph', color: 'secondary-structure', motion: { mode: 'parallax' } },
      });
      const before = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: id } }) as ToolResult;

      const failed = await client.callTool({
        name: 'stereo_structure.control',
        arguments: { sessionId: id, action: 'load_pdb', pdbId: '1crn' },
      }) as ToolResult;
      expect(failed.isError).toBe(true);
      expect(requested).toEqual(['1CRN']);

      const after = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: id } }) as ToolResult;
      const state = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: id } }) as ToolResult;
      expect(after.structuredContent).toEqual(before.structuredContent);
      expect(privateStructure(after)).toEqual(privateStructure(before));
      expect(state.structuredContent).toMatchObject({ mode: 'anaglyph', color: 'secondary-structure', motion: { mode: 'parallax' } });
      expect(state.structuredContent).not.toHaveProperty('pdbId');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects malformed resolved PDB payloads without changing the prior cache or state', async () => {
    const malformed = '<html><body>not an mmCIF response</body></html>';
    const { client, server } = await connectedServer({
      fetchPdbText: async () => malformed,
    });
    try {
      const { sessionId: id } = await openPasted(client, SESSION_A_TEXT);
      await client.callTool({
        name: 'stereo_structure.sync_view',
        arguments: { sessionId: id, mode: 'cross', color: 'element-symbol', motion: { mode: 'spin', axis: 'x' } },
      });
      const before = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: id } }) as ToolResult;

      const control = await client.callTool({
        name: 'stereo_structure.control',
        arguments: { sessionId: id, action: 'load_pdb', pdbId: '1crn' },
      }) as ToolResult;
      const open = await client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId: id, pdbId: '2xyz' },
      }) as ToolResult;
      expect(control.isError).toBe(true);
      expect(open.isError).toBe(true);

      const after = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: id } }) as ToolResult;
      const state = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: id } }) as ToolResult;
      expect(after.structuredContent).toEqual(before.structuredContent);
      expect(privateStructure(after)).toEqual(privateStructure(before));
      expect(state.structuredContent).toMatchObject({ mode: 'cross', color: 'element-symbol', motion: { mode: 'spin', axis: 'x' } });
      expect(state.structuredContent).not.toHaveProperty('pdbId');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('preserves concurrent session syncs when either PDB-loading route commits', async () => {
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const firstText = deferred<string>();
    const secondText = deferred<string>();
    let fetchCount = 0;
    const { client, server } = await connectedServer({
      fetchPdbText: async () => {
        const index = fetchCount;
        fetchCount += 1;
        if (index === 0) {
          firstStarted.resolve();
          return await firstText.promise;
        }
        secondStarted.resolve();
        return await secondText.promise;
      },
    });
    try {
      const controlSession = await openPasted(client, SESSION_A_TEXT);
      const controlLoad = client.callTool({
        name: 'stereo_structure.control',
        arguments: { sessionId: controlSession.sessionId, action: 'load_pdb', pdbId: '1crn' },
      });
      await firstStarted.promise;
      await client.callTool({
        name: 'stereo_structure.sync_view',
        arguments: { sessionId: controlSession.sessionId, mode: 'cross', color: 'secondary-structure', style: 'atomic-detail' },
      });
      firstText.resolve(MMCIF_B_TEXT);
      expect((await controlLoad as ToolResult).isError).not.toBe(true);
      const controlState = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: controlSession.sessionId } }) as ToolResult;
      expect(controlState.structuredContent).toMatchObject({ pdbId: '1CRN', mode: 'cross', color: 'secondary-structure', style: 'atomic-detail' });
      expect(privateStructure(await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: controlSession.sessionId } }) as ToolResult))
        .toMatchObject({ structureText: MMCIF_B_TEXT, pdbId: '1CRN' });

      const openSession = await openPasted(client, SESSION_A_TEXT);
      const opening = client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId: openSession.sessionId, pdbId: '2xyz', color: 'element-symbol' },
      });
      await secondStarted.promise;
      await client.callTool({
        name: 'stereo_structure.sync_view',
        arguments: { sessionId: openSession.sessionId, mode: 'anaglyph', style: 'molecular-surface' },
      });
      secondText.resolve(MMCIF_B_TEXT);
      expect((await opening as ToolResult).isError).not.toBe(true);
      const openState = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: openSession.sessionId } }) as ToolResult;
      // Explicit open appearance wins only for the field it named; the app's
      // concurrent mode/style sync survives the fetch commit.
      expect(openState.structuredContent).toMatchObject({ pdbId: '2XYZ', mode: 'anaglyph', color: 'element-symbol', style: 'molecular-surface' });
      expect(privateStructure(await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: openSession.sessionId } }) as ToolResult))
        .toMatchObject({ structureText: MMCIF_B_TEXT, pdbId: '2XYZ' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('makes source-free renders wait for an in-flight PDB source instead of snapshotting old coordinates', async () => {
    const started = new Map<string, ReturnType<typeof deferred<void>>>();
    const responses = new Map<string, ReturnType<typeof deferred<string>>>();
    for (const pdbId of ['1CRN', '2XYZ']) {
      started.set(pdbId, deferred<void>());
      responses.set(pdbId, deferred<string>());
    }
    const { client, server } = await connectedServer({
      fetchPdbText: async (pdbId) => {
        started.get(pdbId)?.resolve();
        const response = responses.get(pdbId);
        if (response == null) throw new Error(`Unexpected PDB ${pdbId}`);
        return await response.promise;
      },
    });
    try {
      const controlSession = await openPasted(client, SESSION_A_TEXT);
      const controlLoad = client.callTool({
        name: 'stereo_structure.control',
        arguments: { sessionId: controlSession.sessionId, action: 'load_pdb', pdbId: '1crn' },
      }) as Promise<ToolResult>;
      await started.get('1CRN')?.promise;
      const controlRender = client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId: controlSession.sessionId },
      }) as Promise<ToolResult>;
      responses.get('1CRN')?.resolve(MMCIF_A_TEXT);
      const [loadedByControl, renderedAfterControl] = await Promise.all([controlLoad, controlRender]);
      expect(renderToken(renderedAfterControl)).toBeGreaterThan(renderToken(loadedByControl));
      expect(renderedAfterControl.structuredContent).toMatchObject({ pdbId: '1CRN', hasStructure: true });
      expect(privateStructure(await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: controlSession.sessionId } }) as ToolResult))
        .toMatchObject({ structureText: MMCIF_A_TEXT, pdbId: '1CRN' });

      const openSession = await openPasted(client, SESSION_A_TEXT);
      const sourceOpen = client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId: openSession.sessionId, pdbId: '2xyz' },
      }) as Promise<ToolResult>;
      await started.get('2XYZ')?.promise;
      const sourceFree = client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId: openSession.sessionId },
      }) as Promise<ToolResult>;
      responses.get('2XYZ')?.resolve(MMCIF_B_TEXT);
      const [loadedByOpen, renderedAfterOpen] = await Promise.all([sourceOpen, sourceFree]);
      expect(renderToken(renderedAfterOpen)).toBeGreaterThan(renderToken(loadedByOpen));
      expect(renderedAfterOpen.structuredContent).toMatchObject({ pdbId: '2XYZ', hasStructure: true });
      expect(privateStructure(await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: openSession.sessionId } }) as ToolResult))
        .toMatchObject({ structureText: MMCIF_B_TEXT, pdbId: '2XYZ' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('allocates render tokens in call order even when PDB opens resolve out of order', async () => {
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const firstText = deferred<string>();
    const secondText = deferred<string>();
    let fetches = 0;
    const { client, server } = await connectedServer({
      fetchPdbText: async () => {
        fetches += 1;
        if (fetches === 1) {
          firstStarted.resolve();
          return await firstText.promise;
        }
        secondStarted.resolve();
        return await secondText.promise;
      },
    });
    try {
      // A gets token 1 but stays in-flight. B gets token 2 and finishes first.
      const olderA = client.callTool({
        name: 'stereo_structure.open',
        arguments: { pdbId: '1crn' },
      });
      await firstStarted.promise;
      const newerB = client.callTool({
        name: 'stereo_structure.open',
        arguments: { pdbId: '2xyz' },
      });
      await secondStarted.promise;
      secondText.resolve(MMCIF_B_TEXT);
      const resultB = await newerB as ToolResult;
      firstText.resolve(MMCIF_A_TEXT);
      const resultA = await olderA as ToolResult;

      expect(resultA.isError).not.toBe(true);
      expect(resultB.isError).not.toBe(true);
      expect(renderToken(resultA)).toBeLessThan(renderToken(resultB));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps the latest-invoked source when an older PDB fetch completes last', async () => {
    const started = new Map<string, ReturnType<typeof deferred<void>>>();
    const responses = new Map<string, ReturnType<typeof deferred<string>>>();
    for (const pdbId of ['1CRN', '2XYZ', '3DEF', '4GHI']) {
      started.set(pdbId, deferred<void>());
      responses.set(pdbId, deferred<string>());
    }
    const { client, server } = await connectedServer({
      fetchPdbText: async (pdbId) => {
        started.get(pdbId)?.resolve();
        const response = responses.get(pdbId);
        if (response == null) throw new Error(`Unexpected test PDB ${pdbId}`);
        return await response.promise;
      },
    });
    try {
      const initial = await openPasted(client, SESSION_A_TEXT);

      // Cross-route race: control starts first, then the later render source
      // must win even if the first fetch is the last to resolve.
      const slowControl = client.callTool({
        name: 'stereo_structure.control',
        arguments: { sessionId: initial.sessionId, action: 'load_pdb', pdbId: '1crn' },
      });
      await started.get('1CRN')?.promise;
      const laterOpen = client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId: initial.sessionId, pdbId: '2xyz' },
      });
      await started.get('2XYZ')?.promise;
      responses.get('2XYZ')?.resolve(MMCIF_B_TEXT);
      expect((await laterOpen as ToolResult).isError).not.toBe(true);
      responses.get('1CRN')?.resolve(MMCIF_A_TEXT);
      expect((await slowControl as ToolResult).isError).toBe(true);
      expect(privateStructure(await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: initial.sessionId } }) as ToolResult))
        .toMatchObject({ structureText: MMCIF_B_TEXT, pdbId: '2XYZ' });

      // An immediate pasted source is a source request too: it supersedes an
      // in-flight network load rather than letting that old response overwrite
      // the panel after the user has already switched structures.
      const slowOpen = client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId: initial.sessionId, pdbId: '3def' },
      });
      await started.get('3DEF')?.promise;
      const pasted = await client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId: initial.sessionId, structureText: SESSION_A_TEXT, format: 'pdb' },
      }) as ToolResult;
      expect(pasted.isError).not.toBe(true);
      // The old slow fetch remains in the pending map until it settles, but it
      // no longer owns this session's sourceRevision. A source-free render
      // must return the already committed pasted cache promptly rather than
      // wait for an obsolete request that cannot commit.
      const pastedRender = await resolvesWithin(
        client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: initial.sessionId } }) as Promise<ToolResult>,
      );
      expect(pastedRender.structuredContent).toMatchObject({ hasStructure: true });
      expect(pastedRender.structuredContent).not.toHaveProperty('pdbId');
      responses.get('3DEF')?.resolve(MMCIF_B_TEXT);
      expect((await slowOpen as ToolResult).isError).toBe(true);
      const cached = await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: initial.sessionId } }) as ToolResult;
      expect(privateStructure(cached)).toMatchObject({ structureText: SESSION_A_TEXT, format: 'pdb' });
      expect(privateStructure(cached)).not.toHaveProperty('pdbId');

      // The built-in fixture follows the same immediate-source path and must
      // likewise beat an older network response.
      const slowFixtureRace = client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId: initial.sessionId, pdbId: '4ghi' },
      });
      await started.get('4GHI')?.promise;
      const fixture = await client.callTool({
        name: 'stereo_structure.open',
        arguments: { sessionId: initial.sessionId, fixture: 'three-depth-markers' },
      }) as ToolResult;
      expect(fixture.isError).not.toBe(true);
      const fixtureRender = await resolvesWithin(
        client.callTool({ name: 'stereo_structure.open', arguments: { sessionId: initial.sessionId } }) as Promise<ToolResult>,
      );
      expect(fixtureRender.structuredContent).toMatchObject({ hasStructure: true });
      expect(fixtureRender.structuredContent).not.toHaveProperty('pdbId');
      responses.get('4GHI')?.resolve(MMCIF_A_TEXT);
      expect((await slowFixtureRace as ToolResult).isError).toBe(true);
      expect(privateStructure(await client.callTool({ name: 'stereo_structure.get_structure', arguments: { sessionId: initial.sessionId } }) as ToolResult))
        .toMatchObject({ fixture: 'three-depth-markers', format: 'pdb' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects coordinate-bearing diagnostics before they can reach get_state', async () => {
    const { client, server } = await connectedServer();
    const coordinateText = 'ATOM      1  N   GLY A   1       1.000   2.000   3.000  1.00 10.00           N\nEND\n';
    try {
      const { sessionId: id } = await openPasted(client);
      const accepted = await client.callTool({
        name: 'stereo_structure.report_diagnostics',
        arguments: { sessionId: id, diagnostics: MINIMAL_DIAGNOSTICS },
      }) as ToolResult;
      expect(accepted.isError).not.toBe(true);

      const badPdbId = await client.callTool({
        name: 'stereo_structure.report_diagnostics',
        arguments: {
          sessionId: id,
          diagnostics: {
            ...MINIMAL_DIAGNOSTICS,
            sequence: 2,
            state: { ...MINIMAL_DIAGNOSTICS.state, pdbId: coordinateText },
          },
        },
      }) as ToolResult;
      const badBuild = await client.callTool({
        name: 'stereo_structure.report_diagnostics',
        arguments: {
          sessionId: id,
          diagnostics: { ...MINIMAL_DIAGNOSTICS, sequence: 3, viewerBuild: coordinateText },
        },
      }) as ToolResult;
      expect(badPdbId.isError).toBe(true);
      expect(badBuild.isError).toBe(true);
      expect(JSON.stringify(badPdbId)).not.toContain(coordinateText);
      expect(JSON.stringify(badBuild)).not.toContain(coordinateText);

      const state = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: id } }) as ToolResult;
      expect((state.structuredContent as { diagnostics?: unknown }).diagnostics).toEqual(MINIMAL_DIAGNOSTICS);
      expect(JSON.stringify(state)).not.toContain(coordinateText);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('evicts the least-recently-used session even when all accesses share one clock tick', async () => {
    let now = 0;
    let sequence = 0;
    const { client, server } = await connectedServer({
      now: () => now,
      maxSessions: 2,
      sessionIdFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    });
    try {
      const first = await openPasted(client, SESSION_A_TEXT);
      const second = await openPasted(client, SESSION_B_TEXT);
      // Touch A while the clock remains at zero. Map access order is the
      // deterministic tie-breaker, so C must evict untouched B.
      expect((await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: first.sessionId } }) as ToolResult).isError).not.toBe(true);
      const third = await openPasted(client, SESSION_A_TEXT);
      expect((await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: first.sessionId } }) as ToolResult).isError).not.toBe(true);
      expect((await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: second.sessionId } }) as ToolResult).isError).toBe(true);
      expect((await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: third.sessionId } }) as ToolResult).isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('expires idle sessions after the configured TTL', async () => {
    let now = 0;
    let sequence = 0;
    const { client, server } = await connectedServer({
      now: () => now,
      sessionTtlMs: 10,
      sessionIdFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    });
    try {
      const first = await openPasted(client, SESSION_A_TEXT);
      now = 11;
      const expired = await client.callTool({ name: 'stereo_structure.get_state', arguments: { sessionId: first.sessionId } }) as ToolResult;
      expect(expired.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  /**
   * A host that honours `_meta['operon.dev/viewer']` builds the file-open call
   * from the binding: it always sends `contentParam`, and it sends a filename
   * under the binding's name parameter — explicit `nameParam`, otherwise the
   * `filename` default — but only when the advertised input schema declares
   * that property. `openInputSchema` is strict, so the binding and the schema
   * have to stay in lockstep: a name parameter the binding invites without the
   * schema declaring it would fail validation on every dropped .pdb/.cif.
   */
  it('keeps the native file-open binding inside the strict open schema', async () => {
    const { client, server } = await connectedServer();
    try {
      const { tools } = await client.listTools();
      const open = tools.find((tool) => tool.name === 'stereo_structure.open');
      expect(open).toBeDefined();
      const binding = open?._meta?.['operon.dev/viewer'] as { contentParam?: string; nameParam?: string } | undefined;
      expect(binding).toBeTypeOf('object');
      const properties = (open?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      expect(properties).toBeTypeOf('object');
      // The names a host falls back to when the binding leaves them out.
      const contentParam = binding?.contentParam ?? 'content';
      const nameParam = binding?.nameParam ?? 'filename';
      expect(Object.hasOwn(properties as Record<string, unknown>, contentParam)).toBe(true);
      // The host's own rule for whether it will send the name parameter.
      const sendsName = nameParam !== contentParam
        && Object.hasOwn(properties as Record<string, unknown>, nameParam);
      // Declaring one without the other is the mismatch this test guards.
      expect(sendsName).toBe(binding?.nameParam != null);

      const opened = await client.callTool({
        name: 'stereo_structure.open',
        arguments: {
          [contentParam]: SESSION_A_TEXT,
          format: 'pdb',
          ...(sendsName ? { [nameParam]: 'fixture.pdb' } : {}),
        },
      }) as ToolResult;
      expect(opened.isError).not.toBe(true);

      if (!sendsName) {
        // The schema rejects rather than ignores an undeclared filename, which
        // is exactly why the binding must not advertise a name parameter.
        const named = await client.callTool({
          name: 'stereo_structure.open',
          arguments: { [contentParam]: SESSION_A_TEXT, format: 'pdb', [nameParam]: 'fixture.pdb' },
        }) as ToolResult;
        expect(named.isError).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      if (resolvePromise == null) throw new Error('Deferred promise was already resolved.');
      const resolve = resolvePromise;
      resolvePromise = undefined;
      resolve(value);
    },
  };
}

/** A source-free snapshot may not wait for a superseded external fetch. */
async function resolvesWithin<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Promise did not settle within ${timeoutMs} ms.`));
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Every host now says at startup which recognizer will hear the wearer and
 * which route will answer them. The lines existed only in the standalone
 * launcher, so the Claude Science daemon and both Codex hosts started silently
 * and the first evidence of a broken microphone was a wearer pressing the talk
 * button into nothing.
 *
 * The destination is the whole point of the test. stdout on a stdio MCP server
 * is the transport: one stray line there is a parse error that takes the
 * session down, which is a worse failure than the silence being fixed.
 */
describe('host readiness announcement', () => {
  const readyWhisperEnvironment = {
    STEREOFOLD_PTT_TRANSCRIBE: '1',
    STEREOFOLD_PTT_TRANSCRIBER: 'whisper',
    STEREOFOLD_WHISPER_BIN: '/bin/sh',
    STEREOFOLD_FFMPEG_BIN: '/bin/sh',
    STEREOFOLD_WHISPER_MODEL: fileURLToPath(new URL('server-contracts.test.ts', import.meta.url)),
  } satisfies NodeJS.ProcessEnv;

  it('names the transcriber route and the reply route', () => {
    const lines = hostReadinessLines(readyWhisperEnvironment);
    expect(lines.some((line) => line.includes('Headset voice transcribes locally with /bin/sh'))).toBe(true);
    expect(lines.some((line) => line.startsWith('Headset reply audio:'))).toBe(true);
  });

  it('says voice is off rather than saying nothing at all', () => {
    const lines = hostReadinessLines({ STEREOFOLD_PTT_TRANSCRIBE: '0' });
    expect(lines.some((line) => line.includes('Headset voice is off'))).toBe(true);
  });

  it('writes to stderr and never to stdout', () => {
    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    try {
      announceHostReadiness(readyWhisperEnvironment);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
    expect(stdoutLines).toEqual([]);
    expect(stderrLines.join('')).toContain('Headset voice transcribes locally with /bin/sh');
    expect(stderrLines.every((line) => line.endsWith('\n'))).toBe(true);
  });

  it('reports an unusable setting as a line instead of refusing to start', () => {
    // replyAudioFromEnv throws on an unknown provider. A molecular viewer must
    // not fail to start because a narration setting was misspelled.
    const lines = hostReadinessLines({ STEREOFOLD_REPLY_VOICE_PROVIDER: 'elevenlabs', STEREOFOLD_PTT_TRANSCRIBE: '0' });
    expect(lines.some((line) => line.includes('readiness could not be read'))).toBe(true);
    expect(lines.some((line) => line.includes('Headset voice is off'))).toBe(true);
  });

  it('stamps each line with the server name so a daemon log says who spoke', () => {
    const written: string[] = [];
    announceHostReadiness({ STEREOFOLD_PTT_TRANSCRIBE: '0' }, (line) => written.push(line));
    expect(written.every((line) => line.startsWith('Stereofold: '))).toBe(true);
  });
});
