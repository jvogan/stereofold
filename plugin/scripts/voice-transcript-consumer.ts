import { callLocalAgent, type ControlState } from './local-agent.js';
import type { SpeechNormalizationRule } from '../src/speech-vocabulary.js';

export type VoiceTranscript = {
  cursor: number; text: string; utteranceId: string; sequence: number;
  receivedAt: string; referent?: unknown;
  normalizedText?: string; normalizationRules?: SpeechNormalizationRule[];
};
export const sameVoiceSession = (a: ControlState, b: ControlState) =>
  a.origin === b.origin && a.sessionId === b.sessionId && a.token === b.token && a.serverEpoch === b.serverEpoch;

/** A nonblocking snapshot skips backlog without discarding speech from a long poll. */
export function createVoiceTranscriptConsumer(replay = false, call = callLocalAgent) {
  let control: ControlState | undefined;
  let after = 0;
  let primed = replay;
  let snapshot = false;
  return {
    get lastPollWasSnapshot() { return snapshot; },
    async poll(state: ControlState) {
      if (!control || !sameVoiceSession(control, state)) {
        control = { ...state };
        after = 0;
        primed = replay;
      }
      snapshot = !primed;
      const result = await call(state, 'poll_voice_transcripts', { after, waitMs: primed ? 15_000 : 0 });
      if ((result as any)?.isError) throw Error('The host refused the transcript poll.');
      const body = result?.structuredContent;
      if (!body || !Number.isSafeInteger(body.cursor) || body.cursor < 0 || !Array.isArray(body.transcripts))
        throw Error('The host returned an incomplete transcript envelope.');
      if (body.transcripts.some((entry: any) => typeof entry.text !== 'string' || typeof entry.utteranceId !== 'string'
        || !Number.isSafeInteger(entry.sequence) || typeof entry.receivedAt !== 'string' || !Number.isSafeInteger(entry.cursor)))
        throw Error('The host returned a transcript without its utterance identity, sequence or timestamp.');
      after = Math.max(after, body.cursor);
      if (!primed) { primed = true; return [] as VoiceTranscript[]; }
      return body.transcripts as VoiceTranscript[];
    },
  };
}

export function transcriptJsonLine(entry: VoiceTranscript): string {
  return JSON.stringify({ text: entry.text, utteranceId: entry.utteranceId, sequence: entry.sequence,
    ...(entry.normalizedText !== undefined ? { normalizedText: entry.normalizedText,
      normalizationRules: entry.normalizationRules ?? [] } : {}),
    at: entry.receivedAt, referent: entry.referent ?? null });
}
