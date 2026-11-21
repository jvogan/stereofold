/**
 * A picture of the Mac's view, kept current in one file.
 *
 * Some hosts can show a local file beside the chat but cannot open a network
 * connection from that pane, loopback included, so a page this Mac serves can
 * neither be framed there nor fetched. Claude Science is one: its right-hand
 * pane runs previews under a policy with no frame or loopback sources, yet its
 * "This computer" file tab watches a local file and reloads it when the file
 * changes. A JPEG that this host rewrites whenever the scene draws is the one
 * shape every such pane can show.
 *
 * The agent asks for it with `show_live_view`. While that request stands, the
 * poll answer of each desktop panel of the session carries a small request,
 * the panel posts a downscaled JPEG of its own canvas at most once per
 * interval when it draws, and `submit_live_view` writes that JPEG over the
 * file in one rename. Nothing is captured or written until someone asks, and
 * a headset page is never asked: its frames belong to the wearer.
 *
 * Who feeds the file: the latest `start` owns it. Each start writes a new
 * claim into the owner record beside the file, and a session feeds the file
 * only while that record names its claim. A session whose claim is no longer
 * there has been superseded: it stops feeding, its status says so, and it
 * feeds again only after a new explicit start. A record that is missing, or
 * that names a claim no session holds any more, hands the file to nobody, so
 * an older session never takes it back. Stop leaves the record where it is:
 * removing it only while it names this claim would be a read and then a
 * delete, and a start elsewhere between the two would lose its record.
 *
 * There is no lock. What that guarantees is stated once, at the step in
 * `inspection-server.ts` that lands a picture.
 *
 * The picture is the desktop panel's own view of the shared scene: the same
 * structure, chapter, colors, labels and selection the headset shows, from the
 * desktop camera rather than the wearer's head.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** The file name, beside the scene service record (`~/.stereofold` by default). */
export const LIVE_VIEW_FILE = 'live-view.jpg';
/** The claim of the latest start, beside it. */
export const LIVE_VIEW_OWNER_FILE = 'live-view.owner.json';
/** How long shutdown waits for pictures still being written before it goes on. */
export const LIVE_VIEW_CLOSE_DRAIN_MS = 2_000;
/** A temporary file this old is one no write still needs. */
const STALE_TEMPORARY_MS = 60_000;
/** How often a panel may post while the scene keeps drawing. */
export const LIVE_VIEW_INTERVAL_MS = 1_000;
/** The posted picture's width; a host pane rarely shows more. */
export const LIVE_VIEW_MAX_WIDTH = 960;
/** The decoded JPEG may not be larger than this. */
export const LIVE_VIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Frames closer together than this are refused rather than written. */
export const LIVE_VIEW_MIN_SPACING_MS = 250;
/** A panel that has fed the file keeps it until it has been quiet this long. */
export const LIVE_VIEW_PANEL_HOLD_MS = 5_000;

export type LiveViewRequest = { intervalMs: number; maxWidth: number };
export type LiveViewFrame = { at: number; width: number; height: number; bytes: number; panelId: string };

