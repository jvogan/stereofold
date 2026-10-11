import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it, expect } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { detailedViewHtml } from '../src/detailed-view-page.js';
import { DETAILED_VIEW_RETURN_SOURCE } from '../src/detailed-view-return.js';
import { DETAILED_SELECTION_STALE_MS, DETAILED_SURFACE, DETAILED_VIEW_SESSION_SOURCE,
  detailedSelectionFrom, detailedViewSummary, isWearerSurface } from '../src/detailed-view-session.js';
import { PRIVATE_INSPECTION_META_KEY as KEY } from '../src/inspection-contract.js';
import { choosePanel, drawnInDetailedView, DETAILED_VIEW_CHANGES, IN_DETAILED_VIEW_MESSAGE } from '../scripts/agent-arguments.js';

/**
 * The full Mol* viewer as somewhere the assistant is.
 *
 * The failure this suite exists for: pressing Mol* in the headset used to
 * end the conversation. Ordinary panel
 * updates had no destination, headset speech had no page, and the only thing
 * the Mac could do was ask for the wearer back. Every test below is one leg of
 * the journey that has to work instead: enter the viewer, select something,
 * ask about it, hear an answer, see the change, come home with your place.
 *
 * The host half is driven through the real companion `/tool` route, because
 * that is the only route the page has. The page half is driven by evaluating
 * the same source string the document carries.
 */

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const discard = (path: string) => rm(path, {force: true, recursive: true});

const camera = {mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], up: [0, 1, 0], target: [0, 0, 0],
  radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0};
const appearance = {representation: 'cartoon', color: 'chain-id', uniformColor: '#44aaff', background: '#192734',
  highlightColor: '#ffccee', opacity: 1, labels: false, clipping: 0, fog: 30};

const session = new Function(`return ${DETAILED_VIEW_SESSION_SOURCE};`)() as any;
const returnHelpers = new Function(`return ${DETAILED_VIEW_RETURN_SOURCE};`)() as any;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}

const settleTasks = () => new Promise(resolve => setTimeout(resolve, 0));

/** A transcriber that hears one sentence, so the voice route can be driven whole. */
function fakeTranscriber(heard: string) {
  const entries: {text: string; receivedAt: string; durationMs: number}[] = [];
  return {
    enabled: true, ready: true, route: 'whisper' as const,
    describe: () => 'test transcriber',
    missing: () => [] as string[],
    startupLine: () => '',
    dispose: () => {},
    async accept(input: {utteranceId: string; seq: number; final: boolean; data?: string}) {
      if (!input.final) return {utteranceId: input.utteranceId, seq: input.seq, final: false,
        accepted: true, reason: 'chunk', message: `Chunk ${input.seq} received.`};
      entries.push({text: heard, receivedAt: new Date().toISOString(), durationMs: 900});
      return {utteranceId: input.utteranceId, seq: input.seq, final: true, accepted: true,
        reason: 'transcribed', message: `Heard: ${heard}`};
    },
    transcripts: {
      async since(after: number, options?: {waitMs?: number}) {
        if (entries.length <= after && options?.waitMs) await new Promise(next => setTimeout(next, 10));
        return {cursor: entries.length, entries: entries.slice(after)};
      },
    },
  } as any;
}

/** A Mac that can always render a clip, so delivery is about the page, not the voice. */
function fakeReplyAudio() {
  return {
    ready: true, enabled: true,
    describe: () => 'test voice',
    synthesize: async () => ({base64: 'T2dnUwAB', mimeType: 'audio/ogg', format: 'ogg' as const, bytes: 6}),
  } as any;
}

async function setup(spoken = 'what is this part') {
  const dist = await mkdtemp(join(tmpdir(), 'stereofold-dist-'));
  await writeFile(join(dist, 'viewer.html'), '<html><script>void 0;</script></html>');
  await writeFile(join(dist, 'inspector.html'), '<html><script>void 0;</script></html>');
  await mkdir(join(dist, 'molstar'), {recursive: true});
  await writeFile(join(dist, 'molstar/molstar.js'), 'globalThis.molstar={};');
  await writeFile(join(dist, 'molstar/molstar.css'), '.msp-plugin{color:#fff}');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(join(dist, 'viewer.html'),
    {transcriber: fakeTranscriber(spoken), replyAudio: fakeReplyAudio()});
  const client = new Client({name: 'Detailed session test', version: '1'});
  await server.connect(b); await client.connect(a);
  const call = async (name: string, args: Record<string, unknown>) =>
    await client.callTool({name: `stereo_structure.${name}`, arguments: args}) as any;
  const sessionId = (await call('inspect', {structureText: cif})).structuredContent.sessionId;
  const opened = (await call('get_inspection', {sessionId}))._meta[KEY];
  const scene = {sourceSha256: opened.catalog.source.sha256, modelNumber: opened.catalog.modelNumbers[0],
    assemblyId: opened.catalog.assemblyId, selectionKeys: [] as string[], camera: structuredClone(camera),
    inspection: {appearance: structuredClone(appearance), placement: {translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1}}};
  const saved = (await call('sync_inspection', {sessionId, serverEpoch: opened.serverEpoch, sourceToken: opened.sourceToken,
    baseStateRevision: opened.stateRevision, baseInspectionRevision: opened.inspectionRevision, scene})).structuredContent;
  const binding = {sessionId, serverEpoch: saved.serverEpoch, sourceToken: saved.sourceToken,
    baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision};
  const companion = (await call('open_companion', {...binding, connection: 'loopback'})).structuredContent.companion;
  const url = new URL(companion.url);
  const origin = url.origin, pageKey = url.hash.slice(1);
  /** Exactly what the detailed page sends: the page key as bearer, same origin. */
  const press = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch(`${origin}/tool`, {method: 'POST',
      headers: {Authorization: `Bearer ${pageKey}`, Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({name, args})});
    const body = response.ok ? await response.json() as any : undefined;
    return {status: response.status, body, state: body?.structuredContent, priv: body?._meta?.[KEY]};
  };
  /** The current binding, as the page reads it off its own detailed poll. */
  const nowBinding = async () => {
    const polled = await press('poll_detailed_view');
    return {serverEpoch: polled.state.serverEpoch, sourceToken: polled.state.sourceToken,
      baseStateRevision: polled.state.stateRevision, baseInspectionRevision: polled.state.inspectionRevision};
  };
  const attachDetailed = async () => {
    const bound = await nowBinding();
    const attached = await press('attach_inspection', {...bound, surface: DETAILED_SURFACE});
    return {panelId: attached.state.panelId as string, bound};
  };
  const state = async (extra: Record<string, unknown> = {}) =>
    (await call('get_inspection_state', {sessionId, ...extra})).structuredContent;
  return {call, press, state, sessionId, binding, nowBinding, attachDetailed, scene,
    close: async () => { await client.close(); await server.close(); await discard(dist); }};
}

