// @ts-ignore Shared menu status used by the extracted inspector closure.
import { assistantStatus } from '../../lab/browser-roundtrip/assistant-status.mjs';
import { createPollBackoff } from '../src/inspection-poll-backoff.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY, expectedInspection, type InspectionScene } from '../src/inspection-contract.js';
import { InspectionCommands, WEARER_SILENT_MS } from '../src/inspection-commands.js';
import { thrownErrorMessage } from '../src/tool-result.js';
import { followsSourceTransition } from '../src/inspection-panel-recovery.js';

// 2026-09-28. The Codex app drove a Quest 2 lying asleep on a
// desk: a colour edit was claimed by the hidden headset page, which could not
// draw a frame, and was rejected thirty seconds later as render_failed. The
// saved scene kept the old colours. At 14:07 the person put the headset on,
// and the agent, with no way to read whether they had pressed Enter VR, asked
// in chat; the person took the headset off to answer. These tests hold both
// halves: an edit for a paused page is saved, and the host says where the
// wearer's page is.
const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const orange = { kind: 'appearance', patch: { color: 'uniform', uniformColor: '#ff8800' } } as const;

// A request that names a chain and a class together reads the entry's name
// before it saves, which is a real await inside update_inspection. The gate
// holds that read open so a test can commit another edit inside it.
const nameRead = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, reached: () => {} }));
vi.mock('../src/inspection-catalog.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/inspection-catalog.js')>();
  return { ...actual, inspectionSourcePdbId: async (text: string) => {
    nameRead.reached(); await nameRead.hold; return await actual.inspectionSourcePdbId(text);
  } };
});

/** One check-in's XR report, as the headset page sends it. */
const xr = (over: Record<string, unknown> = {}) => ({ phase: 'idle', pending: false, reloadRequired: false, mode: null,
  gestureActive: null, presenting: false, visible: true, ...over });
/** A presenting page's report after it has drawn `frameCount` immersive frames. */
const inVr = (frameCount: number, sessionVisibility = 'visible') =>
  xr({ phase: 'active', mode: 'immersive-ar', presenting: true, sessionVisibility, frameCount });
const hiddenPage = xr({ visible: false });
const offTheHead = xr({ phase: 'active', mode: 'immersive-ar', presenting: true, sessionVisibility: 'hidden' });

const sceneFor = (sourceSha256: string, modelNumber: number, assemblyId: string) => ({
  sourceSha256, modelNumber, assemblyId, selectionKeys: [] as string[],
  camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
    radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
  inspection: {
    appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#071015',
      highlightColor: '#f2c47c', opacity: 1, labels: false, clipping: 0, fog: 0 },
    placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
  } });

