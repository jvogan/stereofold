import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';

// A wearer's stop has to survive an autoplaying tour.
// The lesson saves a scene for every chapter, so the revision the wearer's
// words were recorded on is already old by the time the model reads the
// transcript. That cost 60.9 s and two more chapters.
const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const LESSON = 'subunit-colour';

async function setup() {
  const clock = { now: 0 };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { now: () => clock.now });
  const client = new Client({ name: 'Stereofold tour stop test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({
    name: `stereo_structure.${name}`, arguments: args,
  }) as Promise<any>;
  const opened = await call('inspect', { structureText: cif });
  const sessionId = opened.structuredContent.sessionId as string;
  const privateData = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  let scene: any = {
    sourceSha256: privateData.catalog.source.sha256,
    modelNumber: privateData.catalog.modelNumbers[0],
    assemblyId: privateData.catalog.assemblyId,
    selectionKeys: [],
    camera: {
      mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0,
    },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015', opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const binding = {
    sessionId, serverEpoch: privateData.serverEpoch, sourceToken: privateData.sourceToken,
    baseStateRevision: privateData.stateRevision, baseInspectionRevision: privateData.inspectionRevision,
  };
  const saved = await call('sync_inspection', { ...binding, scene });
  expect(saved.structuredContent.saved).toBe(true);
  binding.baseStateRevision = saved.structuredContent.stateRevision;
  binding.baseInspectionRevision = saved.structuredContent.inspectionRevision;
  const panelId = (await call('attach_inspection', { ...binding, surface: 'companion' })).structuredContent.panelId as string;
  const t = {
    call, sessionId, binding, panelId,
    get scene() { return scene; },
    // One heartbeat, carrying the chapter this panel says it is showing.
    beat: (step: number, active = true) => call('poll_inspection', {
      ...binding, panelId, availability: 'ready',
      tourState: { selectedId: LESSON, step, total: 20, active, autoplay: true, navigating: false },
    }),
    // The same beat from an AUTHORED LESSON. A journey
    // never runs the tour player, so its tourState is inactive for the whole
    // run and the chapter rides in `experience`.
    journeyBeat: (stepIndex?: number, experienceId = LESSON) => call('poll_inspection', {
      ...binding, panelId, availability: 'ready',
      tourState: { step: -1, total: 0, active: false, autoplay: false, navigating: false },
      ...(stepIndex === undefined ? {} : { experience: { experienceId, stepIndex } }),
    }),
    // A save that moves the saved revision, as any rendered scene does.
    save: async (opacity: number) => {
      scene = { ...scene, inspection: { ...scene.inspection, appearance: { ...scene.inspection.appearance, opacity } } };
      const result = await call('sync_inspection', { ...binding, scene });
      expect(result.structuredContent.saved).toBe(true);
      binding.baseInspectionRevision = result.structuredContent.inspectionRevision;
    },
    close: async () => { await client.close(); await server.close(); },
  };
  return t;
}
type Harness = Awaited<ReturnType<typeof setup>>;
// The player draws the next chapter, saves it, and says so on its next beat.
async function chapter(t: Harness, step: number, opacity: number) {
  await t.save(opacity);
  await t.beat(step);
}
// The journey draws the next chapter, saves it, and says so on its next beat.
async function journeyChapter(t: Harness, stepIndex: number, opacity: number) {
  await t.save(opacity);
  await t.journeyBeat(stepIndex);
}
function utterance(t: Harness, commandId: string, action = 'begin', utteranceId?: string) {
  return t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId,
    ...(utteranceId ? { utteranceId } : {}), change: { kind: 'utterance', patch: { action } } });
}
function tour(t: Harness, commandId: string, action: string, utteranceId?: string) {
  return t.call('update_inspection', { ...t.binding, panelId: t.panelId, commandId,
    ...(utteranceId ? { utteranceId } : {}), change: { kind: 'tour', patch: { action } } });
}

it('a stop bound to words spoken two chapters ago is accepted', async () => {
  const t = await setup(); try {
    await t.beat(5);
    const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await chapter(t, 6, 0.6);
    await chapter(t, 7, 0.7);
    const stop = await tour(t, 'stop', 'restore-start', spoken);
    expect(stop.isError).not.toBe(true);
    expect(stop.structuredContent.command.status).toBe('queued');
    expect(stop.structuredContent.command.utteranceId).toBe(spoken);
  } finally { await t.close(); }
});

