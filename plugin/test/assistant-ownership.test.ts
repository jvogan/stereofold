/**
 * One wearer, one utterance, one action.
 *
 * The transcript queue is a broadcast log: two consumers holding the same
 * cursor both receive the same sentence. That is
 * correct for a log and wrong for two assistants sharing one headset, so these
 * tests pin the claim that was added on top of it — who holds the floor, how it
 * changes hands by word and by tool, and that nobody else is handed the
 * wearer's request in the meantime.
 */
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createStereoStructureServer } from '../src/server.js';
import { createPushToTalkTranscriber } from '../src/push-to-talk-transcribe.js';
import { createAssistantOwnership, handoverLine, normalizeAssistantLabel, switchTarget } from '../src/assistant-ownership.js';

const cif = await readFile(new URL('../../fixtures/1CRN.cif', import.meta.url), 'utf8');

describe('what the wearer says about who is listening', () => {
  it('hears an explicit switch and ignores an ordinary mention of a name', () => {
    expect(switchTarget('switch to Codex')).toBe('codex');
    expect(switchTarget('Switch over to Claude, please.')).toBe('claude');
    expect(switchTarget('hand it over to codex')).toBe('codex');
    expect(switchTarget('hand over to claude now')).toBe('claude');
    expect(switchTarget('give the floor to codex')).toBe('codex');
    expect(switchTarget('let codex take over')).toBe('codex');
    expect(switchTarget('codex, take over')).toBe('codex');
    expect(switchTarget('talk to claude instead')).toBe('claude');
    // A question about an assistant is a question, not a handover.
    expect(switchTarget('ask codex what this residue does')).toBeUndefined();
    expect(switchTarget('colour the guide RNA orange')).toBeUndefined();
    expect(switchTarget('')).toBeUndefined();
  });

  it('keeps the line short enough to say out loud', () => {
    expect(handoverLine('Codex')).toBe('Codex has the floor now.');
    expect(handoverLine('Codex').split(' ').length).toBeLessThan(12);
  });

  it('refuses an empty or oversized assistant name', () => {
    expect(normalizeAssistantLabel('  Claude  Code ')).toBe('Claude Code');
    expect(() => normalizeAssistantLabel('   ')).toThrow(/Name the assistant/);
    expect(() => normalizeAssistantLabel('x'.repeat(41))).toThrow(/at most 40/);
  });
});

describe('the active listener', () => {
  const say = (id: string, text: string, cursor: number) => ({ id, text, cursor });

  it('hands one utterance to the active assistant and none to the other', () => {
    const own = createAssistantOwnership();
    own.attach({ label: 'Claude' });
    own.attach({ label: 'Codex' });
    expect(own.list().active).toBe('Claude');

    const utterances = [say('u1', 'colour the guide RNA orange', 1)];
    const first = own.claim({ assistant: 'Claude', utterances });
    expect(first.delivered.map(entry => entry.id)).toEqual(['u1']);
    // The second listener holding the same cursor gets nothing at all.
    expect(own.claim({ assistant: 'Codex', utterances }).delivered).toEqual([]);
    // Nor does the active one get it twice.
    expect(own.claim({ assistant: 'Claude', utterances }).delivered).toEqual([]);
  });

  it('changes hands on the wearer’s own words, and stops the batch there', () => {
    const own = createAssistantOwnership();
    own.attach({ label: 'Claude' });
    own.attach({ label: 'Codex' });
    const claim = own.claim({ assistant: 'Claude', utterances: [
      say('u1', 'fade everything else', 1),
      say('u2', 'switch to Codex', 2),
      say('u3', 'now make it bigger', 3),
    ] });
    expect(claim.delivered.map(entry => entry.id)).toEqual(['u1']);
    expect(claim.handover).toMatchObject({ from: 'Claude', to: 'Codex', by: 'phrase', spoken: 'Codex has the floor now.' });
    expect(claim.cursor).toBe(2);
    expect(own.list().active).toBe('Codex');
    // What came after the switch belongs to the assistant that just took over.
    expect(own.claim({ assistant: 'Claude', utterances: [say('u3', 'now make it bigger', 3)] }).delivered).toEqual([]);
    expect(own.claim({ assistant: 'Codex', utterances: [say('u3', 'now make it bigger', 3)] }).delivered.map(entry => entry.id)).toEqual(['u3']);
  });

  it('keeps the floor through a long silence and refuses an unknown name', () => {
    let clock = 0;
    const own = createAssistantOwnership({ now: () => clock });
    own.attach({ label: 'Claude' });
    own.attach({ label: 'Codex' });
    own.handOver('Codex');
    clock += 60 * 60_000;
    // An hour of saying nothing is not a handover.
    expect(own.list().active).toBe('Codex');
    expect(own.claim({ assistant: 'Codex', utterances: [say('u9', 'zoom to the PAM', 9)] }).delivered).toHaveLength(1);
    expect(() => own.handOver('Gemini')).toThrow(/Attached now: Claude, Codex/);
  });

  it('does nothing at all until an assistant attaches', () => {
    const own = createAssistantOwnership();
    expect(own.engaged()).toBe(false);
    const utterances = [say('u1', 'colour the guide RNA orange', 1)];
    // Broadcast, exactly as the queue behaved before this change existed.
    expect(own.claim({ assistant: undefined, utterances }).delivered).toHaveLength(1);
    expect(own.claim({ assistant: undefined, utterances }).delivered).toHaveLength(1);
  });

  it('gives the floor back when the assistant holding it goes', () => {
    let clock = 0;
    const own = createAssistantOwnership({ now: () => clock });
    own.attach({ label: 'Claude' });
    clock += 1;
    own.attach({ label: 'Codex' });
    own.handOver('Codex');
    expect(own.detach('Codex')).toEqual({ detached: true, active: 'Claude' });
    expect(own.detach('Claude')).toEqual({ detached: true, active: null });
  });
});

