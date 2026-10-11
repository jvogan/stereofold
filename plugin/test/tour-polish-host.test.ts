import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { mountExperiencePlayer } from '../src/experience-player.js';
import { applyTourCommand, tourHeartbeat } from '../src/inspection-tour-client.js';
// @ts-ignore Production inspector closures with page and HTTP adapters.
import { journeyNavigationHarness } from '../../lab/browser-roundtrip/fixtures/journey-navigation-harness.mjs';
// @ts-ignore Shared DOM/draw boundary.
import { tourEndHarness } from '../../lab/browser-roundtrip/fixtures/tour-end-harness.mjs';

const experienceId = 'hemoglobin-quaternary-structure';
const crn = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const hhb = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
const bound = (data: any) => ({ sessionId: data.sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
  stateRevision: data.stateRevision, inspectionRevision: data.inspectionRevision });

async function setup(fetchPdbText: () => Promise<string> = async () => hhb) {
  const h = tourEndHarness();
  const create = document.createElement.bind(document);
  document.createElement = ((...args: any[]) => Object.assign(create(args[0]), { querySelectorAll: () => [], remove() {} })) as any;
  document.removeEventListener = () => {};
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { fetchPdbText, replyAudio: createReplyAudioSynthesizer({ enabled: false }) });
  const client = new Client({ name: 'journey test', version: '1' });
  await server.connect(b); await client.connect(a);
  const raw = async (name: string, args: any) => await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
  const call = async (name: string, args: any) => {
    const result = await raw(name, args);
    if (result.isError) throw Error(result.content[0].text);
    return result;
  };
  const opened = await call('inspect', { structureText: crn });
  const sessionId = opened.structuredContent.sessionId;
  const read = async () => (await call('get_inspection', { sessionId }))._meta[KEY];
  const initial = await read();
  let scene: any = { sourceSha256: initial.catalog.source.sha256, modelNumber: 1, assemblyId: initial.catalog.assemblyId,
    selectionKeys: [], camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#ffffff', background: '#000000',
      highlightColor: '#ffff00', opacity: 1, labels: false, clipping: 0, fog: 0 }, placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
  const context = journeyNavigationHarness({ PRIVATE_KEY: KEY, call, binding: bound(initial), savedScene: scene,
    tourHeartbeat, applyTourCommand, workspace: { snapshot: () => ({ ready: true, interactionActive: false }), capture: () => scene,
      viewer: { inspection: { captureXrRecoveryFrame: () => undefined } } },
    recoverConfirmation: async (error: Error) => { throw error; },
    hydrate: async () => {
      const data = await read(), catalog = await decodeInspectionCatalog(data.catalogWire ?? data.catalog);
      scene = { ...scene, sourceSha256: catalog.source.sha256, assemblyId: catalog.assemblyId };
      context.binding = bound(data);
      const saved = await call('sync_inspection', { ...context.expected(), scene });
      expect(saved.structuredContent.saved).toBe(true);
      context.binding = bound(saved.structuredContent); context.savedScene = scene;
      const attached = await call('attach_inspection', { ...context.expected(), surface: 'companion', replacesPanelId: context.panelId });
      context.panelId = attached.structuredContent.panelId;
      if (data.experience) {
        await call('acknowledge_experience_step', { ...context.expected(), panelId: context.panelId,
          experienceId, experienceRevision: data.experience.revision, stepIndex: data.experience.stepIndex,
          tourState: { selectedId: experienceId, active: true, step: data.experience.stepIndex, total: 20, autoplay: false, navigating: false } });
      }
      context.experienceView = data.experience; player.update(data.experience);
    },
  });
  const player = mountExperiencePlayer({ after: h.after, settle: () => context.tourCommandContext ? Promise.resolve() : context.rendering, explore() {}, finish: async () => ({ status: 'rendered' }),
    navigate: async (id, step, loadedOnly) => { await context.navigateExperience(id, step, loadedOnly); } });
  player.setCatalog([{ id: experienceId, title: 'Hemoglobin' }]); context.panelTour = player;
  const saved = await call('sync_inspection', { ...context.expected(), scene });
  context.binding = bound(saved.structuredContent);
  const attached = await call('attach_inspection', { ...context.expected(), surface: 'companion' });
  context.panelId = attached.structuredContent.panelId;
  const state = async () => (await call('get_inspection_state', { sessionId })).structuredContent;
  const queue = async (action: string) => call('control_tour', { ...context.expected(), panelId: context.panelId, commandId: `d33-${action}`, action });
  return { context, player, call, raw, read, state, queue, close: async () => { player.dispose(); h.cleanup(); await client.close(); await server.close(); } };
}

