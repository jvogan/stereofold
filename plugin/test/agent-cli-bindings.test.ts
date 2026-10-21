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
  BINDING_FIELDS, bindingFieldsFor, describeSource, fillAgentArguments, filledBindingFor, HOST_REBASED_TOOLS, isPanelSurface,
  needsInspectionState, panelOnSurface, requirementsFor, sceneSettled, TOOLS_ACCEPTING_UTTERANCE_ID, UNION_TOOLS,
} from '../scripts/agent-arguments.js';
import { declareUtterance, sendAgentCall } from '../scripts/inspection-agent.js';
import { compatibleLocalSave } from '../src/inspection-local-settle.js';
import type { InspectionChange, InspectionScene } from '../src/inspection-contract.js';
import { movedBy, sharedPanelSession } from './helpers/shared-panel-session.js';

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

/**
 * Claude's commands against the wearer's placement saves.
 *
 * On an emulated Quest 2 a CLI-bound `control_tour start` came back
 * "The target panel has newer or unsaved local work." when it was sent during
 * VR entry and after a scale edit: the CLI had copied the revisions in, and
 * the page's own seat or the wearer's move made them stale before the panel
 * could draw. These three tools now leave the revisions to the host.
 */
describe('the commands a placement save must not strand', () => {
  const state = { serverEpoch: 'epoch', sourceToken: 'source', stateRevision: 7, inspectionRevision: 3,
    panels: [{ panelId: 'quest', surface: 'companion', availability: 'ready', current: true }] };
  const requests: Record<string, Record<string, unknown>> = {
    control_tour: { action: 'start', tourId: 'fold-detective', autoplay: false },
    install_lesson: { lesson: { id: 'walk' } },
    update_inspection: { change: { kind: 'placement', patch: { scale: 2 } } },
  };

  it('names exactly the three tools', () => {
    expect([...HOST_REBASED_TOOLS].sort()).toEqual(Object.keys(requests).sort());
  });

  it.each(Object.entries(requests))('%s leaves both revisions for the host and fills the rest', (name, args) => {
    const filled = fillAgentArguments(name, args, state, () => 'cli-1');
    expect(filled.arguments).toEqual({ ...args, serverEpoch: 'epoch', sourceToken: 'source', panelId: 'quest', commandId: 'cli-1' });
    expect(filled.filled).toEqual(['serverEpoch', 'sourceToken', 'panelId', 'commandId']);
    // The schema still takes them, so a caller may send them.
    expect(bindingFieldsFor(name)).toEqual(BINDING_FIELDS);
    expect(filledBindingFor(name)).toEqual(['serverEpoch', 'sourceToken']);
    expect(needsInspectionState(name, { serverEpoch: 'epoch', sourceToken: 'source', panelId: 'quest' })).toBe(false);
  });

  it('still copies both revisions into every other bound tool', () => {
    for (const [name, args] of [['focus_selection', {}], ['emphasize', {}], ['undo_last_change', {}], ['redo_last_change', {}],
      ['remove_measurement', { measurementId: 'm' }], ['open_detailed_view', {}], ['manage_inspection_view', { action: 'save', name: 'Site' }],
      ['measure', { targets: [], annotate: true }]] as const) {
      const filled = fillAgentArguments(name, args, state, () => 'cli-2');
      expect(filled.arguments, name).toMatchObject({ baseStateRevision: 7, baseInspectionRevision: 3 });
    }
  });

  it('keeps a revision the caller supplied, so a deliberately stale call is still refused', () => {
    const filled = fillAgentArguments('control_tour', { action: 'play', baseStateRevision: 1, baseInspectionRevision: 0 }, state);
    expect(filled.arguments).toMatchObject({ baseStateRevision: 1, baseInspectionRevision: 0, serverEpoch: 'epoch' });
    expect(filled.filled).not.toContain('baseStateRevision');
    const one = fillAgentArguments('update_inspection', { change: { kind: 'motion', patch: { state: 'spin' } }, baseInspectionRevision: 2 }, state);
    expect(one.arguments.baseInspectionRevision).toBe(2);
    expect(one.arguments).not.toHaveProperty('baseStateRevision');
  });

  /**
   * The rebase is the safety the revisions used to give: a command follows a
   * local save only when the save left the command's own inputs alone.
   */
  describe('which local saves each of the three can follow', () => {
    const base: InspectionScene = {
      sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: '1', selectionKeys: ['one'],
      camera: { mode: 'perspective', fov: 45, position: [0, 0, 10], target: [0, 0, 0], up: [0, 1, 0], radius: 4, radiusMax: 8,
        fog: 50, clipFar: true, minNear: .1, minFar: 1 },
      inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#ffffff', background: '#000000',
        highlightColor: '#ffff00', opacity: 1, labels: false, clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
    } as InspectionScene;
    const carried = movedBy(base);
    const translated = movedBy(base, [1, 0, 0], 1);
    const scientific = structuredClone(base); scientific.inspection.appearance.opacity = .4;
    const reselected = structuredClone(base); reselected.selectionKeys = ['two'];
    const changes: [string, InspectionChange, { carried: boolean; translated: boolean }][] = [
      ['control_tour start', { kind: 'tour', patch: { action: 'start', tourId: 'walk' } } as InspectionChange, { carried: true, translated: true }],
      ['install_lesson', { kind: 'lesson', patch: { lesson: {} as any, frame: false } } as InspectionChange, { carried: true, translated: true }],
      ['update_inspection appearance', { kind: 'appearance', patch: { opacity: .8 } } as InspectionChange, { carried: true, translated: true }],
      ['update_inspection visibility', { kind: 'visibility', patch: { hiddenChains: [{ labelChain: 'B', copyId: '1' }], hiddenClasses: [],
        showOnlySelection: false } } as InspectionChange, { carried: true, translated: true }],
      // The wearer's own rescale wins over a scale sent before it; a move does not.
      ['update_inspection placement scale', { kind: 'placement', patch: { scale: 2 } } as InspectionChange, { carried: false, translated: true }],
      ['update_inspection recenter', { kind: 'placement', patch: { recenter: true } } as InspectionChange, { carried: true, translated: true }],
    ];
    it.each(changes)('%s', (_name, change, follows) => {
      expect(compatibleLocalSave(base, carried, change)).toBe(follows.carried);
      expect(compatibleLocalSave(base, translated, change)).toBe(follows.translated);
      // A scientific edit by the wearer still refuses the queued command,
      // except where it is not one of that command's inputs.
      expect(compatibleLocalSave(base, scientific, change)).toBe(change.kind === 'placement');
      if (change.kind !== 'appearance' && change.kind !== 'placement')
        expect(compatibleLocalSave(base, reselected, change)).toBe(false);
    });
    it('keeps a focus framing from following the wearer', () => {
      expect(compatibleLocalSave(base, translated, { kind: 'focus', patch: { selectionKeys: ['one'] } } as InspectionChange)).toBe(false);
    });
    it('lets a start, pause or Done follow a chapter the playing lesson advanced to, but not a different lesson', () => {
      const start = { kind: 'tour', patch: { action: 'start', tourId: 'walk' } } as InspectionChange;
      const startingScene = structuredClone(base);
      const playing = (scene: InspectionScene, tourId: string, chapterId: string, stopped = false) => {
        const next = structuredClone(scene) as any;
        next.inspection.lessonPlayback = { tourId, chapterId, stopped, startingScene };
        return next as InspectionScene;
      };
      const before = playing(base, 'walk', 'one');
      // Autoplay drew the next chapter, which repainted the structure, and the wearer rescaled it.
      const advanced = playing(movedBy(scientific, [0, 0, 0], 1.6), 'walk', 'two');
      expect(compatibleLocalSave(before, advanced, start)).toBe(true);
      expect(compatibleLocalSave(before, playing(base, 'other', 'one'), start)).toBe(false);
      // With no lesson playing, the wearer's own edit still refuses it.
      expect(compatibleLocalSave(base, scientific, start)).toBe(false);
      for (const action of ['pause', 'done', 'restore-start'])
        expect(compatibleLocalSave(before, advanced, { kind: 'tour', patch: { action } } as InspectionChange)).toBe(true);
      expect(compatibleLocalSave(before, advanced, { kind: 'tour', patch: { action: 'next' } } as InspectionChange)).toBe(false);
    });
    // A pause touches only the clock, so it keeps its own rule: the clock it pauses must be unchanged.
    it('refuses a start, Done or restart after the wearer took over or edited the same lesson', () => {
      const startingScene = structuredClone(base);
      const playing = (scene: InspectionScene, chapterId: string, stopped = false, clock?: string) => {
        const next = structuredClone(scene) as any;
        next.inspection.lessonPlayback = { tourId: 'walk', chapterId, stopped, startingScene };
        if (clock) next.inspection.animation = { playback: { chapterId: clock, state: 'playing' } };
        return next as InspectionScene;
      };
      const before = playing(base, 'one', false, 'one');
      const recoloured = playing(scientific, 'one');
      const takenOver = playing(reselected, 'one', true);
      const advancedThenTaken = playing(movedBy(scientific, [0, 0, 0], 1.4), 'two', true, 'two');
      // A chapter cursor whose clock is still the old chapter's was not drawn whole.
      const halfDrawn = playing(scientific, 'two', false, 'one');
      for (const action of ['start', 'done', 'restore-start']) {
        const change = { kind: 'tour', patch: { action, tourId: 'walk' } } as InspectionChange;
        for (const after of [recoloured, takenOver, advancedThenTaken, halfDrawn])
          expect(compatibleLocalSave(before, after, change)).toBe(false);
        expect(compatibleLocalSave(before, playing(scientific, 'two', false, 'two'), change)).toBe(true);
        // A placement-only save still follows, as it does for any tour command.
        expect(compatibleLocalSave(before, playing(movedBy(base, [0, 0, 0], 1.4), 'one', false, 'one'), change)).toBe(true);
      }
    });
  });
});

