import { z } from 'zod';

/**
 * The Mac's half of the headset's return channel.
 *
 * The companion page keeps a small ring buffer of what actually happened
 * inside the headset (`headset-diagnostics.mjs`) and drains it onto the
 * `poll_inspection` heartbeat it already runs. This module holds what arrives,
 * so an agent on this Mac can read the real device's log with `read_headset_log`
 * instead of guessing from a silent page.
 *
 * The store is deliberately small and in memory only. It is a debugging
 * window on a live session, not a record: nothing is written to disk, nothing
 * survives the process, and no entry may carry a pairing code, bearer token,
 * device key or companion URL. Entries are shallow, bounded and validated
 * before they are kept, and the page never sends anything else.
 */

/** How many entries the Mac keeps for one connected page. */
export const MAX_DIAGNOSTICS_PER_CLIENT = 500;
/** How many pages may report at once before the oldest is forgotten. */
export const MAX_DIAGNOSTICS_CLIENTS = 8;
/** Most entries one heartbeat may carry. Matches the page's own drain cap. */
export const MAX_DIAGNOSTICS_BATCH = 24;
/** Longest string any detail field may carry. */
export const MAX_DIAGNOSTIC_STRING = 200;
/** Default and ceiling for one `read_headset_log` page. */
export const READ_HEADSET_LOG_DEFAULT_LIMIT = 100;
export const READ_HEADSET_LOG_MAX_LIMIT = 500;
/** Kinds that count as a failure the wearer would have noticed. */
export const DIAGNOSTIC_ERROR_KINDS = Object.freeze(['page-error', 'unhandled-rejection', 'voice-error', 'toolbar-error', 'xr-frame-error']);
/**
 * Most fields one object inside a detail may carry. Equal to the page's
 * `MAX_DETAIL_KEYS` (lab/browser-roundtrip/headset-diagnostics.mjs),
 * and the test suite pins the two together: the layout record now carries
 * its solver inputs and search summary beside its outputs, and a record the
 * page keeps but this schema refuses is salvaged below as `unreadable`.
 */
export const MAX_DIAGNOSTIC_FIELDS = 40;

/** Most items in a detail array. Matches the page, including all plate rectangles. */
export const MAX_DIAGNOSTIC_ITEMS = 32;

const detailString = z.string().max(MAX_DIAGNOSTIC_STRING);
const detailScalar = z.union([detailString, z.number().finite(), z.boolean(), z.null()]);
const boundedFields = <T extends z.ZodTypeAny>(schema: T) => schema.refine(
  value => Object.keys(value as object).length <= MAX_DIAGNOSTIC_FIELDS,
  `A diagnostic object carries at most ${MAX_DIAGNOSTIC_FIELDS} fields.`);
/**
 * One nested object, because the page can already record one.
 *
 * `sanitizeDetail` in the page's own `headset-diagnostics.mjs` walks a detail
 * to depth four — `detail.frame.menu.rect.left` — and drops anything deeper.
 * This schema stopped at two, then at three; framefix3 records
 * `frame.menu = {rect, move, cleared}` and `frame.share = {whole, lit}` at
 * the same depth as `frame.caption`, and `rect` is one object inside `menu`.
 * The two halves of one contract must agree on that shape. A `plate-standoff`
 * entry recorded with a `frame: {subject:{…},
 * plate:{…}}` cost the wearer the agent: `poll_inspection`
 * rejects the whole heartbeat when any entry fails, the page never got an
 * acknowledgement so it re-sent the same entry every second, and the Mac's
 * panel snapshot went stale in twelve seconds — the tour step ended in "No
 * panel is showing this inspection" while the headset sat there presenting
 * The depths now match, and
 * `salvageDiagnosticEntry` below makes any future disagreement cost one log
 * line rather than the session.
 */
