import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * The host-independent half of the headset conversation.
 *
 * `listen_voice` lets an agent hear the wearer on any host. Answering them
 * only existed as `speak_to_headset`, which needs the host's OAuth voice hook
 * and so is silent under Claude Code and Claude Science. This queue carries a
 * written reply and its bounded spoken line on the `poll_inspection` heartbeat
 * the companion page already runs. The page draws it on the menu's status row
 * and speaks it with the browser's own `speechSynthesis` when it has one.
 *
 * A caption reaches the companion pages that are already polling when it is
 * queued. A page that connects afterwards starts from the newest caption, so a
 * stale answer is never replayed into a conversation that has moved on.
 */

export const HEADSET_CAPTION_MAX_CHARS = 280;
/**
 * One spoken segment. These are the ceilings a single chunk of sound has to
 * respect: the caption row it is drawn on, and the encoder that renders it.
 * They are no longer the ceiling on an answer. A long reply is split at its
 * own sentence boundaries into consecutive segments that each fit here, and
 * the wearer hears all of them, one after another.
 */
export const HEADSET_SPEECH_MAX_WORDS = 36;
export const HEADSET_SPEECH_MAX_CHARS = 240;
export const HEADSET_SPEECH_MAX_SECONDS = 15;
/**
 * The whole reply. An agent explaining a binding site needs a paragraph, so
 * the bound is on the paragraph rather than on the first sentence of it. Past
 * these the call is refused by name; nothing is ever silently shortened.
 */
export const HEADSET_REPLY_MAX_CHARS = 1_200;
export const HEADSET_REPLY_MAX_WORDS = 200;
/** What 200 words come to at ordinary speaking speed, rounded up. */
export const HEADSET_REPLY_MAX_SECONDS = 90;
/** macOS `say` is driven at 180; it is used only to estimate an unmeasured clip. */
export const HEADSET_SPEECH_WORDS_PER_MINUTE = 180;
export const HEADSET_SPEECH_LIMIT = Object.freeze({maxChars:HEADSET_SPEECH_MAX_CHARS,
  maxWords:HEADSET_SPEECH_MAX_WORDS,maxSeconds:HEADSET_SPEECH_MAX_SECONDS,
  replyMaxChars:HEADSET_REPLY_MAX_CHARS,replyMaxWords:HEADSET_REPLY_MAX_WORDS,
  replyMaxSeconds:HEADSET_REPLY_MAX_SECONDS});
export const HEADSET_CAPTION_MIN_HOLD_SECONDS = 2;
export const HEADSET_CAPTION_MAX_HOLD_SECONDS = 15;
export const HEADSET_CAPTION_DEFAULT_HOLD_SECONDS = 6;
/** Roughly two companion heartbeats, so the usual answer reports its own delivery. */
export const HEADSET_CAPTION_DELIVERY_WAIT_MS = 2_500;
/**
 * Total wall clock one reply may spend rendering its segments.
 *
 * A wedged narration route would otherwise hold the call for the per-segment
 * timeout times the segment count. Past the budget the remaining segments are
 * still captioned and still delivered; they simply carry no clip, and the
 * receipt says how many.
 */
export const HEADSET_REPLY_RENDER_BUDGET_MS = 60_000;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

/** One printable line. A caption is drawn as wrapped text, so line breaks carry nothing. */
export function normalizeHeadsetCaption(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(CONTROL_CHARACTERS, ' ').trim().replace(/\s+/gu, ' ');
}

/** Retain whole short replies, clipping only at a complete word within both text bounds. */
export function headsetSpeechLine(value: unknown): { text: string; truncated: boolean } {
  const full = normalizeHeadsetCaption(value);
  if (!full) return { text: '', truncated: false };
  const words: string[] = [];
  for (const word of full.split(' ')) {
    if (words.length === HEADSET_SPEECH_MAX_WORDS
      || [...words, word].join(' ').length > HEADSET_SPEECH_MAX_CHARS) break;
    words.push(word);
  }
  const bounded = words.join(' ').replace(/(?:\.{3,}|…+)$/u, '').trim();
  return { text: bounded, truncated: bounded !== full };
}