/** A residue descriptor the host can map, built from a catalog row's own identity. */
function descriptorOf(row: any) {
  const copy = JSON.parse(row.identity.copyId);
  return {assemblyId: copy[1], operatorIds: copy[3].map(String), labelChain: row.identity.labelChain,
    componentId: row.identity.componentId, insertionCode: row.identity.insertionCode ?? '',
    labelSequenceId: row.identity.labelSequenceId, authorResidue: row.identity.authorResidue};
}

describe('the full Mol* viewer as a panel the host knows about', () => {
  it('attaches as a detailed surface, heartbeats, and is reported as the wearer being there', async () => {
    const t = await setup();
    try {
      // The real journey: the headset page is on screen, the wearer presses
      // Mol*, that same tab leaves, and this is what arrives.
      const bound = await t.nowBinding();
      const companion = await t.press('attach_inspection', bound);
      await t.press('detach_inspection', {...bound, panelId: companion.state.panelId, reason: 'detailed-view'});
      const attached = await t.press('attach_inspection', {...bound, surface: DETAILED_SURFACE});
      const panelId = attached.state.panelId;
      expect(panelId).toMatch(/^[0-9a-f-]{36}$/);
      const beat = await t.press('poll_inspection', {...bound, panelId, availability: 'ready'});
      expect(beat.status).toBe(200);
      expect(beat.state.attached).toBe(true);
      const summary = await t.state();
      const panel = summary.panels.find((entry: any) => entry.panelId === panelId);
      expect(panel.surface).toBe('detailed');
      expect(panel.current).toBe(true);
      expect(panel.availability).toBe('ready');
      // The wearer's own tab left the companion page for this one, so the
      // agent is told where they went rather than that nobody is there.
      expect(summary.companionInDetailedView).toBe(true);
      expect(summary.detailedView.present).toBe(true);
      expect(summary.detailedView.panelId).toBe(panelId);
    } finally { await t.close(); }
  });

  it('does not claim a headset is in Mol* when this Mac simply opened the page', async () => {
    const t = await setup();
    try {
      await t.call('attach_inspection', {...t.binding, surface: 'desktop'});
      const {panelId} = await t.attachDetailed();
      const summary = await t.state();
      // The same page, the same surface. Only the history tells a wearer who
      // walked into the viewer from a second window on a desk, and recalling
      // somebody who is not wearing anything helps nobody.
      expect(summary.companionInDetailedView).toBe(false);
      expect(summary.detailedView.present).toBe(true);
      expect(summary.detailedView.panelId).toBe(panelId);
    } finally { await t.close(); }
  });

  it('still calls every other page on this route the companion', async () => {
    const t = await setup();
    try {
      const bound = await t.nowBinding();
      const attached = await t.press('attach_inspection', bound);
      const summary = await t.state();
      const panel = summary.panels.find((entry: any) => entry.panelId === attached.state.panelId);
      expect(panel.surface).toBe('companion');
      expect(summary.detailedView).toBeUndefined();
    } finally { await t.close(); }
  });
});

describe('an agent change drawn inside the full Mol* viewer', () => {
  it('delivers a colour change to the detailed page and receipts it as rendered', async () => {
    const t = await setup();
    try {
      const {panelId, bound} = await t.attachDetailed();
      await t.press('poll_inspection', {...bound, panelId, availability: 'ready'});
      const queued = await t.call('update_inspection', {...t.binding, panelId, commandId: 'colour-1',
        change: {kind: 'appearance', patch: {color: 'uniform', uniformColor: '#ff8800'}}});
      expect(queued.structuredContent.command.status).toBe('queued');
      const beat = await t.press('poll_inspection', {...bound, panelId, availability: 'ready'});
      const delivery = beat.priv.delivery;
      expect(delivery.change.kind).toBe('appearance');
      expect(session.renders(delivery.change.kind)).toBe(true);
      // The page draws the saved scene with the change folded in, then reports
      // exactly what it drew. nextScene is the page's own copy of the host's
      // expectation, so the two have to agree field for field.
      const next = session.nextScene(t.scene, delivery.change);
      expect(next.inspection.appearance.uniformColor).toBe('#ff8800');
      expect(next.inspection.appearance.representation).toBe('cartoon');
      const done = await t.press('complete_inspection', {...bound, panelId, commandId: delivery.commandId,
        claimToken: delivery.claimToken, scene: next});
      expect(done.state.accepted).toBe(true);
      expect(done.state.command.status).toBe('rendered');
      const summary = await t.state({commandId: 'colour-1'});
      expect(summary.command.status).toBe('rendered');
      expect(summary.view.appearance.uniformColor).toBe('#ff8800');
    } finally { await t.close(); }
  });

  it('refuses a change that belongs to the headset instead of drawing it badly', async () => {
    const t = await setup();
    try {
      const {panelId, bound} = await t.attachDetailed();
      await t.press('poll_inspection', {...bound, panelId, availability: 'ready'});
      await t.call('update_inspection', {...t.binding, panelId, commandId: 'move-1',
        change: {kind: 'placement', patch: {scale: 2}}});
      const beat = await t.press('poll_inspection', {...bound, panelId, availability: 'ready'});
      const delivery = beat.priv.delivery;
      expect(session.renders('placement')).toBe(false);
      expect(session.nextScene(t.scene, delivery.change)).toBeNull();
      const refusal = session.refusal('placement');
      expect(refusal).toBe('The full viewer does not move the molecule.');
      expect(refusal.split(' ').length).toBeLessThan(12);
      const done = await t.press('complete_inspection', {...bound, panelId, commandId: delivery.commandId,
        claimToken: delivery.claimToken, failure: 'render_failed', failureReason: refusal});
      expect(done.state.accepted).toBe(false);
      expect(done.state.command.status).toBe('rejected');
      expect(done.state.command.detail).toBe(refusal);
      // Nothing moved, so the wearer's place is exactly where it was.
      expect((await t.state()).view.placement.scale).toBe(1);
    } finally { await t.close(); }
  });
});

