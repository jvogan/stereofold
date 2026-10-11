import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HeadsetCaptionAudio } from './headset-captions.js';

/**
 * Recent spoken lines, so a repeated sentence costs no round trip.
 *
 * A narration call on this Mac costs about 4.0 s before it produces a sample,
 * almost all of it fixed: Python start-up, the OAuth client secret, and
 * opening the realtime socket. A conversation repeats itself — "Say that
 * again?", "I cannot reach that from here", a refusal the wearer keeps walking
 * into — and rendering the identical words a second time buys nothing but the
 * wait.
 *
 * Entries live beside the structure cache, under the host's own cache
 * directory, never in the repository and never in a project folder. A file
 * holds the encoded clip and nothing else: the key is a digest, so the
 * sentence that produced it cannot be read back out of the directory listing.
 *
 * Everything here is best effort. An unwritable disk, a truncated file, a
 * clip of the wrong shape: each is a miss, and a miss costs the round trip
 * that would have happened anyway.
 */

/** Beside `Library/Caches/Stereofold/sources`, which the structure loader already writes. */
export const REPLY_VOICE_CACHE_DIRECTORY = 'Library/Caches/Stereofold/reply-voice';
/** Roughly a week of one wearer's repeated lines. */
export const REPLY_VOICE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
/** At the inline ceiling of 200 KB of base64 each, 64 entries bound the directory at about 13 MB. */
export const REPLY_VOICE_CACHE_MAX_ENTRIES = 64;
/** A file larger than one inline clip is not a clip this cache wrote. */
export const REPLY_VOICE_CACHE_MAX_BYTES = 400_000;

export type ReplyVoiceCache = {
  /** A digest of everything that changes the sound, not of the words alone. */
  key(parts: readonly string[]): string;
  get(key: string): Promise<HeadsetCaptionAudio | undefined>;
  put(key: string, clip: HeadsetCaptionAudio): Promise<void>;
};

const KEY_SHAPE = /^[0-9a-f]{64}$/u;
/** A byte no part of a key can contain, so two different part lists cannot collide. */
const SEPARATOR = '\u0000';

/**
 * An entry carries the moment it was written, rather than leaning on the
 * file's own timestamp. A copied or restored cache directory arrives with
 * whatever mtimes the copy gave it, and the age this sweep acts on has to be
 * the age the host recorded.
 */
type ReplyVoiceEntry = { at: number; clip: HeadsetCaptionAudio };

function entryOf(value: unknown): ReplyVoiceEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { at, clip } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(at) || (at as number) < 0) return undefined;
  const audio = clipOf(clip);
  return audio ? { at: at as number, clip: audio } : undefined;
}

function clipOf(value: unknown): HeadsetCaptionAudio | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const { base64, mimeType, format, bytes, voice, seconds } = record;
  if (typeof base64 !== 'string' || !base64 || base64.length > REPLY_VOICE_CACHE_MAX_BYTES
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)
    || typeof mimeType !== 'string' || !mimeType || typeof format !== 'string' || !format
    || !Number.isSafeInteger(bytes) || (bytes as number) < 1) return undefined;
  return { base64, mimeType, format, bytes: bytes as number,
    ...(typeof voice === 'string' && voice ? { voice } : {}),
    ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}) };
}

export function replyVoiceCacheRoot(home: string = homedir()): string {
  return join(home, REPLY_VOICE_CACHE_DIRECTORY);
}

export function createReplyVoiceCache({
  root = replyVoiceCacheRoot(),
  maxAgeMs = REPLY_VOICE_CACHE_MAX_AGE_MS,
  maxEntries = REPLY_VOICE_CACHE_MAX_ENTRIES,
  now = Date.now,
}: { root?: string; maxAgeMs?: number; maxEntries?: number; now?: () => number } = {}): ReplyVoiceCache {
  const file = (key: string) => join(root, `${key}.json`);
  const read = async (key: string): Promise<ReplyVoiceEntry | undefined> => {
    try {
      const raw = await readFile(file(key), 'utf8');
      if (raw.length > REPLY_VOICE_CACHE_MAX_BYTES + 1_024) return undefined;
      return entryOf(JSON.parse(raw));
    } catch { return undefined; }
  };
  /**
   * Drop what has expired, then the oldest of whatever is left over the count.
   * A directory this cannot read is a directory this cannot prune, which costs
   * disk and never correctness.
   */
  const prune = async () => {
    let names: string[];
    try { names = await readdir(root); } catch { return; }
    const kept: Array<{ key: string; at: number }> = [];
    const cutoff = now() - maxAgeMs;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -5);
      if (!KEY_SHAPE.test(key)) continue;
      const entry = await read(key);
      // A file this cannot read back is a file nothing can ever hit, so it is
      // swept with the expired rather than counted against the ceiling.
      if (!entry || entry.at <= cutoff) await rm(file(key), { force: true }).catch(() => { /* Gone already. */ });
      else kept.push({ key, at: entry.at });
    }
    kept.sort((left, right) => left.at - right.at);
    for (const entry of kept.slice(0, Math.max(0, kept.length - maxEntries))) {
      await rm(file(entry.key), { force: true }).catch(() => { /* Best effort. */ });
    }
  };

  return {
    key(parts) { return createHash('sha256').update(parts.join(SEPARATOR)).digest('hex'); },
    async get(key) {
      if (!KEY_SHAPE.test(key)) return undefined;
      const entry = await read(key);
      if (!entry || entry.at <= now() - maxAgeMs) return undefined;
      return entry.clip;
    },
    async put(key, clip) {
      if (!KEY_SHAPE.test(key) || !clipOf(clip)) return;
      const temporary = join(root, `.${randomUUID()}.tmp`);
      try {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify({ at: Math.round(now()), clip } satisfies ReplyVoiceEntry),
          { mode: 0o600, flag: 'wx' });
        await rename(temporary, file(key));
      } catch { return; }
      finally { await rm(temporary, { force: true }).catch(() => { /* Renamed already. */ }); }
      await prune();
    },
  };
}
