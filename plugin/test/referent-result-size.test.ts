/**
 * What a spoken request costs to deliver, and what "this" means
 * when the wearer had nothing selected.
 *
 * On a model-driven session the wearer said "stop, go
 * back to my view" during a tour chapter. The referent beside that transcript
 * carried the chapter's 574 canonical keys, so `listen_voice` answered with
 * 102,986 characters — past what the model client would hand to a model at
 * all. It wrote the result to a file instead, and the model spent 15.6 s and a
 * shell command digging the sentence back out. Defect 126.
 *
 * Row 2 of the same session is the other half: "show it as a surface" carried
 * a referent that had captured nothing, and the appearance change was refused
 * "Select residues before styling a selection." — advice about a selection the
 * wearer never asked for. Defect 122.
 *
 * So: the keys stay on this Mac and a sample travels, and a referent that
 * captured nothing means the whole scene.
 */
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { PRIVATE_INSPECTION_META_KEY as PRIVATE_KEY } from '../src/inspection-contract.js';
import { decodeInspectionCatalog } from '../src/inspection-catalog-codec.js';
import { createPushToTalkTranscriber } from '../src/push-to-talk-transcribe.js';
import { REFERENT_INLINE_KEY_LIMIT, createReferentKeyStore, referentKeyDigest } from '../src/inspection-operation.js';
import { voicedWav } from './helpers/voiced-wav.js';

const hemoglobin = await readFile(new URL('../../fixtures/4HHB.cif', import.meta.url), 'utf8');
const crambin = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');
const UTTERANCE = '22222222-2222-4222-8222-222222222222';
const HEARD = 'stop go back to my view';
/**
 * What a model client accepts without spilling the result to a file. The
 * target is a transcript record under 4 KB.
 */
const TRANSCRIPT_BUDGET_BYTES = 4_096;
/** The tour chapter's selection, rounded up past the 574 that broke it. */
const CAPTURED_RESIDUES = 600;

/** ffmpeg and whisper-cli, answered without running either. */
function fakeSpawner() {
  return ((command: string, args: readonly string[]) => {
    const child = new EventEmitter() as any;
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    child.kill = () => true;
    void Promise.resolve().then(async () => {
      if (command.includes('ffmpeg')) { await writeFile(args[args.length - 1]!, voicedWav()); child.emit('close', 0); return; }
      if (command.includes('whisper')) { await writeFile(`${args[args.indexOf('-of') + 1]!}.txt`, `${HEARD}\n`); child.emit('close', 0); return; }
      child.emit('close', 0);
    });
    return child;
  }) as any;
}