describe('the host reads a headset page from its check-ins', () => {
  const binding = { serverEpoch: 'e', sourceToken: 't', stateRevision: 1, inspectionRevision: 1 };
  const expected = { serverEpoch: 'e', sourceToken: 't', baseStateRevision: 1, baseInspectionRevision: 1 };
  const scene = sceneFor('a'.repeat(64), 1, '1') as unknown as InspectionScene;

  it('moves the wearer state through no-page, page-open, entering-vr, in-vr, paused and unknown, with the last check-in', () => {
    let clock = 1_000_000;
    const commands = new InspectionCommands(() => clock);
    expect(commands.wearerPage(binding)).toEqual({ state: 'no-page' });
    const panelId = commands.attach({ ...expected, surface: 'companion' }, binding);
    const beat = (report: Record<string, unknown>, availability: 'ready' | 'busy' = 'ready') => {
      clock += 250;
      return commands.poll({ ...expected, panelId, availability, xrStartup: report as any }, binding);
    };
    beat(xr());
    expect(commands.wearerPage(binding)).toEqual({ state: 'page-open', panelId, checkedInAt: clock });
    // Enter VR: the browser granted the session, and the render loop has not
    // drawn a frame yet. Presenting is not the wearer seeing anything.
    beat(inVr(0));
    beat(inVr(0));
    expect(commands.wearerPage(binding).state).toBe('entering-vr');
    beat(inVr(18));
    expect(commands.wearerPage(binding).state).toBe('in-vr');
    // A system dialog blurs the session: the page stops counting frames, and
    // the first visible report has no new frame in it yet.
    beat(inVr(18, 'visible-blurred'));
    expect(commands.wearerPage(binding).state).toBe('entering-vr');
    beat(inVr(18));
    expect(commands.wearerPage(binding).state).toBe('entering-vr');
    beat(inVr(36));
    expect(commands.wearerPage(binding).state).toBe('in-vr');
    // Frames that stopped moving two seconds before the last report are not fresh.
    for (let i = 0; i < 7; i++) beat(inVr(36));
    expect(commands.wearerPage(binding).state).toBe('in-vr');
    beat(inVr(36));
    expect(commands.wearerPage(binding).state).toBe('entering-vr');
    // The headset came off: the session is hidden, and the page says busy.
    beat(offTheHead, 'busy');
    expect(commands.wearerPage(binding)).toMatchObject({ state: 'paused', pausedBecause: 'headset-hidden' });
    // Asleep on the desk, out of VR: the flat page is hidden.
    beat(hiddenPage);
    expect(commands.wearerPage(binding)).toMatchObject({ state: 'paused', pausedBecause: 'page-hidden' });
    beat(xr());
    const lastBeat = clock;
    clock += WEARER_SILENT_MS - 1;
    expect(commands.wearerPage(binding).state).toBe('page-open');
    clock += 1;
    expect(commands.wearerPage(binding)).toEqual({ state: 'paused', panelId, checkedInAt: lastBeat, pausedBecause: 'silent' });
    // Past the minute of headset grace the panel is dropped. A closed tab
    // looks the same from here, so the host no longer calls it paused.
    clock += 60_000;
    expect(commands.summary(binding).panels).toEqual([]);
    expect(commands.wearerPage(binding)).toEqual({ state: 'unknown', panelId, checkedInAt: lastBeat });
    // The page wakes and registers again.
    const back = commands.attach({ ...expected, surface: 'companion' }, binding);
    expect(commands.wearerPage(binding)).toEqual({ state: 'page-open', panelId: back, checkedInAt: clock });
  });

  it('pauses a silent busy page after its frames stop and does not guess once it is dropped', () => {
    let clock = 0;
    const commands = new InspectionCommands(() => clock);
    const panelId = commands.attach({ ...expected, surface: 'companion' }, binding);
    commands.poll({ ...expected, panelId, availability: 'busy', xrStartup: inVr(100) as any }, binding);
    clock += 250;
    commands.poll({ ...expected, panelId, availability: 'busy', xrStartup: inVr(103) as any }, binding);
    expect(commands.wearerPage(binding).state).toBe('in-vr');
    clock += 2_000;
    expect(commands.wearerPage(binding).state).toBe('entering-vr');
    clock += WEARER_SILENT_MS - 2_000;
    expect(commands.wearerPage(binding)).toMatchObject({ state: 'paused', pausedBecause: 'silent', panelId });
    // The busy panel keeps its longer registry grace without claiming live frames.
    clock += 180_000;
    expect(commands.wearerPage(binding)).toMatchObject({ state: 'unknown', panelId });
  });

  it('requires a new frame rise after the count falls for a new XR session', () => {
    let clock = 0;
    const commands = new InspectionCommands(() => clock);
    const panelId = commands.attach({ ...expected, surface: 'companion' }, binding);
    const beat = (count: number) => commands.poll({ ...expected, panelId, availability: 'ready', xrStartup: inVr(count) as any }, binding);
    beat(100);
    clock += 250;
    beat(101);
    expect(commands.wearerPage(binding).state).toBe('in-vr');
    clock += 250;
    beat(0);
    expect(commands.wearerPage(binding).state).toBe('entering-vr');
    clock += 250;
    beat(1);
    expect(commands.wearerPage(binding).state).toBe('in-vr');
  });

  it('gives a visible busy source renderer its full geometry budget, but still bounds silence', () => {
    let clock = 0;
    const commands = new InspectionCommands(() => clock);
    commands.setRenderBudget(300_000);
    const panelId = commands.attach({ ...expected, surface: 'companion' }, binding);
    commands.poll({ ...expected, panelId, availability: 'busy', xrStartup: xr() as any }, binding);
    commands.holdSourceLoad(panelId);
    clock = 200_000;
    expect(commands.summary(binding).panels.map(p => p.panelId)).toContain(panelId);
    clock = 299_999;
    expect(commands.summary(binding).panels.map(p => p.panelId)).toContain(panelId);
    clock = 300_000;
    expect(commands.summary(binding).panels).toEqual([]);
  });

  it('keeps an edit whose page went quiet before its deadline, however late the host next looks', () => {
    let clock = 0;
    const commands = new InspectionCommands(() => clock);
    const panelId = commands.attach({ ...expected, surface: 'companion' }, binding);
    commands.poll({ ...expected, panelId, availability: 'ready', xrStartup: xr() as any }, binding);
    expect(commands.enqueue({ ...expected, panelId, commandId: 'late', change: orange as any }, binding, scene).status).toBe('queued');
    // The page froze before its next beat, and nothing asked the host for sixteen seconds.
    clock += 16_000;
    expect(commands.summary(binding, 'late').command).toMatchObject({ status: 'queued' });
    expect(commands.keepQueuedForPausedWearer(binding)?.command).toMatchObject({ commandId: 'late', status: 'saved', wearerPaused: 'silent' });
  });

  it('still lets an edit expire when its page was checking in at the deadline', () => {
    let clock = 0;
    const commands = new InspectionCommands(() => clock);
    const panelId = commands.attach({ ...expected, surface: 'companion' }, binding);
    commands.poll({ ...expected, panelId, availability: 'busy', xrStartup: xr() as any }, binding);
    commands.enqueue({ ...expected, panelId, commandId: 'held', change: orange as any }, binding, scene);
    // The page checks in busy until the deadline and hides only then, so it
    // was awake when the deadline came.
    clock += 14_000;
    commands.poll({ ...expected, panelId, availability: 'busy', xrStartup: xr() as any }, binding);
    clock += 1_000;
    commands.poll({ ...expected, panelId, availability: 'ready', xrStartup: hiddenPage as any }, binding);
    clock += 20_000;
    expect(commands.summary(binding, 'held').command).toMatchObject({ status: 'expired' });
  });

  it('never hands a hidden page an edit, and keeps the edit that was waiting for it', () => {
    const commands = new InspectionCommands(() => 0);
    const panelId = commands.attach({ ...expected, surface: 'companion' }, binding);
    commands.poll({ ...expected, panelId, availability: 'ready', xrStartup: xr() as any }, binding);
    const queued = commands.enqueue({ ...expected, panelId, commandId: 'c1', change: orange as any }, binding, scene);
    expect(queued.status).toBe('queued');
    // The page says ready, but hidden: the build before this claimed the edit here.
    const beat = commands.poll({ ...expected, panelId, availability: 'ready', xrStartup: hiddenPage as any }, binding);
    expect(beat).toEqual({ attached: true });
    const kept = commands.keepQueuedForPausedWearer(binding)!;
    expect(kept.command).toMatchObject({ commandId: 'c1', status: 'saved', savedRevision: 2, wearerPaused: 'page-hidden' });
    expect(kept.scene).toEqual(expectedInspection(scene, orange as any));
    expect(commands.summary(binding, 'c1').command?.status).toBe('saved');
  });

  it('saves an edit for a paused page and refuses one only the page can apply', () => {
    const commands = new InspectionCommands(() => 0);
    const panelId = commands.attach({ ...expected, surface: 'companion' }, binding);
    commands.poll({ ...expected, panelId, availability: 'busy', xrStartup: offTheHead as any }, binding);
    const kept = commands.keepForPausedWearer({ ...expected, panelId, commandId: 'c2', change: orange as any }, binding, scene)!;
    expect(kept.command).toMatchObject({ status: 'saved', savedRevision: 2, wearerPaused: 'headset-hidden' });
    expect(() => commands.keepForPausedWearer({ ...expected, panelId, commandId: 'c3',
      change: { kind: 'motion', patch: { state: 'spin' } } as any }, binding, scene))
      .toThrow(/^Not sent: the headset is not showing the VR view.*Only the headset page can apply a spin change/u);
    // Nothing that reaches the queue waits on a page that cannot draw.
    expect(() => commands.enqueue({ ...expected, panelId, commandId: 'c4',
      change: { kind: 'motion', patch: { state: 'spin' } } as any }, binding, scene)).toThrow(/^Not sent:/u);
  });
});