describe('what the person is pointing at inside Mol*', () => {
  it('reports a Mol* selection so that "explain this part" resolves to it', async () => {
    const t = await setup();
    try {
      const {panelId} = await t.attachDetailed();
      const rows = (await t.state({residues: {limit: 3}})).residues.rows;
      const reported = await t.press('report_detailed_selection',
        {panelId, residues: [descriptorOf(rows[0]), descriptorOf(rows[1])]});
      expect(reported.status).toBe(200);
      expect(reported.state.detailedSelection.selectedResidues).toBe(2);
      expect(reported.state.detailedSelection.unmatched).toBe(0);
      const summary = await t.state();
      expect(summary.detailedView.selection.selectedResidues).toBe(2);
      expect(summary.detailedView.selection.stale).toBe(false);
      expect(summary.detailedView.selection.selectionKeys).toEqual([rows[0].key, rows[1].key]);
      // The identities are what makes the question answerable in words.
      const named = summary.detailedView.selection.residues.map((entry: any) =>
        `${entry.identity.labelChain} ${entry.identity.componentId}${entry.identity.authorResidue}`);
      expect(named).toEqual([
        `${rows[0].identity.labelChain} ${rows[0].identity.componentId}${rows[0].identity.authorResidue}`,
        `${rows[1].identity.labelChain} ${rows[1].identity.componentId}${rows[1].identity.authorResidue}`]);
      // Pointing at something is not committing to it: the saved scene is
      // untouched and no revision was spent.
      expect(summary.view.selectedResidueCount).toBe(0);
      expect(summary.inspectionRevision).toBe(t.binding.baseInspectionRevision);
    } finally { await t.close(); }
  });

  it('takes a report only from an attached detailed page', async () => {
    const t = await setup();
    try {
      const bound = await t.nowBinding();
      const companion = await t.press('attach_inspection', bound);
      const rows = (await t.state({residues: {limit: 1}})).residues.rows;
      const refused = await t.press('report_detailed_selection',
        {panelId: companion.state.panelId, residues: [descriptorOf(rows[0])]});
      expect(refused.status).toBe(409);
      expect((await t.state()).detailedView).toBeUndefined();
    } finally { await t.close(); }
  });

  it('marks a selection stale once the page that made it is gone', () => {
    const made = {panelId: 'p1', keys: ['k'], unmatched: 0, truncated: false, at: 1_000};
    const live = detailedViewSummary({panels: [{panelId: 'p1', surface: DETAILED_SURFACE, availability: 'ready', current: true}],
      selection: made, now: 2_000});
    expect(live!.present).toBe(true);
    expect(live!.selection!.stale).toBe(false);
    const gone = detailedViewSummary({panels: [], selection: made, now: 2_000});
    expect(gone!.present).toBe(false);
    expect(gone!.selection!.stale).toBe(true);
    const old = detailedViewSummary({panels: [{panelId: 'p1', surface: DETAILED_SURFACE, availability: 'ready', current: true}],
      selection: made, now: 1_000 + DETAILED_SELECTION_STALE_MS});
    expect(old!.selection!.stale).toBe(true);
  });

  it('maps a reported residue with the return leg’s own mapper', () => {
    const row = {key: 'key-thr-1', identity: {modelNumber: 1, copyId: JSON.stringify(['copy', 'asymmetric_unit', 0, []]),
      labelChain: 'A', componentId: 'THR', insertionCode: '', labelSequenceId: 1, authorResidue: 1}};
    const mapped = detailedSelectionFrom({rows: [row]}, 1, {panelId: 'p1', truncated: true, residues: [
      {assemblyId: 'asymmetric_unit', operatorIds: [], labelChain: 'A', componentId: 'THR',
        insertionCode: '', labelSequenceId: 1, authorResidue: 1},
      {assemblyId: 'asymmetric_unit', operatorIds: [], labelChain: 'Q', componentId: 'THR',
        insertionCode: '', labelSequenceId: 1, authorResidue: 1},
    ]}, 500);
    expect(mapped).toEqual({panelId: 'p1', keys: ['key-thr-1'], unmatched: 1, truncated: true, at: 500});
  });
});