it('done and pause survive the same chapters; the other tour actions do not', async () => {
  for (const action of ['done', 'pause']) {
    const t = await setup(); try {
      await t.beat(5);
      const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
      await chapter(t, 6, 0.6);
      expect((await tour(t, `stop-${action}`, action, spoken)).structuredContent.command.status).toBe('queued');
    } finally { await t.close(); }
  }
  for (const action of ['next', 'back', 'play', 'menu', 'rejoin']) {
    const t = await setup(); try {
      await t.beat(5);
      const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
      await chapter(t, 6, 0.6);
      const refused = await tour(t, `move-${action}`, action, spoken);
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toContain('changed since this utterance');
    } finally { await t.close(); }
  }
});

it('a manual edit between the words and the stop still refuses the stop', async () => {
  const t = await setup(); try {
    await t.beat(5);
    const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    // A hand on the scene: the revision moves, the chapter does not.
    await t.save(0.4);
    await t.beat(5);
    await chapter(t, 6, 0.6);
    const refused = await tour(t, 'stop', 'restore-start', spoken);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('changed since this utterance');
    // Unbound, the same stop is the model's documented fallback and still works.
    expect((await tour(t, 'stop-unbound', 'restore-start')).structuredContent.command.status).toBe('queued');
  } finally { await t.close(); }
});

it('a stop is not forgiven when no tour is playing or the lesson changed', async () => {
  const t = await setup(); try {
    await t.beat(5);
    const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await chapter(t, 6, 0.6);
    // The lesson ended on its own; the words are no longer about it.
    await t.beat(-1, false);
    const refused = await tour(t, 'stop', 'done', spoken);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('changed since this utterance');
  } finally { await t.close(); }
});

it('a begin for the same utterance is unchanged, and the cancel that precedes a stop is accepted', async () => {
  const t = await setup(); try {
    await t.beat(5);
    const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await chapter(t, 6, 0.6);
    await chapter(t, 7, 0.7);
    const rebegun = await utterance(t, 'begin-again', 'begin', spoken);
    expect(rebegun.isError).toBe(true);
    expect(rebegun.content[0].text).toContain('changed since this utterance');
    const cancelled = await utterance(t, 'cancel', 'cancel', spoken);
    expect(cancelled.isError).not.toBe(true);
    expect(cancelled.structuredContent.lifecycle.action).toBe('cancel');
    // Unchanged: a cancel supersedes its own utterance, so a command bound to
    // it afterwards is refused for that reason and not for the revisions.
    const afterCancel = await tour(t, 'stop', 'restore-start', spoken);
    expect(afterCancel.isError).toBe(true);
    expect(afterCancel.content[0].text).toContain('superseded');
  } finally { await t.close(); }
});

it('a stop bound to words spoken before a source change is still refused', async () => {
  const t = await setup(); try {
    await t.beat(5);
    const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await chapter(t, 6, 0.6);
    const wrongSource = await t.call('update_inspection', { ...t.binding, sourceToken: 'not-this-source',
      panelId: t.panelId, commandId: 'stop', utteranceId: spoken, change: { kind: 'tour', patch: { action: 'done' } } });
    expect(wrongSource.isError).toBe(true);
  } finally { await t.close(); }
});

// The device follow-up. The hemoglobin
// lesson autoplayed a chapter every 17 s with `tourState.active:false`
// throughout, and a `restore-start` bound to "Stop, go back to my view" was
// refused 7.5 s after the words, one chapter later.
it('a stop bound to words spoken two authored chapters ago is accepted', async () => {
  const t = await setup(); try {
    await t.journeyBeat(2);
    const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await journeyChapter(t, 3, 0.6);
    await journeyChapter(t, 4, 0.7);
    const stop = await tour(t, 'stop', 'restore-start', spoken);
    expect(stop.isError).not.toBe(true);
    expect(stop.structuredContent.command.status).toBe('queued');
    expect(stop.structuredContent.command.utteranceId).toBe(spoken);
  } finally { await t.close(); }
});

