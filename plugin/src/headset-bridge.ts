/**
 * Channel C: the file bridge the Claude Science assistant reads.
 *
 * The assistant cannot open a network connection, loopback included, but it
 * can read files inside a granted sandbox path. This module is the writer for
 * the Claude Science file route: it turns one render
 * into a small JSON state file plus two PNGs, so the assistant can confirm
 * from pixels that a render actually happened.
 *
 * Everything here is pure in the sense that matters: it takes a state object
 * and two PNG buffers and touches nothing but the bridge directory. It never
 * reads the scene, never talks to the companion, and never learns a token.
 *
 * Security posture, because the assistant reads this directory: treat every
 * byte written here as published to the assistant's context. The input schema
 * is strict, so an unlisted field is a hard error rather than a leak, and
 * `stripCapabilityFields` removes anything token-shaped before validation so a
 * caller that widens its own state object cannot quietly widen this file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { sceneSchema } from './inspection-contract.js';
import { writeLocalControlState } from '../scripts/local-host-security.js';

export const BRIDGE_SCHEMA_ID = 'stereofold.bridge/1';
/** Advisory, and fixed by the spec. A reader older than this reports an age, not a render. */
export const BRIDGE_STALE_AFTER_MS = 15_000;
export const BRIDGE_HISTORY_REVISIONS = 20;
export const BRIDGE_HISTORY_MAX_BYTES = 200 * 1024 * 1024;
/** `scene.selectionKeys` can hold 20,000 strings. Only a count, a digest and this many samples are written. */
export const BRIDGE_SELECTION_SAMPLE = 8;
export const BRIDGE_MAX_CAPTURE_BYTES = 30 * 1024 * 1024;
export const BRIDGE_REVISION_DIGITS = 8;
export const BRIDGE_MAX_REVISION = 99_999_999;

export const BRIDGE_STATE_FILE = 'state.json';
/**
 * The latest thing the wearer said, written beside the state file.
 *
 * Push-to-talk transcription runs in the MCP child while the bridge is written
 * by a separate harness process, so the two cannot share memory. This one small
 * file is the handoff: the transcriber replaces it atomically, and the next
 * bridge write folds it into `state.json`, so the Claude Science assistant
 * reads the speech and the render in one place.
 */
export const BRIDGE_VOICE_FILE = 'voice.json';
export const BRIDGE_CAPTURE_FILE = 'capture.png';
export const BRIDGE_CAPTURE_LEFT_FILE = 'capture-left.png';
/**
 * One still from the physical headset, written by `capture_headset_view`.
 *
 * It is its own entry rather than a reuse of `capture`, because it is a
 * single view with no left crop, and because it arrives from the wearer's
 * device rather than from the emulator harness. Like `voice.json` it can be
 * written on its own, and it is folded into the next full revision so that
 * pixels, speech and scene state land together.
 */
export const BRIDGE_HEADSET_VIEW_FILES = Object.freeze({ 'image/jpeg': 'headset-view.jpg', 'image/png': 'headset-view.png' });
export const BRIDGE_HEADSET_VIEW_STATE_FILE = 'headset-view.json';
export const BRIDGE_HISTORY_DIR = 'history';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const PNG_MAGIC = 0x89504e47;

/**
 * Key names that carry a capability rather than a fact.
 *
 * `sourceToken` is the one the spec names explicitly: it is the freshness
 * capability from `inspection-server.ts`, and `sourceSha256` identifies the
 * same coordinates without granting anything. The rest are the other secrets
 * that exist in this repo — the companion bearer token, the LAN pairing code,
 * the certificate private key.
 */
const CAPABILITY_KEY_PATTERN = /token|bearer|secret|password|passphrase|credential|cookie|authoriz|private[-_]?key|api[-_]?key|pairing/i;

/**
 * `renderToken` is a counter, not a capability, and the spec puts it in the
 * file. It survives the strip only while it is a number, so a caller cannot
 * smuggle a string capability through the one allowlisted name.
 */
const CAPABILITY_KEY_ALLOWLIST = new Set(['renderToken']);