describe('speaking to the person while they are in the full viewer', () => {
  it('delivers the caption and its clip to the detailed page', async () => {
    const t = await setup();
    try {
      const {panelId, bound} = await t.attachDetailed();
      // A page that has only just connected is not owed an older answer, so
      // the cursor is opened first, exactly as the companion opens its own.
      await t.press('poll_inspection', {...bound, panelId, availability: 'ready'});
      const said = await t.call('say_to_headset', {text: 'That is the PAM site.'});
      expect(said.structuredContent.delivered).toBe(false);
      const beat = await t.press('poll_inspection', {...bound, panelId, availability: 'ready'});
      const caption = beat.priv.headsetCaption;
      expect(caption.text).toBe('That is the PAM site.');
      expect(caption.speak).toBe(true);
      expect(caption.audio.mimeType).toBe('audio/ogg');
      // The page turns the clip into something an audio element can play
      // without another authenticated route.
      expect(session.captionAudioUrl(caption)).toBe('data:audio/ogg;base64,T2dnUwAB');
    } finally { await t.close(); }
  });

  it('offers a desktop panel nothing, because it would draw none of it', async () => {
    const t = await setup();
    try {
      const desktop = (await t.call('attach_inspection', {...t.binding, surface: 'desktop'})).structuredContent.panelId;
      await t.call('poll_inspection', {...t.binding, panelId: desktop, availability: 'ready'});
      await t.call('say_to_headset', {text: 'Only the wearer hears this.'});
      const beat = await t.call('poll_inspection', {...t.binding, panelId: desktop, availability: 'ready'});
      expect(beat._meta[KEY].headsetCaption).toBeUndefined();
    } finally { await t.close(); }
  });

  it('carries a held utterance from the detailed page to listen_voice', async () => {
    const t = await setup('why does this residue matter');
    try {
      const {panelId, bound} = await t.attachDetailed();
      await t.press('poll_inspection', {...bound, panelId, availability: 'ready'});
      const utteranceId = '33333333-3333-4333-8333-333333333333';
      const chunk = await t.press('push_to_talk_audio',
        {utteranceId, seq: 0, mime: 'audio/webm;codecs=opus', data: 'AAAA', final: false});
      expect(chunk.status).toBe(200);
      const closed = await t.press('push_to_talk_audio',
        {utteranceId, seq: 1, mime: 'audio/webm;codecs=opus', final: true});
      expect(closed.status).toBe(200);
      const heard = await t.call('listen_voice', {timeoutSeconds: 1});
      expect(heard.structuredContent.transcripts[0].text).toBe('why does this residue matter');
      expect(heard.structuredContent.timedOut).toBe(false);
    } finally { await t.close(); }
  });
});

describe('coming home from the full viewer', () => {
  const snapshot = () => ({
    timestamp: 1, version: '5.11.0', current: 'one',
    entries: [{timestamp: 1, snapshot: {
      id: 'one',
      camera: {current: {mode: 'perspective', fov: 0.6, position: [12, -4, 33], up: [0, 1, 0], target: [1, 2, 3],
        radius: 31.5, radiusMax: 44, fog: 42, clipFar: false, minNear: 4, minFar: 0}, transitionStyle: 'instant'},
      canvas3d: {props: {renderer: {backgroundColor: 0x0a0f14}}},
      data: {tree: {transforms: [
        {ref: 'root', parent: '', transformer: 'build-in.root', params: {}, version: '1'},
        {ref: 'repr', parent: 'structure', transformer: 'ms-plugin.structure-representation-3d', version: '1',
          params: {type: {name: 'ball-and-stick', params: {alpha: 0.8}}, colorTheme: {name: 'uniform', params: {value: 0x11ee44}}}},
      ]}},
    }}],
  });

  it('never sends the full viewer state back to the full viewer', async () => {
    const t = await setup();
    try {
      const {panelId, bound} = await t.attachDetailed();
      // An agent change is drawn here first, so the return has real edits
      // behind it rather than an untouched scene.
      await t.press('poll_inspection', {...bound, panelId, availability: 'ready'});
      await t.call('update_inspection', {...t.binding, panelId, commandId: 'colour-1',
        change: {kind: 'appearance', patch: {color: 'uniform', uniformColor: '#ff8800'}}});
      const beat = await t.press('poll_inspection', {...bound, panelId, availability: 'ready'});
      const next = session.nextScene(t.scene, beat.priv.delivery.change);
      await t.press('complete_inspection', {...bound, panelId, commandId: beat.priv.delivery.commandId,
        claimToken: beat.priv.delivery.claimToken, scene: next});
      const rows = (await t.state({residues: {limit: 2}})).residues.rows;
      const returned = await t.press('return_detailed_view',
        {snapshot: snapshot(), residues: [descriptorOf(rows[0]), descriptorOf(rows[1])]});
      // The detailed page is the one pressing Return, so it is never its own
      // destination. With no other panel attached the projection is saved.
      expect(returned.state.detailedReturn.mode).toBe('saved');
      expect(returned.state.detailedReturn.remaining).toEqual([]);
      expect(returned.state.detailedReturn.applied).toEqual(expect.arrayContaining(['appearance', 'selection', 'camera']));
      const summary = await t.state();
      // The place is preserved: the wearer's picks, the appearance they left
      // with, and the framing they were looking at.
      expect(summary.view.selectedResidueCount).toBe(2);
      expect(summary.view.appearance.representation).toBe('ball-and-stick');
      expect(summary.view.appearance.background).toBe('#0a0f14');
      expect(summary.detailedView.present).toBe(true);
    } finally { await t.close(); }
  });

  it('still prefers the desktop panel when one is there to render it', async () => {
    const t = await setup();
    try {
      const desktop = (await t.call('attach_inspection', {...t.binding, surface: 'desktop'})).structuredContent.panelId;
      await t.attachDetailed();
      const returned = await t.press('return_detailed_view', {snapshot: snapshot()});
      expect(returned.state.detailedReturn.mode).toBe('panel');
      expect(returned.state.detailedReturn.command.panelId).toBe(desktop);
    } finally { await t.close(); }
  });
});