it('the page announces an authored chapter on a beat before saving it, and the stop is still accepted', async () => {
  const t = await setup(); try {
    await t.journeyBeat(2);
    const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    // The device's shape: the step moves on one beat, the save follows, the next beat repeats the step.
    await t.journeyBeat(3); await t.save(0.6); await t.journeyBeat(3);
    await t.journeyBeat(4); await t.save(0.7); await t.journeyBeat(4);
    const stop = await tour(t, 'stop', 'restore-start', spoken);
    expect(stop.isError).not.toBe(true);
    expect(stop.structuredContent.command.status).toBe('queued');
    expect(stop.structuredContent.command.utteranceId).toBe(spoken);
  } finally { await t.close(); }
});

it('a manual edit after the announced chapter and before its save does not make the stop pass', async () => {
  const t = await setup(); try {
    await t.journeyBeat(2);
    const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await t.journeyBeat(3); await t.save(0.6); await t.save(0.65); await t.journeyBeat(3);
    const stop = await tour(t, 'stop', 'restore-start', spoken);
    expect(stop.isError).toBe(true);
  } finally { await t.close(); }
});

it('done and the cancel before a stop survive the same authored chapters', async () => {
  const t = await setup(); try {
    await t.journeyBeat(2);
    const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await journeyChapter(t, 3, 0.6);
    const cancelled = await utterance(t, 'cancel', 'cancel', spoken);
    expect(cancelled.isError).not.toBe(true);
    expect(cancelled.structuredContent.lifecycle.action).toBe('cancel');
  } finally { await t.close(); }
  const t2 = await setup(); try {
    await t2.journeyBeat(2);
    const spoken = (await utterance(t2, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await journeyChapter(t2, 3, 0.6);
    expect((await tour(t2, 'stop-done', 'done', spoken)).structuredContent.command.status).toBe('queued');
  } finally { await t2.close(); }
});

it('a manual edit between the words and the stop still refuses an authored stop', async () => {
  const t = await setup(); try {
    await t.journeyBeat(2);
    const spoken = (await utterance(t, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    // A hand on the scene: the revision moves, the chapter does not.
    await t.save(0.4);
    await t.journeyBeat(2);
    await journeyChapter(t, 3, 0.6);
    const refused = await tour(t, 'stop', 'restore-start', spoken);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('changed since this utterance');
    // Unbound, the same stop is the model's documented fallback and still works.
    expect((await tour(t, 'stop-unbound', 'restore-start')).structuredContent.command.status).toBe('queued');
  } finally { await t.close(); }
});

it('an ended lesson, a different lesson, a skipped chapter and a begin are all refused', async () => {
  // The journey ended: the beat carries no chapter, so the words are no
  // longer about a lesson.
  const ended = await setup(); try {
    await ended.journeyBeat(2);
    const spoken = (await utterance(ended, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await journeyChapter(ended, 3, 0.6);
    await ended.journeyBeat();
    const refused = await tour(ended, 'stop', 'done', spoken);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('changed since this utterance');
  } finally { await ended.close(); }
  // A different lesson is playing now.
  const swapped = await setup(); try {
    await swapped.journeyBeat(2);
    const spoken = (await utterance(swapped, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await swapped.save(0.6);
    await swapped.journeyBeat(3, 'myoglobin-oxygen-affinity');
    const refused = await tour(swapped, 'stop', 'restore-start', spoken);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('changed since this utterance');
  } finally { await swapped.close(); }
  // Two chapters over one saved revision is not the shape autoplay draws.
  const skipped = await setup(); try {
    await skipped.journeyBeat(2);
    const spoken = (await utterance(skipped, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await journeyChapter(skipped, 4, 0.6);
    const refused = await tour(skipped, 'stop', 'restore-start', spoken);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('changed since this utterance');
  } finally { await skipped.close(); }
  // A superseded `begin` is unchanged.
  const begun = await setup(); try {
    await begun.journeyBeat(2);
    const spoken = (await utterance(begun, 'heard')).structuredContent.lifecycle.utterance.utteranceId as string;
    await journeyChapter(begun, 3, 0.6);
    const rebegun = await utterance(begun, 'begin-again', 'begin', spoken);
    expect(rebegun.isError).toBe(true);
    expect(rebegun.content[0].text).toContain('changed since this utterance');
  } finally { await begun.close(); }
});