/** Where this host keeps the picture: beside the scene service record it reads and writes. */
export function liveViewPath(sceneRecordPath: string): string {
  return join(dirname(sceneRecordPath), LIVE_VIEW_FILE);
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** Quantization tables: a precision and id byte, then 64 one- or two-byte entries each, filling the segment exactly. */
function quantizationTables(bytes: Uint8Array, at: number, end: number): boolean {
  if (at >= end) return false;
  while (at < end) {
    if (bytes[at] >> 4 > 1 || (bytes[at] & 15) > 3) return false;
    at += 1 + 64 * ((bytes[at] >> 4) + 1);
  }
  return at === end;
}

/** Huffman tables: a class and id byte, sixteen code counts, then that many symbols each, filling the segment exactly. */
function huffmanTables(bytes: Uint8Array, at: number, end: number): boolean {
  if (at >= end) return false;
  while (at < end) {
    if (at + 17 > end || bytes[at] >> 4 > 1 || (bytes[at] & 15) > 3) return false;
    let symbols = 0;
    for (let index = 1; index <= 16; index++) symbols += bytes[at + index];
    if (symbols < 1 || symbols > 256) return false;
    at += 17 + symbols;
  }
  return at === end;
}

/**
 * The frame size a JPEG declares, read by walking its marker segments from SOI
 * to the first scan. Before the scan there must be quantization tables that
 * fill their segment, one frame header whose length fits its 1 to 4 distinct
 * components, and, for a Huffman-coded frame, Huffman tables that fill theirs.
 * The scan header must name each of the frame's components once, with a length
 * that fits, and scan data must follow before the closing EOI.
 *
 * This is a size and format gate, so the file is an image of the stated
 * dimensions and not text or a header alone. It is not a promise that every
 * decoder accepts the picture: the coded data itself is not read.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const end = bytes.length - 2;
  if (bytes[end] !== 0xff || bytes[end + 1] !== 0xd9) return undefined;
  let at = 2, quantization = false, huffman = false, arithmetic = false;
  let size: { width: number; height: number } | undefined;
  let components: number[] | undefined;
  while (at + 4 <= end) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1];
    if (marker === 0xff) { at++; continue; }
    if (marker <= 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) return undefined;
    const length = (bytes[at + 2] << 8) | bytes[at + 3], body = at + 4, next = at + 2 + length;
    if (length < 2 || next > end) return undefined;
    if (marker === 0xdb) { if (!quantizationTables(bytes, body, next)) return undefined; quantization = true; }
    else if (marker === 0xc4) { if (!huffmanTables(bytes, body, next)) return undefined; huffman = true; }
    else if (SOF_MARKERS.has(marker)) {
      // Precision, height, width, component count, then three bytes per component.
      const count = bytes[body + 5];
      if (components || length < 11 || count < 1 || count > 4 || length !== 8 + 3 * count) return undefined;
      const height = (bytes[body + 1] << 8) | bytes[body + 2];
      const width = (bytes[body + 3] << 8) | bytes[body + 4];
      if (!(width > 0 && height > 0)) return undefined;
      components = Array.from({ length: count }, (_, index) => bytes[body + 6 + 3 * index]);
      if (new Set(components).size !== count) return undefined;
      arithmetic = marker >= 0xc9;
      size = { width, height };
    } else if (marker === 0xda) {
      // Component count, two bytes per component, then three bytes of spectral selection.
      const count = bytes[body];
      if (!size || !components || !quantization || !(huffman || arithmetic)) return undefined;
      if (count !== components.length || length !== 6 + 2 * count) return undefined;
      const named = Array.from({ length: count }, (_, index) => bytes[body + 1 + 2 * index]);
      if (new Set(named).size !== count || !named.every(id => components!.includes(id))) return undefined;
      return next < end ? size : undefined;
    }
    at = next;
  }
  return undefined;
}

/** Base64 that decodes and encodes back to itself, so one picture has one spelling. */
export function canonicalBase64(text: string): Buffer | undefined {
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : undefined;
}

/** What the owner's check of the file found. */
export type LiveViewCheck = 'same' | 'repaired' | 'superseded' | 'skipped';
/** Test seams: a pause once a picture's bytes are written (a new frame or a repair), and word of each finished check of the file. */
export type LiveViewSeams = { written?: () => Promise<void>; checked?: (outcome: LiveViewCheck) => void };

/**
 * Replace the picture in one rename, so a reader polling it never sees half of
 * one. The bytes go to a private temporary file beside it first. `step` then
 * runs synchronously and is handed `publish`, the rename: nothing else in this
 * process can run between what it checks and the picture landing. The
 * temporary file is removed whenever it is not published. `written` runs once
 * the bytes are on disk (a test pauses there). The folder is made private when
 * this call creates it; an existing folder keeps the permissions its owner
 * gave it.
 */
export async function replaceLiveViewFile<T>(picture: string, bytes: Uint8Array, step: (publish: () => void) => T,
  written?: () => Promise<void>): Promise<T> {
  await mkdir(dirname(picture), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(picture), `.${LIVE_VIEW_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  let published = false;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await written?.();
    return step(() => { renameSync(temporary, picture); published = true; });
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Best effort, on start: remove temporary files beside the picture that no
 * write still needs, and the lock files an earlier build of this module left
 * (`live-view.lock*`), so they cannot confuse a person looking in the folder.
 */
export async function sweepLiveViewFolder(picture: string): Promise<void> {
  const directory = dirname(picture);
  const names = await readdir(directory).catch(() => [] as string[]);
  await Promise.all(names.map(async name => {
    const path = join(directory, name);
    try {
      if (name === 'live-view.lock' || name.startsWith('live-view.lock.')) await rm(path, { force: true });
      else if ((name.startsWith(`.${LIVE_VIEW_FILE}.`) || name.startsWith(`${LIVE_VIEW_OWNER_FILE}.`)) && name.endsWith('.tmp')
        && Date.now() - (await stat(path)).mtimeMs > STALE_TEMPORARY_MS) await rm(path, { force: true });
    } catch { /* left for the next start */ }
  }));
}

/** The latest start's claim, the server that made it, and that server's process. */
export type LiveViewOwner = { claim: string; serverEpoch: string; pid: number };
const ownerPath = (picture: string) => join(dirname(picture), LIVE_VIEW_OWNER_FILE);

/** The owner record, or undefined when there is none to read. Records are replaced whole, so any read sees one. */
export function readLiveViewOwner(picture: string): LiveViewOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(ownerPath(picture), 'utf8')) as Partial<LiveViewOwner>;
    return typeof value.claim === 'string' && typeof value.serverEpoch === 'string'
      ? { claim: value.claim, serverEpoch: value.serverEpoch, pid: Number(value.pid) } : undefined;
  } catch { return undefined; }
}

/**
 * A start: name its claim, replacing whatever record was there, in one rename.
 * The folder is made, private, when it is not there yet.
 */
export function writeLiveViewOwner(picture: string, owner: LiveViewOwner): void {
  mkdirSync(dirname(picture), { recursive: true, mode: 0o700 });
  const temporary = `${ownerPath(picture)}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, ownerPath(picture));
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* never written */ }
    throw error;
  }
}

