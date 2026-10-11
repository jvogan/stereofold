import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoiceTranscriptConsumer, sameVoiceSession, transcriptJsonLine } from '../scripts/voice-transcript-consumer.js';
import { main as listenerMain } from '../scripts/listen-voice.js';
import { main as bridgeMain } from '../scripts/voice-bridge.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = { origin: 'http://127.0.0.1:12345', token: 'synthetic-test-token', sessionId: 'session-one' };
const transcript = (cursor: number) => ({ cursor, sequence: cursor + 10, utteranceId: `utterance-${cursor}`,
  text: 'Make that blue. Then show the other copy.', receivedAt: '2026-09-13T20:00:00.000Z',
  referent: { sourceToken: 'synthetic-source', capturedAt: 1, selectionKeys: [] } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Synthetic /agent host, using the real request serializer without binding a socket. */
function host() {
  const requests: any[] = [];
  let cursor = 4;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    expect(url).toBe(`${state.origin}/agent`);
    const request = JSON.parse(options.body);
    requests.push(request);
    if (request.name === 'get_inspection_state') return Response.json({ structuredContent: {} });
    const snapshot = request.arguments.waitMs === 0;
    // The new utterance arrives during the FIRST long poll, never in the snapshot.
    if (!snapshot) cursor++;
    return Response.json({ structuredContent: { cursor, transcripts: [transcript(cursor)] } });
  }));
  return requests;
}

describe('lossless transcript consumer shared by listener and voice bridge', () => {
  it('primes nonblocking and prints the first newly spoken request with its full public envelope', async () => {
    const requests = host();
    const consumer = createVoiceTranscriptConsumer();
    expect(await consumer.poll(state)).toEqual([]);
    const entries = await consumer.poll(state);
    expect(requests.map(r => r.arguments)).toEqual([{ after: 0, waitMs: 0 }, { after: 4, waitMs: 15_000 }]);
    expect(JSON.parse(transcriptJsonLine(entries[0]))).toEqual({ text: transcript(5).text,
      utteranceId: 'utterance-5', sequence: 15, at: transcript(5).receivedAt, referent: transcript(5).referent });
    expect(JSON.parse(transcriptJsonLine({ ...entries[0], referent: undefined })).referent).toBeNull();
  });

  it.each(['origin', 'sessionId', 'token'] as const)('re-primes after control %s changes and resets the old cursor', async key => {
    const call = vi.fn(async () => ({ structuredContent: { cursor: 0, transcripts: [] } }));
    const consumer = createVoiceTranscriptConsumer(false, call);
    await consumer.poll(state);
    await consumer.poll(state);
    const replacement = { ...state, [key]: state[key] + '-new' };
    await consumer.poll(replacement);
    expect(call.mock.calls[2]).toEqual([replacement, 'poll_voice_transcripts', { after: 0, waitMs: 0 }]);
    expect(sameVoiceSession(state, replacement)).toBe(false);
    await consumer.poll(replacement);
    expect(call.mock.calls[3]).toEqual([replacement, 'poll_voice_transcripts', { after: 0, waitMs: 15_000 }]);
  });

  it('replays only when explicitly requested', async () => {
    const requests = host();
    const consumer = createVoiceTranscriptConsumer(true);
    expect(await consumer.poll(state)).toHaveLength(1);
    expect(requests[0].arguments).toEqual({ after: 0, waitMs: 15_000 });
  });

  it('does not mark a failed or malformed snapshot as primed', async () => {
    const call = vi.fn().mockRejectedValueOnce(Error('offline'))
      .mockResolvedValueOnce({ structuredContent: {} })
      .mockResolvedValue({ structuredContent: { cursor: 0, transcripts: [] } });
    const consumer = createVoiceTranscriptConsumer(false, call);
    await expect(consumer.poll(state)).rejects.toThrow('offline');
    await expect(consumer.poll(state)).rejects.toThrow('incomplete transcript');
    await consumer.poll(state);
    expect(call.mock.calls.every(args => args[2].waitMs === 0)).toBe(true);
  });

  it('the actual listener loop prints the first new request as a complete JSON line', async () => {
    const requests = host();
    const stop = new AbortController();
    const output = vi.spyOn(console, 'log').mockImplementation(() => stop.abort());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = await mkdtemp(join(tmpdir(), 'voice-listener-test-'));
    try {
      const path = join(directory, 'state.json');
      await writeFile(path, JSON.stringify(state));
      await listenerMain([path], { signal: stop.signal });
      expect(requests.map(r => r.arguments.waitMs)).toEqual([0, 15_000]);
      expect(output).toHaveBeenCalledOnce();
      expect(JSON.parse(output.mock.calls[0][0])).toEqual({ text: transcript(5).text, utteranceId: 'utterance-5',
        sequence: 15, at: transcript(5).receivedAt, referent: transcript(5).referent });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('the actual bridge loop processes the first long-poll request after priming', async () => {
    const requests = host();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const directory = await mkdtemp(join(tmpdir(), 'voice-listener-test-'));
    const path = join(directory, 'state.json');
    const signals = new Map((['SIGINT', 'SIGTERM'] as NodeJS.Signals[]).map(signal => [signal, process.listeners(signal)]));
    try {
      await writeFile(path, JSON.stringify(state));
      await bridgeMain([path, '--dry-run', '--once']);
      expect(requests.filter(r => r.name === 'poll_voice_transcripts').map(r => r.arguments.waitMs)).toEqual([0, 15_000]);
      expect(output.mock.calls.some(args => String(args[0]).includes('Make that blue.'))).toBe(true);
    } finally {
      for (const [signal, before] of signals) for (const listener of process.listeners(signal))
        if (!before.includes(listener)) process.removeListener(signal, listener);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