async function setup(clock?: { value: number }) {
  // The loopback companion listener serves the packaged inspector page, so the
  // fixture is a miniature dist/.
  const dist = await mkdtemp(join(tmpdir(), 'stereofold-asleep-wearer-'));
  await writeFile(join(dist, 'viewer.html'), '<html><script>void 0;</script></html>');
  await writeFile(join(dist, 'inspector.html'), '<html><script>void 0;</script></html>');
  await mkdir(join(dist, 'molstar'), { recursive: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(join(dist, 'viewer.html'), clock ? { now: () => clock.value } : {});
  const client = new Client({ name: 'Stereofold asleep wearer test', version: '1' });
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
  const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId as string;
  const data = (await call('get_inspection', { sessionId }))._meta[KEY];
  const scene = sceneFor(data.catalog.source.sha256, data.catalog.modelNumbers[0], data.catalog.assemblyId);
  const saved = (await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
    baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene })).structuredContent;
  const live = { sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
    baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  expect((await call('open_companion', { ...live, connection: 'loopback' })).isError).toBeFalsy();
  const headset = (await call('attach_inspection', { ...live, surface: 'companion' })).structuredContent.panelId as string;
  /** One headset check-in at the page's own revision. */
  const beat = async (report: Record<string, unknown>, at = live, availability = 'ready') =>
    await call('poll_inspection', { ...at, panelId: headset, availability, xrStartup: report });
  const state = async (commandId?: string) =>
    (await call('get_inspection_state', { sessionId, ...(commandId ? { commandId } : {}) })).structuredContent;
  return { call, live, scene, sessionId, headset, beat, state,
    close: async () => { await client.close(); await server.close(); await rm(dist, { force: true, recursive: true }); } };
}

describe('an edit sent while the headset is asleep', () => {
  it('is saved inside the call, says so, and reaches the page when it wakes', async () => {
    const t = await setup();
    try {
      await t.beat(hiddenPage);
      const started = Date.now();
      const sent = await t.call('update_inspection', { sessionId: t.sessionId, change: orange, waitForRenderMs: 10_000 });
      expect(Date.now() - started, 'the answer does not wait on a page that cannot draw').toBeLessThan(2_000);
      expect(sent.isError).toBeFalsy();
      expect(sent.structuredContent.command).toMatchObject({ panelId: t.headset, status: 'saved',
        savedRevision: t.live.baseInspectionRevision + 1, wearerPaused: 'page-hidden' });
      expect(sent.content[0].text).toBe('Saved, not drawn: the headset browser has hidden the page, because the headset is asleep '
        + 'or another app is in front. The headset page draws the saved change by itself when it is showing again; nothing needs resending. '
        + 'If the wearer moved the molecule by hand, it stays where they put it; a placement saved on this Mac does not move it. '
        + 'Status "saved" is not "rendered", so do not say the wearer has seen it.');
      const after = await t.state(sent.structuredContent.command.commandId);
      expect(after.view.appearance).toMatchObject({ color: 'uniform', uniformColor: '#ff8800' });
      expect(after.command.status).toBe('saved');
      expect(after.wearer).toMatchObject({ state: 'paused', pausedBecause: 'page-hidden' });
      expect(after.wearer.note).toContain('Wait for wearer.state to change instead of reconnecting');

      // A second edit while still asleep: the page is now behind, and still the target.
      const second = await t.call('update_inspection', { sessionId: t.sessionId,
        change: { kind: 'appearance', patch: { opacity: 0.5 } } });
      expect(second.structuredContent.command).toMatchObject({ panelId: t.headset, status: 'saved' });
      // A focus needs the page, so it is refused at once rather than queued.
      const focus = await t.call('focus_selection', { sessionId: t.sessionId, residues: { labelChain: 'A' } });
      expect(focus.isError).toBe(true);
      expect(focus.content[0].text).toContain('Only the headset page can apply a focus change');

      // The page wakes: its first visible beat is handed the saved scene to follow, and no command.
      const woke = await t.beat(xr());
      expect(woke._meta[KEY].delivery).toBeUndefined();
      expect(woke._meta[KEY].scene.inspection.appearance).toMatchObject({ uniformColor: '#ff8800', opacity: 0.5 });
      expect(woke.structuredContent.outcome).toMatchObject({ status: 'saved' });
    } finally { await t.close(); }
  });

  it('is taken back by undo while the headset is still off', async () => {
    const t = await setup();
    try {
      await t.beat(offTheHead, t.live, 'busy');
      expect((await t.call('update_inspection', { sessionId: t.sessionId, change: orange })).structuredContent.command.status).toBe('saved');
      const undone = await t.call('undo_last_change', { sessionId: t.sessionId });
      expect(undone.structuredContent.command.status).toBe('saved');
      expect(undone.content[0].text).toMatch(/^Undo saved: took back the last appearance change from the companion surface\. Saved, not drawn: the headset is not showing the VR view/u);
      expect((await t.state()).view.appearance).toMatchObject({ color: 'chain-id' });
      expect(undone.structuredContent.history).toEqual({undoCount:0,redoCount:1,canUndo:false,canRedo:true});
      const redone=await t.call('redo_last_change',{sessionId:t.sessionId});
      expect(redone.structuredContent.command.status).toBe('saved');
      expect(redone.structuredContent.history).toEqual({undoCount:1,redoCount:0,canUndo:true,canRedo:false});
      expect((await t.state()).view.appearance).toMatchObject({color:'uniform',uniformColor:'#ff8800'});
    } finally { await t.close(); }
  });

  it('is kept when the page goes quiet after the edit was queued, and after the page drops out', async () => {
    const clock = { value: Date.now() };
    const t = await setup(clock);
    try {
      await t.beat(xr());
      const queued = (await t.call('update_inspection', { sessionId: t.sessionId, change: orange })).structuredContent.command;
      expect(queued.status).toBe('queued');
      // The page froze before its next beat: no hidden report, only silence.
      clock.value += WEARER_SILENT_MS;
      const read = await t.state(queued.commandId);
      expect(read.command).toMatchObject({ status: 'saved', wearerPaused: 'silent' });
      expect(read.view.appearance).toMatchObject({ uniformColor: '#ff8800' });
      expect(read.wearer).toMatchObject({ state: 'paused', pausedBecause: 'silent', checkedInAt: clock.value - WEARER_SILENT_MS });
      // A minute later the host has dropped the silent panel, and still keeps
      // edits for it, but it no longer calls a page it cannot see paused.
      clock.value += 60_000;
      const later = await t.call('update_inspection', { sessionId: t.sessionId, change: { kind: 'appearance', patch: { opacity: 0.4 } } });
      expect(later.structuredContent.command).toMatchObject({ panelId: t.headset, status: 'saved', wearerPaused: 'silent' });
      expect(later.content[0].text).toContain('the headset page has not checked in for 65 s; the headset is asleep, or the page was closed');
      const unknown = await t.call('get_inspection_state', { sessionId: t.sessionId });
      expect(unknown.content[0].text).toContain('wearer not linked (wearer.state unknown, checked in 65 s ago)');
      expect(unknown.structuredContent.wearer.note).toContain('Do not tell the person the headset is asleep.');
    } finally { await t.close(); }
  });

  // A retried call has to answer as the first one did, so the wearer fields
  // carry the time of the last check-in rather than its age.
  it('reports the same wearer on a repeated read while the page stays as it was', async () => {
    const clock = { value: Date.now() };
    const t = await setup(clock);
    try {
      await t.beat(xr());
      for (const [wait, state] of [[WEARER_SILENT_MS, 'paused'], [60_000, 'unknown']] as const) {
        clock.value += wait;
        const first = (await t.state()).wearer;
        clock.value += 2_345;
        expect(first.state).toBe(state);
        expect((await t.state()).wearer).toEqual(first);
      }
    } finally { await t.close(); }
  });

  it('is kept when the next call after the page froze comes after the queue deadline', async () => {
    const clock = { value: Date.now() };
    const t = await setup(clock);
    try {
      await t.beat(xr());
      const queued = (await t.call('update_inspection', { sessionId: t.sessionId, change: orange })).structuredContent.command;
      expect(queued.status).toBe('queued');
      // The page froze before claiming it, and the host hears nothing for 16 s,
      // past the 15 s queue deadline. The next call is another edit.
      clock.value += 16_000;
      const next = await t.call('update_inspection', { sessionId: t.sessionId, change: { kind: 'appearance', patch: { opacity: 0.5 } } });
      expect(next.structuredContent.command).toMatchObject({ status: 'saved', savedRevision: t.live.baseInspectionRevision + 2 });
      const read = await t.state(queued.commandId);
      expect(read.command).toMatchObject({ status: 'saved', savedRevision: t.live.baseInspectionRevision + 1, wearerPaused: 'silent' });
      expect(read.view.appearance).toMatchObject({ uniformColor: '#ff8800', opacity: 0.5 });
    } finally { await t.close(); }
  });

  it('is refused, not saved over a newer revision, when other edits commit while it resolves', async () => {
    const t = await setup();
    try {
      await t.beat(hiddenPage);
      let release!: () => void, arrived!: () => void;
      const reached = new Promise<void>(resolve => { arrived = resolve; });
      nameRead.hold = new Promise<void>(resolve => { release = resolve; });
      nameRead.reached = () => arrived();
      const slow = t.call('update_inspection', { sessionId: t.sessionId,
        change: { kind: 'visibility', patch: { op: 'only', chains: ['A'], classes: ['polymer'] } } });
      await reached;
      nameRead.hold = undefined; nameRead.reached = () => {};
      // While it waits, a second agent's edit is saved, and a Mac panel saves over that.
      const base = t.live.baseInspectionRevision;
      // An explicitly bound external edit bypasses the implicit admission lane.
      expect((await t.call('update_inspection', { ...t.live, panelId: t.headset, change: orange })).structuredContent.command)
        .toMatchObject({ status: 'saved', savedRevision: base + 1 });
      const mac = await t.call('sync_inspection', { ...t.live, baseInspectionRevision: base + 1, scene: t.scene });
      expect(mac.structuredContent).toMatchObject({ saved: true, inspectionRevision: base + 2 });
      release();
      const late = await slow;
      expect(late.isError).toBe(true);
      expect(late.content[0].text).toContain('use its current saved revisions');
      const after = await t.state();
      expect(after.inspectionRevision).toBe(base + 2);
      expect(after.view.appearance).toMatchObject({ color: 'chain-id' });
    } finally { nameRead.hold = undefined; nameRead.reached = () => {}; await t.close(); }
  });

  it('reads the wearer state after a launch without the person being asked', async () => {
    const t = await setup();
    try {
      await t.beat(xr());
      expect((await t.state()).wearer).toMatchObject({ state: 'page-open' });
      // Hosts that show the model only the sentence read the same state there.
      expect((await t.call('get_inspection_state', { sessionId: t.sessionId })).content[0].text).toContain('(wearer.state page-open, checked in');
      await t.beat(inVr(0));
      expect((await t.state()).wearer).toMatchObject({ state: 'entering-vr' });
      await t.beat(inVr(18));
      expect((await t.state()).wearer).toMatchObject({ state: 'in-vr', checkedInAt: expect.any(Number) });
    } finally { await t.close(); }
  });
});

// The page half: the headset page must not start drawing the saved scene
// while it cannot draw, or the restore waits out its frame deadline and leaves
// the page behind Retry when the wearer puts the headset back on.
const inspectorSource = await readFile(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const inspectorAst = ts.createSourceFile('inspector.ts', inspectorSource, ts.ScriptTarget.Latest, true);
const pageFunctions = (names: string[]) => inspectorAst.statements
  .filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''))
  .map(node => node.getText(inspectorAst)).join('\n');
