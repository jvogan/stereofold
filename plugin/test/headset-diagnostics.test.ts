import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect } from 'vitest';
// @ts-ignore Shared real browser producer and stereo fixtures.
import { layoutDiagnosticEntry, syntheticViews, plate } from '../../lab/browser-roundtrip/fixtures/component-label-diagnostics.mjs';
// @ts-ignore Shared strict harness executes the real entry record producer.
import { entryStandoffHarness } from '../../lab/browser-roundtrip/fixtures/entry-standoff.mjs';
// @ts-ignore Shared per-eye render measurement.
import { measureComponentLabels } from '../../lab/browser-roundtrip/component-label-measurement.mjs';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as KEY, pollInspectionSchema } from '../src/inspection-contract.js';
import { createHeadsetDiagnosticsStore, diagnosticEntrySchema, formatDiagnosticLine, readHeadsetLogSchema,
  salvageDiagnosticEntries, MAX_DIAGNOSTICS_BATCH, MAX_DIAGNOSTIC_FIELDS, MAX_DIAGNOSTIC_ITEMS } from '../src/headset-diagnostics.js';
import { ALLOWED_TOOLS as LAN_TOOLS } from '../src/inspection-lan.js';
import { TOOLS as COMPANION_TOOLS } from '../src/inspection-companion-http.js';
// @ts-ignore Shared JavaScript headset diagnostics ring buffer.
import { createDiagnosticsBuffer, sanitizeDetail, normalizeKind, describeMediaRecorderSupport, collectSessionFacts, watchSessionInput, watchFrameRate, recordMicrophonePermission, installHeadsetDiagnostics, resetHeadsetDiagnostics, diagnosticsHeartbeat, acknowledgeDiagnostics, MAX_DIAGNOSTIC_ENTRIES } from '../../lab/browser-roundtrip/headset-diagnostics.mjs';

const entry = (seq: number, kind = 'orb-press', detail: Record<string, unknown> = {}) => ({ seq, at: 1_700_000_000_000 + seq, kind, detail });

it('retains measured entry and changed plate evidence through ten-minute heartbeat salvage', () => {
  let clock = 0;
  const buffer = createDiagnosticsBuffer({ now: () => clock });
  const harness = entryStandoffHarness((kind: string, detail: Record<string, unknown>) => buffer.record(kind, detail));
  harness.frame();
  const standoff = buffer.all()[0];
  const changed = [];
  for (clock = 0; clock <= 600000; clock += 1000) {
    if (clock % 60000 === 0) changed.push(buffer.record('plate-update', { changed: 30, ms: 277, geometry: true }));
    buffer.record('plate-update', { changed: 0, ms: 20 });
    for (const kind of ['frame-cost', 'frame-rate']) buffer.record(kind, { sample: clock });
    for (const phase of ['rows', 'plates']) buffer.record('toolbar', { phase });
  }
  expect(buffer.size()).toBe(200);
  const store = createHeadsetDiagnosticsStore();
  while (buffer.pending().length) {
    const batch = buffer.pending();
    for (const record of batch) expect(diagnosticEntrySchema.parse(record)).toEqual(record);
    const salvaged = salvageDiagnosticEntries(batch);
    expect(salvaged).toEqual(batch);
    buffer.acknowledge(store.ingest('panel-entry', salvaged).ack);
  }
  const recorded = store.read({ kind: 'plate-standoff' }).entries[0]!;
  expect(recorded.detail).toEqual(standoff.detail);
  const expectedClearance = (eye: string) => {
    const view = harness.geometry.views.find((view: { eye: string }) => view.eye === eye);
    const p = view.projectionMatrix, eyeOffset = view.transform.inverse.matrix[12];
    const tangentX = (x: number, z: number) => ((p[0] * (x + eyeOffset) + p[8] * z) / -z + p[8]) / p[0];
    return Math.round((tangentX(-.4, -2) - tangentX(-.4, -1)) * 10000) / 10000;
  };
  expect(recorded.detail).toMatchObject({ phase: 'entry',
    clearanceLeft: expectedClearance('left'), clearanceRight: expectedClearance('right'), lit: true });
  expect(store.read({ kind: 'plate-update' }).entries.filter(value => value.detail.changed === 30)
    .map(value => value.seq)).toEqual(changed.map(value => value.seq));
  expect(buffer.acknowledged()).toBe(buffer.sequence());
});

it('strict clearance fields reject malformed values while salvage advances their sequences', () => {
  for (const field of ['clearanceLeft', 'clearanceRight']) {
    const receipt = entry(5, 'plate-standoff', { phase: 'entry', clearanceLeft: .1, clearanceRight: -.01,
      lit: true, [field]: 'unknown' });
    expect(diagnosticEntrySchema.safeParse(receipt).success).toBe(false);
    expect(salvageDiagnosticEntries([receipt])).toEqual([{ ...receipt, detail: { unreadable: true } }]);
    const nonfinite = { ...receipt, detail: sanitizeDetail({ ...receipt.detail, [field]: Infinity }) };
    expect(salvageDiagnosticEntries([nonfinite])[0]?.detail).toEqual({ unreadable: true });
  }
});

it('preserves a refused Mol* outcome and full reason through page sanitization, strict parsing and Mac salvage', () => {
  const detail = { phrase: 'open mol', action: 'open-workbench', outcome: 'refused',
    reason: 'The filament tier has no atom coordinates. Switch to an atomic tier, then open Mol* again.' };
  const buffer = createDiagnosticsBuffer();
  const receipt = buffer.record('voice-command', detail);
  expect(receipt.detail).toEqual(detail);
  expect(diagnosticEntrySchema.parse(receipt)).toEqual(receipt);
  expect(salvageDiagnosticEntries([receipt])).toEqual([receipt]);
});