describe('the detailed page half of the session', () => {
  it('retains authored figure selections and annotations while a global style carries home from the full viewer', () => {
    const figure = { layers: [{ id: 'custom-part', target: { chain: 'local' }, representation: 'cartoon', color: '#25859b', opacity: 1, context: false }],
      labels: [{ id: 'part-name', target: { chain: 'local' }, text: 'Custom part', color: '#25859b', offsetX: 0, offsetY: 0, sizeFactor: 1 }], distances: [] };
    const scene = { sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: 'asymmetric_unit', selectionKeys: ['one'], camera: structuredClone(camera),
      inspection: { appearance: structuredClone(appearance), placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, lessonFigure: figure } };
    const changed = session.nextScene(scene, { kind: 'appearance', patch: { representation: 'spacefill' } });
    expect(changed.inspection.lessonFigure).toEqual({ ...figure, representationOverride: 'spacefill' });
    expect(changed.selectionKeys).toEqual(scene.selectionKeys);
    expect(changed.inspection.placement).toEqual(scene.inspection.placement);
    expect(scene.inspection.lessonFigure).toEqual(figure);
  });
  it('folds a change into the saved scene exactly as the host expects', () => {
    const scene = {sourceSha256: 'a'.repeat(64), modelNumber: 1, assemblyId: 'asymmetric_unit',
      selectionKeys: ['one'], camera: structuredClone(camera),
      inspection: {appearance: structuredClone(appearance), placement: {translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1}}};
    const coloured = session.nextScene(scene, {kind: 'appearance', patch: {uniformColor: '#ff0000', opacity: 0.5}});
    expect(coloured.inspection.appearance).toEqual({...appearance, uniformColor: '#ff0000', opacity: 0.5});
    expect(coloured.selectionKeys).toEqual(['one']);
    expect(coloured.camera).toEqual(scene.camera);
    const picked = session.nextScene(scene, {kind: 'selection', patch: {selectionKeys: ['two', 'three']}});
    expect(picked.selectionKeys).toEqual(['two', 'three']);
    const lit = session.nextScene(scene, {kind: 'emphasis',
      patch: {parts: [{id: 'pam', label: 'PAM', color: '#ff8800'}], focus: ['pam'], contextOpacity: 0.12}});
    expect(lit.inspection.emphasis.focus).toEqual(['pam']);
    // The original is never edited, so a refused receipt leaves the page's
    // copy of the saved scene exactly where it was.
    expect(scene.inspection.appearance.uniformColor).toBe('#44aaff');
    for (const kind of ['placement', 'camera', 'motion', 'focus', 'tour', 'render-quality']) {
      expect(session.renders(kind)).toBe(false);
      expect(session.nextScene(scene, {kind, patch: {}})).toBeNull();
      expect(session.refusal(kind).length).toBeLessThan(60);
    }
  });

  it('removes only the picture it drew, children first', async () => {
    const deleted: string[] = [];
    const commits: number[] = [];
    const plugin = {
      build: () => ({delete: (ref: string) => { deleted.push(ref); }, commit: async () => { commits.push(deleted.length); }}),
      canvas3d: {}, managers: {},
      builders: {data: {}, structure: {
        representation: {addRepresentation: async () => ({ref: `repr-${deleted.length}`})},
        tryCreateComponentFromSelection: async () => ({ref: 'component'}),
        tryCreateComponentStatic: async () => ({ref: 'all'}),
      }},
    };
    const refs: string[] = [];
    const painter = session.recordingPlugin(plugin, refs);
    const made = await painter.builders.structure.tryCreateComponentFromSelection({}, {}, 'k', {});
    expect(made.ref).toBe('component');
    await painter.builders.structure.representation.addRepresentation(made, {});
    expect(refs).toEqual(['component', 'repr-0']);
    expect(await session.clearPainted(plugin, refs)).toBe(2);
    // A representation is deleted before the component that holds it.
    expect(deleted).toEqual(['repr-0', 'component']);
    expect(commits).toEqual([2]);
    expect(refs).toEqual([]);
    expect(await session.clearPainted(plugin, refs)).toBe(0);
  });

  it('sends one report per settled pick, not one per highlight', () => {
    const one = [{assemblyId: 'asymmetric_unit', operatorIds: [], labelChain: 'A', componentId: 'THR',
      insertionCode: '', labelSequenceId: 1, authorResidue: 1}];
    const same = [{...one[0]}];
    const other = [{...one[0], authorResidue: 2}];
    expect(session.selectionSignature(one)).toBe(session.selectionSignature(same));
    expect(session.selectionSignature(one)).not.toBe(session.selectionSignature(other));
    expect(session.selectionSignature([])).toBe('');
  });

  it('reads one heartbeat into what the page has to do about it', () => {
    const empty = session.readBeat({structuredContent: {attached: true, serverEpoch: 'e', sourceToken: 's',
      stateRevision: 4, inspectionRevision: 2}, private: {}});
    expect(empty.binding).toEqual({serverEpoch: 'e', sourceToken: 's', baseStateRevision: 4, baseInspectionRevision: 2});
    expect(empty.delivery).toBeUndefined();
    const drawn = session.readBeat({structuredContent: {attached: true},
      private: {delivery: {commandId: 'c', claimToken: 'k', change: {kind: 'appearance', patch: {}}},
        headsetCaption: {text: 'Here it is.'}}});
    expect(drawn.draws).toBe(true);
    expect(drawn.refusal).toBe('');
    expect(drawn.caption.text).toBe('Here it is.');
    const refused = session.readBeat({structuredContent: {attached: true},
      private: {delivery: {commandId: 'c', claimToken: 'k', change: {kind: 'tour', patch: {}}}}});
    expect(refused.draws).toBe(false);
    expect(refused.refusal).toBe('A lesson plays in the headset, not here.');
    expect(session.readBeat({structuredContent: {attached: false}, private: {}}).attached).toBe(false);
  });

  it('refuses a figure style it cannot paint without losing the authored saved scene', () => {
    const scene = {inspection: {lessonFigure: {layers: [{id: 'protein', representation: 'cartoon'}]}}};
    const before = structuredClone(scene);
    const delivery = {commandId: 'figure-style', claimToken: 'claim',
      change: {kind: 'appearance', patch: {representation: 'spacefill'}}};
    for (const answer of [
      {structuredContent: {attached: true}, private: {delivery}},
      {structuredContent: {attached: true}, private: {delivery, scene}},
    ]) {
      const read = session.readBeat(answer, scene);
      expect(read.delivery).toEqual(delivery);
      expect(read.draws).toBe(false);
      expect(read.refusal).toBe('Change the lesson figure style in the linked headset or inspector.');
    }
    expect(scene).toEqual(before);
    expect(session.readBeat({private: {delivery: {...delivery,
      change: {kind: 'appearance', patch: {background: '#08131f'}}}}}, scene).draws).toBe(true);
    expect(session.readBeat({private: {delivery}}, {inspection: {}}).draws).toBe(true);
  });

  it('holds the microphone for one utterance and closes it with a final chunk', async () => {
    const posted: any[] = [];
    let recorder: any;
    class Recorder {
      ondataavailable?: (event: any) => void;
      onstop?: () => void;
      constructor(public stream: unknown, public options: {mimeType: string}) { recorder = this; }
      static isTypeSupported(type: string) { return type === 'audio/webm'; }
      start() { /* The test drives the chunks itself. */ }
      stop() { this.onstop?.(); }
    }
    const said: string[] = [];
    const talk = session.createTalk({
      post: async (name: string, args: unknown) => { posted.push({name, args}); },
      uuid: () => '44444444-4444-4444-8444-444444444444',
      toBase64: async () => 'QUJD',
      Recorder, getMedia: async () => ({}), mimeTypes: ['audio/ogg', 'audio/webm'],
      say: (text: string) => said.push(text),
    });
    expect(await talk.start()).toBe(true);
    expect(talk.recording).toBe(true);
    expect(recorder.options.mimeType).toBe('audio/webm');
    await recorder.ondataavailable({data: {size: 12}});
    await recorder.ondataavailable({data: {size: 0}});
    talk.stop();
    await new Promise(next => setTimeout(next, 0));
    expect(posted.map(entry => entry.name)).toEqual(['push_to_talk_audio', 'push_to_talk_audio']);
    expect(posted[0].args).toEqual({utteranceId: '44444444-4444-4444-8444-444444444444', seq: 0,
      mime: 'audio/webm', data: 'QUJD', final: false});
    expect(posted[1].args).toEqual({utteranceId: '44444444-4444-4444-8444-444444444444', seq: 1,
      mime: 'audio/webm', final: true});
    expect(said).toEqual(['Listening.', 'Thinking about that.']);
    for (const line of said) expect(line.split(' ').length).toBeLessThan(12);
  });

  it('waits for delayed conversion before finalizing one transcript', async () => {
    const converted = deferred<string>();
    const posted: any[] = [], heard: string[] = [];
    let recorder: any;
    class Recorder {
      ondataavailable?: (event: any) => void;
      onstop?: () => void;
      constructor() { recorder = this; }
      static isTypeSupported() { return true; }
      start() {}
      stop() { this.onstop?.(); }
    }
    const talk = session.createTalk({
      post: async (_name: string, args: any) => {
        posted.push(args);
        return args.final ? {structuredContent: {transcript: {text: 'converted once'}}} : {};
      },
      uuid: () => '88888888-8888-4888-8888-888888888888',
      toBase64: async () => await converted.promise,
      Recorder, getMedia: async () => ({}), mimeTypes: ['audio/webm'], say: () => {},
      onTranscript: (text: string) => heard.push(text),
    });
    await talk.start();
    const chunk = recorder.ondataavailable({data: {size: 12}});
    talk.stop();
    await settleTasks();
    expect(posted).toEqual([]);
    converted.resolve('QUJD');
    await chunk;
    await settleTasks();
    expect(posted.map(entry => ({seq: entry.seq, final: entry.final}))).toEqual([
      {seq: 0, final: false}, {seq: 1, final: true},
    ]);
    expect(new Set(posted.map(entry => entry.seq)).size).toBe(posted.length);
    expect(heard).toEqual(['converted once']);
    expect(talk.recording).toBe(false);
  });

  it('waits for delayed network upload before finalizing one transcript', async () => {
    const uploaded = deferred<void>();
    const posted: any[] = [], heard: string[] = [];
    let recorder: any;
    class Recorder {
      ondataavailable?: (event: any) => void;
      onstop?: () => void;
      constructor() { recorder = this; }
      static isTypeSupported() { return true; }
      start() {}
      stop() { this.onstop?.(); }
    }
    const talk = session.createTalk({
      post: async (_name: string, args: any) => {
        posted.push(args);
        if (!args.final) await uploaded.promise;
        return args.final ? {structuredContent: {transcript: {text: 'uploaded once'}}} : {};
      },
      uuid: () => '99999999-9999-4999-8999-999999999999', toBase64: async () => 'QUJD',
      Recorder, getMedia: async () => ({}), mimeTypes: ['audio/webm'], say: () => {},
      onTranscript: (text: string) => heard.push(text),
    });
    await talk.start();
    const chunk = recorder.ondataavailable({data: {size: 12}});
    await settleTasks();
    talk.stop();
    await settleTasks();
    expect(posted.map(entry => entry.seq)).toEqual([0]);
    uploaded.resolve();
    await chunk;
    await settleTasks();
    expect(posted.map(entry => ({seq: entry.seq, final: entry.final}))).toEqual([
      {seq: 0, final: false}, {seq: 1, final: true},
    ]);
    expect(new Set(posted.map(entry => entry.seq)).size).toBe(posted.length);
    expect(heard).toEqual(['uploaded once']);
    expect(talk.recording).toBe(false);
  });

  it('latches release before microphone permission and finalizes once', async () => {
    const permission = deferred<unknown>();
    const posted: any[] = [], heard: string[] = [], said: string[] = [];
    class Recorder {
      ondataavailable?: (event: any) => void;
      onstop?: () => void;
      static isTypeSupported() { return true; }
      start() {}
      stop() {
        this.ondataavailable?.({data: {size: 12}});
        this.onstop?.();
      }
    }
    const talk = session.createTalk({
      post: async (_name: string, args: any) => {
        posted.push(args);
        return args.final ? {structuredContent: {transcript: {text: 'quick press'}}} : {};
      },
      uuid: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', toBase64: async () => 'QUJD',
      Recorder, getMedia: async () => await permission.promise, mimeTypes: ['audio/webm'],
      say: (text: string) => said.push(text), onTranscript: (text: string) => heard.push(text),
    });
    const starting = talk.start();
    expect(talk.recording).toBe(true);
    expect(talk.stop()).toBe(true);
    permission.resolve({});
    expect(await starting).toBe(true);
    await settleTasks();
    expect(posted.map(entry => ({seq: entry.seq, final: entry.final}))).toEqual([
      {seq: 0, final: false}, {seq: 1, final: true},
    ]);
    expect(new Set(posted.map(entry => entry.seq)).size).toBe(posted.length);
    expect(heard).toEqual(['quick press']);
    expect(said).toEqual(['Listening.', 'Thinking about that.']);
    expect(talk.recording).toBe(false);
  });

  /**
   * "Say return when done", kept by the page itself.
   *
   * The handoff line the headset speaks on the way out promises one word, and
   * a promise that needs an agent awake on the Mac to be kept is not one. The
   * closing push_to_talk_audio call already answers with the transcript the Mac
   * just made, so the page hears the word on the route it already had.
   */
  it('takes the wearer home when the held press says return, and leaves every other word alone', async () => {
    const spoken = ['return', 'Return.', 'okay return please', 'go back', 'back', 'Take me back!',
      'done', "I'm done", 'back to the headset', 'return to VR', 'go home'];
    for (const phrase of spoken) expect(session.isReturnRequest(phrase), phrase).toBe(true);
    // A question about the structure, a command for the panel, and the word
    // hidden inside a longer sentence all have to reach the assistant instead.
    const left = ['what is this', 'colour the chain by element', 'go back to the cartoon view',
      'do not go back yet', 'return the selection to spacefill', '', '   ', 'next',
      'read that back to me one more time so I can write it down and then think about it'];
    for (const phrase of left) expect(session.isReturnRequest(phrase), phrase).toBe(false);
    expect(session.isReturnRequest(undefined)).toBe(false);
    expect(session.isReturnRequest(42)).toBe(false);
  });

  it('reads the transcript off the closing chunk and only off that one', async () => {
    const heard: string[] = [];
    let recorder: any;
    class Recorder {
      ondataavailable?: (event: any) => void;
      onstop?: () => void;
      constructor(public stream: unknown, public options: {mimeType: string}) { recorder = this; }
      static isTypeSupported() { return true; }
      start() { /* The test drives the chunks itself. */ }
      stop() { this.onstop?.(); }
    }
    const talk = session.createTalk({
      // Every chunk answers with a transcript; only the final one is read, so
      // a mid-utterance partial can never be taken as the whole sentence.
      post: async (_name: string, args: any) => ({structuredContent: {
        transcript: {text: args.final ? 'return' : 'ret'}}}),
      uuid: () => '55555555-5555-4555-8555-555555555555',
      toBase64: async () => 'QUJD',
      Recorder, getMedia: async () => ({}), mimeTypes: ['audio/webm'],
      say: () => {},
      onTranscript: (text: string) => heard.push(text),
    });
    expect(await talk.start()).toBe(true);
    await recorder.ondataavailable({data: {size: 12}});
    talk.stop();
    await new Promise(next => setTimeout(next, 0));
    expect(heard).toEqual(['return']);
  });

  it('a host that transcribed nothing, or a reader that throws, costs the utterance nothing', async () => {
    let recorder: any;
    class Recorder {
      ondataavailable?: (event: any) => void;
      onstop?: () => void;
      constructor(public stream: unknown, public options: {mimeType: string}) { recorder = this; }
      static isTypeSupported() { return true; }
      start() {}
      stop() { this.onstop?.(); }
    }
    const said: string[] = [];
    // A host with no transcriber turned on answers with a message and no
    // record at all; the page must not read `text` off nothing.
    const quiet = session.createTalk({
      post: async () => ({structuredContent: {accepted: true, reason: 'disabled'}}),
      uuid: () => '66666666-6666-4666-8666-666666666666', toBase64: async () => 'QUJD',
      Recorder, getMedia: async () => ({}), mimeTypes: ['audio/webm'],
      say: (text: string) => said.push(text),
      onTranscript: () => { throw Error('nothing should reach this'); },
    });
    expect(await quiet.start()).toBe(true);
    quiet.stop();
    await new Promise(next => setTimeout(next, 0));
    expect(said).toEqual(['Listening.', 'Thinking about that.']);

    const angry = session.createTalk({
      post: async () => ({structuredContent: {transcript: {text: 'return'}}}),
      uuid: () => '77777777-7777-4777-8777-777777777777', toBase64: async () => 'QUJD',
      Recorder, getMedia: async () => ({}), mimeTypes: ['audio/webm'],
      say: () => {},
      onTranscript: () => { throw Error('the page navigated out from under the reader'); },
    });
    expect(await angry.start()).toBe(true);
    angry.stop();
    await new Promise(next => setTimeout(next, 0));
    expect(angry.recording).toBe(false);
  });

  it('says so plainly when the browser cannot record or will not listen', async () => {
    const said: string[] = [];
    const noRecorder = session.createTalk({post: async () => {}, uuid: () => 'x', toBase64: async () => '',
      Recorder: undefined, getMedia: async () => ({}), mimeTypes: ['audio/webm'], say: (text: string) => said.push(text)});
    expect(await noRecorder.start()).toBe(false);
    class Recorder {
      static isTypeSupported() { return true; }
      start() {} stop() {}
    }
    const refused = session.createTalk({post: async () => {}, uuid: () => 'x', toBase64: async () => '',
      Recorder, getMedia: async () => { throw Error('NotAllowedError'); }, mimeTypes: ['audio/webm'],
      say: (text: string) => said.push(text)});
    expect(await refused.start()).toBe(false);
    expect(said).toEqual(['This browser cannot record. Use the headset menu.', 'The microphone is not allowed here.']);
    expect(session.captionAudioUrl({})).toBe('');
    expect(session.captionAudioUrl({audio: {base64: 'QUJD'}})).toBe('data:audio/wav;base64,QUJD');
    expect(session.pickRecordingMime(undefined, ['audio/webm'])).toBe('');
  });

  it('collects only what the person selected, bounded, for a live report', () => {
    const residues = [{comp: 'THR', label: 1, auth: 1, chain: 'A'}, {comp: 'ILE', label: 7, auth: 7, chain: 'A'}];
    const perAtom = residues.flatMap((_, index) => [index, index]);
    const unit = {
      id: 0, elements: perAtom.map((_, atom) => atom),
      conformation: {operator: {assembly: undefined}},
      model: {atomicHierarchy: {
        chainAtomSegments: {index: perAtom}, residueAtomSegments: {index: perAtom},
        chains: {label_asym_id: {value: (index: number) => residues[index].chain}},
        atoms: {label_comp_id: {value: (atom: number) => residues[perAtom[atom]].comp}},
        residues: {label_seq_id: {value: (index: number) => residues[index].label},
          auth_seq_id: {value: (index: number) => residues[index].auth},
          pdbx_PDB_ins_code: {value: () => ''}},
      }},
    };
    const loaded = {units: [unit], elementCount: 4};
    const plugin = {managers: {structure: {
      selection: {getLoci: () => ({kind: 'element-loci', elements: [{unit, indices: [0, 1, 2, 3]}]})},
      // A component the person gathered is their work, but it is not what they
      // are pointing at right now, so a live report never folds one in.
      hierarchy: {current: {structures: [{components: [
        {cell: {obj: {data: {units: [unit], elementCount: 2}, label: 'Binding site'}, transform: {tags: ''}}},
      ]}]}},
    }}};
    const whole = returnHelpers.collectSelection(plugin, loaded);
    expect(whole.residues.map((entry: any) => entry.componentId)).toEqual(['THR', 'ILE']);
    expect(whole.truncated).toBe(false);
    const capped = returnHelpers.collectSelection(plugin, loaded, 1);
    expect(capped.residues).toHaveLength(1);
    expect(capped.truncated).toBe(true);
    // The Return press is unchanged: it still folds the person's components in.
    expect(returnHelpers.collect(plugin, loaded).componentLabels).toEqual(['Binding site']);
  });
});