const run = (source: string, context: vm.Context) => vm.runInContext(ts.transpileModule(source,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, alwaysStrict: true } }).outputText, context);
const blank = () => ({ hidden: true, textContent: '', addEventListener() {}, dataset: {} as Record<string, string> });

function wakingPage({ attached = true, sourceToken = 't', shared = true } = {}) {
  const restored: any[] = [], hydrated: string[] = [], attaches: unknown[] = [];
  const saved = { inspection: { appearance: { uniformColor: '#ff8800' } }, sourceSha256: 'sha' };
  const h: any = vm.createContext({
    failedSourceLoad:undefined,pollBackoff:createPollBackoff(),
    closed: false, experiencePreparing: false, pollInFlight: false, beatInFlight: false, beatCompletion: undefined, desktopReceiptInFlight: false, desktopReceiptBeat: undefined, pollTimer: undefined,
    generation: 1, dirty: false, blocked: false, remote: false, loading: false, edits: 0,
    heldComparisons: new Map(), comparisonRegistration: 0,
    binding: { sessionId: 's', serverEpoch: 'e', sourceToken: 't', stateRevision: 1, inspectionRevision: 1 },
    panelId: 'panel', savedScene: {}, pendingReceipt: undefined, isCompanion: true, repairNeeded: false, nextRepairAt: 0,
    replyOnThisBeat: false, hiddenSince: undefined, steppedAside: undefined, HIDDEN_STEP_ASIDE_MS: 10_000,
    voiceReadyBinding: '', problemRetryKind: 'save', rendering: Promise.resolve(), connectionWatchdog: undefined,
    connectionNotice:false,retryHydrationId:undefined,loadErrorDetails:'',thrownErrorMessage,
    Error, JSON, Date, Promise, String, Boolean, Object, Number, globalThis: {}, setTimeout, clearTimeout, PRIVATE_KEY: KEY,
    document: { visibilityState: 'hidden', body: { dataset: {} }, querySelector: () => undefined },
    app: { getHostCapabilities: () => ({}) },
    workspace: { snapshot: () => ({ ready: true, interactionActive: false, xrPresenting: false, sourceSha256: 'sha' }),
      capture: () => h.savedScene, serializeCapture() { return JSON.stringify(this.capture()); },
      viewer: { xr: { spatialContext: () => null, blind: () => false } },
      restoreShared: async (scene: any) => { restored.push(scene); return scene; } },
    expected: () => ({ sessionId: 's', serverEpoch: 'e', sourceToken: 't', baseStateRevision: 1, baseInspectionRevision: h.binding.inspectionRevision }),
    liveAvailability: () => 'ready', tourHeartbeat: () => ({}), tourPlayer: undefined, installedLesson: undefined, panelTour: undefined, experiencePlayer: undefined, experienceView: undefined,
    xrStartupReport: () => ({}), isRendererHeartbeatFailure: () => false, noteRendererHeartbeat: () => {}, noteAgentPresence: () => {}, assistantStatus,
    noteNamedViews: () => {}, receiveSpokenReply: () => {}, recordTalkReplyDelivery: () => {}, requestHeadsetViewCapture: () => {},
    showOutcome: () => {}, retireStaleHud: () => {}, syncHandoff: () => {}, scheduleSave: () => {}, handoffSpokenRequest: async () => {},
    voiceBindingKey: () => 'key', clearConnectionProblem: () => {},
    followsSourceTransition,
    receive: async () => {}, save: async () => {},
    attach: async (...args: unknown[]) => { attaches.push(args); },
    hydrate: async (id: string) => { hydrated.push(id); },
    call: async (name: string) => name !== 'poll_inspection' ? { structuredContent: {}, _meta: {} } : {
      structuredContent: { attached, hasScene: true, shared, sessionId: 's', serverEpoch: 'e', sourceToken,
        stateRevision: 1, inspectionRevision: 2 },
      _meta: { [KEY]: { scene: saved } } },
    notice: blank(), message: blank(), retry: blank(), reload: blank(), pairAgain: blank(), details: blank(), detailsText: blank(), outcome: blank(),
  });
  h.globalThis = { dispatchEvent: () => true };
  run(pageFunctions(['armPoll', 'beatSuspended', 'registerPollState', 'receivePollDelivery', 'busyBeat', 'poll', 'problemMessage', 'showProblem', 'showConnectionProblem',
    'registerComparisonSources', 'stepAsideWhileHidden']), h);
  return { h, restored, saved, hydrated, attaches };
}