for (const surface of ['menu', 'desktop']) it(`${surface} pause then Next survives a preparation heartbeat and reports the rendered host chapter`, async () => {
  const t = await setup();
  try {
    await t.player.openMenu(); await t.player.start();
    if (surface === 'desktop') {
      await t.queue('pause');
      await expect(t.player.next()).rejects.toThrow('A desktop command arrived before this tour step. Use Play to continue.');
      expect((await t.state()).panels[0].tour).toMatchObject({ active: true, step: 0, autoplay: false });
    } else t.player.pause();
    const call = t.context.call;
    t.context.call = async (name: string, args: any) => {
      if (name === 'navigate_experience') await t.context.busyBeat(t.context.generation);
      return call(name, args);
    };
    await t.player.next();
    const state = await t.state();
    expect(state.panels.find((p: any) => p.panelId === t.context.panelId)).toMatchObject({ current: true, availability: 'ready', tour: { active: true, step: 1, autoplay: false } });
    expect(state.modelContext.chapter.index).toBe(2); expect(state.experience.applied).toBe(true);
  } finally { await t.close(); }
});

it('chooser receipt settles before immediate Start and pending source preparation never claims an active chapter', async () => {
  let release!: () => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const t = await setup(async () => { started(); await gate; return hhb; });
  try {
    await t.queue('menu');
    await t.context.busyBeat(t.context.generation);
    const start = t.player.start();
    await began;
    await t.context.busyBeat(t.context.generation);
    const pending = await t.state();
    expect(pending.panels.find((p: any) => p.panelId === t.context.panelId).tour.active).toBe(false);
    expect(pending.modelContext.chapter).toBeNull(); expect(pending.experience).toBeUndefined();
    release(); await start;
    expect((await t.state()).modelContext.chapter.index).toBe(1);
    expect(t.player.getState()).toMatchObject({ active: true, step: 0, navigating: false });
  } finally { release(); await t.close(); }
});

for (const interruption of ['dirty', 'correction']) it(`a ${interruption} during source preparation still refuses the journey without a false host chapter`, async () => {
  let release!: () => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const t = await setup(async () => { started(); await gate; return hhb; });
  try {
    await t.player.openMenu();
    const before = await t.read();
    const start = t.player.start();
    const refused = expect(start).rejects.toThrow('A newer inspection superseded this journey request.');
    await began;
    if (interruption === 'dirty') {
      t.context.dirty = true; await t.context.busyBeat(t.context.generation);
    } else await t.call('update_inspection', { ...t.context.expected(), panelId: t.context.panelId, commandId: 'newer-change',
      change: { kind: 'appearance', patch: { color: 'uniform', uniformColor: '#ff0000' } } });
    release(); await refused;
    const after = await t.read(), state = await t.state();
    expect(after.sourceToken).toBe(before.sourceToken); expect(after.scene).toEqual(before.scene); expect(after.experience).toBeUndefined();
    expect(state.modelContext.chapter).toBeNull();
    expect(t.player.getState()).toMatchObject({ active: false, step: -1, feedbackError: true });
  } finally { release(); await t.close(); }
});
