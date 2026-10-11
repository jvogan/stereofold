/**
 * Remembered headsets for the private LAN companion.
 *
 * A headset that has already entered the pairing code once may be handed a
 * device key: 32 random bytes it keeps in its own browser storage. The key is
 * never stored here. Only its SHA-256 digest is written, so reading this file
 * does not let anyone pair. Redemption compares digests in constant time,
 * refuses an expired record, and returns a record the caller can turn into a
 * normal 30-minute session on the live listener.
 *
 * The whole set lives in one 0600 JSON file inside the LAN certificate store,
 * beside the private key that already has to be protected there.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { questDeviceIdleMs } from './local-helper-config.js';

export const DEVICE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DEVICES = 12;
const MAX_FILE_BYTES = 64 * 1024;
const FILE_NAME = 'remembered-devices.json';
const ID_PATTERN = /^[a-f0-9]{32}$/;
const KEY_PATTERN = /^[a-f0-9]{64}$/;

export type RememberedDevice = { id: string; label: string; createdAt: number; expiresAt: number; lastSeenAt: number };
type StoredDevice = RememberedDevice & { keyHash: string };
export type IssuedDevice = { deviceId: string; deviceKey: string; expiresAt: number; label: string };

export type RememberedDeviceStoreOptions = {
  /** The LAN certificate store; the device file is written inside it. */
  directory: string;
  now?: () => number;
  lifetimeMs?: number;
  idleTimeoutMs?: number;
  randomKey?: () => string;
  randomId?: () => string;
  maxDevices?: number;
};

/** Reading the environment once at construction keeps `--no-remember` a start-time decision. */
export function rememberingEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const raw = environment.STEREOFOLD_LAN_REMEMBER;
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

/**
 * A short human label for the status list. The raw user agent is attacker
 * controlled text from a LAN peer, so it is reduced to printable ASCII and
 * truncated before it is ever stored or printed.
 */
