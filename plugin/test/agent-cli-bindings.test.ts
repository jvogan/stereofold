/**
 * What a local tool call has to carry when the tool's schema is a union, and
 * what the CLI does with a named surface, a replaced source and a settled scene.
 *
 * `agent-arguments.test.ts` checks the written map against every packaged
 * tool's advertised `required` array. That check cannot see a union: a zod
 * discriminated union converts to a JSON schema with no properties at all, so
 * `manage_inspection_view` advertised nothing, matched a map entry that also
 * said nothing, and its save, restore and return-to-desktop branches left the
 * CLI with no binding — which is how the Claude Code probe got
 * zod's "expected string, received undefined" from a call it had not typed
 * anything wrong in. So the branches are checked here against the running
 * server itself rather than against a schema that does not survive conversion.
 */
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
import { MAX_INSPECTION_VIEWS } from '../src/inspection-views.js';
import {
  BINDING_FIELDS, bindingFieldsFor, describeSource, fillAgentArguments, isPanelSurface, needsInspectionState,
  panelOnSurface, requirementsFor, sceneSettled, TOOLS_ACCEPTING_UTTERANCE_ID, UNION_TOOLS,
} from '../scripts/agent-arguments.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

/**
 * A live session with a saved scene and one attached panel — the state a
 * terminal agent is in when it reaches for a named view.
 */
