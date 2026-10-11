/**
 * Which assistant is listening to the wearer right now.
 *
 * Two hosts can now share one scene on this Mac. That is the point of the
 * scene service beside this file, and it creates a problem the transcript
 * queue never had to solve: the queue is a broadcast log, so two listeners
 * holding the same cursor both receive the same utterance and both act on it.
 * The wearer says "colour the guide RNA orange" once and two assistants paint
 * it, each unaware of the other.
 *
 * This module is the missing claim. Exactly one attached assistant is the
 * active listener. Only that one is handed an utterance, each utterance is
 * handed out once, and the floor changes hands only when someone says so: by
 * the wearer's own words, or by a tool call. Sitting quiet does not lose it.
 * An assistant that is not attached here changes nothing at all, which is what
 * keeps a single-host Mac working exactly as it did.
 */
import { randomUUID } from 'node:crypto';

/** Long enough for "Claude in Claude Code", short enough to say out loud. */
export const ASSISTANT_LABEL_MAX = 40;
/** How many attached assistants one Mac keeps. Two is the real case. */
export const MAX_ATTACHED_ASSISTANTS = 8;
/** How many utterance claims are remembered, so a replayed cursor stays quiet. */
export const CLAIM_HISTORY = 256;

export type AssistantRecord = {
  id: string;
  label: string;
  attachedAt: number;
  /** When this assistant last took an utterance. Never used to take the floor away. */
  heardAt?: number;
};

/** One thing the wearer said, as the queue records it. */
export type ClaimableUtterance = { id: string; text: string; cursor?: number };

export type Handover = { from: string; to: string; by: 'phrase' | 'tool'; spoken: string };

export type ClaimResult = {
  /** Who holds the floor after this claim. */
  active?: AssistantRecord;
  /** What this caller may act on. Empty for everyone but the active assistant. */
  delivered: ClaimableUtterance[];
  /** The highest cursor this claim consumed, so the caller does not re-read it. */
  cursor?: number;
  handover?: Handover;
};

/** Trim a spoken or typed assistant name into the one this module stores. */
export function normalizeAssistantLabel(label: string): string {
  const value = String(label ?? '').replace(/\s+/gu, ' ').trim();
  if (!value) throw Error('Name the assistant taking part, such as "Claude" or "Codex".');
  if (value.length > ASSISTANT_LABEL_MAX) throw Error(`An assistant name is at most ${ASSISTANT_LABEL_MAX} characters.`);
  return value;
}

const TRAILING = /\s+(?:please|now|instead|thanks|thank you)$/u;
const LEADING = /^(?:hey|ok|okay|hi)\s+/u;

/**
 * The wearer's own way of changing who is listening.
 *
 * Only an explicit switch counts. "Ask Codex about the PAM" is a question for
 * whoever holds the floor, not a handover, so nothing here matches a bare
 * mention of a name. The verb has to be there.
 */
const SWITCH_PATTERNS: readonly RegExp[] = [
  /^switch(?:\s+over)?\s+to\s+(.+)$/u,
  /^hand(?:\s+it|\s+this)?\s+(?:over|off)\s+to\s+(.+)$/u,
  /^hand\s+over\s+to\s+(.+)$/u,
  /^give\s+(?:the\s+)?(?:floor|controls?|mic|microphone)\s+to\s+(.+)$/u,
  /^let\s+(.+?)\s+take\s+(?:over|it|this)$/u,
  /^(.+?),?\s+take\s+over$/u,
  /^talk\s+to\s+(.+)$/u,
  /^put\s+(.+?)\s+on$/u,
];

/**
 * The assistant name a spoken line hands the floor to, or nothing.
 *
 * The answer is a name, not a decision: the caller still has to find an
 * attached assistant by that name, and an unmatched name leaves the utterance
 * an ordinary request.
 */
export function switchTarget(text: string): string | undefined {
  const spoken = String(text ?? '').toLowerCase().replace(/[.!?,;:]+$/u, '').replace(/\s+/gu, ' ').trim().replace(LEADING, '');
  if (!spoken) return undefined;
  for (const pattern of SWITCH_PATTERNS) {
    const match = pattern.exec(spoken);
    if (!match) continue;
    const named = match[1].replace(TRAILING, '').replace(/^(?:the|my)\s+/u, '').replace(/[.!?,;:]+$/u, '').trim();
    if (named && named.length <= ASSISTANT_LABEL_MAX) return named;
  }
  return undefined;
}

/** The one short line a handover is worth saying out loud. */
export function handoverLine(label: string): string {
  return `${label} has the floor now.`;
}

export type AssistantOwnership = ReturnType<typeof createAssistantOwnership>;