/** String shapes that are a capability whatever key they arrive under. */
const CAPABILITY_VALUE_PATTERN = /^Bearer\s|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex SHA-256.');
const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// `Date.prototype.toISOString` output exactly: readers call `Date.parse` on it.
const isoInstantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'Expected a UTC ISO-8601 instant with milliseconds.');
const dimensionSchema = z.number().int().positive().max(16_384);
const offsetSchema = z.number().int().nonnegative().max(16_384);

const viewSchema = z.object({
  eye: z.enum(['left', 'right']),
  x: offsetSchema, y: offsetSchema, width: dimensionSchema, height: dimensionSchema,
}).strict();

/**
 * The scene half of the state. `camera` is taken from `sceneSchema` rather
 * than restated, so the bridge cannot drift from the validated snapshot the
 * inspector already round-trips.
 */
export const bridgeStateInputSchema = z.object({
  sessionId: z.string().uuid(),
  serverEpoch: z.string().uuid(),
  panelId: z.union([z.string().uuid(), z.literal('unidentified')]),
  surface: z.enum(['companion', 'inspector', 'headset']),
  sourceSha256: sha256Schema,
  structureId: z.string().regex(/^[0-9A-Za-z]{4}$/).nullable(),
  stateRevision: revisionSchema,
  inspectionRevision: revisionSchema,
  renderToken: revisionSchema,
  representation: sceneSchema.shape.inspection.shape.appearance.shape.representation,
  selection: z.object({
    count: z.number().int().nonnegative().max(20_000),
    digest: sha256Schema,
    sample: z.array(z.string().min(1).max(4096)).max(BRIDGE_SELECTION_SAMPLE),
  }).strict(),
  camera: sceneSchema.shape.camera,
  lastCommand: z.object({
    // `commandIdSchema` from `inspection-contract.ts:70`. A command ID is
    // caller-chosen rather than server-issued, so the real harness sends
    // labels such as `companion-xr-uniform`, not a UUID. The character class
    // and the 80-byte bound keep it a name and nothing else.
    commandId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    outcome: z.enum(['applied', 'queued', 'rejected']),
    at: isoInstantSchema,
    // The raw `completeInspectionSchema.failure` value, bounded so no path,
    // URL or message body can ride along in it.
    detail: z.string().regex(/^[a-z0-9_.:-]{1,64}$/).nullable(),
  }).strict().nullable(),
  /** Present only once the wearer has spoken. Text only; audio never reaches this file. */
  voice: z.lazy(() => bridgeVoiceSchema).optional(),
  /** Present only once `capture_headset_view` has taken a still. */
  headsetView: z.lazy(() => bridgeHeadsetViewSchema).optional(),
}).strict();

/**
 * One still from the headset, beside `capture` rather than inside it.
 *
 * `views` may hold a single entry, because the in-page path reads one eye and a
 * device capture returns the composited panel as one frame it cannot split.
 * `source` says which produced it: `page` is the page's own WebGL read of the
 * molecular scene, `device` is the headset's display buffer over adb, which
 * also shows the passthrough room and system UI. `file` carries its own
 * extension, because the two sources do not agree on a format.
 */
export const bridgeHeadsetViewSchema = z.object({
  at: isoInstantSchema,
  file: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, 'Expected a bridge file name.'),
  mediaType: z.enum(['image/jpeg', 'image/png']),
  source: z.enum(['page', 'device']),
  width: dimensionSchema,
  height: dimensionSchema,
  bytes: z.number().int().positive().max(BRIDGE_MAX_CAPTURE_BYTES),
  views: z.array(viewSchema.extend({ eye: z.enum(['left', 'right', 'none']) }).strict()).min(1).max(2),
  sha256: sha256Schema,
}).strict();

/**
 * One transcribed utterance. `model` is a file name, not a path: the assistant
 * needs to know which whisper model produced the text, not where it lives.
 *
 * `receivedAt` is when the last audio chunk arrived, stamped before
 * the recognizer runs. `transcribedAt` (Unix milliseconds) is when its text
 * was accepted and `recognizerMs` how long recognition took, so a reader can
 * tell the upload from the recognition instead of charging both to delivery.
 * Both are optional: a record written before these fields carries neither.
 */