const detailLeaf = boundedFields(z.record(detailString, detailScalar));
/**
 * The menu record, because the page records one.
 *
 * `recordStandoff` in the page's `viewer.mjs` writes
 * `frame.menu = {rect, move, cleared, ghost}` and
 * `frame.menu.ghost = {crossed, cleared}`. The page sanitiser keeps both —
 * `ghost` is an object at the same depth `rect` already was, and its fields
 * are scalars one level down — but this schema stopped `frame`'s values at one
 * flat object. The two halves disagreed on exactly one shape, the 913ec77
 * failure all over again, so `frame` now takes a menu-shaped value beside a
 * flat one. Anything deeper than `ghost`'s scalars is still refused below.
 */
const detailMenu = boundedFields(z.record(detailString, z.union([detailScalar, detailLeaf])));
/**
 * The `frame` value, because the page records a menu in it.
 *
 * `recordStandoff` in the page's `viewer.mjs` writes
 * `frame.menu = {rect, move, cleared, ghost}` and
 * `frame.menu.ghost = {crossed, cleared}`. The page sanitiser keeps both —
 * `ghost` is an object at the same depth `rect` already was, and its fields
 * are scalars one level down — but the generic value below stopped at one
 * flat object. The two halves disagreed on exactly one shape, the 913ec77
 * failure all over again. The deeper shape is scoped to this key alone, so
 * the depth guard the schema tests pin down holds everywhere else: anything
 * deeper than `ghost`'s scalars is still refused, at this key too.
 */
const frameDetailValue = boundedFields(z.record(detailString, z.union([detailScalar, detailLeaf, detailMenu])));
const detailNested = boundedFields(z.record(detailString, z.union([detailScalar, detailLeaf])));
const detailValue: z.ZodType<unknown> = z.union([
  detailScalar,
  z.array(z.union([detailScalar, detailLeaf])).max(MAX_DIAGNOSTIC_ITEMS),
  boundedFields(z.record(detailString, z.union([detailScalar, z.array(detailScalar).max(MAX_DIAGNOSTIC_ITEMS),
    detailNested]))),
]);

export const diagnosticKindSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u);
/** One entry exactly as the page recorded it. `seq` is the page's own counter. */
export const diagnosticEntrySchema = z.object({
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  kind: diagnosticKindSchema,
  detail: boundedFields(z.object({
    frame: frameDetailValue.nullable().optional(),
    // Audio-start evidence matches loop-timing.mjs, including replies without IDs.
    spokenText: detailString.optional(),
    spokenWords: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    // Whether a plate state commit took Mol*'s shape-geometry path.
    geometry: z.boolean().optional(),
    // Room-metre translation of the head-seated reply after binocular clearance.
    replyOffset: z.array(z.number().finite()).superRefine((v, ctx) => { if (v.length !== 3) ctx.addIssue({ code: 'custom', message: 'Expected exactly 3 values.' }); }).transform(v => v as [number, number, number]).optional(),
    // Entry menu-to-lit-silhouette gaps in each eye's tangent coordinates.
    clearanceLeft: z.number().finite().optional(),
    clearanceRight: z.number().finite().optional(),
  }).catchall(detailValue)),
}).strict();
export type DiagnosticEntry = z.output<typeof diagnosticEntrySchema>;

/** What one heartbeat carries: only the entries the desktop has not acknowledged. */
export const headsetDiagnosticsBatchSchema = z.object({
  entries: z.array(diagnosticEntrySchema).min(1).max(MAX_DIAGNOSTICS_BATCH),
}).strict();

/**
 * The heartbeat's own batch, which is never allowed to fail.
 *
 * The batch above says what a well-formed entry is. This one says what the
 * HEARTBEAT does with a malformed one, and the two are deliberately different:
 * a heartbeat carries the panel's availability, its tour state and its
 * spatial context, and a page whose heartbeat is refused stops existing as far
 * as the agent is concerned. Nothing in a log line is worth that, so the
 * entries arrive unvalidated here and are salvaged one at a time below.
 */
export const heartbeatDiagnosticsBatchSchema = z.object({
  entries: z.array(z.unknown()).min(1).max(MAX_DIAGNOSTICS_BATCH),
}).strict();