export function createAssistantOwnership({ now = Date.now, claimHistory = CLAIM_HISTORY }: { now?: () => number; claimHistory?: number } = {}) {
  const byId = new Map<string, AssistantRecord>();
  const claimed = new Set<string>();
  let activeId: string | undefined;

  const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  const find = (name: string): AssistantRecord | undefined => {
    const wanted = String(name ?? '').replace(/\s+/gu, ' ').trim();
    if (!wanted) return undefined;
    return byId.get(wanted) ?? [...byId.values()].find(record => sameName(record.label, wanted));
  };
  const note = (utteranceId: string) => {
    claimed.add(utteranceId);
    while (claimed.size > claimHistory) {
      const oldest = claimed.values().next().value;
      if (oldest === undefined) break;
      claimed.delete(oldest);
    }
  };
  const publicRecord = (record: AssistantRecord) => ({ ...record, active: record.id === activeId });

  return {
    get size() { return byId.size; },
    /** Whether anything here applies at all. A Mac with no attached assistant is untouched. */
    engaged() { return byId.size > 0; },
    active(): AssistantRecord | undefined { return activeId === undefined ? undefined : byId.get(activeId); },
    list() {
      return { active: this.active()?.label ?? null, attached: [...byId.values()].map(publicRecord) };
    },
    /**
     * Register one assistant, by the name a person would say.
     *
     * Attaching again under the same name is the same assistant coming back,
     * not a second one: a host that restarts keeps its identity and, if it had
     * the floor, keeps that too.
     */
    attach({ label, id }: { label: string; id?: string }) {
      const name = normalizeAssistantLabel(label);
      const known = find(name);
      if (known) {
        known.attachedAt = now();
        known.label = name;
        if (activeId === undefined) activeId = known.id;
        return publicRecord(known);
      }
      if (byId.size >= MAX_ATTACHED_ASSISTANTS) {
        const oldest = [...byId.values()].filter(record => record.id !== activeId).sort((a, b) => a.attachedAt - b.attachedAt)[0];
        if (!oldest) throw Error('Too many assistants are attached to this scene.');
        byId.delete(oldest.id);
      }
      const record: AssistantRecord = { id: id ?? randomUUID(), label: name, attachedAt: now() };
      byId.set(record.id, record);
      if (activeId === undefined) activeId = record.id;
      return publicRecord(record);
    },
    /** Hand the floor to a named assistant. An unknown name is refused by name. */
    handOver(name: string, { by = 'tool' as 'phrase' | 'tool' } = {}): Handover & { changed: boolean } {
      const target = find(name);
      if (!target) {
        const attached = [...byId.values()].map(record => record.label);
        throw Error(attached.length
          ? `No assistant called "${name}" is here. Attached now: ${attached.join(', ')}.`
          : `No assistant called "${name}" is here, and none is attached to this scene.`);
      }
      const from = this.active()?.label ?? 'nobody';
      const changed = target.id !== activeId;
      activeId = target.id;
      return { from, to: target.label, by, spoken: handoverLine(target.label), changed };
    },
    /** Let an assistant go. The floor passes to whoever attached most recently. */
    detach(name: string) {
      const record = find(name);
      if (!record) return { detached: false, active: this.active()?.label ?? null };
      byId.delete(record.id);
      if (activeId === record.id) {
        activeId = [...byId.values()].sort((a, b) => b.attachedAt - a.attachedAt)[0]?.id;
      }
      return { detached: true, active: this.active()?.label ?? null };
    },
    /**
     * Hand out what the wearer said, once.
     *
     * The active assistant receives every utterance nobody has taken yet. Any
     * other caller receives none, and is told who is listening instead. A
     * spoken switch is consumed rather than delivered: it changed who is
     * listening, so it is not also a molecular request, and everything after it
     * in the same batch is left for the assistant that just took the floor.
     */
    claim({ assistant, utterances }: { assistant?: string; utterances: readonly ClaimableUtterance[] }): ClaimResult {
      const active = this.active();
      if (!active) return { delivered: [...utterances] };
      const caller = assistant === undefined ? undefined : find(assistant);
      if (!caller || caller.id !== active.id) return { delivered: [], active };
      const delivered: ClaimableUtterance[] = [];
      let cursor: number | undefined;
      let handover: Handover | undefined;
      for (const utterance of utterances) {
        if (utterance.cursor !== undefined) cursor = utterance.cursor;
        if (claimed.has(utterance.id)) continue;
        const named = switchTarget(utterance.text);
        const target = named === undefined ? undefined : find(named);
        if (target) {
          note(utterance.id);
          const moved = this.handOver(target.label, { by: 'phrase' });
          handover = { from: moved.from, to: moved.to, by: 'phrase', spoken: moved.spoken };
          break;
        }
        note(utterance.id);
        delivered.push(utterance);
      }
      active.heardAt = now();
      return { delivered, active: this.active(), ...(cursor === undefined ? {} : { cursor }), ...(handover ? { handover } : {}) };
    },
  };
}