describe('a headset page with a scene saved while it slept', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('waits until it can draw before it follows the saved scene', async () => {
    vi.useFakeTimers();
    const page = wakingPage();
    try {
      await page.h.poll();
      expect(page.restored, 'a hidden page does not start the restore').toEqual([]);
      expect(page.h.binding.inspectionRevision).toBe(1);
      // Presenting, but the headset shows something else: the same.
      page.h.document.visibilityState = 'visible';
      page.h.workspace.viewer.xr.blind = () => true;
      await page.h.poll();
      expect(page.restored).toEqual([]);
      page.h.workspace.viewer.xr.blind = () => false;
      await page.h.poll();
      expect(page.restored).toEqual([page.saved]);
      expect(page.h.binding.inspectionRevision).toBe(2);
      expect(page.h.blocked).toBe(false);
    } finally { page.h.closed = true; clearTimeout(page.h.pollTimer); }
  });

  it('neither draws nor re-registers after the host dropped it, until it can draw', async () => {
    vi.useFakeTimers();
    const page = wakingPage({ attached: false });
    try {
      // Silent past its grace, the host dropped the page and saved an edit.
      // A timer fires while the page is still hidden.
      await page.h.poll();
      expect(page.hydrated, 'a hidden page does not start the recovery hydration').toEqual([]);
      expect(page.attaches, 'nor register again').toEqual([]);
      expect(page.h.panelId).toBe('panel');
      page.h.document.visibilityState = 'visible';
      page.h.workspace.viewer.xr.blind = () => true;
      await page.h.poll();
      expect([page.hydrated, page.attaches, page.restored]).toEqual([[], [], []]);
      // Awake: it follows the saved scene, then registers at that revision.
      page.h.workspace.viewer.xr.blind = () => false;
      await page.h.poll();
      expect(page.restored).toEqual([page.saved]);
      expect(page.attaches).toHaveLength(1);
      expect(page.h.blocked).toBe(false);
    } finally { page.h.closed = true; clearTimeout(page.h.pollTimer); }
  });

  it('defers a source change to its first awake beat', async () => {
    vi.useFakeTimers();
    // An agent loaded another structure while the headset slept.
    const page = wakingPage({ sourceToken: 't2' });
    try {
      await page.h.poll();
      expect(page.hydrated, 'a hidden page does not start loading the new structure').toEqual([]);
      page.h.document.visibilityState = 'visible';
      page.h.workspace.viewer.xr.blind = () => true;
      await page.h.poll();
      expect(page.hydrated).toEqual([]);
      page.h.workspace.viewer.xr.blind = () => false;
      await page.h.poll();
      expect(page.hydrated).toEqual(['s']);
      expect(page.h.blocked).toBe(false);
    } finally { page.h.closed = true; clearTimeout(page.h.pollTimer); }
  });

  function outcomePage(xrPresenting = false) {
    const outcome = blank(), plates: string[][] = [];
    const h: any = vm.createContext({ outcome, binding: { inspectionRevision: 1 }, hudSignature: '', hudWaitingSince: 0,
      workspace: { snapshot: () => ({ xrPresenting }), viewer: { xr: { outcome: async (text: string, state: string) => { plates.push([text, state]); } } } },
      recordHeadsetEvent: () => {}, assistantStatus, JSON, Array, Number, String, Date });
    run(pageFunctions(['showOutcome', 'clearWaitingHud']), h);
    return { h, outcome, plates };
  }
  const saved = { commandId: 'c', status: 'saved', savedRevision: 2, fields: ['color', 'uniformColor'] };

  it('reads a saved edit as waiting until the page draws its revision, then as applied', () => {
    const { h, outcome } = outcomePage();
    h.showOutcome(saved);
    expect([outcome.textContent, outcome.dataset.state]).toEqual(['Waiting · color, uniform color', 'waiting']);
    h.binding = { inspectionRevision: 2 };
    h.showOutcome(saved);
    expect([outcome.textContent, outcome.dataset.state]).toEqual(['Applied · color, uniform color · revision 2', 'applied']);
  });

  it('never calls a saved edit applied when the page woke to a later revision instead', () => {
    // Orange saved at revision 2 while the headset slept; the Mac then saved
    // blue at 3. The page wakes onto 3 and never drew orange.
    const { h, outcome, plates } = outcomePage(true);
    h.showOutcome(saved);
    expect(plates).toEqual([['Waiting · color, uniform color', 'waiting']]);
    h.binding = { inspectionRevision: 3 };
    h.showOutcome(saved);
    expect([outcome.textContent, outcome.dataset.state]).toEqual(['Shared view shown · revision 3', 'connected']);
    expect(plates, 'the orange plate comes down and nothing says applied').toEqual([['Waiting · color, uniform color', 'waiting'], ['', '']]);
  });
});