/** How many words a reply carries, counted the way the caption counts them. */
export function headsetSpeechWords(value: unknown): number {
  const text = normalizeHeadsetCaption(value);
  return text ? text.split(' ').length : 0;
}

/**
 * How long a segment takes to say, when no encoder measured it.
 *
 * Used for the page's own fallback timer and for a receipt on a host whose
 * narration route reports no duration. It is an estimate and is reported as
 * one; a measured clip always wins over it.
 */
export function estimateHeadsetSpeechSeconds(value: unknown): number {
  const words = headsetSpeechWords(value);
  if (!words) return 0;
  const seconds = Math.min(HEADSET_SPEECH_MAX_SECONDS, words / (HEADSET_SPEECH_WORDS_PER_MINUTE / 60));
  return Math.round(seconds * 10) / 10;
}

/** A terminator, any closing quote or bracket it carries, then the gap to the next sentence. */
const SENTENCE_BREAK = /(?<=[.!?\u2026]["'\u201d\u2019)\]]*)\s+/u;
/** A word that ends a clause, where a forced cut inside a sentence reads least badly. */
const CLAUSE_END = /[,;:\u2014]$/u;
/** A forced cut looks for a clause boundary only in the last part of the piece. */
const CLAUSE_CUT_FLOOR = 0.6;

function wordsOf(text: string): string[] { return text ? text.split(' ') : []; }

/**
 * Cut one sentence that is longer than a segment into spoken pieces.
 *
 * Words are never split, except for the one case where they must be: a single
 * token longer than a whole segment cannot be said any other way, and saying
 * all of it in two pieces beats dropping the rest of the answer.
 */
function cutSentence(sentence: string, maxChars: number, maxWords: number): string[] {
  const pieces: string[] = [];
  let words = wordsOf(sentence);
  while (words.length) {
    let taken: string[] = [];
    for (const word of words) {
      const next = [...taken, word];
      if (next.join(' ').length > maxChars || next.length > maxWords) break;
      taken = next;
    }
    if (!taken.length) {
      const word = words[0]!;
      pieces.push(word.slice(0, maxChars));
      const rest = word.slice(maxChars);
      words = rest ? [rest, ...words.slice(1)] : words.slice(1);
      continue;
    }
    if (taken.length < words.length) {
      for (let index = taken.length - 1; index > 0; index--) {
        if (taken.slice(0, index).join(' ').length < maxChars * CLAUSE_CUT_FLOOR) break;
        if (CLAUSE_END.test(taken[index - 1]!)) { taken = taken.slice(0, index); break; }
      }
    }
    pieces.push(taken.join(' '));
    words = words.slice(taken.length);
  }
  return pieces;
}

/**
 * The whole reply, as the consecutive segments the headset will hear.
 *
 * Sentences are kept whole and packed together until the next one would not
 * fit the caption row or the encoder, so an ordinary paragraph comes back as
 * a handful of segments that each end on a full stop. Nothing is dropped: the
 * concatenation of the segments is the submitted text, word for word.
 */
export function splitHeadsetSpeech(value: unknown,
  limit: { maxChars?: number; maxWords?: number } = {}): string[] {
  const maxChars = Number.isSafeInteger(limit.maxChars) && limit.maxChars! > 0 ? limit.maxChars! : HEADSET_SPEECH_MAX_CHARS;
  const maxWords = Number.isSafeInteger(limit.maxWords) && limit.maxWords! > 0 ? limit.maxWords! : HEADSET_SPEECH_MAX_WORDS;
  const full = normalizeHeadsetCaption(value);
  if (!full) return [];
  const segments: string[] = [];
  let current = '';
  for (const sentence of full.split(SENTENCE_BREAK)) {
    if (!sentence) continue;
    for (const piece of cutSentence(sentence, maxChars, maxWords)) {
      const merged = current ? `${current} ${piece}` : piece;
      if (current && (merged.length > maxChars || wordsOf(merged).length > maxWords)) {
        segments.push(current);
        current = piece;
      } else current = merged;
    }
  }
  if (current) segments.push(current);
  return segments;
}

export const sayToHeadsetSchema = z.object({
  commandId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  utteranceId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  // The bound is on the whole answer, and it is a refusal that names itself.
  // A reply past it is never shortened behind the agent's back.
  text: z.string().min(1)
    .max(HEADSET_REPLY_MAX_CHARS,
      `One reply is at most ${HEADSET_REPLY_MAX_CHARS} characters. Say the rest in a second say_to_headset call.`)
    .refine(value => normalizeHeadsetCaption(value).length > 0, 'The reply must contain readable text.')
    .refine(value => headsetSpeechWords(value) <= HEADSET_REPLY_MAX_WORDS,
      `One reply is at most ${HEADSET_REPLY_MAX_WORDS} words. Say the rest in a second say_to_headset call.`),
  speak: z.boolean().optional(),
  holdSeconds: z.number().int().min(HEADSET_CAPTION_MIN_HOLD_SECONDS).max(HEADSET_CAPTION_MAX_HOLD_SECONDS).optional(),
  /**
   * This reply IS a refusal, of a request that never reached a tool.
   *
   * A dispatched mutation that is refused already writes an outcome record and
   * draws a refusal card, because every registered tool's handler is wrapped.
   * A request the loopback agent refused BEFORE dispatch — an insecure URL, a
   * paste past the size bound — was never a tool call, so the wearer who asked
   * for it saw nothing at all while the sentence went to the terminal
   * This field is how that caller
   * hands the refusal back to the same delivery path: `tool` is the tool the
   * request was for, and `sessionId` is what scopes the card to the scene the
   * wearer is looking at. Omit `sessionId` and the refusal is still recorded
   * and still drawn, scoped only to its utterance.
   *
   * A refusal is never spoken and never consumes a reply turn, exactly as a
   * host-raised refusal is not and does not.
   */
  refusal: z.object({
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    sessionId: z.string().uuid().optional(),
  }).strict().optional(),
}).strict();
export type SayToHeadsetInput = z.output<typeof sayToHeadsetSchema>;

/**
 * A clip of the reply rendered on the Mac, delivered inline with the caption.
 *
 * Quest Browser has no `speechSynthesis` voice, so the page cannot make sound
 * from text alone. The queue carries the bytes rather than a URL: a clip of a
 * short sentence is a few tens of kilobytes, and inline delivery works over
 * the loopback companion and the private Wi-Fi listener without either of them
 * growing a second authenticated route.
 */
export type HeadsetCaptionAudio = {
  base64: string;
  mimeType: string;
  format: string;
  bytes: number;
  voice?: string;
  /** The clip's measured length, where the encoder could read one off the container. */
  seconds?: number;
};

/**
 * One consecutive piece of a long reply.
 *
 * The page draws `text` on the caption row, plays `audio`, and only then moves
 * to the next index. `seconds` is the clip's own length where the encoder
 * could measure it and an estimate otherwise; the page uses it as the timeout
 * that keeps a clip which never reports its end from stalling the rest.
 */
export type HeadsetCaptionSegment = {
  index: number;
  text: string;
  audio?: HeadsetCaptionAudio;
  seconds?: number;
};

export type HeadsetCaption = {
  commandId?:string; utteranceId?:string;
  /** Safe diagnostic identity for scoped and unscoped refusal delivery. */
  refusal?: { tool: string; reason: string; origin?: 'pre-dispatch' };
  /**
   * Host refusal scope; ordinary replies retain their existing unbound behavior.
   *
   * `sourceToken` binds the card to the structure the refused command was
   * dispatched against, and is set only when there was such a command. A
   * refusal raised before dispatch answers a request that never named a
   * source, so it carries no token and survives a source rotation; the session
   * and the refusal serial remain its binding.
   */
  refusalScope?: { sessionId: string; sourceToken?: string; panelId?: string; serial: number;
    /** A refused correction retains its recorded ID but explains itself in this turn. */
    activeUtteranceId?: string };
  id: string;
  seq: number;
  text: string;
  /**
   * The caption this entry is the spoken copy of.
   *
   * A reply is queued before its speech exists, so the wearer reads it on the
   * next heartbeat instead of waiting out a narration round trip. Clips that
   * arrive after a page has already taken the silent caption cannot be hung on
   * it, so they ride a second entry carrying the same words, which names the
   * caption it speaks for.
   */
  voiceFor?: string;
  /** The complete spoken text; `text` remains the complete caption. */
  speechText?: string;
  truncated?: boolean;
  speak: boolean;
  holdSeconds: number;
  createdAt: number;
  audio?: HeadsetCaptionAudio;
  /**
   * The reply in playback order. A page that understands segments plays these
   * and ignores `audio`, which stays the first segment's clip so a page that
   * predates segments still makes the sound it always did.
   */
  segments?: HeadsetCaptionSegment[];
  segmentCount?: number;
};

/**
 * What a new reply cuts short.
 *
 * A reply that arrives while an older multi-segment one is still playing takes
 * the caption row, and the page drops whatever of the older answer had not
 * started. This is that fact, derived on this Mac from when the page took the
 * older reply and how long each of its segments runs, so the new receipt can
 * say what the wearer will not hear.
 */
export type HeadsetReplyInterruption = {
  captionId: string;
  segments: number;
  playedSegments: number;
  droppedSegments: number;
  playedSeconds: number;
  totalSeconds: number;
};

export type HeadsetCaptionRejection = {
  captionId: string; utteranceId: string; activeUtteranceId: string | null; stale: true;
};

/**
 * The card a new caption takes the plate away from.
 *
 * `interrupted()` answers only for a spoken reply, because only a spoken reply
 * has segments left unheard. A refusal card is never spoken and still occupies
 * the plate for its whole hold, so a reply that lands on top of one retires it
 * early and the receipt has to be able to say so. This is that fact, measured
 * from when a page took the card rather than from when it was queued.
 */
export type HeadsetCaptionRetirement = {
  captionId: string;
  kind: 'refusal' | 'reply';
  /** How long the card asked for, in milliseconds. */
  holdMs: number;
  /** How long it had actually been on the plate. */
  shownMs: number;
};

/** Which part of a refusal's scope the claiming panel no longer matches. */
export type HeadsetCaptionScopeMismatch = 'session' | 'source' | 'panel' | 'serial';

/**
 * A scoped refusal a connected wearer panel stepped over.
 *
 * The queue holds a refusal until one of its wearer's pages takes it, so a
 * card nobody takes is indistinguishable from one that is merely waiting. This
 * is the distinction: a panel read this entry and its scope no longer named
 * that panel's session, source, page or request, so the card will never be
 * drawn and the caller can be told why instead of being told it is queued.
 */
export type HeadsetCaptionScopeMiss = {
  captionId: string; sessionId: string; mismatch: readonly HeadsetCaptionScopeMismatch[];
};

export type HeadsetCaptionQueue = {
  /** Queue one reply for every companion page currently connected. */
  say(input: SayToHeadsetInput, extra?: {
    audio?: HeadsetCaptionAudio; id?: string; segments?: readonly HeadsetCaptionSegment[];
    refusalScope?: HeadsetCaption['refusalScope'];
    refusal?: HeadsetCaption['refusal'];
    voiceFor?: string;
  }): HeadsetCaption;
  /**
   * Hang rendered speech on a caption no page has taken yet.
   *
   * True when the clips joined the caption already queued, so the wearer reads
   * and hears one entry. False when a page took the silent caption first, and
   * the caller has to send the spoken copy as its own entry.
   */
  attachSpeech(id: string, segments: readonly HeadsetCaptionSegment[]): boolean;
  /**
   * Take back a caption no page has taken, and say whether it was still there.
   *
   * False means a page already has it: the words are on the plate and the only
   * honest thing left is to report that they were drawn.
   */
  withdraw(id: string): boolean;
  /**
   * The card still inside its hold on the plate, or undefined when the plate
   * is idle. Read it before queueing the caption that will replace it.
   */
  retiring(): HeadsetCaptionRetirement | undefined;
  /**
   * The spoken reply a new one would cut short, or undefined when nothing is
   * still running. Read it before queueing the replacement.
   */
  interrupted(): HeadsetReplyInterruption | undefined;
  /** Revalidate bound replies against this panel, skipping stale entries and advancing its cursor. */
  claim(panelId: string, binding?: {
    activeUtteranceId?: string;
    sessionId?: string; sourceToken?: string; refusalSerial?: number;
    onStale?: (receipt: HeadsetCaptionRejection) => void;
    /** Called for every scoped refusal this panel stepped over, and why. */
    onScopeMiss?: (miss: HeadsetCaptionScopeMiss) => void;
  }): HeadsetCaption | undefined;
  /** How many panels have taken this caption. */
  deliveries(id: string): number;
  /** Resolves true as soon as one panel takes the caption, false at the deadline. */
  waitForDelivery(id: string, timeoutMs: number): Promise<boolean>;
  /** Number of panels currently connected to this queue. */
  panels(): number;
  size(): number;
};

/**
 * A bounded, source-independent caption mailbox.
 *
 * "the companion pages that are already polling" now
 * means both of the wearer's pages. The full Mol* viewer registers as a panel
 * with surface `detailed` and heartbeats like any other, so it is offered the
 * same captions and plays the same clip on its own status line. That is what
 * makes a question asked inside the full viewer answerable inside it, instead
 * of only after the wearer has been brought home. A desktop panel is still
 * offered nothing, because it would take the reply and draw none of it.
 *
 * It is deliberately not scoped to a session or a source token: `say_to_headset`
 * carries no binding, for the same reason `listen_voice` carries none. The
 * wearer is talking to an agent, not to one saved inspection, and an agent that
 * has not opened a panel still has to be able to answer. Nothing here reads or
 * changes molecular state, so an unbound caption cannot move a scene.
 */
export function createHeadsetCaptionQueue({ now = Date.now, ttlMs = 60_000, maxPending = 8, maxPanels = 32 }: {
  now?: () => number; ttlMs?: number; maxPending?: number; maxPanels?: number;
} = {}): HeadsetCaptionQueue {
  if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1
    || !Number.isSafeInteger(maxPending) || maxPending < 1
    || !Number.isSafeInteger(maxPanels) || maxPanels < 1) {
    throw new TypeError('Headset caption queue requires bounded lifetime and capacity.');
  }
  let seq = 0;
  let entries: HeadsetCaption[] = [];
  const cursors = new Map<string, number>();
  const takenBy = new Map<string, Set<string>>();
  const waiters = new Map<string, Set<() => void>>();
  // The spoken reply the wearer is currently hearing, so the next one can
  // report what it cuts off. It holds no audio, only lengths.
  let running: { id: string; seconds: number[]; deliveredAt?: number } | undefined;
  // The card on the plate, spoken or not, so a reply that lands on top of a
  // refusal can report that it retired one. Silent cards have no segments to
  // lose, so `running` cannot carry them.
  let showing: { id: string; kind: 'refusal' | 'reply'; holdMs: number; deliveredAt?: number } | undefined;

  const prune = () => {
    const cutoff = now() - ttlMs;
    entries = entries.filter(entry => entry.createdAt > cutoff);
    while (entries.length > maxPending) entries.shift();
    const live = new Set(entries.map(entry => entry.id));
    for (const id of [...takenBy.keys()]) if (!live.has(id)) takenBy.delete(id);
  };
  const wake = (id: string) => {
    const listeners = waiters.get(id);
    if (!listeners) return;
    waiters.delete(id);
    for (const listener of listeners) { try { listener(); } catch { /* A waiter that throws must not block delivery. */ } }
  };

  return {
    say(input, extra) {
      prune();
      const text = normalizeHeadsetCaption(input.text);
      if (!text) throw Error('The reply must contain readable text.');
      const speak = input.speak ?? true;
      const speech = headsetSpeechLine(text);
      // A reply the agent asked not to be spoken never carries sound, however
      // the clip or the segments were produced.
      const segments = speak && extra?.segments?.length ? extra.segments.map(segment => ({ ...segment })) : undefined;
      // The first segment's clip stays on `audio` so a page that predates
      // segments plays the opening of the answer rather than nothing at all.
      const audio = speak ? (segments ? segments[0]?.audio : extra?.audio) : undefined;
      const caption: HeadsetCaption = {
        ...(extra?.voiceFor ? { voiceFor: extra.voiceFor } : {}),
        ...(extra?.refusal ? { refusal: { ...extra.refusal } } : {}),
        ...(extra?.refusalScope ? { refusalScope: { ...extra.refusalScope } } : {}),
        id: extra?.id ?? randomUUID(), seq: ++seq, text,
        speak,
        holdSeconds: input.holdSeconds ?? HEADSET_CAPTION_DEFAULT_HOLD_SECONDS,
        createdAt: now(),
        ...(input.commandId?{commandId:input.commandId}:{}),
        ...(input.utteranceId?{utteranceId:input.utteranceId}:{}),
        ...(speak ? segments
          ? { speechText: segments.map(segment => segment.text).join(' '), truncated: false }
          : { speechText:speech.text, truncated:speech.truncated } : {}),
        ...(audio ? { audio } : {}),
        ...(segments ? { segments, segmentCount: segments.length } : {}),
      };
      entries.push(caption);
      while (entries.length > maxPending) entries.shift();
      // A newer spoken reply owns the caption row from here, so whatever was
      // still running is no longer running.
      running = speak
        ? { id: caption.id, seconds: (segments ?? [{ index: 0, text: speech.text }])
            .map(segment => segment.seconds ?? estimateHeadsetSpeechSeconds(segment.text)) }
        : undefined;
      showing = { id: caption.id, kind: caption.refusal ? 'refusal' : 'reply',
        holdMs: Math.round(caption.holdSeconds * 1000) };
      return caption;
    },
    attachSpeech(id, segments) {
      const entry = entries.find(candidate => candidate.id === id);
      if (!entry || !entry.speak || !segments.length) return false;
      if ((takenBy.get(id)?.size ?? 0) > 0) return false;
      const copied = segments.map(segment => ({ ...segment }));
      entry.segments = copied;
      entry.segmentCount = copied.length;
      entry.speechText = copied.map(segment => segment.text).join(' ');
      entry.truncated = false;
      const opening = copied[0]?.audio;
      if (opening) entry.audio = opening; else delete entry.audio;
      // The measured clip lengths replace the estimate this reply was queued
      // with, so whatever interrupts it counts real seconds.
      if (running?.id === id) {
        running.seconds = copied.map(segment => segment.seconds ?? estimateHeadsetSpeechSeconds(segment.text));
      }
      return true;
    },
    withdraw(id) {
      const index = entries.findIndex(candidate => candidate.id === id);
      if (index < 0 || (takenBy.get(id)?.size ?? 0) > 0) return false;
      entries.splice(index, 1);
      takenBy.delete(id);
      if (running?.id === id) running = undefined;
      if (showing?.id === id) showing = undefined;
      return true;
    },
    retiring() {
      if (!showing || showing.deliveredAt === undefined) return undefined;
      const shownMs = Math.max(0, now() - showing.deliveredAt);
      if (shownMs >= showing.holdMs) return undefined;
      return { captionId: showing.id, kind: showing.kind, holdMs: showing.holdMs, shownMs };
    },
    interrupted() {
      if (!running || running.deliveredAt === undefined) return undefined;
      const elapsed = Math.max(0, (now() - running.deliveredAt) / 1000);
      let start = 0, playedSegments = 0;
      for (const seconds of running.seconds) {
        if (start <= elapsed) playedSegments++;
        start += seconds;
      }
      const droppedSegments = Math.max(0, running.seconds.length - playedSegments);
      if (droppedSegments < 1) return undefined;
      const tenths = (value: number) => Math.round(value * 10) / 10;
      return { captionId: running.id, segments: running.seconds.length, playedSegments, droppedSegments,
        playedSeconds: tenths(Math.min(elapsed, start)), totalSeconds: tenths(start) };
    },
    claim(panelId, binding) {
      prune();
      if (typeof panelId !== 'string' || !panelId) return undefined;
      const cursor = cursors.get(panelId);
      if (cursor === undefined) {
        // A page that has only just connected is not owed an answer given
        // before it existed. It starts from now and receives the next one.
        cursors.set(panelId, seq);
        while (cursors.size > maxPanels) cursors.delete(cursors.keys().next().value!);
        return undefined;
      }
      let next: HeadsetCaption | undefined;
      for (const entry of entries) {
        if (entry.seq <= cursor) continue;
        cursors.set(panelId, entry.seq);
        const scope = entry.refusalScope;
        if (scope) {
          // A scope with no source token was never bound to one, so a source
          // rotation is not a reason to step over it.
          const mismatch: HeadsetCaptionScopeMismatch[] = [];
          if (scope.sessionId !== binding?.sessionId) mismatch.push('session');
          if (scope.sourceToken !== undefined && scope.sourceToken !== binding?.sourceToken) mismatch.push('source');
          if (scope.panelId && scope.panelId !== panelId) mismatch.push('panel');
          if (scope.serial !== binding?.refusalSerial) mismatch.push('serial');
          if (mismatch.length) {
            binding?.onScopeMiss?.({ captionId: entry.id, sessionId: scope.sessionId, mismatch });
            continue;
          }
        }
        const replyOwner=scope?.activeUtteranceId ?? entry.utteranceId;
        if (entry.utteranceId && replyOwner !== binding?.activeUtteranceId) {
          binding?.onStale?.({ captionId: entry.id, utteranceId: entry.utteranceId,
            activeUtteranceId: binding?.activeUtteranceId ?? null, stale: true });
          continue;
        }
        next = entry;
        break;
      }
      if (!next) return undefined;
      const taken = takenBy.get(next.id) ?? new Set<string>();
      const first = taken.size === 0;
      taken.add(panelId);
      takenBy.set(next.id, taken);
      // Playback starts when the first page takes the reply, which is the only
      // moment this Mac can tie an elapsed second to a spoken one.
      if (first && running?.id === next.id && running.deliveredAt === undefined) running.deliveredAt = now();
      if (first && showing?.id === next.id && showing.deliveredAt === undefined) showing.deliveredAt = now();
      wake(next.id);
      return next;
    },
    deliveries(id) { return takenBy.get(id)?.size ?? 0; },
    waitForDelivery(id, timeoutMs) {
      if ((takenBy.get(id)?.size ?? 0) > 0) return Promise.resolve(true);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(false);
      return new Promise<boolean>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const listener = () => { if (timer) clearTimeout(timer); resolve(true); };
        const listeners = waiters.get(id) ?? new Set<() => void>();
        listeners.add(listener);
        waiters.set(id, listeners);
        timer = setTimeout(() => {
          waiters.get(id)?.delete(listener);
          resolve((takenBy.get(id)?.size ?? 0) > 0);
        }, timeoutMs);
        // A pending answer must never hold the process open by itself.
        (timer as any)?.unref?.();
      });
    },
    panels() { return cursors.size; },
    size() { prune(); return entries.length; },
  };
}
