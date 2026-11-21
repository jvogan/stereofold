/**
 * A source load handed to the headset page while a desktop panel shares the
 * session. The headset is the transition owner and starts drawing; the desktop
 * waits for the owner's first saved scene. A desktop panel the host drops for
 * silence while the owner draws used to re-register by drawing the new source
 * and saving its first scene at once, and the owner's save was then refused.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { sharedPanelSession, type Binding } from './helpers/shared-panel-session.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const showing = { phase: 'active', pending: false, reloadRequired: false, mode: 'immersive-ar', gestureActive: null,
  presenting: true, visible: true, sessionVisibility: 'visible', frameCount: 20 };
const headsetOff = { ...showing, presenting: false, visible: false, sessionVisibility: 'hidden', frameCount: 0 };
const nextSource = { kind: 'pasted', text: `${cif}\n# next source\n` };

async function deskAndHeadset() {
  const clock = { now: 1_000_000 };
  const t = await sharedPanelSession({ now: () => clock.now });
  const desk = (await t.call('attach_inspection', { sessionId: t.sessionId, ...t.binding, surface: 'desktop' })).structuredContent.panelId as string;
  const before: Binding = { ...t.binding };
  const deskBeat = () => t.call('poll_inspection', { sessionId: t.sessionId, ...before, panelId: desk, availability: 'ready' });
  const headsetBeat = (availability: 'ready' | 'busy', xrStartup = showing) => t.call('poll_inspection',
    { sessionId: t.sessionId, ...before, panelId: t.panelId, availability, xrStartup });
  await headsetBeat('ready'); await deskBeat();
  /** The headset draws for `ms` and reports busy; the desk sends nothing. */
  const deskSilent = async (ms: number) => { for (let elapsed = 0; elapsed < ms; elapsed += 3_000) { clock.now += 3_000; await headsetBeat('busy'); } };
  /** What the dropped desk does with a beat, as `poll` in inspector.ts decides. */
  const deskFollows = (beat: any) => {
    expect(beat.structuredContent.attached).toBe(false);
    const sourceChanged = beat.structuredContent.sourceToken !== before.sourceToken;
    return sourceChanged && beat._meta[KEY].awaitSourceOwner === true ? 'wait' : 'hydrate';
  };
  /** The desk's hydrate: read the host, draw its scene or a first one, save. */
  const deskHydrates = async () => {
    const read = (await t.call('get_inspection', { sessionId: t.sessionId }))._meta[KEY];
    const catalog = read.catalog ?? await decodeInspectionCatalog(read.catalogWire);
    const binding = { serverEpoch: read.serverEpoch, sourceToken: read.sourceToken,
      baseStateRevision: read.stateRevision, baseInspectionRevision: read.inspectionRevision };
    const scene = read.scene ?? { ...t.saved, sourceSha256: catalog.source.sha256, selectionKeys: [] };
    return { scene, answer: (await t.call('sync_inspection', { sessionId: t.sessionId, ...binding, scene })).structuredContent };
  };
  return { t, clock, desk, before, deskBeat, headsetBeat, deskSilent, deskFollows, deskHydrates };
}

describe('a desktop panel dropped while another page draws a new source', () => {
  it('waits for the page that owns the load, whose first save is then accepted', async () => {
    const { t, before, deskBeat, headsetBeat, deskSilent, deskFollows, deskHydrates } = await deskAndHeadset();
    try {
      const loaded = await t.call('replace_inspection_source', { sessionId: t.sessionId, ...before, panelId: t.panelId, source: nextSource });
      expect(loaded.isError, JSON.stringify(loaded.content)).not.toBe(true);
      // The headset takes the load on a visible beat and reads the new source.
      expect((await headsetBeat('ready'))._meta[KEY].transitionTarget).toBe(true);
      const owner = (await t.call('get_inspection', { sessionId: t.sessionId }))._meta[KEY];
      expect(owner.sourceReplacement?.panelId).toBe(t.panelId);
      // A follower desk beat is told to wait for the owner.
      expect((await deskBeat())._meta[KEY].transitionTarget).toBe(false);
      // The desk misses its 10 s allowance while the headset draws.
      await deskSilent(12_000);
      expect(deskFollows(await deskBeat())).toBe('wait');
      expect(deskFollows(await deskBeat())).toBe('wait');
      // The owner's save, on the revisions it read before drawing, is accepted.
      const catalog = owner.catalog ?? await decodeInspectionCatalog(owner.catalogWire);
      const ownerScene = { ...t.saved, sourceSha256: catalog.source.sha256, selectionKeys: [],
        camera: { ...t.saved.camera, position: [20, 0, 60] } };
      const ownerSave = (await t.call('sync_inspection', { sessionId: t.sessionId, serverEpoch: owner.serverEpoch,
        sourceToken: owner.sourceToken, baseStateRevision: owner.stateRevision, baseInspectionRevision: owner.inspectionRevision,
        panelId: t.panelId, scene: ownerScene })).structuredContent;
      expect(ownerSave).toMatchObject({ saved: true });
      // Then the desk re-registers on the owner's scene, as before.
      expect(deskFollows(await deskBeat())).toBe('hydrate');
      const desk = await deskHydrates();
      expect(desk.scene.camera.position).toEqual([20, 0, 60]);
      expect(desk.answer).toMatchObject({ saved: true });
    } finally { await t.close(); }
  });

  it('stops waiting when the owning page leaves, or when the load lease ends', async () => {
    for (const ending of ['detached', 'lease'] as const) {
      const { t, clock, before, deskBeat, headsetBeat, deskSilent, deskFollows, deskHydrates } = await deskAndHeadset();
      try {
        await t.call('replace_inspection_source', { sessionId: t.sessionId, ...before, panelId: t.panelId, source: nextSource });
        expect((await headsetBeat('ready'))._meta[KEY].transitionTarget).toBe(true);
        await deskSilent(12_000);
        expect(deskFollows(await deskBeat()), ending).toBe('wait');
        if (ending === 'detached') await t.call('detach_inspection', { sessionId: t.sessionId, ...before, panelId: t.panelId });
        // The headset still beats busy at 114 s; the 120 s lease ends the wait.
        else { await deskSilent(102_000); expect(deskFollows(await deskBeat())).toBe('wait'); clock.now += 9_000; }
        expect(deskFollows(await deskBeat()), ending).toBe('hydrate');
        expect((await deskHydrates()).answer, ending).toMatchObject({ saved: true });
      } finally { await t.close(); }
    }
  });

  it('hydrates at once as today when no page has started the load', async () => {
    for (const owned of ['none', 'paused-headset'] as const) {
      const { t, before, deskBeat, headsetBeat, deskSilent, deskFollows, deskHydrates } = await deskAndHeadset();
      try {
        await deskSilent(12_000);
        await t.call('replace_inspection_source', { sessionId: t.sessionId, ...before,
          ...(owned === 'paused-headset' ? { panelId: t.panelId } : {}), source: nextSource });
        if (owned === 'paused-headset') expect((await headsetBeat('busy', headsetOff))._meta[KEY].transitionTarget).toBe(true);
        const beat = await deskBeat();
        expect(beat._meta[KEY].awaitSourceOwner, owned).toBeUndefined();
        expect(deskFollows(beat), owned).toBe('hydrate');
        expect((await deskHydrates()).answer, owned).toMatchObject({ saved: true });
      } finally { await t.close(); }
    }
  });
});