export const bridgeVoiceSchema = z.object({
  utteranceId: z.string().uuid(),
  text: z.string().max(2_000),
  durationMs: z.number().int().nonnegative().max(600_000),
  receivedAt: isoInstantSchema,
  transcribedAt: z.number().int().nonnegative().optional(),
  recognizerMs: z.number().int().nonnegative().max(600_000).optional(),
  model: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/, 'Expected a model file name.'),
}).strict();

export type BridgeStateInput = z.output<typeof bridgeStateInputSchema>;
export type BridgeVoice = z.output<typeof bridgeVoiceSchema>;
export type BridgeHeadsetView = z.output<typeof bridgeHeadsetViewSchema>;
export type BridgeView = z.output<typeof viewSchema>;

export type BridgeCaptureInput = {
  /** When the framebuffer was read, not when it was written here. */
  at: string;
  width: number;
  height: number;
  views: readonly BridgeView[];
  /** Both-eye framebuffer PNG, exactly as `companion-browser.ts` encodes it. */
  paired: Buffer;
  /** Left-eye crop PNG. */
  left: Buffer;
};

export type BridgeState = BridgeStateInput & {
  schema: typeof BRIDGE_SCHEMA_ID;
  revision: number;
  capture: {
    at: string; file: string; leftFile: string; width: number; height: number;
    views: BridgeView[]; sha256: string;
  };
  writtenAt: string;
  staleAfterMs: number;
};

/**
 * Drop token-shaped keys anywhere in the object, before validation.
 *
 * The strict schema would already reject an unknown key, but rejecting is the
 * wrong failure for a caller that simply passed its whole freshness quadruple:
 * stripping lets the honest call succeed while making the leak impossible.
 */
export function stripCapabilityFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(entry => stripCapabilityFields(entry)) as unknown as T;
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (CAPABILITY_KEY_PATTERN.test(key) && !(CAPABILITY_KEY_ALLOWLIST.has(key) && typeof entry === 'number')) continue;
    if (typeof entry === 'string' && CAPABILITY_VALUE_PATTERN.test(entry)) continue;
    result[key] = stripCapabilityFields(entry);
  }
  return result as T;
}

/** Count, digest and at most eight samples. The full key array is never written. */
export function summariseSelection(selectionKeys: readonly string[]): BridgeStateInput['selection'] {
  const sorted = [...selectionKeys].sort();
  return {
    count: selectionKeys.length,
    digest: createHash('sha256').update(sorted.join('\n')).digest('hex'),
    sample: sorted.slice(0, BRIDGE_SELECTION_SAMPLE),
  };
}

export function bridgeRevisionPrefix(revision: number): string {
  if (!Number.isInteger(revision) || revision < 0 || revision > BRIDGE_MAX_REVISION) {
    throw new Error(`A bridge revision must be an integer from 0 through ${BRIDGE_MAX_REVISION}.`);
  }
  return String(revision).padStart(BRIDGE_REVISION_DIGITS, '0');
}