export function deviceLabel(userAgent?: string): string {
  const raw = typeof userAgent === 'string' ? userAgent.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!raw) return 'Unrecognized browser';
  const version = (pattern: RegExp) => pattern.exec(raw)?.[1] ?? '';
  if (/OculusBrowser/i.test(raw)) { const major = version(/OculusBrowser\/(\d+)/i); return `Meta Quest Browser${major ? ` ${major}` : ''}`; }
  if (/Wolvic/i.test(raw)) return 'Wolvic';
  if (/Firefox\//i.test(raw)) { const major = version(/Firefox\/(\d+)/i); return `Firefox${major ? ` ${major}` : ''}`; }
  if (/Edg\//i.test(raw)) { const major = version(/Edg\/(\d+)/i); return `Edge${major ? ` ${major}` : ''}`; }
  if (/Chrome\//i.test(raw)) { const major = version(/Chrome\/(\d+)/i); return `Chrome${major ? ` ${major}` : ''}`; }
  if (/Safari\//i.test(raw)) { const major = version(/Version\/(\d+)/i); return `Safari${major ? ` ${major}` : ''}`; }
  return raw.slice(0, 60);
}

function hashKey(key: string) { return createHash('sha256').update(key, 'utf8').digest('hex'); }

function sameDigest(left: string, right: string) {
  const a = Buffer.from(left, 'utf8'), b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function validRecord(value: unknown): value is StoredDevice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && ID_PATTERN.test(record.id) && typeof record.keyHash === 'string' && KEY_PATTERN.test(record.keyHash)
    && typeof record.label === 'string' && record.label.length <= 120
    && [record.createdAt, record.expiresAt, record.lastSeenAt].every(entry => typeof entry === 'number' && Number.isFinite(entry));
}

function publicRecord({ id, label, createdAt, expiresAt, lastSeenAt }: StoredDevice): RememberedDevice {
  return { id, label, createdAt, expiresAt, lastSeenAt };
}

export class RememberedDeviceStore {
  readonly #directory: string;
  readonly #now: () => number;
  readonly #lifetimeMs: number;
  readonly #idleTimeoutMs: number;
  readonly #randomKey: () => string;
  readonly #randomId: () => string;
  readonly #maxDevices: number;
  #serial: Promise<unknown> = Promise.resolve();

  constructor({ directory, now = Date.now, lifetimeMs = DEVICE_LIFETIME_MS, idleTimeoutMs = questDeviceIdleMs(), randomKey = () => randomBytes(32).toString('hex'),
    randomId = () => randomBytes(16).toString('hex'), maxDevices = MAX_DEVICES }: RememberedDeviceStoreOptions) {
    if (typeof directory !== 'string' || !isAbsolute(directory) || typeof now !== 'function' || typeof randomKey !== 'function' || typeof randomId !== 'function'
      || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0
      || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0 || !Number.isInteger(maxDevices) || maxDevices < 1)
      throw new TypeError('RememberedDeviceStore requires an absolute directory and valid lifetime options.');
    this.#directory = directory; this.#now = now; this.#lifetimeMs = lifetimeMs; this.#idleTimeoutMs = idleTimeoutMs;
    this.#randomKey = randomKey; this.#randomId = randomId; this.#maxDevices = maxDevices;
  }

  /** The single 0600 file holding every remembered device for this Mac. */
  get path(): string { return join(this.#directory, FILE_NAME); }

  /** Mint one device key. Only its digest is stored; the key returned here is the only copy. */
  async issue(userAgent?: string): Promise<IssuedDevice> {
    return this.#run(async () => {
      const key = this.#randomKey(), id = this.#randomId();
      if (!KEY_PATTERN.test(key) || !ID_PATTERN.test(id)) throw Error('Remembered device generator returned an invalid key.');
      const now = this.#now(), label = deviceLabel(userAgent);
      const record: StoredDevice = { id, keyHash: hashKey(key), label, createdAt: now, expiresAt: now + this.#lifetimeMs, lastSeenAt: now };
      const devices = (await this.#read()).filter(entry => entry.id !== id);
      devices.push(record);
      // The oldest use is dropped first, so a headset in daily use is never
      // evicted by a one-off pairing from another device.
      devices.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
      await this.#write(devices.slice(0, this.#maxDevices));
      return { deviceId: id, deviceKey: key, expiresAt: record.expiresAt, label };
    });
  }

  /** Return the record when this exact key matches an unexpired device, and record the visit. */
  async redeem(deviceId: unknown, deviceKey: unknown, userAgent?: string): Promise<RememberedDevice | undefined> {
    return this.#run(async () => {
      if (typeof deviceId !== 'string' || !ID_PATTERN.test(deviceId) || typeof deviceKey !== 'string' || !KEY_PATTERN.test(deviceKey)) return undefined;
      const devices = await this.#read(), now = this.#now();
      const digest = hashKey(deviceKey);
      const match = devices.find(entry => entry.id === deviceId && sameDigest(entry.keyHash, digest) && now < entry.expiresAt);
      if (!match) return undefined;
      match.lastSeenAt = now;
      match.label = deviceLabel(userAgent) === 'Unrecognized browser' ? match.label : deviceLabel(userAgent);
      await this.#write(devices);
      return publicRecord(match);
    });
  }

  /** Every unexpired device, most recently seen first. */
  async list(): Promise<RememberedDevice[]> {
    return this.#run(async () => (await this.#read()).sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(publicRecord));
  }

  /** Revoke one device id, or every device with 'all'. Returns the ids that were removed. */
  async forget(deviceId: string): Promise<string[]> {
    return this.#run(async () => {
      const devices = await this.#read();
      const removed = devices.filter(entry => deviceId === 'all' || entry.id === deviceId).map(entry => entry.id);
      if (removed.length === 0) return [];
      const kept = devices.filter(entry => !removed.includes(entry.id));
      if (kept.length === 0) await rm(this.path, { force: true });
      else await this.#write(kept);
      return removed;
    });
  }

  #run<T>(work: () => Promise<T>) { const next = this.#serial.then(work, work); this.#serial = next.then(() => undefined, () => undefined); return next; }

  /**
   * Opening once with O_NOFOLLOW and stating that handle refuses a file another
   * user substituted with a symbolic link, and closes the window an
   * lstat-then-read pair leaves open. A missing, oversized, or unparsable file
   * reads as no remembered devices rather than failing a pairing request.
   */
  async #read(): Promise<StoredDevice[]> {
    let text: string;
    try {
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return [];
        text = await handle.readFile('utf8');
      } finally { await handle.close(); }
    } catch { return []; }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return []; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as any).devices)) return [];
    const now = this.#now();
    const devices = ((parsed as any).devices as unknown[]).filter(validRecord).filter(entry => now < entry.expiresAt && now - entry.lastSeenAt < this.#idleTimeoutMs);
    // One key per device id: a duplicated id in a hand-edited file keeps the
    // most recently seen record and drops the rest.
    const byId = new Map<string, StoredDevice>();
    for (const entry of devices.sort((a, b) => a.lastSeenAt - b.lastSeenAt)) byId.set(entry.id, entry);
    return [...byId.values()];
  }

  async #write(devices: StoredDevice[]): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const pending = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const handle = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, devices }), 'utf8'); await handle.chmod(0o600); } finally { await handle.close(); }
      await rename(pending, this.path);
      await chmod(this.path, 0o600);
    } catch (error) { await rm(pending, { force: true }).catch(() => undefined); throw error; }
  }
}