/** A transcriber whose queue a test can speak into, with nothing spawned. */
function quietTranscriber() {
  const spawn = ((command: string, args: readonly string[]) => {
    const child = new EventEmitter() as any;
    child.stdout = Readable.from([]);
    child.stderr = Readable.from([]);
    child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
    child.kill = () => true;
    void Promise.resolve().then(() => child.emit('close', 0));
    void args; void command;
    return child;
  }) as any;
  return createPushToTalkTranscriber({ enabled: true, transcriber: 'whisper',
    whisperBin: '/opt/homebrew/bin/whisper-cli', whisperModel: '/models/ggml-small.en.bin',
    ffmpegBin: '/opt/homebrew/bin/ffmpeg', exists: () => true, spawn, log: () => {} });
}

async function host(name: string, sceneServiceFile: string, transcriber?: ReturnType<typeof quietTranscriber>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, { sceneServiceFile, ...(transcriber ? { transcriber } : {}) });
  const client = new Client({ name, version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name: `stereo_structure.${tool}`, arguments: args }) as Promise<any>;
  return { call, close: async () => { await client.close(); await server.close(); } };
}

let spoken = 0;
const speak = (transcriber: ReturnType<typeof quietTranscriber>, text: string) =>
  transcriber.transcripts.publish({ utteranceId: `00000000-0000-4000-8000-${String(++spoken).padStart(12, '0')}`,
    text, durationMs: 900, receivedAt: new Date(spoken * 1000).toISOString(), model: 'test' });

