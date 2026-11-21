/**
 * A headset page that is paused or gone must not hold up the Mac.
 *
 * Two panels share one session here: the headset page from
 * `sharedPanelSession` and a desktop panel beside it. The headset reports a
 * hidden immersive session (taken off, or a boundary prompt in front of it)
 * or a hidden flat page, the way a sleeping Quest does, and the desktop keeps
 * checking in.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PRIVATE_INSPECTION_META_KEY as KEY, type InspectionScene } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { sharedPanelSession, type Binding } from './helpers/shared-panel-session.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const lesson = () => {
  const atom = (residue: number) => ({ chain: 'A', residues: { from: residue, to: residue }, atomName: 'CA' });
  const chapter = (id: string) => ({ id, title: id, caption: 'An authored test path.', durationSeconds: 10,
    changes: [{ kind: 'hold', durationSeconds: 10 }], immersive: { motion: 'hold',
      figure: { layers: [{ id: 'body', target: { chain: 'A' }, representation: 'cartoon', color: '#ff8800' }],
        labels: [{ id: 'name', target: atom(1), text: 'First residue', color: '#ffffff' }] } } });
  return { version: 1, id: 'paused-lesson', title: 'Paused lesson', mode: 'explore',
    provenance: { sourceRefs: [{ kind: 'public', ref: 'https://www.rcsb.org/structure/1CRN' }] },
    chapters: [chapter('first'), chapter('second')] };
};
const report = { phase: 'active', pending: false, reloadRequired: false, mode: 'immersive-ar', gestureActive: null };
const headsetOff = { ...report, presenting: true, visible: true, sessionVisibility: 'hidden' };
const pageHidden = { ...report, presenting: false, visible: false, sessionVisibility: 'visible' };
const showing = { ...report, presenting: true, visible: true, sessionVisibility: 'visible', frameCount: 20 };
const textState = (result: any) => Object.assign({}, ...result.content.flatMap((item: any) => {
  if (item.type !== 'text') return [];
  if (item.text.startsWith('{')) return [JSON.parse(item.text)];
  const json = item.text.match(/```json\n([\s\S]*?)\n```/);
  return json ? [JSON.parse(json[1])] : [];
}));

async function deskAndHeadset() {
  const clock = { now: 1_000_000 };
  const t = await sharedPanelSession({ now: () => clock.now });
  const desk = (await t.call('attach_inspection', { sessionId: t.sessionId, ...t.binding, surface: 'desktop' })).structuredContent.panelId as string;
  const deskBeat = async (from: Binding = t.binding) => (await t.call('poll_inspection',
    { sessionId: t.sessionId, ...from, panelId: desk, availability: 'ready' }));
  const headsetBeat = async (xrStartup: any, availability: 'ready' | 'busy' = 'busy', from: Binding = t.binding) => (await t.call('poll_inspection',
    { sessionId: t.sessionId, ...from, panelId: t.panelId, availability, xrStartup }));
  const receipt = async (commandId: string) => (await t.state(commandId)).command;
  return { t, clock, desk, deskBeat, headsetBeat, receipt };
}

describe('a lesson waiting for a paused headset page', () => {
  it('holds up neither the desktop save nor the next command', async () => {
    const { t, desk, headsetBeat, deskBeat, receipt } = await deskAndHeadset();
    try {
      await headsetBeat(headsetOff);
      const installed = await t.call('install_lesson', { sessionId: t.sessionId, lesson: lesson() });
      expect(installed.isError, JSON.stringify(installed.content)).not.toBe(true);
      const queued = textState(installed).command;
      expect(queued).toMatchObject({ status: 'queued', panelId: t.panelId });
      // The desktop orbits its own view: a camera save commits, and the lesson
      // follows it to the new revision instead of answering the desk "busy".
      const orbit = structuredClone(t.saved) as InspectionScene;
      orbit.camera = { ...orbit.camera, position: [20, 0, 60] };
      const saved = (await t.call('sync_inspection', { sessionId: t.sessionId, ...t.binding, panelId: desk, scene: orbit })).structuredContent;
      expect(saved).toMatchObject({ saved: true });
      expect(saved.busy).toBeUndefined();
      expect(await receipt(queued.commandId)).toMatchObject({ status: 'queued' });
      const after: Binding = { ...t.binding, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
      expect((await deskBeat(after))._meta[KEY].delivery).toBeUndefined();
      // A newer request at the desk replaces the waiting lesson instead of
      // being refused as "already in progress".
      const edit = await t.call('update_inspection', { sessionId: t.sessionId, ...after, panelId: desk, commandId: 'desk-edit',
        change: { kind: 'appearance', patch: { opacity: 0.7 } } });
      expect(edit.isError, JSON.stringify(edit.content)).not.toBe(true);
      expect(await receipt(queued.commandId)).toMatchObject({ status: 'cancelled', reason: 'replaced_while_paused' });
      expect((await deskBeat(after))._meta[KEY].delivery).toMatchObject({ commandId: 'desk-edit' });
    } finally { await t.close(); }
  });

  it('conflicts with the reason when a desktop edit changes its inputs', async () => {
    const { t, desk, headsetBeat, receipt } = await deskAndHeadset();
    try {
      await headsetBeat(pageHidden, 'ready');
      const queued = textState(await t.call('install_lesson', { sessionId: t.sessionId, lesson: lesson() })).command;
      expect(queued).toMatchObject({ status: 'queued', panelId: t.panelId });
      const edited = structuredClone(t.saved) as InspectionScene;
      edited.inspection.appearance.opacity = 0.5;
      const saved = (await t.call('sync_inspection', { sessionId: t.sessionId, ...t.binding, panelId: desk, scene: edited })).structuredContent;
      expect(saved).toMatchObject({ saved: true });
      expect(await receipt(queued.commandId)).toMatchObject({ status: 'conflict', reason: expect.stringMatching(/Another panel changed/) });
    } finally { await t.close(); }
  });

  it.each([
    ['headset-off', headsetOff, 'busy', 180_000],
    ['page-hidden', pageHidden, 'ready', 120_000],
  ] as const)('is delivered when the %s wearer comes back in time and expires when they do not', async (_name, paused, availability, holdMs) => {
    for (const wakes of [true, false]) {
      const { t, clock, headsetBeat, deskBeat, receipt } = await deskAndHeadset();
      try {
        await headsetBeat(paused, availability);
        const queued = textState(await t.call('install_lesson', { sessionId: t.sessionId, lesson: lesson() })).command;
        // The headset keeps checking in slowly while hidden; the desk is awake.
        for (let elapsed = 0; elapsed < holdMs - 20_000; elapsed += 20_000) {
          clock.now += 20_000;
          await deskBeat();
          expect((await headsetBeat(paused, availability))._meta[KEY].delivery).toBeUndefined();
          expect(await receipt(queued.commandId)).toMatchObject({ status: 'queued' });
        }
        if (wakes) {
          expect((await headsetBeat(showing, 'ready'))._meta[KEY].delivery?.change.kind).toBe('lesson');
          continue;
        }
        clock.now += 20_000;
        await headsetBeat(paused, availability);
        expect(await receipt(queued.commandId)).toMatchObject({ status: 'expired', reason: 'panel_hold_expired',
          detail: expect.stringMatching(new RegExp(`still paused ${holdMs / 1000} seconds`)) });
        expect((await headsetBeat(showing, 'ready'))._meta[KEY].delivery).toBeUndefined();
      } finally { await t.close(); }
    }
  });
});

describe('a source load while the headset page is paused', () => {
  /** The renderer that owns a source transition draws, saves and attaches the new source. */
  async function drawSource(t: any, panelId: string, surface: 'desktop' | 'companion', previous: Binding) {
    const data = (await t.call('get_inspection', { sessionId: t.sessionId }))._meta[KEY];
    expect(data.sourceReplacement?.panelId).toBe(panelId);
    const catalog = data.catalog ?? await decodeInspectionCatalog(data.catalogWire);
    const next = { ...previous, sourceToken: data.sourceToken, baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision };
    const scene = { ...t.saved, sourceSha256: catalog.source.sha256, selectionKeys: [] };
    const saved = (await t.call('sync_inspection', { sessionId: t.sessionId, ...next, scene })).structuredContent;
    expect(saved).toMatchObject({ saved: true });
    return t.call('attach_inspection', { sessionId: t.sessionId, ...next, baseInspectionRevision: saved.inspectionRevision,
      surface, replacesPanelId: panelId });
  }
  const nextSource = { kind: 'pasted', text: `${cif}\n# next source\n` };

  it.each([['headset-off', headsetOff], ['page-hidden', pageHidden]] as const)(
    'is drawn on the desktop when asked for at the desk while the headset is %s', async (_name, paused) => {
      const { t, desk, headsetBeat, deskBeat } = await deskAndHeadset();
      try {
        const before = t.binding;
        await headsetBeat(paused);
        const loaded = await t.call('replace_inspection_source', { sessionId: t.sessionId, source: nextSource });
        expect(loaded.isError, JSON.stringify(loaded.content)).not.toBe(true);
        expect(loaded.structuredContent.sourceRenderStatus.panelId).toBe(desk);
        expect((await headsetBeat(paused, 'busy', before))._meta[KEY].transitionTarget).toBe(false);
        expect((await deskBeat(before))._meta[KEY].transitionTarget).toBe(true);
        const attached = await drawSource(t, desk, 'desktop', before);
        expect(attached.isError, JSON.stringify(attached.content)).not.toBe(true);
        expect(attached.structuredContent.sourceRenderReceipt).toMatchObject({ status: 'rendered', panelId: desk });
        // The headset follows the saved scene once it can draw again.
        const woke = await headsetBeat(showing, 'ready', before);
        expect(woke.structuredContent.hasScene).toBe(true);
      } finally { await t.close(); }
    });

  it('is drawn on the desktop when the headset page was dropped for silence', async () => {
    const { t, clock, desk, deskBeat, headsetBeat } = await deskAndHeadset();
    try {
      const before = t.binding;
      await headsetBeat(headsetOff);
      for (let elapsed = 0; elapsed < 190_000; elapsed += 5_000) { clock.now += 5_000; await deskBeat(); }
      expect((await t.state()).wearer.state).toBe('unknown');
      const loaded = await t.call('replace_inspection_source', { sessionId: t.sessionId, source: nextSource });
      expect(loaded.isError, JSON.stringify(loaded.content)).not.toBe(true);
      expect(loaded.structuredContent.sourceRenderStatus.panelId).toBe(desk);
      expect((await deskBeat(before))._meta[KEY].transitionTarget).toBe(true);
      const attached = await drawSource(t, desk, 'desktop', before);
      expect(attached.structuredContent.sourceRenderReceipt).toMatchObject({ status: 'rendered', panelId: desk });
    } finally { await t.close(); }
  });

  it('sent to a sleeping headset page passes to the desktop, but never once the headset has started it', async () => {
    for (const started of [false, true]) {
      const { t, desk, headsetBeat, deskBeat } = await deskAndHeadset();
      try {
        const before = t.binding;
        await headsetBeat(headsetOff);
        const loaded = await t.call('replace_inspection_source', { sessionId: t.sessionId, ...before, panelId: t.panelId, source: nextSource });
        expect(loaded.isError, JSON.stringify(loaded.content)).not.toBe(true);
        if (started) {
          // The wearer came back and the page took the load on a visible beat.
          expect((await headsetBeat(showing, 'ready', before))._meta[KEY].transitionTarget).toBe(true);
          await headsetBeat(headsetOff, 'busy', before);
          expect((await deskBeat(before))._meta[KEY].transitionTarget).toBe(false);
          const attached = await drawSource(t, t.panelId, 'companion', before);
          expect(attached.structuredContent.sourceRenderReceipt).toMatchObject({ status: 'rendered', panelId: t.panelId });
          continue;
        }
        expect((await headsetBeat(headsetOff, 'busy', before))._meta[KEY].transitionTarget).toBe(true);
        expect((await deskBeat(before))._meta[KEY].transitionTarget).toBe(true);
        expect((await headsetBeat(headsetOff, 'busy', before))._meta[KEY].transitionTarget).toBe(false);
        const attached = await drawSource(t, desk, 'desktop', before);
        expect(attached.isError, JSON.stringify(attached.content)).not.toBe(true);
        expect(attached.structuredContent.sourceRenderReceipt).toMatchObject({ status: 'rendered', panelId: desk });
      } finally { await t.close(); }
    }
  });

  it('still waits for the headset when no other page can draw it', async () => {
    const clock = { now: 1_000_000 };
    const t = await sharedPanelSession({ now: () => clock.now });
    try {
      const before = t.binding;
      const beat = (xrStartup: any, availability: 'ready' | 'busy' = 'busy') =>
        t.call('poll_inspection', { sessionId: t.sessionId, ...before, panelId: t.panelId, availability, xrStartup });
      await beat(headsetOff);
      const loaded = await t.call('replace_inspection_source', { sessionId: t.sessionId, source: nextSource });
      expect(loaded.isError, JSON.stringify(loaded.content)).not.toBe(true);
      expect(loaded.structuredContent.sourceRenderStatus.panelId).toBe(t.panelId);
      clock.now += 30_000;
      await beat(headsetOff);
      // The wearer looks back: the page that was asked draws it.
      expect((await beat(showing, 'ready'))._meta[KEY].transitionTarget).toBe(true);
      const attached = await drawSource(t, t.panelId, 'companion', before);
      expect(attached.structuredContent.sourceRenderReceipt).toMatchObject({ status: 'rendered', panelId: t.panelId });
    } finally { await t.close(); }
  });
});