describe('a CLI-bound start against a real shared headset session', () => {
  const tourOf = async (live: Awaited<ReturnType<typeof sharedPanelSession>>) => (await live.state()).tours[0].id as string;
  const sendStart = async (live: Awaited<ReturnType<typeof sharedPanelSession>>, extra: Record<string, unknown> = {}) => {
    const filled = fillAgentArguments('control_tour', { action: 'start', tourId: await tourOf(live), autoplay: false, narration: false, ...extra },
      await live.state(), () => `cli-${Math.random().toString(36).slice(2, 10)}`);
    const answer = await live.call('control_tour', { ...filled.arguments, sessionId: live.sessionId });
    expect(answer.isError, JSON.stringify(answer.content)).not.toBe(true);
    return answer.structuredContent.command as { commandId: string; status: string };
  };

  it('follows the wearer’s placement save and is delivered instead of conflicting', async () => {
    const live = await sharedPanelSession();
    try {
      await live.beat('ready');
      const queued = await sendStart(live);
      expect(queued.status).toBe('queued');
      // The wearer scales the molecule: the page holds the command while it saves.
      expect(await live.beat('busy')).toBeUndefined();
      const before = live.binding;
      const moved = movedBy(live.saved);
      expect(await live.save(moved)).toMatchObject({ saved: true });
      // A beat sent before that save answered must not conflict the command.
      expect(await live.beat('busy', before)).toBeUndefined();
      expect((await live.state(queued.commandId)).command).toMatchObject({ status: 'queued', heldForPanel: true });
      const delivery = await live.beat('ready');
      expect(delivery).toMatchObject({ commandId: queued.commandId, deferLocalSave: true });
      const receipt = await live.complete(delivery, moved);
      expect(receipt.command).toMatchObject({ status: 'rendered' });
      expect((await live.state()).inspectionRevision).toBe(before.baseInspectionRevision + 2);
    } finally { await live.close(); }
  });

  it('a start sent while the page is already seating the wearer is admitted, not refused', async () => {
    const live = await sharedPanelSession();
    try {
      // VR entry: the seat is unsaved local work, reported as busy.
      await live.beat('busy');
      const queued = await sendStart(live);
      expect(queued).toMatchObject({ status: 'queued' });
      expect(await live.save(movedBy(live.saved))).toMatchObject({ saved: true });
      const delivery = await live.beat('ready');
      expect(delivery?.commandId).toBe(queued.commandId);
      expect((await live.complete(delivery, live.saved)).command.status).toBe('rendered');
    } finally { await live.close(); }
  });

  it('a scientific save while it waits still conflicts it, naming the cause', async () => {
    const live = await sharedPanelSession();
    try {
      await live.beat('ready');
      const queued = await sendStart(live);
      const edited = structuredClone(live.saved); edited.inspection.appearance.opacity = .3;
      expect(await live.save(edited)).toMatchObject({ saved: true });
      expect((await live.state(queued.commandId)).command).toMatchObject({ status: 'conflict',
        reason: expect.stringContaining('A local edit in the panel changed this command’s inputs') });
      expect(await live.beat('ready')).toBeUndefined();
    } finally { await live.close(); }
  });

  it('declares an utterance unbound, and a voice start after the wearer’s move is still accepted', async () => {
    const live = await sharedPanelSession();
    try {
      await live.beat('ready');
      const request = async (_state: unknown, name: string, args: Record<string, unknown> = {}) =>
        live.call(name, { ...args, sessionId: live.sessionId });
      const control = { origin: 'http://127.0.0.1:1', token: 'unused', sessionId: live.sessionId };
      const declared = await declareUtterance(control, 'begin', {}, request as any);
      expect(declared.panelId).toBe(live.panelId);
      // The wearer moves the molecule between the words and the command.
      expect(await live.save(movedBy(live.saved))).toMatchObject({ saved: true });
      await live.beat('ready');
      const queued = await sendStart(live, { utteranceId: declared.utteranceId });
      expect(queued.status).toBe('queued');
      // A placement change from those same words would move it again, so it is refused by name.
      const placed = fillAgentArguments('update_inspection', { utteranceId: declared.utteranceId,
        change: { kind: 'placement', patch: { scale: 3 } } }, await live.state());
      const refused = await live.call('update_inspection', { ...placed.arguments, sessionId: live.sessionId });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toMatch(/wearer moved the structure since this utterance began/u);
    } finally { await live.close(); }
  });

  // `--utterance begin` used to thread an ID no reply could use, and a panelId
  // say_to_headset's strict schema refuses, so the agent could not speak first.
  it('speaks first with say_to_headset --utterance begin, and a begun start still renders', async () => {
    const live = await sharedPanelSession();
    try {
      await live.beat('ready');
      const control = { origin: 'http://127.0.0.1:1', token: 'unused', sessionId: live.sessionId };
      // The loopback route stamps the session on every call but the voice tools, whose schemas take none.
      const transport = async (_state: unknown, name: string, args: Record<string, unknown> = {}) =>
        live.call(name, name === 'say_to_headset' ? args : { ...args, sessionId: live.sessionId });
      const wait = { pollMs: 10, timeoutMs: 1_000 };
      const greeting = sendAgentCall(control, { name: 'say_to_headset', arguments: { text: 'Hello, this is Claude.', speak: false },
        utterance: 'begin' }, wait, transport as any);
      let caption: any;
      for (let beat = 0; beat < 100 && !caption; beat += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        caption = (await live.call('poll_inspection', { sessionId: live.sessionId, ...live.binding, panelId: live.panelId,
          availability: 'ready' }))._meta?.[PRIVATE_KEY]?.headsetCaption;
      }
      const said = await greeting;
      const greeted = said.utterance!.utteranceId;
      expect(said.arguments).toEqual({ text: 'Hello, this is Claude.', speak: false, utteranceId: greeted });
      expect(said.result.structuredContent).toMatchObject({ queued: true, delivered: true, stale: false,
        utteranceBinding: 'active', utteranceId: greeted });
      expect(caption).toMatchObject({ text: 'Hello, this is Claude.', utteranceId: greeted });

      const started = await sendAgentCall(control, { name: 'control_tour', utterance: 'begin',
        arguments: { action: 'start', tourId: await tourOf(live), autoplay: false, narration: false } }, wait, transport as any);
      const turn = started.utterance!.utteranceId;
      expect(started.arguments).toMatchObject({ panelId: live.panelId, utteranceId: turn });
      expect(started.receipt).toMatchObject({ status: 'queued' });
      const delivery = await live.beat('ready');
      expect(delivery?.commandId).toBe(started.receipt!.commandId);
      expect((await live.complete(delivery, live.saved)).command.status).toBe('rendered');
      // The start's turn is newer, so the greeting's turn no longer takes replies.
      expect((await live.call('say_to_headset', { text: 'Hello again.', utteranceId: greeted, speak: false })).structuredContent)
        .toMatchObject({ stale: true, utteranceId: greeted, activeUtteranceId: turn });
    } finally { await live.close(); }
  });
});
