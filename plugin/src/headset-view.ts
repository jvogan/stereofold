import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * The Mac's eye on the headset.
 *
 * An agent on this machine can already hear the wearer and read the headset's
 * log, but it cannot see the scene, so every visual judgement has been a
 * question put to the person wearing the device. This is the return path for
 * pixels: `capture_headset_view` arms a request, the request rides the
 * `poll_inspection` heartbeat the companion page already runs, the page reads
 * one left-eye frame out of the live XR presentation buffer and posts a small
 * JPEG back on `submit_headset_view`.
 *
 * The store holds one image per session and nothing else. It is a live window,
 * not a record: nothing reaches disk from here, nothing survives the process,
 * and a new capture replaces the old one. The bytes are the wearer's view of a
 * structure they opened themselves, and they never leave this Mac unless the
 * agent asks for the file.
 */

/** Width the page downscales one eye to before reading it back. */
export const HEADSET_VIEW_DEFAULT_WIDTH = 480;
export const HEADSET_VIEW_MIN_WIDTH = 160;
export const HEADSET_VIEW_MAX_WIDTH = 640;
/**
 * What a caller may ask `capture_headset_view` for, which is not what the page
 * can give.
 *
 * The page reads one eye and 640 is its ceiling. The device source reads the
 * whole composited panel, 3664x1920 on a Quest 2, and the spatial menu's text
 * stops being readable below about a thousand pixels wide, so one knob serves
 * both and the caller's number is clamped to `HEADSET_VIEW_MAX_WIDTH` before it
 * reaches the page.
 */
export const HEADSET_VIEW_MAX_REQUEST_WIDTH = 2_048;
/**
 * Height is not bounded by the width.
 *
 * The page keeps the eye's aspect: it picks a width and derives the height
 * from `viewportHeight / viewportWidth`. A Quest 2 eye is taller than it is
 * wide (864x950 at framebuffer scale 0.6, aspect 1.0995), so a 640-wide
 * capture is 704 tall. Bounding height by `HEADSET_VIEW_MAX_WIDTH` rejected
 * every capture above about 582 px wide: a real 640x704 frame came back as
 * `request_failed`.
 * Twice the width covers any eye aspect a headset can present.
 */
export const HEADSET_VIEW_MAX_HEIGHT = HEADSET_VIEW_MAX_WIDTH * 2;
export const HEADSET_VIEW_DEFAULT_QUALITY = 0.6;
/** Base64 ceiling for one upload. Well inside the 2 MiB companion tool body. */
export const HEADSET_VIEW_MAX_BASE64 = 1_400_000;
/** How long `capture_headset_view` waits for the page before it reports back. */
export const HEADSET_VIEW_WAIT_MS = 4_000;
/** A request nobody claimed is forgotten after this. */
export const HEADSET_VIEW_REQUEST_TTL_MS = 15_000;
/** Sessions that may hold a latest frame at once. */
export const HEADSET_VIEW_MAX_SESSIONS = 4;