/** Why a session stopped feeding the file without being asked to. */
export type LiveViewSuperseded = 'another-session' | 'another-host' | 'owner-gone';
/** One reserved frame: the claim it was reserved under and its place in order. */
export type LiveViewToken = { claim: string; order: number };

/** The last picture this server landed: its bytes, and the source it was drawn from (compared by the server). */
export type LiveViewWritten = { bytes: Buffer; source: unknown };

/**
 * Which session of this server feeds the file, under which claim, and what the
 * last picture was. `admit` reserves a frame synchronously; `commit` records it
 * only if its claim still feeds and no later frame has landed.
 */
export function createLiveViewState({ now = Date.now }: { now?: () => number } = {}) {
  type Feed = { sessionId: string; claim: string; since: number; frame?: LiveViewFrame;
    written?: LiveViewWritten; holder?: { panelId: string; at: number }; reservedAt: number; reserved: number; landed: number };
  let feed: Feed | undefined;
  const superseded = new Map<string, LiveViewSuperseded>();
  const current = (token: LiveViewToken) => feed !== undefined && feed.claim === token.claim && token.order > feed.landed;
  return {
    /** A start: this session feeds the file under `claim`; another session of this server that did stops. */
    arm(sessionId: string, claim: string): void {
      if (feed && feed.sessionId !== sessionId) superseded.set(feed.sessionId, 'another-session');
      superseded.delete(sessionId);
      const kept = feed?.sessionId === sessionId ? feed : undefined;
      feed = { sessionId, claim, since: now(), ...(kept?.frame ? { frame: kept.frame } : {}), ...(kept?.written ? { written: kept.written } : {}),
        reservedAt: -Infinity, reserved: 0, landed: 0 };
    },
    /** A stop or a session's end: the session stops feeding. Returns the claim to give up, if it fed. */
    end(sessionId: string): string | undefined {
      superseded.delete(sessionId);
      if (feed?.sessionId !== sessionId) return undefined;
      const { claim } = feed;
      feed = undefined;
      return claim;
    },
    /** The record no longer names `claim`: its session stops feeding and keeps the reason for its status. */
    supersede(claim: string, reason: LiveViewSuperseded): void {
      if (feed?.claim !== claim) return;
      superseded.set(feed.sessionId, reason);
      feed = undefined;
    },
    feeding(): { sessionId: string; claim: string } | undefined {
      return feed && { sessionId: feed.sessionId, claim: feed.claim };
    },
    /** The last picture the feeding session landed; the same object until another lands. */
    written(): LiveViewWritten | undefined { return feed?.written; },
    request(sessionId: string): LiveViewRequest | undefined {
      return feed?.sessionId === sessionId ? { intervalMs: LIVE_VIEW_INTERVAL_MS, maxWidth: LIVE_VIEW_MAX_WIDTH } : undefined;
    },
    admit(sessionId: string, panelId: string): { token: LiveViewToken } | { reason: 'not-requested' | 'too-soon' | 'other-panel' } {
      if (feed?.sessionId !== sessionId) return { reason: 'not-requested' };
      const at = now();
      if (feed.holder && feed.holder.panelId !== panelId && at - feed.holder.at < LIVE_VIEW_PANEL_HOLD_MS) return { reason: 'other-panel' };
      if (at - feed.reservedAt < LIVE_VIEW_MIN_SPACING_MS) return { reason: 'too-soon' };
      feed.reservedAt = at;
      feed.holder = { panelId, at };
      return { token: { claim: feed.claim, order: ++feed.reserved } };
    },
    /** Whether a reserved frame may still land: its claim feeds, and no later frame has landed. */
    current,
    /** Why a reserved frame may not land: its session stopped feeding, or a later frame landed first. */
    refusal(token: LiveViewToken): 'stopped' | 'older' | undefined {
      return current(token) ? undefined : feed?.claim === token.claim ? 'older' : 'stopped';
    },
    commit(token: LiveViewToken, next: Omit<LiveViewFrame, 'at'>, written: LiveViewWritten): boolean {
      if (!current(token)) return false;
      feed!.landed = token.order;
      feed!.frame = { ...next, at: now() };
      feed!.written = written;
      return true;
    },
    status(sessionId: string): { active: boolean; since?: number; frame?: LiveViewFrame; superseded?: LiveViewSuperseded } {
      const mine = feed?.sessionId === sessionId ? feed : undefined;
      const reason = superseded.get(sessionId);
      return { active: mine !== undefined, ...(mine ? { since: mine.since } : {}), ...(mine?.frame ? { frame: mine.frame } : {}),
        ...(reason ? { superseded: reason } : {}) };
    },
  };
}
export type LiveViewState = ReturnType<typeof createLiveViewState>;