async function liveSession() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined);
  const client = new Client({ name: 'Stereofold agent CLI binding test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  const priv = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  const scene = {
    sourceSha256: priv.catalog.source.sha256, modelNumber: priv.catalog.modelNumbers[0], assemblyId: priv.catalog.assemblyId,
    selectionKeys: [priv.catalog.rows[0].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const saved = await call('sync_inspection', { sessionId, serverEpoch: priv.serverEpoch, sourceToken: priv.sourceToken,
    baseStateRevision: priv.stateRevision, baseInspectionRevision: priv.inspectionRevision, scene });
  await call('attach_inspection', { sessionId, serverEpoch: priv.serverEpoch, sourceToken: priv.sourceToken,
    baseStateRevision: saved.structuredContent.stateRevision, baseInspectionRevision: saved.structuredContent.inspectionRevision });
  const state = async () => (await call('get_inspection_state', { sessionId })).structuredContent;
  return { call, sessionId, state, close: async () => { await client.close(); await server.close(); } };
}

/**
 * The route stamps the session ID on every call, so the CLI never sends one.
 * Everything else is what `fillAgentArguments` put there.
 */
const asSent = (sessionId: string, filled: { arguments: Record<string, unknown> }) => ({ ...filled.arguments, sessionId });

describe('a tool whose schema is a union of branches', () => {
  it('sends save with the whole binding, a panel and a command, and is accepted', async () => {
    const live = await liveSession();
    try {
      const state = await live.state();
      const filled = fillAgentArguments('manage_inspection_view', { action: 'save', name: 'Active site' }, state, () => 'cli-save-1');
      expect(filled.filled).toEqual([...BINDING_FIELDS, 'panelId', 'commandId']);
      const saved = await live.call('manage_inspection_view', asSent(live.sessionId, filled));
      expect(saved.isError).not.toBe(true);
      expect(saved.structuredContent.command).toMatchObject({ commandId: 'cli-save-1', status: 'queued' });
    } finally { await live.close(); }
  });

  it('sends restore the same way, and delete with the binding but no panel', async () => {
    const live = await liveSession();
    try {
      const restore = fillAgentArguments('manage_inspection_view', { action: 'restore', viewId: '33333333-3333-4333-8333-333333333333' },
        await live.state(), () => 'cli-restore-1');
      expect(restore.arguments).toMatchObject({ panelId: expect.any(String), commandId: 'cli-restore-1' });
      // The view does not exist, so the host refuses by name rather than with
      // a missing-field error, which is the whole point of the fix.
      const refused = await live.call('manage_inspection_view', asSent(live.sessionId, restore));
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).not.toMatch(/expected string, received undefined/u);

      const remove = fillAgentArguments('manage_inspection_view', { action: 'delete', viewId: '33333333-3333-4333-8333-333333333333', viewRevision: 1 }, await live.state());
      expect(remove.filled).toEqual(BINDING_FIELDS);
      expect(remove.arguments).not.toHaveProperty('panelId');
      expect(remove.arguments).not.toHaveProperty('commandId');
    } finally { await live.close(); }
  });

  it('reads the list with no binding at all', async () => {
    const live = await liveSession();
    try {
      expect(needsInspectionState('manage_inspection_view', { action: 'list' })).toBe(false);
      const listed = await live.call('manage_inspection_view', { sessionId: live.sessionId, action: 'list' });
      expect(listed.structuredContent.namedViews).toMatchObject({ scope: 'live-session', maximum: MAX_INSPECTION_VIEWS });
    } finally { await live.close(); }
  });

  it('says which action is missing instead of sending a call that cannot bind', () => {
    expect(() => requirementsFor('manage_inspection_view', {})).toThrow(/action to be one of list, save, restore, delete, return-to-desktop/u);
    // The state is read anyway, so the refusal comes from here by name rather
    // than from zod by field.
    expect(needsInspectionState('manage_inspection_view', {})).toBe(true);
    expect(bindingFieldsFor('manage_inspection_view')).toEqual([]);
    expect(bindingFieldsFor('manage_inspection_view', { action: 'save' })).toEqual(BINDING_FIELDS);
  });

  /**
   * The guard that stops the next one being missed. A tool advertising no
   * properties either takes nothing or is a union whose requirements were
   * dropped in conversion, and an HTTP client cannot tell those apart, so both
   * are named here and a new one fails this until somebody classifies it. A
   * classified union may publish its fields flat, as `manage_inspection_view`
   * does; a flat list still does not say which fields each branch needs, so
   * the written branches stay and must match the published discriminator.
   */
  it('leaves no union tool unclassified', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer('/does-not-need-to-exist.html');
    const client = new Client({ name: 'Stereofold union schema test', version: '1' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const propertyless = tools
        .filter(tool => Object.keys((tool.inputSchema as { properties?: object }).properties ?? {}).length === 0)
        .map(tool => tool.name.replace('stereo_structure.', ''));
      expect(propertyless.filter(name => !UNION_TOOLS.has(name))).toEqual(['list_experiences']);
      for (const [name, union] of UNION_TOOLS) {
        const schema = tools.find(tool => tool.name === `stereo_structure.${name}`)?.inputSchema as
          { properties?: Record<string, { enum?: string[] }> } | undefined;
        expect(schema, name).toBeDefined();
        const published = schema?.properties?.[union.discriminator]?.enum;
        if (published) expect([...published].sort(), name).toEqual(Object.keys(union.branches).sort());
      }
    } finally { await client.close(); await server.close(); }
  });

  it('threads an utterance only into tools that take one', () => {
    expect(TOOLS_ACCEPTING_UTTERANCE_ID.has('manage_inspection_view')).toBe(true);
    expect(TOOLS_ACCEPTING_UTTERANCE_ID.has('get_inspection_state')).toBe(false);
    expect(TOOLS_ACCEPTING_UTTERANCE_ID.has('replace_inspection_source')).toBe(true);
  });
});

describe('naming the surface instead of the panel', () => {
  const panels = [
    { panelId: 'desk', surface: 'desktop', availability: 'ready', current: true },
    { panelId: 'quest', surface: 'companion', availability: 'busy', current: true },
  ];

  it('takes the panel on the surface asked for, ready or not', () => {
    expect(panelOnSurface(panels, 'desktop')).toEqual({ panelId: 'desk' });
    // The busy companion is still the panel the caller meant; the blur wait
    // upstream is what handles it, and skipping to the Mac would be the bug.
    expect(panelOnSurface(panels, 'companion')).toEqual({ panelId: 'quest' });
  });

  it('says what is there when that surface is not', () => {
    expect(panelOnSurface(panels, 'detailed')).toEqual({ error: expect.stringContaining('No current detailed panel') });
    expect(panelOnSurface(panels, 'detailed')).toEqual({ error: expect.stringContaining('desktop ready, companion busy') });
    expect(panelOnSurface([], 'desktop')).toEqual({ error: expect.stringContaining('No current desktop panel') });
  });

  it('refuses to guess between two panels on one surface, and ignores stale ones', () => {
    expect(panelOnSurface([...panels, { panelId: 'desk-2', surface: 'desktop', availability: 'ready', current: true }], 'desktop'))
      .toEqual({ error: expect.stringContaining('Name one with panelId') });
    expect(panelOnSurface([{ panelId: 'old', surface: 'desktop', availability: 'ready', current: false }], 'desktop'))
      .toEqual({ error: expect.stringContaining('No current desktop panel') });
  });

  it('knows the three surfaces a panel reports itself as', () => {
    expect(isPanelSurface('companion')).toBe(true);
    expect(isPanelSurface('headset')).toBe(false);
  });
});

describe('a source that was replaced rather than queued', () => {
  const ready = { panelId: 'quest', surface: 'companion', availability: 'ready', current: true };

  it('is settled only once a scene is saved and every current panel is ready', () => {
    expect(sceneSettled({ hasScene: true, panels: [ready] })).toBe(true);
    expect(sceneSettled({ hasScene: false, panels: [ready] })).toBe(false);
    expect(sceneSettled({ hasScene: true, panels: [] })).toBe(false);
    expect(sceneSettled({ hasScene: true, panels: [ready, { panelId: 'desk', surface: 'desktop', availability: 'unsaved', current: true }] })).toBe(false);
    // A panel that has fallen out of the session cannot hold the wait open.
    expect(sceneSettled({ hasScene: true, panels: [ready, { panelId: 'gone', surface: 'desktop', availability: 'busy', current: false }] })).toBe(true);
    expect(sceneSettled(undefined)).toBe(false);
  });

  it('says what is loaded in the terms the state reports it', () => {
    expect(describeSource({ sourceKind: 'pdb', sourceSelection: { modelNumber: 2, assemblyId: '1' }, lesson: { title: 'CRISPR' } }))
      .toBe('Now loaded: source pdb, model 2, assembly 1, lesson CRISPR.');
    expect(describeSource({})).toBe('Now loaded: source unknown, model unknown, assembly unknown.');
  });
});


it('only source replacement can use the host’s explicit failed-source recovery owner',()=>{
  const state={serverEpoch:'epoch',sourceToken:'failed',stateRevision:2,inspectionRevision:0,
    panels:[{panelId:'owner',surface:'companion',availability:'unsaved',current:false}],
    sourceRecovery:{panelId:'owner',ready:true}};
  expect(fillAgentArguments('replace_inspection_source',{pdbId:'1CRN'},state).arguments)
    .toMatchObject({sourceToken:'failed',panelId:'owner',baseInspectionRevision:0});
  expect(()=>fillAgentArguments('replace_inspection_source',{pdbId:'1CRN',mode:'compare'},state)).toThrow();
  expect(()=>fillAgentArguments('update_inspection',{change:{kind:'appearance',patch:{labels:true}}},state)).toThrow();
});