it('a clean desktop follows the private saved scene after sharing stops',async()=>{
  vi.useFakeTimers();
  try {
    const page=wakingPage({shared:false});page.h.isCompanion=false;
    page.h.document.visibilityState='visible';
    await page.h.poll();
    expect(page.restored).toEqual([page.saved]);
    expect(page.h.binding.inspectionRevision).toBe(2);
  }finally{vi.useRealTimers();}
});

it.each(['dirty','blocked','interaction','source'])('post-Stop desktop follow preserves %s local work',async guard=>{
  vi.useFakeTimers();
  try {
    const page=wakingPage({shared:false});page.h.isCompanion=false;page.h.document.visibilityState='visible';
    if(guard==='dirty')page.h.dirty=true;
    if(guard==='blocked')page.h.blocked=true;
    page.h.workspace.snapshot=()=>({ready:true,interactionActive:guard==='interaction',xrPresenting:false,
      sourceSha256:guard==='source'?'different-source':'sha'});
    await page.h.poll();
    expect(page.restored).toEqual([]);expect(page.h.binding.inspectionRevision).toBe(1);
  }finally{vi.useRealTimers();}
});

it('post-Stop desktop follow refuses a restore if local work starts before its commit',async()=>{
  vi.useFakeTimers();
  try {
    const page=wakingPage({shared:false});page.h.isCompanion=false;page.h.document.visibilityState='visible';
    page.h.workspace.restoreShared=async(_scene:any,beforeCommit:()=>void)=>{
      page.h.dirty=true;beforeCommit();throw Error('Restore must not reach its commit.');
    };
    await page.h.poll();
    expect(page.restored).toEqual([]);expect(page.h.binding.inspectionRevision).toBe(1);
    expect(page.h.dirty).toBe(true);
    expect(page.h.detailsText.textContent).toContain('Local work changed before the shared view arrived');
  }finally{vi.useRealTimers();}
});

