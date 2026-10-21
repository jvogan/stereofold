import type { TranscriptQueue, TranscriptRecord } from './push-to-talk-transcribe.js';

export const HEADSET_CHANNEL_METHOD = 'notifications/claude/channel';
export type ChannelTranscript = TranscriptRecord & { cursor: number; sessionId: string; panelId: string };
export type ChannelDelivery = { state: 'pushed'; assistant: string; acknowledgement: 'unavailable' };
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Scene-owned reservations. A push is an attempt, never a host acknowledgement. */
export function createHeadsetChannel({ queue, active, linked, claim, wake, now = Date.now }: {
  queue: TranscriptQueue;
  active: () => string | undefined;
  linked: (entry: TranscriptRecord) => Promise<ChannelTranscript | undefined>;
  claim: (assistant: string, entry: ChannelTranscript) => boolean;
  wake: () => void;
  now?: () => number;
}) {
  const records = new Map<string, { owner?: string; entry: Promise<ChannelTranscript | undefined>;
    delivery?: ChannelDelivery; recovered?: boolean }>();
  const leases = new Map<string, { sessionId: string; at: number }>();
  const off = queue.subscribe?.(entry => {
    // The headset page acts on these words itself; handing them over too would do it twice.
    if (records.has(entry.utteranceId) || entry.headsetAction) return;
    // Pin ownership when recognition finishes, before an asynchronous scene read.
    records.set(entry.utteranceId, { owner: active(), entry: linked(entry).catch(() => undefined) });
    while (records.size > 256) records.delete(records.keys().next().value!);
    wake();
  }) ?? (() => {});
  return {
    close() { off(); leases.clear(); },
    active(sessionId: string) {
      const owner = active();
      const lease = owner ? leases.get(owner.toLowerCase()) : undefined;
      return !!lease && lease.sessionId === sessionId && now() - lease.at < 2_000;
    },
    async take(assistant: string, sessionId: string) {
      if (!same(assistant, active())) return [];
      leases.set(assistant.toLowerCase(), { sessionId, at: now() });
      const delivered: ChannelTranscript[] = [];
      for (const record of records.values()) {
        if (record.delivery || !same(record.owner, assistant)) continue;
        const entry = await record.entry;
        // Recheck after every await and against the current headset binding.
        if (!entry || entry.sessionId !== sessionId || !same(active(), assistant)) continue;
        if (!await linked(entry) || !same(active(), assistant) || record.delivery) continue;
        if (!claim(assistant, entry)) continue;
        record.delivery = { state: 'pushed', assistant, acknowledgement: 'unavailable' };
        delivered.push(entry);
      }
      return delivered;
    },
    /** One recovery read per pushed ID, even if the caller replays its cursor. */
    recover(assistant: string | undefined, entries: readonly (TranscriptRecord & { cursor: number })[]) {
      if (!same(assistant, active())) return [];
      return entries.flatMap(entry => {
        const record = records.get(entry.utteranceId);
        if (!record?.delivery || record.recovered || !same(record.owner, assistant)) return [];
        record.recovered = true;
        return [{ ...entry, channelDelivery: record.delivery, alreadyDelivered: true }];
      });
    },
  };
}

export function headsetChannelParams(entry: ChannelTranscript) {
  return { content: entry.text, meta: {
    source_kind: 'stereofold-headset', utterance_id: entry.utteranceId,
    session_id: entry.sessionId, panel_id: entry.panelId, received_at: entry.receivedAt,
    ...(entry.referent ? { referent: JSON.stringify(entry.referent) } : {}),
  } };
}