async function setup(source = hemoglobin, selected = CAPTURED_RESIDUES) {
  const transcriber = createPushToTalkTranscriber({ enabled: true, transcriber: 'whisper',
    whisperBin: '/opt/homebrew/bin/whisper-cli', whisperModel: '/models/ggml-small.en.bin',
    ffmpegBin: '/opt/homebrew/bin/ffmpeg', exists: () => true, spawn: fakeSpawner(), log: () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { transcriber });
  const client = new Client({ name: 'Stereofold referent size test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as Promise<any>;
  const sessionId = (await call('inspect', { structureText: source })).structuredContent.sessionId as string;
  const privateData = (await call('get_inspection', { sessionId }))._meta[PRIVATE_KEY];
  // Haemoglobin's catalog rides compressed; crambin's arrives inline.
  const catalog = privateData.catalog ?? await decodeInspectionCatalog(privateData.catalogWire);
  const rows = catalog.rows as any[];
  const selectionKeys = rows.slice(0, selected).map(row => row.key as string);
  const scene = {
    sourceSha256: catalog.source.sha256,
    modelNumber: catalog.modelNumbers[0],
    assemblyId: catalog.assemblyId,
    selectionKeys,
    camera: { mode: 'perspective', fov: Math.PI / 4, position: [0, 0, 80], target: [0, 0, 0], up: [0, 1, 0],
      radius: 20, radiusMax: 20, fog: 50, clipFar: true, minNear: 5, minFar: 0 },
    inspection: {
      appearance: { representation: 'cartoon', color: 'chain-id', uniformColor: '#58dcc9', background: '#071015',
        opacity: 1, labels: false, highlightColor: '#f2c47c', clipping: 0, fog: 0 },
      placement: { translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1 },
    },
  };
  const opened = { sessionId, serverEpoch: privateData.serverEpoch, sourceToken: privateData.sourceToken,
    baseStateRevision: privateData.stateRevision, baseInspectionRevision: privateData.inspectionRevision };
  const saved = (await call('sync_inspection', { ...opened, scene })).structuredContent;
  const live = { ...opened, baseStateRevision: saved.stateRevision, baseInspectionRevision: saved.inspectionRevision };
  const panelId = (await call('attach_inspection', { ...live, surface: 'companion' })).structuredContent.panelId as string;
  await call('poll_inspection', { ...live, panelId, availability: 'ready' });
  const claim = async () => (await call('poll_inspection', { ...live, panelId, availability: 'ready' }))._meta?.[PRIVATE_KEY]?.delivery;
  /** One press, transcribed, exactly as the talk orb drives it. */
  const speak = async () => {
    await call('push_to_talk_audio', { sessionId, utteranceId: UTTERANCE, seq: 0,
      mime: 'audio/webm;codecs=opus', data: Buffer.from('opus').toString('base64'), final: true });
    return (await call('listen_voice', { timeoutSeconds: 1 })).structuredContent;
  };
  return { call, rows, scene, selectionKeys, panelId, sessionId, claim, speak,
    binding: () => live,
    close: async () => { await transcriber.dispose(); await client.close(); await server.close(); } };
}

describe('the size of the referent a spoken request carries', () => {
  it('keeps a tour-sized capture out of the listen_voice result and still names all of it', async () => {
    const t = await setup();
    try {
      const heard = await t.speak();
      expect(heard.transcripts).toHaveLength(1);
      const record = heard.transcripts[0];
      expect(record.text).toBe(HEARD);
      // The defect in one number: this record was 102,986 characters.
      expect(JSON.stringify(record).length).toBeLessThan(TRANSCRIPT_BUDGET_BYTES);
      expect(record.referent.truncated).toBe(true);
      expect(record.referent.selectionCount).toBe(CAPTURED_RESIDUES);
      expect(record.referent.selectionKeys).toHaveLength(REFERENT_INLINE_KEY_LIMIT);
      expect(record.referent.selectionKeys).toEqual(t.selectionKeys.slice(0, REFERENT_INLINE_KEY_LIMIT));
      expect(record.referent.selectionDigest).toBe(referentKeyDigest(t.selectionKeys));
    } finally { await t.close(); }
  });

  it('binds an echoed compact referent to the whole capture, not to the sample', async () => {
    const t = await setup();
    try {
      const { referent } = (await t.speak()).transcripts[0];
      const framed = await t.call('focus_selection', { ...t.binding(), panelId: t.panelId,
        commandId: 'focus-captured', framing: 'context', referent });
      expect(framed.isError).not.toBe(true);
      expect(framed.structuredContent.focus.residueCount).toBe(CAPTURED_RESIDUES);
      expect(framed.structuredContent.command.appliedTo.selectionKeys).toHaveLength(CAPTURED_RESIDUES);
      const delivered = await t.claim();
      expect(delivered.change.patch.selectionKeys).toEqual(t.selectionKeys);
    } finally { await t.close(); }
  });

  it('refuses an echoed referent this Mac no longer holds the capture for', async () => {
    const t = await setup();
    try {
      const { referent } = (await t.speak()).transcripts[0];
      const refused = await t.call('focus_selection', { ...t.binding(), panelId: t.panelId,
        commandId: 'focus-forgotten', framing: 'context',
        referent: { ...referent, selectionDigest: 'f'.repeat(32) } });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/no longer held on this Mac/);
      expect(await t.claim()).toBeUndefined();
    } finally { await t.close(); }
  });

  it('still refuses a compact referent captured on another structure, before asking for its keys', async () => {
    const t = await setup();
    try {
      const { referent } = (await t.speak()).transcripts[0];
      const elsewhere = await t.call('focus_selection', { ...t.binding(), panelId: t.panelId,
        commandId: 'focus-elsewhere', framing: 'context',
        referent: { ...referent, sourceToken: '99999999-9999-4999-8999-999999999999' } });
      expect(elsewhere.isError).toBe(true);
      expect(elsewhere.content[0].text).toMatch(/captured on a different structure/);
      expect(await t.claim()).toBeUndefined();
    } finally { await t.close(); }
  });

  it('leaves a capture small enough to read inline exactly as it was', () => {
    const store = createReferentKeyStore();
    const keys = Array.from({ length: REFERENT_INLINE_KEY_LIMIT }, (_value, index) => `key-${index}`);
    const referent = { sourceToken: '11111111-1111-4111-8111-111111111111', capturedAt: 1, selectionKeys: keys };
    expect(store.compact(referent)).toEqual(referent);
    expect(store.size()).toBe(0);
    expect(store.expand(referent, referent.sourceToken)).toEqual(referent);
  });

  it('forgets a capture once its window has passed', () => {
    const clock = { now: 1_000 };
    const store = createReferentKeyStore({ now: () => clock.now, ttlMs: 100 });
    const keys = Array.from({ length: REFERENT_INLINE_KEY_LIMIT + 1 }, (_value, index) => `key-${index}`);
    const compact = store.compact({ sourceToken: '11111111-1111-4111-8111-111111111111', capturedAt: 1, selectionKeys: keys });
    expect(store.expand(compact, compact.sourceToken).selectionKeys).toEqual(keys);
    clock.now += 101;
    expect(() => store.expand(compact, compact.sourceToken)).toThrow(/no longer held on this Mac/);
  });
});

describe('an appearance change whose referent captured nothing', () => {
  /** Row 2: nothing selected when the wearer said "show it as a surface". */
  const empty = (binding: { sourceToken: string }, scene: { modelNumber: number; assemblyId: string }) =>
    ({ sourceToken: binding.sourceToken, capturedAt: 1_700_000_000_000,
      modelNumber: scene.modelNumber, assemblyId: scene.assemblyId, selectionKeys: [] });

  it.each([
    ['representation', { representation: 'molecular-surface' }],
    ['color', { color: 'uniform', uniformColor: '#0000ff' }],
    ['opacity', { opacity: 0.5 }],
  ])('applies %s to the whole scene rather than refusing for an empty selection', async (_name, patch) => {
    const t = await setup(crambin, 4);
    try {
      const referent = empty(t.binding(), t.scene);
      const applied = await t.call('update_inspection', { ...t.binding(), panelId: t.panelId,
        commandId: `scene-${_name}`, referent, change: { kind: 'appearance', patch } });
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent.command.appliedTo).toEqual({ scene: true, capturedAt: referent.capturedAt });
      const delivered = await t.claim();
      // The scene's own appearance, not a style layer over captured residues.
      expect(delivered.change.kind).toBe('appearance');
      expect(delivered.change.patch).toEqual(patch);
    } finally { await t.close(); }
  });

  it('keeps the explicit selection-scoped refusal for a request that asked for one', async () => {
    const t = await setup(crambin, 4);
    try {
      const refused = await t.call('update_inspection', { ...t.binding(), panelId: t.panelId,
        commandId: 'scoped-empty', referent: empty(t.binding(), t.scene),
        change: { kind: 'appearance', scope: 'selection', patch: { opacity: 0.5 } } });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/Select residues before styling a selection/);
      expect(await t.claim()).toBeUndefined();
    } finally { await t.close(); }
  });

  it('still targets the captured residues when the request began on a selection', async () => {
    const t = await setup(crambin, 4);
    try {
      const referent = { ...empty(t.binding(), t.scene), selectionKeys: t.selectionKeys.slice(0, 2) };
      const applied = await t.call('update_inspection', { ...t.binding(), panelId: t.panelId,
        commandId: 'captured-two', referent, change: { kind: 'appearance', patch: { opacity: 0.5 } } });
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent.command.appliedTo)
        .toEqual({ selectionKeys: referent.selectionKeys, capturedAt: referent.capturedAt });
      expect((await t.claim()).change.kind).toBe('styles');
    } finally { await t.close(); }
  });
});