describe('the headset ring buffer', () => {
  it('keeps a bounded window and reports what it dropped', () => {
    const buffer = createDiagnosticsBuffer({ now: () => 1_000, rateLimitMs: 0 });
    for (let index = 0; index < MAX_DIAGNOSTIC_ENTRIES + 25; index += 1) buffer.record('frame-rate', { fps: index });
    expect(buffer.size()).toBe(MAX_DIAGNOSTIC_ENTRIES);
    expect(buffer.dropped()).toBe(25);
    expect(buffer.sequence()).toBe(MAX_DIAGNOSTIC_ENTRIES + 25);
    // The oldest surviving entry is the 26th recorded, not the first.
    expect(buffer.all()[0]!.detail.fps).toBe(25);
  });

  it('rate-limits frequent frame telemetry without evicting rare evidence', () => {
    let clock = 0;
    const buffer = createDiagnosticsBuffer({ now: () => clock, limit: 42 });
    for (let index = 0; index < 10; index += 1) {
      buffer.record('frame-cost', { index });
      buffer.record('frame-rate', { index });
      for (const kind of ['component-label-layout', 'component-labels-drawn', 'toolbar', 'tour']) {
        buffer.record(kind, { index });
      }
      clock += 100;
    }
    const entries = buffer.all();
    expect(entries).toHaveLength(42);
    expect(entries.filter((value: any) => value.kind === 'frame-cost')).toHaveLength(1);
    expect(entries.filter((value: any) => value.kind === 'frame-rate')).toHaveLength(1);
    for (const kind of ['component-label-layout', 'component-labels-drawn', 'toolbar', 'tour'])
      expect(entries.filter((value: any) => value.kind === kind)).toHaveLength(10);
  });

  it('rejects an unusable kind and normalizes the rest', () => {
    expect(normalizeKind('XR Select Start')).toBe('xr-select-start');
    expect(normalizeKind('  page-error ')).toBe('page-error');
    expect(normalizeKind('')).toBe(null);
    expect(normalizeKind(42)).toBe(null);
    expect(normalizeKind('x'.repeat(80))).toBe(null);
    const buffer = createDiagnosticsBuffer();
    expect(buffer.record('***', {})).toBe(null);
    expect(buffer.size()).toBe(0);
  });

  it('caps strings, fields and nesting so no entry can carry a payload', () => {
    const detail = sanitizeDetail({
      long: 'x'.repeat(500),
      fn: () => 1,
      nested: { deeper: { deepest: { gone: true } }, kept: 2 },
      list: Array.from({ length: MAX_DIAGNOSTIC_ITEMS + 1 }, (_, i) => i),
      nan: Number.NaN,
      ...Object.fromEntries(Array.from({ length: MAX_DIAGNOSTIC_FIELDS + 10 }, (_, index) => [`k${index}`, index])),
    });
    expect((detail.long as string).length).toBe(200);
    expect(detail.fn).toBeUndefined();
    expect((detail.nested as any).kept).toBe(2);
    expect((detail.nested as any).deeper.deepest).toEqual({ gone: true });
    expect((detail.list as unknown[]).length).toBe(MAX_DIAGNOSTIC_ITEMS);
    expect(detail.nan).toBe(null);
    expect(Object.keys(detail).length).toBe(MAX_DIAGNOSTIC_FIELDS);
  });

  it('sends only unacknowledged entries and re-sends when an acknowledgement is lost', () => {
    const buffer = createDiagnosticsBuffer();
    for (const kind of ['session-start', 'xr-select', 'orb-press']) buffer.record(kind, {});
    expect(buffer.pending().map((value: any) => value.kind)).toEqual(['session-start', 'xr-select', 'orb-press']);
    buffer.acknowledge(2);
    expect(buffer.pending().map((value: any) => value.seq)).toEqual([3]);
    // A lower or repeated acknowledgement never rewinds the cursor.
    buffer.acknowledge(1);
    expect(buffer.acknowledged()).toBe(2);
    // A dropped heartbeat leaves the entry pending, so the next beat re-sends it.
    buffer.record('frame-rate', {});
    expect(buffer.pending().map((value: any) => value.seq)).toEqual([3, 4]);
    buffer.acknowledge(4);
    expect(buffer.pending()).toEqual([]);
  });

  it('drains a burst over several heartbeats', () => {
    resetHeadsetDiagnostics({ rateLimitMs: 0 });
    for (let index = 0; index < MAX_DIAGNOSTICS_BATCH + 6; index += 1) diagnosticsHeartbeatSeed(index);
    const first = diagnosticsHeartbeat();
    expect(first.diagnostics.entries).toHaveLength(MAX_DIAGNOSTICS_BATCH);
    acknowledgeDiagnostics(first.diagnostics.entries.at(-1).seq);
    const second = diagnosticsHeartbeat();
    expect(second.diagnostics.entries).toHaveLength(6);
    acknowledgeDiagnostics(second.diagnostics.entries.at(-1).seq);
    expect(diagnosticsHeartbeat()).toEqual({});
  });

  it('reports that the page loaded before any immersion', () => {
    resetHeadsetDiagnostics();
    const hook = installHeadsetDiagnostics({ isSecureContext: true, navigator: { userAgent: 'OculusBrowser/33', xr: {} } });
    hook.begin();
    const open = hook.entries().find((value: any) => value.kind === 'page-open');
    expect(open.detail).toMatchObject({ userAgent: 'OculusBrowser/33', secureContext: true, hasWebXr: true });
    expect(open.detail.mediaRecorder.present).toBe(false);
  });

  it('publishes the soft global hook other modules record through', () => {
    const scope: any = {};
    resetHeadsetDiagnostics();
    installHeadsetDiagnostics(scope);
    scope.__stereofoldDiagnostics?.record?.('orb-press', { phase: 'idle' });
    expect(scope.__stereofoldDiagnostics.entries().at(-1).kind).toBe('orb-press');
    // The call site pattern must be a no-op when diagnostics are absent.
    const bare: any = {};
    expect(() => bare.__stereofoldDiagnostics?.record?.('orb-press', {})).not.toThrow();
  });
});

function diagnosticsHeartbeatSeed(index: number) {
  installHeadsetDiagnostics({}).record('frame-rate', { fps: index });
}