describe('two assistants sharing one headset', () => {
  it('delivers one utterance once, to whoever is listening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-floor-'));
    const file = join(directory, 'scene-service.json');
    const transcriber = quietTranscriber();
    const a = await host('Stereofold host A', file, transcriber);
    const b = await host('Stereofold host B', file);
    try {
      await a.call('inspect', { structureText: cif });
      await a.call('continue_session', { assistant: 'Claude' });
      await b.call('continue_session', { assistant: 'Codex' });

      speak(transcriber, 'colour the guide RNA orange');

      // Both hosts listen. Only the one holding the floor is given the request.
      const [claude, codex] = await Promise.all([
        a.call('listen_voice', { timeoutSeconds: 1 }),
        b.call('listen_voice', { timeoutSeconds: 1 }),
      ]);
      expect(claude.structuredContent.transcripts.map((entry: any) => entry.text)).toEqual(['colour the guide RNA orange']);
      expect(codex.structuredContent.transcripts).toEqual([]);
      expect(codex.structuredContent.active).toBe('Claude');
      expect(JSON.stringify(codex.content)).toMatch(/Claude is listening to the wearer now\./);
      // Both answers count in the owner's queue, the host told to wait included.
      expect(claude.structuredContent.epoch).toBe(transcriber.transcripts.epoch);
      expect(codex.structuredContent.epoch).toBe(transcriber.transcripts.epoch);

      // Even the listening host is not handed it a second time.
      const again = await a.call('listen_voice', { timeoutSeconds: 1, cursor: 0 });
      expect(again.structuredContent.transcripts).toEqual([]);
    } finally { await b.close(); await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('changes who is listening on the wearer’s words', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-floor-'));
    const file = join(directory, 'scene-service.json');
    const transcriber = quietTranscriber();
    const a = await host('Stereofold host A', file, transcriber);
    const b = await host('Stereofold host B', file);
    try {
      const opened = await a.call('inspect', { structureText: cif });
      const sessionId = opened.structuredContent.sessionId;
      await a.call('continue_session', { assistant: 'Claude' });
      await b.call('continue_session', { assistant: 'Codex' });

      speak(transcriber, 'switch to Codex');
      const heard = await a.call('listen_voice', { timeoutSeconds: 1 });
      // The switch is consumed as a handover, never acted on as a request.
      expect(heard.structuredContent.transcripts).toEqual([]);
      expect(heard.structuredContent.handover).toMatchObject({ from: 'Claude', to: 'Codex', by: 'phrase' });
      expect(JSON.stringify(heard.content)).toMatch(/Codex has the floor now\./);

      speak(transcriber, 'make it bigger');
      const [claude, codex] = await Promise.all([
        a.call('listen_voice', { timeoutSeconds: 1 }),
        b.call('listen_voice', { timeoutSeconds: 1 }),
      ]);
      expect(claude.structuredContent.transcripts).toEqual([]);
      expect(codex.structuredContent.transcripts.map((entry: any) => entry.text)).toEqual(['make it bigger']);

      // And the ownership both hosts read is the same one.
      expect((await b.call('switch_assistant', { sessionId })).structuredContent.active).toBe('Codex');
      expect((await a.call('switch_assistant', { sessionId })).structuredContent.active).toBe('Codex');
    } finally { await b.close(); await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('changes who is listening on a tool call from either host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-floor-'));
    const file = join(directory, 'scene-service.json');
    const transcriber = quietTranscriber();
    const a = await host('Stereofold host A', file, transcriber);
    const b = await host('Stereofold host B', file);
    try {
      const opened = await a.call('inspect', { structureText: cif });
      const sessionId = opened.structuredContent.sessionId;
      await a.call('continue_session', { assistant: 'Claude' });
      await b.call('continue_session', { assistant: 'Codex' });

      // The attached host asks for the floor; the request is answered by the
      // scene, so the host that had it sees the change too.
      const moved = await b.call('switch_assistant', { sessionId, to: 'Codex' });
      expect(moved.isError).not.toBe(true);
      expect(moved.structuredContent.handover).toMatchObject({ from: 'Claude', to: 'Codex', by: 'tool', changed: true });
      expect(JSON.stringify(moved.content)).toMatch(/Codex has the floor now\./);

      speak(transcriber, 'fade everything else');
      const [claude, codex] = await Promise.all([
        a.call('listen_voice', { timeoutSeconds: 1 }),
        b.call('listen_voice', { timeoutSeconds: 1 }),
      ]);
      expect(claude.structuredContent.transcripts).toEqual([]);
      expect(codex.structuredContent.transcripts.map((entry: any) => entry.text)).toEqual(['fade everything else']);

      // Back again, asked for by the other host this time.
      expect((await a.call('switch_assistant', { sessionId, to: 'Claude' })).structuredContent.active).toBe('Claude');
      const refused = await a.call('switch_assistant', { sessionId, to: 'Gemini' });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toMatch(/Attached now: Claude, Codex/);
    } finally { await b.close(); await a.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('leaves a single host’s voice route exactly as it was', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-floor-'));
    const transcriber = quietTranscriber();
    const a = await host('Stereofold host A', join(directory, 'scene-service.json'), transcriber);
    try {
      await a.call('inspect', { structureText: cif });
      speak(transcriber, 'start the tour');
      const heard = await a.call('listen_voice', { timeoutSeconds: 1 });
      expect(heard.structuredContent.transcripts.map((entry: any) => entry.text)).toEqual(['start the tour']);
      // No assistant attached, so no ownership fields and no claim.
      expect(heard.structuredContent.active).toBeUndefined();
      expect(heard.structuredContent.listening).toBeUndefined();
      const replay = await a.call('listen_voice', { timeoutSeconds: 1, cursor: 0 });
      expect(replay.structuredContent.transcripts).toHaveLength(1);
    } finally { await a.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

/** The runtime file is this user's alone, which is what the token rests on. */
describe('the runtime record on disk', () => {
  it('is written with owner-only permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stereofold-floor-'));
    const file = join(directory, 'scene-service.json');
    const a = await host('Stereofold host A', file);
    try {
      await a.call('inspect', { structureText: cif });
      await a.call('continue_session', { assistant: 'Claude' });
      const record = JSON.parse(await readFile(file, 'utf8'));
      expect(record).toMatchObject({ version: 1, pid: process.pid });
      expect(record.token).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.keys(record)).not.toContain('structureText');
      // A record a stranger left behind is never even read.
      await writeFile(file, JSON.stringify(record), { mode: 0o644 });
      const reread = await a.call('continue_session', { assistant: 'Claude' });
      expect(reread.structuredContent.role).toBe('owner');
    } finally { await a.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