function pngDimensions(bytes: Buffer, label: string): { width: number; height: number } {
  if (bytes.byteLength < 24 || bytes.readUInt32BE(0) !== PNG_MAGIC) throw new Error(`The ${label} capture is not a PNG.`);
  if (bytes.byteLength > BRIDGE_MAX_CAPTURE_BYTES) throw new Error(`The ${label} capture is unreasonably large.`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function assertNotSymbolicLink(path: string, label: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error(`The bridge ${label} must not be a symbolic link: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Create the directory pair with 0700, refusing a symlinked or non-directory target. */
export async function ensureBridgeDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new Error('The bridge directory must be an absolute path.');
  const root = resolve(directory);
  for (const path of [root, join(root, BRIDGE_HISTORY_DIR)]) {
    const label = path === root ? 'directory' : 'history directory';
    if (await assertNotSymbolicLink(path, label)) {
      if (!(await stat(path)).isDirectory()) throw new Error(`The bridge ${label} exists and is not a directory: ${path}`);
    } else {
      await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
    }
    // `mkdir`'s mode is masked by the process umask, so set it explicitly.
    await chmod(path, DIRECTORY_MODE);
  }
  return root;
}

/**
 * The binary sibling of `writeLocalControlState`.
 *
 * That helper JSON-stringifies its value, so it cannot carry a PNG. This keeps
 * the identical algorithm — `.<basename>.<12-hex>.tmp`, `flag: 'wx'`,
 * `mode: 0o600`, refuse a symlinked target, then `rename` — because the
 * atomicity guarantee the readers rely on comes from that exact sequence.
 */
async function writeAtomicBytes(path: string, bytes: Buffer): Promise<void> {
  await assertNotSymbolicLink(path, 'capture file');
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: FILE_MODE });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** History names are unique per revision, so they are written once with `wx` and never replaced. */
async function writeHistoryFile(path: string, bytes: Buffer | string): Promise<void> {
  await assertNotSymbolicLink(path, 'history file');
  await writeFile(path, bytes, { flag: 'wx', mode: FILE_MODE });
}

const HISTORY_SUFFIXES = Object.freeze(['state.json', 'capture.png', 'capture-left.png', ...Object.values(BRIDGE_HEADSET_VIEW_FILES)]);
const HISTORY_ENTRY = new RegExp(`^(\\d{${BRIDGE_REVISION_DIGITS}})-(${HISTORY_SUFFIXES.map(suffix => suffix.replace(/\./gu, '\\.')).join('|')})$`);

async function historyRevisions(historyDirectory: string): Promise<number[]> {
  const entries = await readdir(historyDirectory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw error;
  });
  const revisions = new Set<number>();
  for (const entry of entries) {
    const match = HISTORY_ENTRY.exec(entry);
    if (match) revisions.add(Number(match[1]));
  }
  return [...revisions].sort((left, right) => left - right);
}

/**
 * Keep the newest twenty revisions and stay under the byte cap.
 *
 * The newest revision is never pruned even when it alone exceeds the cap: the
 * alternative is a bridge that deletes the evidence it just produced.
 */
async function pruneHistory(historyDirectory: string): Promise<void> {
  let revisions = await historyRevisions(historyDirectory);
  const remove = async (revision: number) => {
    const prefix = bridgeRevisionPrefix(revision);
    for (const suffix of HISTORY_SUFFIXES) {
      await rm(join(historyDirectory, `${prefix}-${suffix}`), { force: true });
    }
  };
  while (revisions.length > BRIDGE_HISTORY_REVISIONS) await remove(revisions.shift()!);

  const sizeOf = async (revision: number) => {
    const prefix = bridgeRevisionPrefix(revision);
    let bytes = 0;
    for (const suffix of HISTORY_SUFFIXES) {
      const entry = await stat(join(historyDirectory, `${prefix}-${suffix}`)).catch(() => null);
      if (entry?.isFile()) bytes += entry.size;
    }
    return bytes;
  };
  const sizes = new Map<number, number>();
  let total = 0;
  for (const revision of revisions) { const bytes = await sizeOf(revision); sizes.set(revision, bytes); total += bytes; }
  while (total > BRIDGE_HISTORY_MAX_BYTES && revisions.length > 1) {
    const oldest = revisions.shift()!;
    total -= sizes.get(oldest) ?? 0;
    await remove(oldest);
  }
}

function assertCaptureGeometry(capture: BridgeCaptureInput): BridgeView[] {
  const views = z.array(viewSchema).length(2).parse(capture.views);
  const width = dimensionSchema.parse(capture.width);
  const height = dimensionSchema.parse(capture.height);
  if ([...new Set(views.map(view => view.eye))].length !== 2) throw new Error('A bridge capture needs one left and one right view.');
  for (const view of views) {
    if (view.x + view.width > width || view.y + view.height > height) {
      throw new Error(`The ${view.eye} view lies outside the ${width}x${height} framebuffer.`);
    }
  }
  const paired = pngDimensions(capture.paired, 'both-eye');
  if (paired.width !== width || paired.height !== height) throw new Error('The both-eye PNG was scaled or cropped away from the framebuffer.');
  const leftView = views.find(view => view.eye === 'left')!;
  const left = pngDimensions(capture.left, 'left-eye');
  if (left.width !== leftView.width || left.height !== leftView.height) throw new Error('The left-eye PNG does not match its viewport.');
  return views;
}

export type BridgeHeadsetViewInput = {
  at: string;
  mediaType: 'image/jpeg' | 'image/png';
  source: 'page' | 'device';
  width: number;
  height: number;
  views: readonly { eye: 'left' | 'right' | 'none'; x: number; y: number; width: number; height: number }[];
  bytes: Buffer;
};

/**
 * Publish one headset still, image and descriptor, without a scene revision.
 *
 * `capture_headset_view` carries no session binding, so it cannot produce the
 * scene half of `state.json`. This writes the pair the assistant can read on
 * its own, exactly as `writeBridgeVoice` does for a spoken line, and the next
 * full revision folds the descriptor into `state.json`.
 *
 * The stable name carries the media type's own extension, so the other one is
 * removed rather than left beside it pointing at an older frame.
 */
export async function writeBridgeHeadsetView(directory: string, input: BridgeHeadsetViewInput): Promise<BridgeHeadsetView> {
  if (!Buffer.isBuffer(input?.bytes) || input.bytes.byteLength === 0) throw new Error('A headset view needs image bytes.');
  const file = BRIDGE_HEADSET_VIEW_FILES[input.mediaType];
  if (!file) throw new Error('A headset view must be a JPEG or a PNG.');
  const record = bridgeHeadsetViewSchema.parse(stripCapabilityFields({
    at: input.at, file, mediaType: input.mediaType, source: input.source,
    width: input.width, height: input.height, bytes: input.bytes.byteLength,
    views: input.views.map(view => ({ ...view })),
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
  }));
  for (const view of record.views) {
    if (view.x + view.width > record.width || view.y + view.height > record.height) {
      throw new Error(`The ${view.eye} view lies outside the ${record.width}x${record.height} still.`);
    }
  }
  const root = await ensureBridgeDirectory(directory);
  await writeAtomicBytes(join(root, file), input.bytes);
  for (const other of Object.values(BRIDGE_HEADSET_VIEW_FILES)) {
    if (other !== file) await rm(join(root, other), { force: true });
  }
  const path = join(root, BRIDGE_HEADSET_VIEW_STATE_FILE);
  await assertNotSymbolicLink(path, 'headset view file');
  await writeLocalControlState(path, record);
  return record;
}

/** The last headset still, or `undefined` when none was taken or the file is unreadable. */
export async function readBridgeHeadsetView(directory: string): Promise<BridgeHeadsetView | undefined> {
  try {
    return bridgeHeadsetViewSchema.parse(JSON.parse(await readFile(join(resolve(directory), BRIDGE_HEADSET_VIEW_STATE_FILE), 'utf8')));
  } catch { return undefined; }
}

/** Replace `voice.json` atomically, at 0600, inside a bridge directory. */
export async function writeBridgeVoice(directory: string, record: unknown): Promise<BridgeVoice> {
  const voice = bridgeVoiceSchema.parse(stripCapabilityFields(record));
  const root = await ensureBridgeDirectory(directory);
  const path = join(root, BRIDGE_VOICE_FILE);
  await assertNotSymbolicLink(path, 'voice file');
  await writeLocalControlState(path, voice);
  return voice;
}

/** The last utterance, or `undefined` when nothing was said or the file is unreadable. */
export async function readBridgeVoice(directory: string): Promise<BridgeVoice | undefined> {
  try {
    return bridgeVoiceSchema.parse(JSON.parse(await readFile(join(resolve(directory), BRIDGE_VOICE_FILE), 'utf8')));
  } catch { return undefined; }
}

/**
 * Write one revision, in the order the staleness rule depends on.
 *
 * `state.json` goes last so a reader that sees revision N is guaranteed the
 * PNG for revision N is already in place, and `capture.sha256` lets that
 * reader detect a torn read rather than trusting the JSON alone.
 */
export async function writeHeadsetBridge(options: {
  directory: string;
  revision: number;
  state: unknown;
  capture: BridgeCaptureInput;
  now?: () => Date;
}): Promise<BridgeState> {
  const root = await ensureBridgeDirectory(options.directory);
  const history = join(root, BRIDGE_HISTORY_DIR);
  const prefix = bridgeRevisionPrefix(options.revision);
  const views = assertCaptureGeometry(options.capture);
  // A caller that already carries `voice` wins; otherwise the latest utterance
  // on disk is folded in, so speech and pixels arrive on one revision.
  const record = Boolean(options.state) && typeof options.state === 'object' ? options.state as Record<string, unknown> : undefined;
  const spoken = record && 'voice' in record ? undefined : await readBridgeVoice(root);
  // The headset still is folded in the same way, so one revision carries the
  // scene, what the wearer said, and what they were looking at.
  const seen = record && 'headsetView' in record ? undefined : await readBridgeHeadsetView(root);
  const scene = bridgeStateInputSchema.parse(stripCapabilityFields(
    record ? { ...record, ...(spoken ? { voice: spoken } : {}), ...(seen ? { headsetView: seen } : {}) } : options.state));
  const now = options.now?.() ?? new Date();

  const state: BridgeState = {
    schema: BRIDGE_SCHEMA_ID,
    revision: options.revision,
    ...scene,
    capture: {
      at: isoInstantSchema.parse(options.capture.at),
      file: BRIDGE_CAPTURE_FILE,
      leftFile: BRIDGE_CAPTURE_LEFT_FILE,
      width: options.capture.width,
      height: options.capture.height,
      views,
      sha256: createHash('sha256').update(options.capture.paired).digest('hex'),
    },
    writtenAt: now.toISOString(),
    staleAfterMs: BRIDGE_STALE_AFTER_MS,
  };
  const serialised = `${JSON.stringify(state, null, 2)}\n`;

  await writeHistoryFile(join(history, `${prefix}-capture.png`), options.capture.paired);
  await writeHistoryFile(join(history, `${prefix}-capture-left.png`), options.capture.left);
  // A revision that names a headset still keeps its own copy, so `history/`
  // stays comparable across revisions rather than pointing at one live file.
  if (scene.headsetView) {
    const still = await readFile(join(root, scene.headsetView.file)).catch(() => undefined);
    if (still && createHash('sha256').update(still).digest('hex') === scene.headsetView.sha256) {
      await writeHistoryFile(join(history, `${prefix}-${scene.headsetView.file}`), still).catch(() => {});
    }
  }
  await writeAtomicBytes(join(root, BRIDGE_CAPTURE_FILE), options.capture.paired);
  await writeAtomicBytes(join(root, BRIDGE_CAPTURE_LEFT_FILE), options.capture.left);
  await writeHistoryFile(join(history, `${prefix}-state.json`), serialised);
  await assertNotSymbolicLink(join(root, BRIDGE_STATE_FILE), 'state file');
  await writeLocalControlState(join(root, BRIDGE_STATE_FILE), state);
  await pruneHistory(history);
  return state;
}

export type HeadsetBridgeWriter = {
  directory: string;
  revision: () => number;
  write: (state: unknown, capture: BridgeCaptureInput) => Promise<BridgeState>;
};

/**
 * A writer that owns the monotonic `revision` counter and serialises writes.
 *
 * The counter resumes above whatever `history/` already holds, so restarting
 * the harness against an existing bridge never replays a revision a reader has
 * already seen. Writes are chained rather than run concurrently, because the
 * four-step order is the whole guarantee.
 */
export async function createHeadsetBridgeWriter(directory: string): Promise<HeadsetBridgeWriter> {
  const root = await ensureBridgeDirectory(directory);
  const existing = await historyRevisions(join(root, BRIDGE_HISTORY_DIR));
  let next = existing.length ? existing[existing.length - 1]! + 1 : 1;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    directory: root,
    revision: () => next,
    write(state, capture) {
      const run = queue.then(async () => {
        const revision = next;
        const written = await writeHeadsetBridge({ directory: root, revision, state, capture });
        next = revision + 1;
        return written;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