/** What one capture answer carries, beside the session binding. */
export const headsetViewFrameShape = {
  requestId: z.string().uuid(),
  status: z.enum(['captured', 'failed']),
  reason: z.string().max(200).optional(),
  eye: z.enum(['left', 'right', 'none']).optional(),
  width: z.number().int().min(1).max(HEADSET_VIEW_MAX_WIDTH).optional(),
  height: z.number().int().min(1).max(HEADSET_VIEW_MAX_HEIGHT).optional(),
  mime: z.literal('image/jpeg').optional(),
  path: z.string().max(40).optional(),
  frameMs: z.number().nonnegative().max(10_000).optional(),
  capturedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  framebufferWidth: z.number().int().nonnegative().max(16_384).optional(),
  framebufferHeight: z.number().int().nonnegative().max(16_384).optional(),
  directReadable: z.boolean().optional(),
  /** Present when every sampled pixel of the eye read back as this one colour. */
  flatColor: z.string().regex(/^#[0-9a-f]{6}$/u).optional(),
  flatChecked: z.boolean().optional(),
  /** Whether the eye's centre pixel, read straight off the layer in the same frame, held anything. */
  probeLit: z.boolean().optional(),
  data: z.string().min(4).max(HEADSET_VIEW_MAX_BASE64).regex(/^[A-Za-z0-9+/]*={0,2}$/u, 'Expected base64.').optional(),
} as const;

export const captureHeadsetViewSchema = z.object({
  /**
   * Which way to look. "page" is the companion page's own read of the
   * immersive frame, "device" is the headset's composited display buffer over
   * adb, and "auto" tries the page first and falls back to the device.
   */
  source: z.enum(['auto', 'page', 'device']).optional(),
  maxWidth: z.number().int().min(HEADSET_VIEW_MIN_WIDTH).max(HEADSET_VIEW_MAX_REQUEST_WIDTH).optional(),
  quality: z.number().min(0.3).max(0.95).optional(),
  waitMs: z.number().int().min(500).max(10_000).optional(),
  /** Absolute `.jpg`, `.jpeg` or `.png` path; the saved extension follows the actual format. */
  savePath: z.string().min(1).max(1024).optional(),
  /** Scope page capture to this session's current source; device capture remains unbound. */
  sessionId: z.string().max(128).optional(),
}).strict();
export type CaptureHeadsetViewInput = z.output<typeof captureHeadsetViewSchema>;

export type HeadsetViewRequest = {
  id: string;
  maxWidth: number;
  quality: number;
  createdAt: number;
  claimedBy?: string;
  /** Bound when requested explicitly, otherwise when the first page claims it. */
  claimedView?: { sessionId: string; sourceToken: string; serverEpoch: string };
};

export type HeadsetViewFrame = {
  requestId: string;
  sessionId: string;
  panelId: string;
  sourceToken?: string;
  serverEpoch?: string;
  eye: 'left' | 'right' | 'none';
  width: number;
  height: number;
  mime: 'image/jpeg';
  bytes: number;
  /** Milliseconds the page spent inside the XR animation frame taking it. */
  frameMs: number;
  /** Which read path the page took, as the page named it. */
  path: string;
  /** Whether a direct read of the opaque XR framebuffer was permitted there. */
  directReadable: boolean;
  /**
   * The one colour the whole eye showed, when it showed only one. Such a frame
   * is never reported as a capture; see `flatColor` in xr-snapshot.mjs.
   */
  flatColor?: string;
  flatChecked?: boolean;
  /** The page's centre-pixel probe for this frame: false is `[0,0,0,0]` there. */
  probeLit?: boolean;
  framebuffer: { width: number; height: number };
  capturedAt: number;
  receivedAt: number;
  data: Buffer;
};

export type HeadsetViewOutcome =
  | { ok: true; frame: HeadsetViewFrame }
  | { ok: false; reason: string; code?: 'capture_superseded' };

export type HeadsetViewSubmission = { requestId: string; status: 'captured' | 'failed' } & Record<string, unknown>;

export type HeadsetViewStore = {
  /** Arm one capture, optionally pinned to a current session/source before any page polls. */
  request(input?: { maxWidth?: number; quality?: number; view?: HeadsetViewRequest['claimedView'] }): HeadsetViewRequest;
  /** Reoffer an unanswered request only to the original panel and source. */
  claim(panelId: string, view?: HeadsetViewRequest['claimedView']): { id: string; maxWidth: number; quality: number; expiresAt: number } | undefined;
  /** Take one answer from the page. Returns what the waiter will see. */
  submit(sessionId: string, panelId: string, input: HeadsetViewSubmission): HeadsetViewOutcome;
  /** Resolves as soon as this request is answered, or at the deadline. */
  waitFor(requestId: string, timeoutMs: number): Promise<HeadsetViewOutcome | undefined>;
  /** The newest frame this session holds. */
  latest(sessionId?: string): HeadsetViewFrame | undefined;
  /** Drop what one session holds, on detach or source replacement. */
  forget(sessionId: string): void;
  pending(): number;
};

export function createHeadsetViewStore({ now = Date.now, ttlMs = HEADSET_VIEW_REQUEST_TTL_MS,
  maxSessions = HEADSET_VIEW_MAX_SESSIONS }: { now?: () => number; ttlMs?: number; maxSessions?: number } = {}): HeadsetViewStore {
  if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs < 1
    || !Number.isSafeInteger(maxSessions) || maxSessions < 1) {
    throw new TypeError('The headset view store requires bounded lifetime and capacity.');
  }
  let requests: HeadsetViewRequest[] = [];
  const outcomes = new Map<string, HeadsetViewOutcome>();
  const waiters = new Map<string, Set<(value: HeadsetViewOutcome | undefined) => void>>();
  const latest = new Map<string, HeadsetViewFrame>();

  const prune = () => {
    const cutoff = now() - ttlMs;
    requests = requests.filter(entry => entry.createdAt > cutoff);
    // An outcome is only ever read by the one waiter that asked for it, so
    // anything without a live request has already been delivered or abandoned.
    const live = new Set(requests.map(entry => entry.id));
    for (const id of [...outcomes.keys()]) if (!live.has(id)) outcomes.delete(id);
  };
  const wake = (id: string, outcome: HeadsetViewOutcome | undefined) => {
    const listeners = waiters.get(id);
    if (!listeners) return;
    waiters.delete(id);
    for (const listener of listeners) {
      try { listener(outcome); } catch { /* A waiter that throws must not block the next one. */ }
    }
  };

  return {
    request(input) {
      prune();
      const entry: HeadsetViewRequest = {
        id: randomUUID(),
        maxWidth: input?.maxWidth ?? HEADSET_VIEW_DEFAULT_WIDTH,
        quality: input?.quality ?? HEADSET_VIEW_DEFAULT_QUALITY,
        createdAt: now(),
        ...(input?.view ? { claimedView: { ...input.view } } : {}),
      };
      // Only the newest request matters: an agent asks for what the wearer is
      // looking at now, so an older unanswered one is already stale.
      for (const previous of requests) {
        if (!outcomes.has(previous.id)) wake(previous.id, {
          ok: false, code: 'capture_superseded', reason: 'A newer headset capture superseded this request. Ask for another still if needed.',
        });
      }
      requests = [entry];
      outcomes.clear();
      return entry;
    },
    claim(panelId, view) {
      prune();
      if (typeof panelId !== 'string' || !panelId) return undefined;
      const entry = requests.find(candidate => !outcomes.has(candidate.id)
        && (!candidate.claimedBy || candidate.claimedBy === panelId));
      if (!entry) return undefined;
      if (entry.claimedView && (!view || entry.claimedView.sessionId !== view.sessionId
        || entry.claimedView.sourceToken !== view.sourceToken || entry.claimedView.serverEpoch !== view.serverEpoch)) return undefined;
      entry.claimedBy = panelId;
      if (!entry.claimedView && view) entry.claimedView = { ...view };
      return { id: entry.id, maxWidth: entry.maxWidth, quality: entry.quality, expiresAt: entry.createdAt + ttlMs };
    },
    submit(sessionId, panelId, input) {
      prune();
      const entry = requests.find(candidate => candidate.id === input.requestId);
      if (!entry) throw Error('That capture request is no longer current.');
      if (!entry.claimedBy || entry.claimedBy !== panelId) throw Error('That capture request belongs to another panel or has not been claimed.');
      if (entry.claimedView && (entry.claimedView.sessionId !== sessionId
        || entry.claimedView.sourceToken !== input.sourceToken || entry.claimedView.serverEpoch !== input.serverEpoch))
        throw Error('The capture belongs to a changed view. Ask for another one.');
      const settled = outcomes.get(entry.id);
      if (settled) return settled;
      if (input.status === 'failed') {
        const outcome: HeadsetViewOutcome = { ok: false, reason: String(input.reason ?? 'The headset could not take a snapshot.').slice(0, 200) };
        outcomes.set(entry.id, outcome);
        wake(entry.id, outcome);
        return outcome;
      }
      const data = typeof input.data === 'string' ? Buffer.from(input.data, 'base64') : undefined;
      if (!data?.byteLength) throw Error('The capture answer carried no image.');
      // A JPEG starts with SOI. Refusing anything else keeps a mislabelled or
      // truncated upload out of a file the agent is about to open.
      if (data[0] !== 0xff || data[1] !== 0xd8) throw Error('The capture answer was not a JPEG.');
      const frame: HeadsetViewFrame = {
        requestId: entry.id, sessionId, panelId,
        ...(entry.claimedView ? { sourceToken: entry.claimedView.sourceToken, serverEpoch: entry.claimedView.serverEpoch } : {}),
        eye: (input.eye === 'right' || input.eye === 'none' ? input.eye : 'left'),
        width: Number(input.width) || 0, height: Number(input.height) || 0,
        mime: 'image/jpeg', bytes: data.byteLength,
        frameMs: Number(input.frameMs) || 0,
        path: String(input.path ?? 'unknown').slice(0, 40),
        directReadable: input.directReadable === true,
        ...(typeof input.flatColor === 'string' && /^#[0-9a-f]{6}$/u.test(input.flatColor) ? { flatColor: input.flatColor } : {}),
        ...(input.flatChecked === true ? { flatChecked: true } : {}),
        ...(typeof input.probeLit === 'boolean' ? { probeLit: input.probeLit } : {}),
        framebuffer: { width: Number(input.framebufferWidth) || 0, height: Number(input.framebufferHeight) || 0 },
        capturedAt: Number(input.capturedAt) || now(),
        receivedAt: now(),
        data,
      };
      latest.set(sessionId, frame);
      while (latest.size > maxSessions) latest.delete(latest.keys().next().value!);
      const outcome: HeadsetViewOutcome = { ok: true, frame };
      outcomes.set(entry.id, outcome);
      wake(entry.id, outcome);
      return outcome;
    },
    waitFor(requestId, timeoutMs) {
      const settled = outcomes.get(requestId);
      if (settled) return Promise.resolve(settled);
      const retire = () => {
        requests = requests.filter(entry => entry.id !== requestId);
        outcomes.delete(requestId);
        wake(requestId, undefined);
      };
      if (!requests.some(entry => entry.id === requestId)) return Promise.resolve(undefined);
      // A zero-duration lookup is observational; only an admitted wait owns
      // the deadline that retires a request.
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(undefined);
      return new Promise<HeadsetViewOutcome | undefined>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const listener = (outcome: HeadsetViewOutcome | undefined) => { if (timer !== undefined) clearTimeout(timer); resolve(outcome); };
        const listeners = waiters.get(requestId) ?? new Set<(value: HeadsetViewOutcome | undefined) => void>();
        listeners.add(listener);
        waiters.set(requestId, listeners);
        timer = setTimeout(() => {
          // Retire this ID before another heartbeat can start unused GPU work
          // after its caller has returned or fallen back to a device capture.
          retire();
        }, timeoutMs);
        // A pending capture must never hold the process open by itself.
        (timer as any)?.unref?.();
      });
    },
    latest(sessionId) {
      if (sessionId === undefined) return [...latest.values()].at(-1);
      return latest.get(sessionId);
    },
    forget(sessionId) { latest.delete(sessionId); },
    pending() { prune(); return requests.length; },
  };
}