it.each(['companion','stopped desktop'])('shared follow ignores a delayed older snapshot after a newer %s save',async surface=>{
  vi.useFakeTimers();
  const page=wakingPage({shared:surface==='companion'});
  try {
    page.h.isCompanion=surface==='companion';page.h.document.visibilityState='visible';
    const originalCall=page.h.call;
    let release!:()=>void,reached!:()=>void;
    const admitted=new Promise<void>(resolve=>{reached=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
    page.h.call=async(name:string)=>{
      const answer=await originalCall(name);
      if(name==='poll_inspection') {reached();await hold;}
      return answer;
    };
    const polling=page.h.poll();await admitted;
    // The reply captured revision 2. While it is in transport, this page
    // renders and saves a local change at revision 3 (or confirms a command).
    const newer=structuredClone(page.saved);newer.inspection.appearance.uniformColor='#00aaff';
    page.h.savedScene=newer;page.h.binding.inspectionRevision=3;page.h.edits++;
    release();await polling;
    expect(page.restored,'the delayed revision must not overwrite the newer visible save').toEqual([]);
    expect(page.h.binding.inspectionRevision).toBe(3);expect(page.h.savedScene).toEqual(newer);
    expect(page.h.blocked).toBe(false);
  }finally{page.h.closed=true;clearTimeout(page.h.pollTimer);vi.useRealTimers();}
});

it('shared follow refuses a queued restore after a newer receipt advances the binding before commit',async()=>{
  vi.useFakeTimers();const page=wakingPage();
  try {
    page.h.document.visibilityState='visible';
    const newer=structuredClone(page.saved);newer.inspection.appearance.uniformColor='#00aaff';
    page.h.workspace.restoreShared=async(scene:any,beforeCommit:()=>void)=>{
      // A renderer receipt settles while this restore waits for its queue.
      // Both capture() and savedScene are now the newly confirmed scene.
      page.h.binding.inspectionRevision=3;page.h.savedScene=newer;
      beforeCommit();page.restored.push(scene);return scene;
    };
    await page.h.poll();
    expect(page.restored).toEqual([]);expect(page.h.binding.inspectionRevision).toBe(3);
    expect(page.h.savedScene).toEqual(newer);
    expect(page.h.detailsText.textContent).toContain('Local work changed before the shared view arrived');
  }finally{page.h.closed=true;clearTimeout(page.h.pollTimer);vi.useRealTimers();}
});

it.each(['epoch','source'])('shared follow still hydrates a changed %s whose revision is lower than this page',async changed=>{
  vi.useFakeTimers();const page=wakingPage();
  try {
    page.h.document.visibilityState='visible';page.h.binding.inspectionRevision=3;
    const originalCall=page.h.call;
    page.h.call=async(name:string)=>{
      const answer=await originalCall(name);
      if(name==='poll_inspection') Object.assign(answer.structuredContent,{inspectionRevision:0,
        ...(changed==='epoch'?{serverEpoch:'new-epoch'}:{sourceToken:'new-source'})});
      return answer;
    };
    await page.h.poll();
    expect(page.hydrated).toEqual(['s']);expect(page.restored).toEqual([]);
    expect(page.h.blocked).toBe(false);
  }finally{page.h.closed=true;clearTimeout(page.h.pollTimer);vi.useRealTimers();}
});

it('shared follow preserves epoch recovery before revision ordering when the primary journey transition is not ready',async()=>{
  vi.useFakeTimers();const page=wakingPage();
  try {
    page.h.document.visibilityState='visible';page.h.binding.inspectionRevision=3;
    const originalCall=page.h.call;
    page.h.call=async(name:string)=>{
      const answer=await originalCall(name);
      if(name==='poll_inspection') Object.assign(answer.structuredContent,{serverEpoch:'new-epoch',inspectionRevision:0,
        experience:{id:'restored-journey',revision:1,stepIndex:0,applied:false},experienceCompletion:{status:'pending'}});
      return answer;
    };
    await page.h.poll();
    expect(page.hydrated).toEqual(['s']);expect(page.restored).toEqual([]);
    expect(page.h.blocked).toBe(false);
  }finally{page.h.closed=true;clearTimeout(page.h.pollTimer);vi.useRealTimers();}
});


it('a refused-source owner keeps heartbeating and follows a newer authorized replacement',async()=>{
  vi.useFakeTimers();
  const page=wakingPage({attached:false,sourceToken:'failed'}),sent:any[]=[];
  try {
    Object.assign(page.h,{blocked:true,retryHydrationId:'s',failedSourceLoad:{sessionId:'s',sourceToken:'failed'}});
    page.h.document.visibilityState='visible';
    let token='failed';
    page.h.call=async(name:string,args:any)=>{
      sent.push(args);
      return {structuredContent:{sessionId:'s',serverEpoch:'e',sourceToken:token,attached:false,hasScene:false,
        sourceRenderReceipt:token==='failed'?{status:'failed',panelId:'panel'}:undefined},
        _meta:{[KEY]:{transitionTarget:true}}};
    };
    await page.h.poll();
    expect(sent.at(-1).sourceFailureToken).toBe('failed');
    expect(page.h.panelId).toBe('panel');
    expect(page.hydrated).toEqual([]);
    page.h.dirty=true;token='next';
    await page.h.poll();
    expect(sent.at(-1).sourceFailureToken).toBe('failed');
    expect(page.hydrated).toEqual(['s']);
    page.hydrated.length=0;
    // Another host load also overrides the outgoing dirty gesture state.
    page.h.panelId='panel';page.h.dirty=false;
    await page.h.poll();
    expect(page.hydrated).toEqual(['s']);
  } finally {page.h.closed=true;clearTimeout(page.h.pollTimer);vi.useRealTimers();}
});


it('a refused stale source acknowledgement does not prevent discovering a newer source',async()=>{
  vi.useFakeTimers();const page=wakingPage({sourceToken:'new'}),calls:string[]=[];
  try {
    const original=page.h.call;
    Object.assign(page.h,{blocked:true,retryHydrationId:'s',
      failedSourceLoad:{sessionId:'s',sourceToken:'failed',receipt:{sourceToken:'failed'}},recordHeadsetEvent:()=>{}});
    page.h.document.visibilityState='visible';
    page.h.call=async(name:string,args:any)=>{calls.push(name);
      if(name==='report_source_failure')throw Error('This refusal no longer belongs to the current source.');
      return original(name,args);
    };
    await page.h.poll();
    expect(calls).toEqual(['report_source_failure','poll_inspection']);
    expect(page.hydrated).toEqual(['s']);
  }finally{page.h.closed=true;clearTimeout(page.h.pollTimer);vi.useRealTimers();}
});

it('an authorized source transition interrupts an active drag instead of waiting for release',async()=>{
  vi.useFakeTimers();const page=wakingPage({sourceToken:'new'});
  try {
    page.h.document.visibilityState='visible';
    const snapshot=page.h.workspace.snapshot;
    page.h.workspace.snapshot=()=>({...snapshot(),interactionActive:true});
    await page.h.poll();
    expect(page.hydrated).toEqual(['s']);
  }finally{page.h.closed=true;clearTimeout(page.h.pollTimer);vi.useRealTimers();}
});

it('the fast heartbeat keeps failed-source recovery while the wearer holds the old molecule',async()=>{
  vi.useFakeTimers();const page=wakingPage({sourceToken:'failed'}),sent:any[]=[];
  try {
    Object.assign(page.h,{failedSourceLoad:{sessionId:'s',sourceToken:'failed'},retryHydrationId:'s'});
    page.h.liveAvailability=()=> 'busy';
    const original=page.h.call;
    page.h.call=async(name:string,args:any)=>{sent.push(args);return original(name,args);};
    await page.h.busyBeat(1);
    expect(sent.at(-1)).toMatchObject({sourceFailureToken:'failed',availability:'ready'});
    // Explicit hydration owns a competing renderer transaction and revokes it.
    await page.h.busyBeat(1,true);
    expect(sent.at(-1)).not.toHaveProperty('sourceFailureToken');
    expect(sent.at(-1).availability).toBe('busy');
  }finally{page.h.closed=true;clearTimeout(page.h.pollTimer);vi.useRealTimers();}
});

it('the fast heartbeat dispatches a lesson admitted during a busy grab',async()=>{
  vi.useFakeTimers();const page=wakingPage(),received:any[]=[];
  try {
    page.h.liveAvailability=()=> 'busy';page.h.receive=async(delivery:any)=>{received.push(delivery);};
    const original=page.h.call;
    const delivery={change:{kind:'lesson'},panelId:'panel',commandId:'lesson'};
    page.h.call=async(name:string,args:any)=>{const response=await original(name,args);
      response._meta[KEY].delivery=delivery;return response;};
    await page.h.busyBeat(1);await page.h.rendering;
    expect(received).toEqual([delivery]);
  }finally{page.h.closed=true;clearTimeout(page.h.pollTimer);vi.useRealTimers();}
});