/** What replaces a detail the contract cannot carry: the fact that there was one. */
export const UNREADABLE_DIAGNOSTIC_DETAIL = Object.freeze({ unreadable: true });

/**
 * One entry, or the nearest thing to it this Mac can keep.
 *
 * A well-formed entry is returned unchanged. One the contract cannot carry
 * keeps its sequence, its time and its kind — everything the acknowledgement
 * and the log's shape depend on — and loses only its detail, so the page's
 * cursor still advances and the entry never comes back. An entry without a
 * usable sequence is dropped: there is nothing to acknowledge and nothing to
 * order it by.
 */
export function salvageDiagnosticEntry(value: unknown): DiagnosticEntry | undefined {
  const parsed = diagnosticEntrySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const seq = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse(raw.seq);
  const at = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).safeParse(raw.at);
  if (!seq.success || !at.success) return undefined;
  const kind = diagnosticKindSchema.safeParse(raw.kind);
  return { seq: seq.data, at: at.data, kind: kind.success ? kind.data : 'unreadable',
    detail: { ...UNREADABLE_DIAGNOSTIC_DETAIL } };
}

/** Every entry of one heartbeat batch that this Mac can keep, in the order sent. */
export function salvageDiagnosticEntries(entries: readonly unknown[]): DiagnosticEntry[] {
  if (!Array.isArray(entries)) return [];
  const kept: DiagnosticEntry[] = [];
  for (const entry of entries) {
    const salvaged = salvageDiagnosticEntry(entry);
    if (salvaged) kept.push(salvaged);
  }
  return kept;
}

export const readHeadsetLogSchema = z.object({
  sinceSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(READ_HEADSET_LOG_MAX_LIMIT).optional(),
  kind: diagnosticKindSchema.optional(),
  // The log belongs to the headset, not to one saved inspection, so nothing
  // here is session-scoped. The standalone host's loopback agent route stamps
  // its current session onto every call it forwards, so the field is accepted
  // and ignored rather than turning that route into a validation error.
  sessionId: z.string().max(128).optional(),
}).strict();
export type ReadHeadsetLogInput = z.output<typeof readHeadsetLogSchema>;

/** One stored entry. `sequence` is this Mac's cursor; `seq` stays the page's. */
export type StoredDiagnostic = {
  sequence: number;
  clientId: string;
  seq: number;
  at: number;
  receivedAt: number;
  kind: string;
  detail: Record<string, unknown>;
};

export type HeadsetDiagnosticsSummary = {
  clients: number;
  entries: number;
  cursor: number;
  dropped: number;
  counts: Record<string, number>;
  lastError: { at: number; kind: string; detail: Record<string, unknown> } | null;
  device: Record<string, unknown> | null;
  lastEntryAt: number | null;
};

export type HeadsetDiagnosticsStore = {
  /** Take one heartbeat batch. Returns the page sequence to acknowledge. */
  ingest(clientId: string, entries: readonly DiagnosticEntry[]): { accepted: number; ack: number };
  /** Entries this Mac holds after `sinceSequence`, oldest first. */
  read(input?: ReadHeadsetLogInput): { entries: StoredDiagnostic[]; cursor: number; more: boolean };
  /** Counts by kind, the last failure, and what the device said about itself. */
  summary(): HeadsetDiagnosticsSummary;
  /** Forget everything one page reported, on detach or disconnect. */
  forget(clientId: string): void;
  size(): number;
  cursor(): number;
};

/**
 * Hold what the headset reports, bounded per page.
 *
 * A page identifies itself by its server-issued panel ID, which is the only
 * client identity that reaches the tool layer: the LAN pairing client ID lives
 * one hop lower, inside the proxy, and is never carried on a tool call.
 */