describe('what the page collects when a session starts', () => {
  const session = {
    mode: 'immersive-ar', enabledFeatures: ['local-floor', 'hand-tracking'],
    supportedFrameRates: new Float32Array([60, 72, 90]), frameRate: 72,
    inputSources: [{ handedness: 'left', targetRayMode: 'tracked-pointer', profiles: ['oculus-touch-v3'] }],
    addEventListener() {}, removeEventListener() {},
  };

  it('records the device facts the Mac cannot otherwise see', () => {
    const facts = collectSessionFacts({ session, navigator: { userAgent: 'Mozilla/5.0 Quest 2 OculusBrowser/33' },
      scope: { MediaRecorder: Object.assign(function MediaRecorder() {}, { isTypeSupported: (mime: string) => mime === 'audio/webm' }) } });
    expect(facts.mode).toBe('immersive-ar');
    expect(facts.enabledFeatures).toEqual(['local-floor', 'hand-tracking']);
    expect(facts.deviceClass).toBe('quest2');
    expect(facts.inputSources[0]).toMatchObject({ handedness: 'left', hasSqueeze: true, isHand: false });
    expect(facts.framebufferScale).toBe(0.8);
    expect(facts.supportedFrameRates).toEqual([60, 72, 90]);
    expect(facts.reportedFrameRate).toBe(72);
    expect(facts.mediaRecorder).toEqual({ present: true, checkable: true, supported: ['audio/webm'],
      unsupported: ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'] });
  });

  it('keeps session input profiles flat and whole on the Mac', () => {
    const facts = collectSessionFacts({ describeInputSources: () => [{ profiles: ['oculus-touch-v3', 'generic-trigger'] }] });
    expect(facts.inputSources[0].profiles).toBe('oculus-touch-v3,generic-trigger');
    expect(diagnosticEntrySchema.parse(entry(1, 'session-start', sanitizeDetail(facts))).detail).toEqual(facts);
  });

  it('reports a browser with no MediaRecorder rather than throwing', () => {
    expect(describeMediaRecorderSupport({})).toMatchObject({ present: false, supported: [] });
    expect(collectSessionFacts({}).deviceClass).toBe('unknown');
  });

  it('answers the microphone permission question even when the browser refuses it', async () => {
    const seen: Array<[string, any]> = [];
    const record = (kind: string, detail: any) => { seen.push([kind, detail]); return null; };
    await recordMicrophonePermission({ navigator: { permissions: { query: async () => ({ state: 'granted' }) } } }, record);
    await recordMicrophonePermission({ navigator: { permissions: { query: () => { throw new TypeError('unknown name'); } } } }, record);
    await recordMicrophonePermission({}, record);
    expect(seen.map(([, detail]) => detail.state)).toEqual(['granted', 'unqueryable', 'unqueryable']);
  });

  it('records every select and squeeze with the hand that made it', () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const fake = { addEventListener: (type: string, handler: any) => listeners.set(type, handler), removeEventListener: (type: string) => listeners.delete(type) };
    const seen: Array<[string, any]> = [];
    const stop = watchSessionInput(fake, (kind: string, detail: any) => { seen.push([kind, detail]); return null; });
    listeners.get('select')!({ inputSource: { handedness: 'right', targetRayMode: 'tracked-pointer', gripSpace: {} } });
    listeners.get('squeezestart')!({ inputSource: { handedness: 'left', targetRayMode: 'tracked-pointer', hand: {} } });
    expect(seen).toEqual([
      ['xr-select', { hand: 'right', ray: 'tracked-pointer', handTracking: false, gripSpace: true }],
      ['xr-squeezestart', { hand: 'left', ray: 'tracked-pointer', handTracking: true, gripSpace: false }],
    ]);
    stop();
    expect(listeners.size).toBe(0);
  });

  it('estimates the frame rate on the session loop without owning it', () => {
    let clock = 0, callback: ((time: number, frame: unknown) => void) | undefined;
    const fake = { requestAnimationFrame: (handler: any) => { callback = handler; return 7; }, cancelAnimationFrame: () => { callback = undefined; } };
    const seen: Array<[string, any]> = [];
    const stop = watchFrameRate(fake, { record: (kind: string, detail: any) => { seen.push([kind, detail]); return null; }, now: () => clock, intervalMs: 1_000 });
    for (let frame = 0; frame < 72; frame += 1) { clock += 1_000 / 72; callback!(0, {}); }
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe('frame-rate');
    expect(seen[0]![1].fps).toBeCloseTo(72, 0);
    stop();
    expect(callback).toBeUndefined();
  });
});

describe('the store on the Mac', () => {
  it('keeps entries per client, ignores replays, and survives a page reload', () => {
    const store = createHeadsetDiagnosticsStore({ now: () => 5_000 });
    expect(store.ingest('panel-a', [entry(1), entry(2)])).toEqual({ accepted: 2, ack: 2 });
    // A repeated heartbeat carries entries the store already holds.
    expect(store.ingest('panel-a', [entry(2), entry(3)])).toEqual({ accepted: 1, ack: 3 });
    // The page reloaded: its counter restarts at 1 and the entries are new.
    expect(store.ingest('panel-a', [entry(1, 'session-start')])).toEqual({ accepted: 1, ack: 1 });
    expect(store.size()).toBe(4);
    expect(store.ingest('panel-b', [entry(1, 'page-error')]).accepted).toBe(1);
    expect(store.summary().clients).toBe(2);
    store.forget('panel-b');
    expect(store.summary().clients).toBe(1);
  });

  it('bounds one client and forgets the oldest client past capacity', () => {
    const store = createHeadsetDiagnosticsStore({ maxPerClient: 3, maxClients: 2 });
    store.ingest('panel-a', [entry(1), entry(2), entry(3), entry(4)]);
    expect(store.read().entries.map(value => value.seq)).toEqual([2, 3, 4]);
    expect(store.summary().dropped).toBe(1);
    store.ingest('panel-b', [entry(1)]);
    store.ingest('panel-c', [entry(1)]);
    expect(store.summary().clients).toBe(2);
    expect(store.read().entries.some(value => value.clientId === 'panel-a')).toBe(false);
  });

  it('pages by cursor and says when more is waiting', () => {
    const store = createHeadsetDiagnosticsStore();
    store.ingest('panel-a', Array.from({ length: 10 }, (_, index) => entry(index + 1)));
    const first = store.read({ limit: 4 });
    expect(first.entries).toHaveLength(4);
    expect(first.more).toBe(true);
    const second = store.read({ sinceSequence: first.cursor, limit: 100 });
    expect(second.entries).toHaveLength(6);
    expect(second.more).toBe(false);
    expect(store.read({ sinceSequence: second.cursor }).entries).toEqual([]);
  });

  it('summarizes counts, the last failure and the device facts', () => {
    const store = createHeadsetDiagnosticsStore();
    store.ingest('panel-a', [
      entry(1, 'session-start', { deviceClass: 'quest2', userAgent: 'OculusBrowser' }),
      entry(2, 'xr-select', { hand: 'right' }),
      entry(3, 'page-error', { message: 'first' }),
      entry(4, 'xr-select', { hand: 'left' }),
      entry(5, 'unhandled-rejection', { message: 'last' }),
    ]);
    const summary = store.summary();
    expect(summary.counts).toEqual({ 'session-start': 1, 'xr-select': 2, 'page-error': 1, 'unhandled-rejection': 1 });
    expect(summary.lastError).toMatchObject({ kind: 'unhandled-rejection', detail: { message: 'last' } });
    expect(summary.device).toEqual({ deviceClass: 'quest2', userAgent: 'OculusBrowser' });
    expect(summary.entries).toBe(5);
  });

  it('filters by kind and formats one terminal line', () => {
    const store = createHeadsetDiagnosticsStore();
    store.ingest('panel-a', [entry(1, 'xr-select', { hand: 'left' }), entry(2, 'frame-rate', { fps: 71.4 })]);
    expect(store.read({ kind: 'frame-rate' }).entries.map(value => value.kind)).toEqual(['frame-rate']);
    expect(formatDiagnosticLine(store.read({ kind: 'xr-select' }).entries[0]!))
      .toBe('HEADSET 2023-11-14T22:13:20.001Z xr-select {"hand":"left"}');
  });

  it('refuses an entry that is not a bounded, JSON-safe record', () => {
    expect(diagnosticEntrySchema.safeParse(entry(1)).success).toBe(true);
    for (const bad of [
      { ...entry(1), kind: 'Not A Kind' },
      { ...entry(1), seq: 0 },
      { ...entry(1), detail: { long: 'x'.repeat(201) } },
      { ...entry(1), detail: Object.fromEntries(Array.from({ length: MAX_DIAGNOSTIC_FIELDS + 1 }, (_, index) => [`k${index}`, index])) },
      { ...entry(1), detail: { rects: Array.from({ length: MAX_DIAGNOSTIC_ITEMS + 1 }, () => ({ id: 'plate', x: 0, y: 0, hw: 1, hh: 1 })) } },
      { ...entry(1), extra: true },
    ]) expect(diagnosticEntrySchema.safeParse(bad).success).toBe(false);
    expect(readHeadsetLogSchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(readHeadsetLogSchema.safeParse({ sinceSequence: 12, limit: 5, kind: 'xr-select' }).success).toBe(true);
  });
});

/**
 * A Quest 2 wall tour the agent lost after one chapter.
 *
 * The tour's first scene rendered, was spoken and was confirmed, and then the
 * next command came back "No panel is showing this inspection" while the page
 * was still presenting and still beating once a second. The page console showed
 * HTTP 409 on `/tool` from the beat after the `plate-standoff` record below and
 * on every beat after that: the entry was one level deeper than the schema
 * accepted, `poll_inspection` refuses the whole heartbeat when any entry fails,
 * and an entry that is never accepted is never acknowledged, so the page
 * re-sent the same poison entry for ever.
 */
const wallChapterStandoff = Object.freeze({
  framing: 'fill', plates: 190, limited: 'lens-ceiling', clears: false, measured: true,
  granted: -1.205, reachLimited: true,
  frame: { subject: { left: -0.069, right: 0.98, bottom: -0.419, top: 0.419 },
    plate: { left: -0.867, right: -0.099, bottom: -0.638, top: 0.843 },
    axis: 'right', shrink: 0.776, overlap: false },
  plateNear: 1.427, plateFar: 1.859, floor: 1.677, minDistance: 3.5,
  after: { distance: 3.5, nearest: 1.045, farthest: 5.955, radius: 2.887, depth: 2.455,
    subjectLens: 0.524, assemblyLens: 0.916, subjectRise: 0.419, assemblyWide: 0.524,
    assemblyTall: 0.419, pierced: 0 },
  before: { distance: 1.2, nearest: -0.316, farthest: 2.716, radius: 1.782, depth: 1.516,
    subjectLens: 0.944, assemblyLens: 1.65, subjectRise: 0.755, assemblyWide: 0.944,
    assemblyTall: 0.755, pierced: 190 },
});

/** The same record plus the menu column and the projected shares. */
const wallChapterStandoffWithMenu = Object.freeze({
  ...wallChapterStandoff,
  frame: { ...wallChapterStandoff.frame,
    caption: { left: -0.853, right: -0.105, bottom: 0.268, top: 0.756 },
    menu: { rect: { left: -0.853, right: -0.105, bottom: -0.444, top: 0.15 },
      move: 'shrink', cleared: true },
    share: { whole: 0.6, lit: 0.5 } },
});

/** The same record plus the strand's own verdict on the buttons. */
const wallChapterStandoffWithGhost = Object.freeze({
  ...wallChapterStandoffWithMenu,
  frame: { ...wallChapterStandoffWithMenu.frame,
    menu: { ...wallChapterStandoffWithMenu.frame.menu,
      ghost: { crossed: true, cleared: true } } },
});

describe('a diagnostic the page can record', () => {
  const binding = { sessionId: '00000000-0000-4000-8000-000000000000', serverEpoch: '00000000-0000-4000-8000-000000000001',
    sourceToken: '00000000-0000-4000-8000-000000000002', baseStateRevision: 1, baseInspectionRevision: 1,
    panelId: '00000000-0000-4000-8000-000000000003', availability: 'ready' as const };

  it('salvages retained rare records after twenty minutes without a heartbeat', () => {
    let clock = 1789283000000;
    const buffer = resetHeadsetDiagnostics({ now: () => clock });
    const rare = [
      buffer.record('tour', { action: 'scene', step: 4 }),
      buffer.record('xr-frame-error', { phase: 'head-frame', error: 'frame failed' }),
      buffer.record('voice-command', { phrase: 'open mol', action: 'open-workbench', outcome: 'applied' }),
      buffer.record('talk-caption', { text: 'Filament tier has no atoms. Switch to an atomic tier.' }),
      buffer.record('component-label-layout', layoutDiagnosticEntry().detail),
      buffer.record('plate-standoff', wallChapterStandoffWithGhost),
      buffer.record('toolbar', { event: 'seat', reason: 'entry', latched: true }),
    ];
    for (let second = 0; second < 1200; second++) {
      clock += 1000;
      buffer.record('frame-rate', { fps: 72 });
      buffer.record('frame-cost', { frameMs: 4 });
      buffer.record('component-labels-drawn', { eye: 'left', visible: 10 });
      buffer.record('toolbar', { phase: 'rows', draw: second });
    }
    const store = createHeadsetDiagnosticsStore();
    try {
      while (buffer.pending().length) {
        const heartbeat = diagnosticsHeartbeat();
        const beat = pollInspectionSchema.parse({ ...binding, ...heartbeat });
        const entries = salvageDiagnosticEntries(beat.diagnostics!.entries);
        expect(entries).toEqual(heartbeat.diagnostics.entries);
        const { ack } = store.ingest('late-page', entries);
        acknowledgeDiagnostics(ack);
      }
      const received = store.read({ limit: 500 }).entries;
      expect(received.slice(0, rare.length).map(value => ({ seq: value.seq, at: value.at, kind: value.kind, detail: value.detail })))
        .toEqual(rare);
      expect(received).toHaveLength(buffer.size());
      expect(buffer.acknowledged()).toBe(buffer.sequence());
    } finally { resetHeadsetDiagnostics(); }
  });

  it('forwards frame samples after an acknowledged rare window fills the page ring', () => {
    let clock = 0;
    const buffer = resetHeadsetDiagnostics({ limit: MAX_DIAGNOSTIC_ENTRIES, now: () => clock, rateLimitMs: 0 });
    for (let index = 0; index < MAX_DIAGNOSTIC_ENTRIES; index += 1) {
      clock += 1;
      buffer.record('render-operation-cost', { index });
    }
    const store = createHeadsetDiagnosticsStore();
    try {
      while (buffer.pending().length) {
        const heartbeat = diagnosticsHeartbeat();
        const beat = pollInspectionSchema.parse({ ...binding, ...heartbeat });
        const { ack } = store.ingest('frame-sample-page', salvageDiagnosticEntries(beat.diagnostics!.entries));
        acknowledgeDiagnostics(ack);
      }
      buffer.record('frame-rate', { fps: 72 });
      buffer.record('frame-cost', { frameMs: 4 });
      const heartbeat = diagnosticsHeartbeat();
      const beat = pollInspectionSchema.parse({ ...binding, ...heartbeat });
      const entries = salvageDiagnosticEntries(beat.diagnostics!.entries);
      expect(entries.map(value => value.kind)).toEqual(['frame-rate', 'frame-cost']);
      store.ingest('frame-sample-page', entries);
      expect(store.read({ kind: 'frame-rate' }).entries).toHaveLength(1);
      expect(store.read({ kind: 'frame-cost' }).entries).toHaveLength(1);
    } finally { resetHeadsetDiagnostics(); }
  });

  it('preserves the real twenty-nine-field layout and both ten-plate eye records through heartbeat salvage', () => {
    const layout = layoutDiagnosticEntry();
    const plates = Array.from({ length: 10 }, (_, i) => plate(`part-${i}`, (i - 5) / 10, 0, 2, 0.04, 0.02));
    const measured = measureComponentLabels({ plates, views: syntheticViews() });
    const entries = [layout, ...measured.map((detail: any, i: number) => ({ seq: i + 2, at: 1000,
      kind: 'component-labels-drawn', detail }))];
    // Twenty-two output fields, unresolved/degraded/overlapArea, then the
    // anchors, obstacles, inputs and search.
    expect(Object.keys(layout.detail)).toHaveLength(29);
    expect(layout.detail.predicted).toBe(true);
    expect(layout.detail.basis).toBe('head');
    expect(layout.detail.reason).toBe('scene');
    expect(layout.detail.menuReason).toBe('expand,reseat');
    expect(layout.detail.anchors).toHaveLength(10);
    expect(layout.detail.anchors[0]).toEqual({ id: 'part-0', x: -0.5, y: 0, z: 400, r: 5, w: 0.02, h: 0.03, lines: 1, focused: true });
    expect(layout.detail.obstacles).toEqual([{ x: -0.55, y: -0.2, hw: 0.17, hh: 0.35 }]);
    expect(layout.detail.inputs).toEqual({ characterUnits: 0.08, minSizeScale: 1, contextAlpha: 0.35, standoff: 0.5, clearance: 0,
      fieldHalfWidth: 0.6, fieldHalfHeight: 0.58, subjectX: 0, subjectY: 0.1, subjectHalfWidth: 0.2, subjectHalfHeight: 0.3 });
    expect(layout.detail.search).toEqual({ nodes: 12, slots: 2048, complete: true, resolution: 0.03 });
    for (const entry of entries) {
      expect(entry.detail.rects).toHaveLength(10);
      expect(sanitizeDetail(entry.detail)).toEqual(entry.detail);
      expect(diagnosticEntrySchema.parse(entry)).toEqual(entry);
    }
    const beat = pollInspectionSchema.parse({ ...binding, diagnostics: { entries } });
    expect(salvageDiagnosticEntries(beat.diagnostics!.entries)).toEqual(entries);
    const store = createHeadsetDiagnosticsStore();
    expect(store.ingest('panel-measured', salvageDiagnosticEntries(beat.diagnostics!.entries))).toEqual({ accepted: 3, ack: 3 });
    expect(store.read().entries.map(entry => entry.detail)).toEqual(entries.map(entry => entry.detail));
  });

  it('carries the record that cost the wearer the agent', () => {
    expect(diagnosticEntrySchema.safeParse(entry(1, 'plate-standoff', wallChapterStandoff)).success).toBe(true);
  });

  it('carries the menu rectangle and the projected shares at the same depth as caption', () => {
    expect(diagnosticEntrySchema.safeParse(entry(1, 'plate-standoff', wallChapterStandoffWithMenu)).success).toBe(true);
    expect(sanitizeDetail(wallChapterStandoffWithMenu).frame).toMatchObject({
      menu: { rect: { left: -0.853, right: -0.105, bottom: -0.444, top: 0.15 },
        move: 'shrink', cleared: true },
      share: { whole: 0.6, lit: 0.5 },
    });
  });

  it('carries the ghost strand verdict inside the menu record, and nothing deeper', () => {
    // recordStandoff writes frame.menu.ghost = {crossed, cleared}. The page
    // sanitizer keeps it (depth three is scalars inside the extra object), so
    // the schema has to accept it at the same depth the menu record arrived
    // at — the mismatch is one level of nesting, and a refused entry is a
    // heartbeat the page re-sends for ever. And the depth guard holds at this
    // key too: a third level under ghost is refused like everywhere else.
    expect(diagnosticEntrySchema.safeParse(entry(1, 'plate-standoff', wallChapterStandoffWithGhost)).success).toBe(true);
    expect(sanitizeDetail(wallChapterStandoffWithGhost).frame).toMatchObject({
      menu: { ghost: { crossed: true, cleared: true } },
    });
    const deeper = { ...wallChapterStandoffWithGhost,
      frame: { ...wallChapterStandoffWithGhost.frame,
        menu: { ...wallChapterStandoffWithGhost.frame.menu,
          ghost: { crossed: { a: { b: 1 } }, cleared: true } } } };
    expect(diagnosticEntrySchema.safeParse(entry(2, 'plate-standoff', deeper)).success).toBe(false);
  });

  it('accepts every shape the page sanitizer can produce and nothing deeper', () => {
    // The page is the only writer, so its own sanitizer is the definition of
    // what this schema must carry. Anything it keeps has to parse; anything
    // deeper than it keeps must still be refused, or the cap means nothing.
    const sanitized = sanitizeDetail({
      scalar: 1, text: 'two', flag: true, empty: null,
      flat: [1, 'two', false, null],
      objects: [{ a: 1 }, { b: 'two' }],
      nested: { a: 1, list: [1, 2], deep: { left: -0.069, right: 0.98 } },
      menu: { rect: { left: -0.85, right: -0.1, bottom: -0.44, top: 0.15 }, move: 'shrink', cleared: true },
      tooDeep: { a: { b: { c: { d: { e: 1 } } } } },
      arrayOfArrays: [[1, 2], [3, 4]],
    });
    expect(diagnosticEntrySchema.safeParse(entry(1, 'plate-standoff', sanitized)).success).toBe(true);
    expect((sanitized.nested as any).deep).toEqual({ left: -0.069, right: 0.98 });
    expect((sanitized.menu as any).rect).toEqual({ left: -0.85, right: -0.1, bottom: -0.44, top: 0.15 });
    // Five levels and an array of arrays are the two shapes the schema refuses,
    // so the sanitizer must not be able to emit either.
    expect((sanitized.tooDeep as any).a.b).toEqual({});
    expect(sanitized.arrayOfArrays).toEqual([]);
    for (const bad of [
      { ...entry(1), detail: { a: { b: { c: { d: { e: 1 } } } } } },
      { ...entry(1), detail: { a: [[1, 2]] } },
      { ...entry(1), detail: { a: { b: Object.fromEntries(Array.from({ length: MAX_DIAGNOSTIC_FIELDS + 1 }, (_, i) => [`k${i}`, i])) } } },
    ]) expect(diagnosticEntrySchema.safeParse(bad).success).toBe(false);
  });

  it('never lets one unreadable entry cost the beat that carries the panel', () => {
    // The heartbeat schema takes the entries unvalidated and the salvage below
    // is what decides. A malformed detail keeps its sequence, its time and its
    // kind, so the page's cursor still advances past it and it never returns.
    const poison = { ...entry(7, 'plate-standoff'), detail: { frame: { subject: { a: { b: { c: 1 } } } } } };
    expect(diagnosticEntrySchema.safeParse(poison).success).toBe(false);
    expect(pollInspectionSchema.safeParse({ ...binding, diagnostics: { entries: [entry(6), poison, entry(8)] } }).success).toBe(true);
    const salvaged = salvageDiagnosticEntries([entry(6, 'xr-select', { hand: 'left' }), poison, entry(8)]);
    expect(salvaged.map(value => value.seq)).toEqual([6, 7, 8]);
    expect(salvaged[1]).toEqual({ seq: 7, at: poison.at, kind: 'plate-standoff', detail: { unreadable: true } });
    expect(salvaged[0]!.detail).toEqual({ hand: 'left' });
    // The store still acknowledges through the unreadable one, which is the
    // whole point: the page moves on instead of re-sending it every second.
    const store = createHeadsetDiagnosticsStore({ now: () => 1_700_000_000_000 });
    expect(store.ingest('panel-a', salvaged).ack).toBe(8);
    expect(store.read().entries.map(value => value.kind)).toEqual(['xr-select', 'plate-standoff', 'orb-press']);
  });

  it('drops only an entry with no sequence to acknowledge', () => {
    expect(salvageDiagnosticEntries([{ at: 1, kind: 'orb-press', detail: {} }])).toEqual([]);
    expect(salvageDiagnosticEntries(['not an entry', null, 42])).toEqual([]);
    // A kind the log cannot file is still an acknowledgeable sequence.
    expect(salvageDiagnosticEntries([{ seq: 3, at: 9, kind: 'Not A Kind', detail: { a: 1 } }]))
      .toEqual([{ seq: 3, at: 9, kind: 'unreadable', detail: { unreadable: true } }]);
  });
});

describe('the heartbeat contract and the tool that reads the log', () => {
  const binding = { sessionId: '00000000-0000-4000-8000-000000000000', serverEpoch: '00000000-0000-4000-8000-000000000001',
    sourceToken: '00000000-0000-4000-8000-000000000002', baseStateRevision: 1, baseInspectionRevision: 1,
    panelId: '00000000-0000-4000-8000-000000000003', availability: 'ready' as const };

  it('accepts a bounded batch on poll_inspection and refuses an unbounded one', () => {
    expect(pollInspectionSchema.safeParse({ ...binding, diagnostics: { entries: [entry(1)] } }).success).toBe(true);
    expect(pollInspectionSchema.safeParse({ ...binding }).success).toBe(true);
    expect(pollInspectionSchema.safeParse({ ...binding, diagnostics: { entries: [] } }).success).toBe(false);
    expect(pollInspectionSchema.safeParse({ ...binding,
      diagnostics: { entries: Array.from({ length: MAX_DIAGNOSTICS_BATCH + 1 }, (_, index) => entry(index + 1)) } }).success).toBe(false);
  });

  it('carries the headset log up the heartbeat and back out through read_headset_log', async () => {
    const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createStereoStructureServer();
    const client = new Client({ name: 'Headset diagnostics contract test', version: '1' });
    await server.connect(b); await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any;
    try {
      const empty = await call('read_headset_log', {});
      expect(empty.isError).not.toBe(true);
      expect(empty.structuredContent.entries).toEqual([]);
      expect(empty.content[0].text).toMatch(/has reported nothing/);

      const sessionId = (await call('inspect', { structureText: cif })).structuredContent.sessionId;
      const data = (await call('get_inspection', { sessionId }))._meta[KEY];
      const scene = { sourceSha256: data.catalog.source.sha256, modelNumber: data.catalog.modelNumbers[0], assemblyId: data.catalog.assemblyId,
        selectionKeys: [data.catalog.rows[0].key],
        camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0], radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
        inspection: { appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734', opacity: 1, labels: false, highlightColor: '#ffccee', clipping: 0, fog: 30 },
          placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } };
      const saved = (await call('sync_inspection', { sessionId, serverEpoch: data.serverEpoch, sourceToken: data.sourceToken,
        baseStateRevision: data.stateRevision, baseInspectionRevision: data.inspectionRevision, scene })).structuredContent;
      const bound = { sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
        baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
      const panelId = (await call('attach_inspection', bound)).structuredContent.panelId;

      const polled = await call('poll_inspection', { ...bound, panelId, availability: 'ready',
        diagnostics: { entries: [entry(1, 'session-start', { deviceClass: 'quest2' }), entry(2, 'xr-select', { hand: 'left' })] } });
      expect(polled.isError).not.toBe(true);
      expect(polled._meta[KEY].diagnosticsAck).toBe(2);

      const log = await call('read_headset_log', {});
      expect(log.structuredContent.entries.map((value: any) => value.kind)).toEqual(['session-start', 'xr-select']);
      expect(log.structuredContent.summary.device).toEqual({ deviceClass: 'quest2' });
      expect(log.content[0].text).toContain('HEADSET ');
      expect(log.structuredContent.more).toBe(false);
      // A second read from the returned cursor sees nothing new.
      expect((await call('read_headset_log', { sinceSequence: log.structuredContent.cursor })).structuredContent.entries).toEqual([]);

      const status = await call('manage_companion', { sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken, action: 'status' });
      expect(status.structuredContent.diagnostics.counts).toEqual({ 'session-start': 1, 'xr-select': 1 });
      expect(status.structuredContent.diagnostics.entries).toBe(2);
    } finally { await client.close(); await server.close(); }
  });

  it('lets the headset write the log but never read it back', async () => {
    // `read_headset_log` is model-side only, like `listen_voice` and
    // `say_to_headset`: a paired page must not be able to read what other
    // pages reported.
    expect(LAN_TOOLS.has('read_headset_log')).toBe(false);
    expect(COMPANION_TOOLS.has('read_headset_log')).toBe(false);
    expect(LAN_TOOLS.has('poll_inspection')).toBe(true);
    const host = await readFile(new URL('../scripts/serve-inspection.ts', import.meta.url), 'utf8');
    const permitted = host.match(/const permitted=new Set\(\[(.+?)\]\);/s)?.[1] ?? '';
    expect(permitted).toContain("'read_headset_log'");
    expect(permitted).toContain("'manage_companion'");
  });
});

describe('spoken reply evidence', () => {
  it('keeps the page audio-start text and full word count through the heartbeat', async () => {
    // @ts-ignore The shared browser producer is the wire contract.
    const { recordLoopStage } = await import('../../lab/browser-roundtrip/loop-timing.mjs');
    const buffer = createDiagnosticsBuffer({ now: () => 1234 });
    const text = 'Here is TCAB1, beside the RNA.';
    recordLoopStage('spoken-confirmation-started', { text }, { __stereofoldDiagnostics: buffer });
    const entries = buffer.all();
    expect(entries).toHaveLength(1);
    const parsed = diagnosticEntrySchema.parse(entries[0]);
    expect(parsed.detail).toEqual({ stage: 'spoken-confirmation-started', spokenText: text, spokenWords: 6 });
    const store = createHeadsetDiagnosticsStore();
    expect(store.ingest('page', [parsed])).toEqual({ accepted: 1, ack: 1 });
    expect(store.read().entries[0]?.detail).toEqual(parsed.detail);
    expect(salvageDiagnosticEntries(entries)[0]?.detail).toEqual(parsed.detail);
  });

  it('validates the explicit spoken evidence fields without widening the envelope', () => {
    for (const spokenWords of [-1, 1.5, '12', null]) {
      expect(diagnosticEntrySchema.safeParse(entry(1, 'voice-loop', { spokenWords })).success).toBe(false);
    }
    expect(diagnosticEntrySchema.safeParse(entry(1, 'voice-loop', { spokenWords: 13, spokenText: 'x'.repeat(200) })).success).toBe(true);
    expect(diagnosticEntrySchema.safeParse(entry(1, 'voice-loop', { spokenWords: 13, spokenText: 'x'.repeat(201) })).success).toBe(false);
    expect(diagnosticEntrySchema.safeParse({ ...entry(1), spokenWords: 12 }).success).toBe(false);
  });
});


it('samples no-op plate bursts but retains changed or slow records through Mac salvage', () => {
  let clock = 0;
  const buffer = createDiagnosticsBuffer({ now: () => clock });
  buffer.record('tour', { action: 'start' });
  for (let i = 0; i < 500; i++) buffer.record('plate-update', {
    path: 'relayout', reason: 'grow', layers: 30, changed: 0, geometry: false, ms: 2,
  });
  expect(buffer.size()).toBe(2);
  for (const detail of [
    { changed: 1, geometry: true, ms: 1 },
    { changed: 20, geometry: true, ms: 100 },
    { changed: 0, geometry: false, ms: 50 },
  ]) expect(buffer.record('plate-update', { path: 'relayout', layers: 30, ...detail })).not.toBeNull();
  clock = 5000;
  expect(buffer.record('plate-update', { changed: 0, geometry: false, ms: 0 })).not.toBeNull();
  const entries = buffer.all();
  expect(entries).toHaveLength(6);
  for (const record of entries) expect(diagnosticEntrySchema.parse(record)).toEqual(record);
  expect(salvageDiagnosticEntries(entries)).toEqual(entries);
  const store = createHeadsetDiagnosticsStore();
  store.ingest('plate-test', entries);
  expect(store.read().entries.map(record => record.detail)).toEqual(entries.map((record: any) => record.detail));
  expect(diagnosticEntrySchema.safeParse(entry(10, 'plate-update', { geometry: 'yes' })).success).toBe(false);
});

/**
 * The layout record now carries the solver's inputs and
 * its exact search summary beside its outputs, so a device ring can replay a
 * pass on real inputs. The page keeps a record only if it fits its own cap,
 * and this Mac keeps it only if it fits this schema; the two caps are pinned
 * equal here, and the record the page really produces is parsed as it will
 * arrive, after JSON, and salvaged unchanged.
 */
// @ts-ignore Shared page diagnostics caps.
import { MAX_DETAIL_KEYS, MAX_DETAIL_ITEMS } from '../../lab/browser-roundtrip/headset-diagnostics.mjs';
// @ts-ignore Shared real Menu action harness around the page builder and solver.
import { menuLayoutHarness } from '../../lab/browser-roundtrip/fixtures/label-action-harness.mjs';
// @ts-ignore Shared plate geometry.
import { plateLineEm, plateMarginEm, PLATE_FIELD } from '../../lab/browser-roundtrip/label-layout.mjs';
import { readFileSync } from 'node:fs';

describe('component-label-layout record contract', () => {
  it('keeps the page and Mac detail caps equal', () => {
    expect(MAX_DIAGNOSTIC_FIELDS).toBe(MAX_DETAIL_KEYS);
    expect(MAX_DIAGNOSTIC_ITEMS).toBe(MAX_DETAIL_ITEMS);
  });

  it('accepts the page layout record with its anchors, obstacles, inputs and search', async () => {
    const characterUnits = .05, standoff = .2, lineEm = plateLineEm();
    const fixture = JSON.parse(readFileSync(new URL('../../lab/browser-roundtrip/fixtures/overprint-backtracking.json', import.meta.url), 'utf8'));
    const widths = new Map<string, number>(fixture.rects.map((r: { id: string; halfWidth: number; halfHeight: number }) =>
      [r.id, r.halfWidth / r.halfHeight * lineEm - 2 * plateMarginEm()]));
    // A crowded tiling, so the exact search runs and reports itself.
    const crowded = await menuLayoutHarness({
      plates: fixture.rects.map((r: { id: string; halfHeight: number }) => ({ id: r.id, text: r.id, radius: .1,
        anchor: [0, 0, -(characterUnits * lineEm / (2 * r.halfHeight) + standoff)] })),
      characterUnits, standoff, field: fixture.field, eye: [0, 0, 0], target: [0, 0, -1],
      measureText: (text: string) => widths.get(text),
    });
    // Ten plates around a subject beside a menu column, as an entry pass.
    const seated = await menuLayoutHarness({
      plates: Array.from({ length: 10 }, (_, i) => ({ id: `part-${i}`, text: `Part ${i}`, radius: .05,
        anchor: [(i % 5 - 2) * .12, (Math.floor(i / 5) - .5) * .2, -1.5] })),
      characterUnits, standoff, field: PLATE_FIELD, eye: [0, 0, 0], target: [0, 0, -1],
      obstacles: [{ x: -.55, y: -.2, halfWidth: .17, halfHeight: .35 }],
      subject: { points: [-1, 1].flatMap(x => [-1, 1].map(y => [x * .3, y * .25, -1.5])) },
      measureText: (text: string) => text.length * .55,
    });
    for (const [name, harness] of [['crowded', crowded], ['seated', seated]] as const) {
      const records = await harness.press();
      const layout = records.find((r: { kind: string }) => r.kind === 'component-label-layout') as Record<string, unknown>;
      const { kind, ...detail } = layout;
      const entry = { seq: 1, at: 0, kind, detail: JSON.parse(JSON.stringify(detail)) };
      expect((entry.detail.anchors as unknown[]).length, name).toBe(name === 'crowded' ? 8 : 10);
      expect(entry.detail.inputs, name).toBeTruthy();
      if (name === 'crowded') expect(entry.detail.search, name).toMatchObject({ complete: true });
      if (name === 'seated') expect((entry.detail.obstacles as unknown[]).length, name).toBe(1);
      expect(Object.keys(entry.detail).length, name).toBeLessThanOrEqual(MAX_DIAGNOSTIC_FIELDS);
      const parsed = diagnosticEntrySchema.safeParse(entry);
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.success ? null : parsed.error.issues[0])}`).toBe(true);
      expect(salvageDiagnosticEntries([entry])[0], name).toEqual(entry);
    }
  });
});
