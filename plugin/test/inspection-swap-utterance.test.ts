import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as key } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';

// The wearer speaks again while a structure is still
// loading. "No, cancel that, show me crambin" was recorded
// against 1CRN, 1JB0 drew two seconds later, and the correction, its retry and
// the follow-up load were all refused: the words fell out of the receipt chain
// in exactly the mid-action case this promises.
const crn = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const hhb = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');

async function setup() {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const fetching = new Promise<void>(r => { entered = r; });
  const server = createStereoStructureServer(undefined, { fetchPdbText: async () => { entered(); await gate; return hhb; } });
  const client = new Client({ name: 'Stereofold swap utterance test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const call = (name: string, args: any) => client.callTool({ name: 'stereo_structure.' + name, arguments: args }) as Promise<any>;
  const ok = (r: any) => { if (r.isError) throw Error(JSON.stringify(r.content)); return r; };
  const sessionId = ok(await call('inspect', { structureText: crn })).structuredContent.sessionId;
  // A larger structure arrives encoded; the panel decodes it either way.
  const hydrate = async () => {
    const meta = ok(await call('get_inspection', { sessionId }))._meta[key];
    return { ...meta, catalog: meta.catalog ?? await decodeInspectionCatalog(meta.catalogWire) };
  };
  const data = await hydrate();
  const sceneFor = (source: any) => ({
    sourceSha256: source.catalog.source.sha256, modelNumber: source.catalog.modelNumbers[0],
    assemblyId: source.catalog.assemblyId, selectionKeys: [source.catalog.rows[0].key],
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
      opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } });
  let scene: any = sceneFor(data);
  const binding = { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
  const sync = ok(await call('sync_inspection', { ...binding, scene })).structuredContent;
  binding.baseStateRevision = sync.stateRevision; binding.baseInspectionRevision = sync.inspectionRevision;
  let panelId: string = ok(await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId;
  await call('poll_inspection', { ...binding, panelId, availability: 'ready' });
  const t = {
    call, ok, fetching, release,
    get binding() { return binding; }, get panelId() { return panelId; }, get scene() { return scene; },
    firstKeys: [...data.catalog.rows.slice(0, 1).map((row: any) => row.key)],
    // Words: an utterance recorded on whatever the panel is showing now.
    speak: async (commandId: string) => ok(await call('update_inspection', { ...binding, panelId, commandId,
      change: { kind: 'utterance', patch: { action: 'begin' } } })).structuredContent.lifecycle.utterance.utteranceId as string,
    // The replacement page draws the new source, saves it and registers.
    render: async () => {
      const replaced = await hydrate();
      const previous = panelId;
      Object.assign(binding, { sourceToken: replaced.sourceToken, baseStateRevision: replaced.stateRevision,
        baseInspectionRevision: replaced.inspectionRevision });
      scene = sceneFor(replaced);
      const saved = ok(await call('sync_inspection', { ...binding, scene })).structuredContent;
      binding.baseInspectionRevision = saved.inspectionRevision;
      panelId = ok(await call('attach_inspection', { ...binding, surface: 'companion', replacesPanelId: previous })).structuredContent.panelId;
      await call('poll_inspection', { ...binding, panelId, availability: 'ready' });
      return panelId;
    },
    close: async () => { release(); await client.close(); await server.close(); },
  };
  return t;
}
type Harness = Awaited<ReturnType<typeof setup>>;
function lifecycle(t: Harness, commandId: string, action: string, utteranceId: string) {
  return t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId, utteranceId,
    change: { kind: 'utterance', patch: { action } } });
}
// Start a swap, let it reach the resolver, then hear the wearer change their mind.
async function interrupted(t: Harness) {
  const asked = await t.speak('asked');
  const swap = t.call('replace_inspection_source', { ...t.binding, panelId: t.panelId, utteranceId: asked,
    commandId: 'load', pdbId: '4HHB' });
  await t.fetching;
  const corrected = await t.speak('corrected');
  t.release();
  t.ok(await swap);
  return { asked, corrected };
}

it('a cancel spoken during a source swap still cancels once the swap has drawn', async () => {
  const t = await setup(); try {
    const { corrected } = await interrupted(t);
    await t.render();
    const cancelled = await lifecycle(t, 'cancel', 'cancel', corrected);
    expect(cancelled.isError).not.toBe(true);
    expect(cancelled.structuredContent.lifecycle.action).toBe('cancel');
  } finally { await t.close(); }
});

it('a correction spoken during a swap is accepted, and its follow-up load is bound to it', async () => {
  const t = await setup(); try {
    const { corrected } = await interrupted(t);
    await t.render();
    expect((await lifecycle(t, 'correct', 'correct', corrected)).isError).not.toBe(true);
    // "…show me crambin": the same words, now acting on the swapped-in scene.
    const back = await t.call('replace_inspection_source', { ...t.binding, panelId: t.panelId, utteranceId: corrected,
      commandId: 'crambin-back', source: { kind: 'pasted', text: crn, format: 'mmcif' } });
    expect(back.isError).not.toBe(true);
  } finally { await t.close(); }
});

it('an edit carrying the old structure\'s keys is still refused after the swap', async () => {
  const t = await setup(); try {
    const { corrected } = await interrupted(t);
    const stale = t.firstKeys;
    await t.render();
    expect((await lifecycle(t, 'correct', 'correct', corrected)).isError).not.toBe(true);
    const edit = await t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId: 'stale-keys',
      utteranceId: corrected, change: { kind: 'selection', patch: { selectionKeys: stale } } });
    expect(edit.isError).toBe(true);
  } finally { await t.close(); }
});

it('words spoken before the swap was asked for are not carried over', async () => {
  const t = await setup(); try {
    // An earlier utterance, recorded on the old source before anything loaded.
    const earlier = await t.speak('earlier');
    await interrupted(t);
    await t.render();
    const refused = await lifecycle(t, 'cancel-earlier', 'cancel', earlier);
    expect(refused.isError).toBe(true);
  } finally { await t.close(); }
});

it('a begin for the utterance a newer correction superseded still refuses', async () => {
  const t = await setup(); try {
    const { asked, corrected } = await interrupted(t);
    await t.render();
    expect((await lifecycle(t, 'correct', 'correct', corrected)).isError).not.toBe(true);
    const superseded = await lifecycle(t, 'begin-old', 'begin', asked);
    expect(superseded.isError).toBe(true);
  } finally { await t.close(); }
});