describe('the detailed document itself', () => {
  const html = detailedViewHtml();
  const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

  it('carries the talk control and the caption line the session needs', () => {
    expect(html).toContain('id="talk"');
    expect(html).toContain('Hold to talk');
    expect(html).toContain('id="caption"');
    // Both are the same 64 px target the way back is, because they are aimed
    // at with the same controller ray from across a room.
    expect(html).toContain('#talk{display:inline-flex;align-items:center;min-height:64px');
    expect(script).not.toContain('if (!talk.recording) return;');
  });

  it('registers, beats, reports and detaches over the route it already has', () => {
    expect(script).toContain("'attach_inspection'");
    expect(script).toContain("surface: 'detailed'");
    expect(script).toContain("'poll_inspection'");
    expect(script).toContain("'complete_inspection'");
    expect(script).toContain("'report_detailed_selection'");
    expect(script).toContain("'push_to_talk_audio'");
    expect(script).toContain("'detach_inspection'");
    // One page key, one route, no second transport.
    expect(script.match(/fetch\('\/tool'/g)!.length).toBeGreaterThan(0);
    expect(script).not.toContain('http://');
    expect(() => new Function(script)).not.toThrow();
  });

  it('keeps the way home and the Return press exactly as they were', () => {
    expect(script).toContain("'return_detailed_view'");
    expect(script).toContain("'poll_detailed_view'");
    expect(html).toContain('Back to headset view');
    expect(html).toContain('Apply changes, then back to headset');
  });
});

describe('choosing the full viewer as the panel to send a change to', () => {
  const detailed = {panelId: 'mol', surface: DETAILED_SURFACE, availability: 'ready', current: true};
  const desktop = {panelId: 'desk', surface: 'desktop', availability: 'ready', current: true};
  const companion = {panelId: 'quest', surface: 'companion', availability: 'ready', current: true};

  it('sends a change the viewer draws to the page the wearer is standing in', () => {
    expect(choosePanel([desktop, detailed], {companionInDetailedView: true, detailedRenders: true}))
      .toEqual({panelId: 'mol'});
    // And a change it cannot draw still asks for the wearer back, with the
    // sentence naming what would have worked instead.
    const refused = choosePanel([desktop, detailed], {companionInDetailedView: true, detailedRenders: false});
    expect(refused).toEqual({error: IN_DETAILED_VIEW_MESSAGE});
    expect(IN_DETAILED_VIEW_MESSAGE).toContain('recall_headset');
    expect(IN_DETAILED_VIEW_MESSAGE).toContain('Appearance, selection');
  });

  it('still gives the companion page the command when the wearer is back on it', () => {
    expect(choosePanel([companion, detailed], {detailedRenders: true})).toEqual({panelId: 'quest'});
  });

  it('knows which changes the viewer draws', () => {
    expect(drawnInDetailedView('update_inspection', {change: {kind: 'appearance'}})).toBe(true);
    expect(drawnInDetailedView('update_inspection', {change: {kind: 'selection'}})).toBe(true);
    expect(drawnInDetailedView('emphasize', {})).toBe(true);
    expect(drawnInDetailedView('update_inspection', {change: {kind: 'placement'}})).toBe(false);
    expect(drawnInDetailedView('control_tour', {})).toBe(false);
    expect(drawnInDetailedView('focus_selection', {})).toBe(false);
    // The two lists are one list: what the CLI will send there is what the
    // page will draw.
    for (const kind of DETAILED_VIEW_CHANGES) expect(session.renders(kind)).toBe(true);
  });
});

describe('which surfaces count as the person in the headset', () => {
  it('is the companion page and the full viewer, and nothing on a desk', () => {
    expect(isWearerSurface('companion')).toBe(true);
    expect(isWearerSurface(DETAILED_SURFACE)).toBe(true);
    expect(isWearerSurface('desktop')).toBe(false);
    expect(isWearerSurface(undefined)).toBe(false);
  });
});
