/**
 * The in-process host the voice-corpus runner plays its synthetic pass against.
 *
 * THIS IS NOT A MICROPHONE. The only thing this file replaces is the seam where
 * whisper-cpp or Apple's recognizer would hand the host a string: everything
 * downstream of that seam — the utterance ledger, the transcript queue, the
 * referent capture on the press, `listen_voice`, the target-bound command queue
 * and every receipt — is the shipped server, reached over the same MCP client
 * the panel and the agent use. A run built on this host proves that the command
 * path does the right thing with a given sentence. It proves nothing at all
 * about whether the headset would have heard that sentence, and the runner
 * labels its output accordingly.
 *
 * The corpus logic itself lives in `lab/voice-corpus/`.
 * This module exists because that lab is plain ESM and the server is TypeScript:
 * it is the adapter, and it holds no knowledge of what any case means.
 */
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createStereoStructureServer } from '../src/server.js';
import { createTranscriptQueue, type TranscriptRecord } from '../src/push-to-talk-transcribe.js';
import { createReplyAudioSynthesizer } from '../src/headset-reply-audio.js';
import type { RequestReferent } from '../src/inspection-contract.js';

/** What the transcript record says produced its words, so no reader can mistake it. */
export const INJECTED_TRANSCRIPT_MODEL = 'injected-transcript';

export type CorpusToolCall = (name: string, args: Record<string, unknown>) => Promise<any>;

export type SyntheticCorpusHost = {
  readonly kind: 'synthetic';
  /** One tool call on the in-process server, named without the `stereo_structure.` prefix. */
  call: CorpusToolCall;
  /** The words the next completed utterance transcribes to. */
  arm(text: string): void;
  /** Turn the recognizer off, the way a host started without `--ptt` is off. */
  setTranscription(enabled: boolean): void;
  /** The server's clock, so a case can age a referent without sleeping. */
  clock: { now: number };
  close(): Promise<void>;
};

type Utterance = { referent?: RequestReferent; opened: boolean };

/**
 * A transcriber whose only difference from the shipped one is where the words
 * come from. It keeps the real transcript queue, the real referent binding and
 * the real outcome vocabulary, so `listen_voice` cannot tell the two apart.
 */
function injectedTranscriber(clock: { now: number }) {
  const queue = createTranscriptQueue();
  const live = new Map<string, Utterance>();
  let readReferent: ((sessionId: string) => RequestReferent | undefined) | undefined;
  let armed = '';
  let enabled = true;
  return {
    get enabled() { return enabled; },
    get ready() { return enabled; },
    route: 'injected' as const,
    describe: () => 'injected transcript (no microphone)',
    missing: () => [] as string[],
    startupLine: () => 'Voice corpus runner: transcripts are injected, not heard.',
    dispose: async () => { live.clear(); },
    arm(text: string) { armed = text; },
    setEnabled(value: boolean) { enabled = value; },
    /** The host hands this over once its referent store exists. */
    useReferents(read: (sessionId: string) => RequestReferent | undefined) { readReferent = read; },
    async accept(input: { sessionId: string; utteranceId: string; seq: number; final: boolean }) {
      const base = { utteranceId: input.utteranceId, seq: input.seq, final: input.final };
      if (!enabled) return { ...base, accepted: false, reason: 'disabled' as const,
        message: 'Headset transcription is off on this host, so nothing was heard.' };
      if (input.seq === 0 && !live.has(input.utteranceId)) {
        // The referent belongs to the moment the press opened, exactly as it
        // does on the shipped route; a later chunk never re-reads it.
        live.set(input.utteranceId, { referent: readReferent?.(input.sessionId), opened: true });
      }
      if (!input.final) return { ...base, accepted: true, reason: 'chunk' as const, message: 'Chunk received.' };
      const utterance = live.get(input.utteranceId);
      live.delete(input.utteranceId);
      const record: TranscriptRecord = {
        utteranceId: input.utteranceId,
        text: armed,
        durationMs: 0,
        receivedAt: new Date(clock.now).toISOString(),
        model: INJECTED_TRANSCRIPT_MODEL,
        ...(utterance?.referent ? { referent: utterance.referent } : {}),
      };
      queue.publish(record);
      return { ...base, accepted: true, reason: 'transcribed' as const, message: `Heard: ${armed}`, transcript: record };
    },
    transcripts: queue,
  };
}

/**
 * A bare host: a server, a connected client, and nothing opened. Every case
 * loads its own fixture, because the corpus pins a different one per group.
 */
export async function createSyntheticCorpusHost(): Promise<SyntheticCorpusHost> {
  const clock = { now: Date.UTC(2026, 8, 13) };
  const transcriber = injectedTranscriber(clock);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createStereoStructureServer(undefined, {
    now: () => clock.now,
    transcriber,
    // Reply audio shells out to `say` and ffmpeg. The corpus records reply text;
    // audibility is a worn-headset observation this runner cannot make.
    replyAudio: createReplyAudioSynthesizer({ enabled: false }),
  } as any);
  const client = new Client({ name: `Stereofold voice corpus runner ${randomUUID()}`, version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    kind: 'synthetic',
    call: async (name, args) => await client.callTool({ name: `stereo_structure.${name}`, arguments: args }) as any,
    arm: text => transcriber.arm(text),
    setTranscription: value => transcriber.setEnabled(value),
    clock,
    close: async () => { await client.close(); await server.close(); },
  };
}