/**
 * Why a page frame is not the wearer's view, or undefined when it is.
 *
 * On the live Quest run of 2026-09-28, with frames near 72 fps, the page
 * answered with an all-black JPEG that its own log described as
 * `probeReadable: true, probeLit: false`, centre pixel `[0,0,0,0]`, and the
 * Mac called it `captured: true`. The page ships in the same build as this
 * server and checks the raw pixels before it encodes them, so its `flatColor`
 * is the one test: a frame that carries it is never the wearer's view. The
 * centre probe is reported beside it and decides nothing, because a
 * passthrough eye with the structure off to one side reads an empty centre too.
 */
export function unlitPageFrame(frame: Pick<HeadsetViewFrame, 'flatChecked' | 'flatColor' | 'probeLit' | 'directReadable'>):
{ reason: string; color?: string } | undefined {
  if (frame.flatChecked !== true) return { reason: 'the page did not report that it checked the frame for a flat colour' };
  if (!frame.flatColor) return undefined;
  const emptyCentre = frame.directReadable && frame.probeLit === false;
  return { color: frame.flatColor,
    reason: `the page's frame was one flat colour, ${frame.flatColor}${emptyCentre ? ', and its centre pixel read empty' : ''}` };
}

/** Where a capture is written when the caller names no path. */
export function defaultHeadsetViewPath(tmpdir: string, at: number, join: (...parts: string[]) => string,
  mediaType: 'image/jpeg' | 'image/png' = 'image/jpeg') {
  const stamp = new Date(at).toISOString().replace(/[:.]/gu, '-').replace(/Z$/u, '');
  return join(tmpdir, 'stereofold-snapshots', `${stamp}.${mediaType === 'image/png' ? 'png' : 'jpg'}`);
}