export function createHeadsetDiagnosticsStore({ now = Date.now, maxPerClient = MAX_DIAGNOSTICS_PER_CLIENT,
  maxClients = MAX_DIAGNOSTICS_CLIENTS }: { now?: () => number; maxPerClient?: number; maxClients?: number } = {}): HeadsetDiagnosticsStore {
  if (typeof now !== 'function' || !Number.isSafeInteger(maxPerClient) || maxPerClient < 1
    || !Number.isSafeInteger(maxClients) || maxClients < 1) {
    throw new TypeError('The headset diagnostics store requires bounded capacity.');
  }
  const clients = new Map<string, { entries: StoredDiagnostic[]; lastSeq: number; dropped: number }>();
  let cursor = 0;
  let device: Record<string, unknown> | null = null;

  const clientFor = (clientId: string) => {
    let client = clients.get(clientId);
    if (!client) {
      client = { entries: [], lastSeq: 0, dropped: 0 };
      clients.set(clientId, client);
      // The oldest reporting page is forgotten first. A stale panel that never
      // detached must not keep a live headset's log out of memory.
      while (clients.size > maxClients) {
        const oldest = clients.keys().next().value;
        if (oldest === undefined || oldest === clientId) break;
        clients.delete(oldest);
      }
    }
    return client;
  };

  const ordered = () => [...clients.values()].flatMap(client => client.entries).sort((a, b) => a.sequence - b.sequence);

  return {
    ingest(clientId, entries) {
      if (typeof clientId !== 'string' || !clientId || !Array.isArray(entries) || entries.length === 0) return { accepted: 0, ack: 0 };
      const client = clientFor(clientId);
      const sorted = [...entries].sort((a, b) => a.seq - b.seq);
      // A page that reloads restarts its own counter at 1. Its highest
      // sequence dropping below what this Mac already holds is that restart,
      // not a replay, so the cursor is reset rather than the batch dropped.
      if (sorted[sorted.length - 1]!.seq < client.lastSeq) client.lastSeq = 0;
      const receivedAt = now();
      let accepted = 0;
      for (const entry of sorted) {
        if (entry.seq <= client.lastSeq) continue;
        client.lastSeq = entry.seq;
        client.entries.push({ sequence: ++cursor, clientId, seq: entry.seq, at: entry.at, receivedAt,
          kind: entry.kind, detail: { ...entry.detail } });
        if (entry.kind === 'session-start') device = { ...entry.detail };
        accepted += 1;
        while (client.entries.length > maxPerClient) { client.entries.shift(); client.dropped += 1; }
      }
      return { accepted, ack: client.lastSeq };
    },
    read({ sinceSequence = 0, limit = READ_HEADSET_LOG_DEFAULT_LIMIT, kind } = {}) {
      const matching = ordered().filter(entry => entry.sequence > sinceSequence && (kind === undefined || entry.kind === kind));
      const entries = matching.slice(0, limit);
      return { entries, cursor: entries.length ? entries[entries.length - 1]!.sequence : sinceSequence, more: matching.length > entries.length };
    },
    summary() {
      const entries = ordered();
      const counts: Record<string, number> = {};
      for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
      const failure = [...entries].reverse().find(entry => DIAGNOSTIC_ERROR_KINDS.includes(entry.kind));
      return {
        clients: clients.size,
        entries: entries.length,
        cursor,
        dropped: [...clients.values()].reduce((total, client) => total + client.dropped, 0),
        counts,
        lastError: failure ? { at: failure.at, kind: failure.kind, detail: failure.detail } : null,
        device,
        lastEntryAt: entries.length ? entries[entries.length - 1]!.at : null,
      };
    },
    forget(clientId) { clients.delete(clientId); },
    size() { return ordered().length; },
    cursor() { return cursor; },
  };
}

/** One log line for a terminal: `HEADSET <iso> <kind> <json>`. */
export function formatDiagnosticLine(entry: StoredDiagnostic): string {
  const at = Number.isFinite(entry.at) && entry.at > 0 ? new Date(entry.at).toISOString() : new Date(0).toISOString();
  return `HEADSET ${at} ${entry.kind} ${JSON.stringify(entry.detail)}`;
}
