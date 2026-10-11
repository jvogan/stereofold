/**
 * Read the paired headset's log from a terminal.
 *
 *     pnpm --dir plugin run headset-log <state.json> [--follow] [--kind session-start]
 *
 * The state file is the private local-host state `serve-inspection.ts` writes:
 * a loopback origin and a bearer for this Mac only. Nothing here reaches the
 * headset; it reads what the companion page already sent up its heartbeat, so
 * an agent can see the real device's log while the wearer is still wearing it.
 *
 * Prints one line per entry: `HEADSET <iso> <kind> <json>`. No token, pairing
 * code or companion URL is ever printed.
 */
import { readFile } from 'node:fs/promises';
import { formatDiagnosticLine, READ_HEADSET_LOG_MAX_LIMIT, type StoredDiagnostic } from '../src/headset-diagnostics.js';

const FOLLOW_INTERVAL_MS = 1_000;

const argv = process.argv.slice(2);
const statePath = argv.find(argument => !argument.startsWith('--'));
const follow = argv.includes('--follow');
const kindIndex = argv.indexOf('--kind');
const kind = kindIndex >= 0 ? argv[kindIndex + 1] : undefined;
const limitIndex = argv.indexOf('--limit');
const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : undefined;
if (!statePath) throw Error('Usage: headset-log.ts private-state.json [--follow] [--since N] [--kind KIND] [--limit N]');
const sinceIndex = argv.indexOf('--since');
let cursor = sinceIndex >= 0 ? Number(argv[sinceIndex + 1]) : 0;
if (!Number.isFinite(cursor) || cursor < 0) throw Error('--since takes a non-negative sequence number.');
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > READ_HEADSET_LOG_MAX_LIMIT))
  throw Error(`--limit takes 1-${READ_HEADSET_LOG_MAX_LIMIT}.`);

const state = JSON.parse(await readFile(statePath, 'utf8'));
const origin = new URL(state.origin);
// The agent route is a loopback capability. Refuse anything else outright
// rather than sending this Mac's bearer to a host that is not this Mac.
if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:') throw Error('Local control requires loopback.');

async function call(name: string, args: Record<string, unknown>) {
  const response = await fetch(`${state.origin}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` },
    body: JSON.stringify({ name, arguments: args }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const text = (payload as any)?.error ?? (payload as any)?.content?.[0]?.text ?? `HTTP ${response.status}`;
    throw Error(`headset-log: ${text}`);
  }
  return payload as { structuredContent?: { entries?: StoredDiagnostic[]; cursor?: number; more?: boolean; summary?: Record<string, unknown> } };
}

async function drain(): Promise<{ printed: number; more: boolean }> {
  const result = await call('read_headset_log', {
    sinceSequence: cursor,
    ...(limit !== undefined ? { limit } : {}),
    ...(kind ? { kind } : {}),
  });
  const entries = result.structuredContent?.entries ?? [];
  for (const entry of entries) console.log(formatDiagnosticLine(entry));
  if (entries.length) cursor = entries[entries.length - 1]!.sequence;
  else if (Number.isFinite(result.structuredContent?.cursor)) cursor = Math.max(cursor, result.structuredContent!.cursor!);
  return { printed: entries.length, more: result.structuredContent?.more === true };
}

// A single read drains every waiting page, so a backlog larger than one
// response is not silently truncated.
let first = await drain();
while (first.more) first = await drain();
if (!follow) {
  if (first.printed === 0 && cursor === 0) console.error('headset-log: the headset has reported nothing yet.');
  process.exit(0);
}
console.error(`headset-log: following from sequence ${cursor}. Press Ctrl+C to stop.`);
for (;;) {
  await new Promise(resolve => setTimeout(resolve, FOLLOW_INTERVAL_MS));
  try {
    let round = await drain();
    while (round.more) round = await drain();
  } catch (error) {
    // A host that restarts mid-follow should not end the watch; the next
    // round reconnects and the cursor is still valid for the new store only
    // if it did not restart, which a lower cursor on the server reveals.
    console.error(`headset-log: ${(error as Error).message}`);
  }
}