/** The panel's posted picture. Canonical base64 of at most `LIVE_VIEW_MAX_BYTES` decoded bytes. */
export const liveViewFrameShape = {
  image: z.string().min(16).max(Math.ceil(LIVE_VIEW_MAX_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
    .refine(text => canonicalBase64(text) !== undefined, 'Expected canonical base64.'),
  width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096),
};

export const showLiveViewSchema = z.object({
  sessionId: z.string().uuid(),
  action: z.enum(['start', 'stop', 'status']).optional()
    .describe('start (default) keeps the picture current; stop leaves the last picture in place and stops replacing it; status reports the file and its last update.'),
}).strict();

/** How old a picture is, in words. */
function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 2 ? 'just now' : seconds < 120 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`;
}

/**
 * The answer the agent passes on. It names the file, says whether a picture
 * has arrived, and tells a host that cannot open the path for itself how a
 * person shows it beside the chat.
 */
export function liveViewText({ path, action, active, frame, now, superseded, otherSession, otherHost }: {
  path: string; action: 'start' | 'stop' | 'status'; active: boolean; frame?: LiveViewFrame; now: number;
  /** Why this session stopped feeding the file without being asked to. */
  superseded?: LiveViewSuperseded;
  /** Another session of this server feeds the file. */
  otherSession?: boolean;
  /** The owner record names another Stereofold host on this Mac, whose start came later. */
  otherHost?: boolean;
}): string {
  const where = `The live view is the file ${path}.`;
  const elsewhere = otherHost ? 'the latest live view start on this Mac came from another Stereofold host'
    : otherSession ? 'another session on this Mac still replaces it' : undefined;
  if (action === 'stop') return elsewhere
    ? `${where} This session no longer feeds it, but ${elsewhere}.`
    : `${where} It is no longer replaced; the last picture stays in place. Call show_live_view again to resume.`;
  if (!active && superseded) {
    const why = superseded === 'another-host' ? 'another Stereofold host on this Mac started its own live view after this one'
      : superseded === 'another-session' ? 'another session on this Mac started its own live view after this one'
        : 'the record of the latest start beside the file is gone or unreadable, so nothing shows this session started last';
    return `${where} This session has stopped feeding it: ${why}. The latest start owns the file. Call show_live_view with action "start" to feed it again.`;
  }
  if (!active) return `${where} No live view is running for this session${elsewhere ? `; ${elsewhere}` : ''}. Call show_live_view with action "start" to begin.`;
  const picture = frame
    ? `The last picture is ${frame.width}x${frame.height}, written ${age(now - frame.at)}.`
    : 'No picture has arrived yet: it comes from this session\'s desktop panel on this Mac, which must be open and visible, and the first one follows its next draw.';
  return `${where} It is replaced about once a second while the scene draws, with this Mac's desktop view of the shared scene (the same structure, chapter, colors and labels as the headset, seen from the desktop camera). ${picture} `
    + `To show it beside the chat in Claude Science, give the person this path and ask them to open it once from Files, This computer; that tab reloads the picture by itself whenever the file changes, so no further requests are needed. `
    + 'Claude Science cannot open that tab for you, and its previews cannot frame a page served on this Mac. In another host, open the path in any viewer that reloads a changed file.';
}
