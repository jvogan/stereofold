/**
 * The desktop panel's half of the live view (see `live-view.ts`).
 *
 * While the host's poll answer carries a `liveViewRequest`, this copies the
 * Mol* canvas into a small 2D canvas right after a draw, at most once per
 * requested interval, and posts it as a JPEG. The copy is made inside Mol*'s
 * own `didDraw` notification, while the drawing buffer still holds the frame,
 * so the WebGL context needs no `preserveDrawingBuffer` and the renderer does
 * no extra work: a scene that is not drawing is not captured. A draw that was
 * skipped because it came too soon is owed a picture, so a timer asks Mol* for
 * one more draw once the interval has passed, and the last state after a
 * motion stops is the one the file ends on.
 *
 * Mol*'s `didDraw` is a BehaviorSubject: subscribing replays its last value at
 * once, outside any draw, when the buffer may already be cleared. That replay
 * is ignored. The binding a picture is posted under is read when its pixels
 * are copied, and a picture whose capture was stopped or restarted while it
 * was being encoded is dropped, so pixels never travel under a newer source.
 */

export type LiveViewRequest = { intervalMs: number; maxWidth: number };
export type LiveViewPicture = { image: string; width: number; height: number };

type Subscription = { unsubscribe(): void };
export type LiveViewCanvas3d = {
  didDraw: { subscribe(next: () => void): Subscription };
  requestDraw(): void;
};
type SourceCanvas = { width: number; height: number };
type CopyCanvas = { width: number; height: number;
  getContext(kind: '2d'): { drawImage(source: unknown, x: number, y: number, width: number, height: number): void } | null };

export type LiveViewCaptureDeps<Context = unknown> = {
  canvas3d: () => LiveViewCanvas3d | undefined;
  canvas: () => SourceCanvas | undefined;
  /** What the picture is posted under, read when its pixels are copied; undefined skips the copy. */
  context: () => Context | undefined;
  /** True while the panel is loading, hidden or closed: no copy is made then. */
  paused?: () => boolean;
  /** Posts one picture under the context read at its copy; rejects when the host refuses it. */
  submit: (picture: LiveViewPicture, context: Context) => Promise<void>;
  /** Encodes the copy as base64 JPEG without a data: prefix. */
  encode?: (copy: CopyCanvas) => Promise<string>;
  createCanvas?: () => CopyCanvas;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

const JPEG_QUALITY = 0.72;
const MIN_INTERVAL_MS = 250;
const MAX_BACKOFF_MS = 10_000;

/** Fit the source into `maxWidth`, keeping its aspect ratio and an even size. */
export function liveViewSize(source: SourceCanvas, maxWidth: number): { width: number; height: number } | undefined {
  if (!(source.width > 0) || !(source.height > 0)) return undefined;
  const scale = Math.min(1, maxWidth / source.width);
  const width = Math.max(16, Math.round(source.width * scale / 2) * 2);
  const height = Math.max(16, Math.round(source.height * scale / 2) * 2);
  return { width, height };
}

function browserEncode(copy: CopyCanvas): Promise<string> {
  return new Promise((resolve, reject) => {
    (copy as unknown as HTMLCanvasElement).toBlob(blob => {
      if (!blob) { reject(Error('The live view picture could not be encoded.')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? Error('The live view picture could not be read.'));
      reader.onload = () => {
        const url = String(reader.result ?? '');
        const comma = url.indexOf(',');
        if (comma < 0) reject(Error('The live view picture could not be read.'));
        else resolve(url.slice(comma + 1));
      };
      reader.readAsDataURL(blob);
    }, 'image/jpeg', JPEG_QUALITY);
  });
}

export function createLiveViewCapture<Context>(deps: LiveViewCaptureDeps<Context>) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const encode = deps.encode ?? browserEncode;
  const createCanvas = deps.createCanvas ?? (() => document.createElement('canvas') as unknown as CopyCanvas);
  let request: LiveViewRequest | undefined;
  let subscription: Subscription | undefined;
  let subscribedTo: LiveViewCanvas3d | undefined;
  let timer: unknown;
  let copy: CopyCanvas | undefined;
  let lastAt = -Infinity;
  let owed = false;
  let busy = false;
  let backoffMs = 0;
  let generation = 0;
  let replaying = false;

  const interval = () => Math.max(MIN_INTERVAL_MS, request?.intervalMs ?? 1_000) + backoffMs;

  function capture(): void {
    if (replaying) return;
    if (!request || busy || deps.paused?.()) { owed = true; return; }
    if (now() - lastAt < interval()) { owed = true; return; }
    const source = deps.canvas();
    const size = source ? liveViewSize(source, request.maxWidth) : undefined;
    const context = deps.context();
    if (!source || !size || context === undefined) { owed = true; return; }
    copy ??= createCanvas();
    if (copy.width !== size.width) copy.width = size.width;
    if (copy.height !== size.height) copy.height = size.height;
    const drawing = copy.getContext('2d');
    if (!drawing) return;
    // Synchronous, inside the draw notification: the buffer still holds this frame.
    drawing.drawImage(source, 0, 0, size.width, size.height);
    lastAt = now(); owed = false; busy = true;
    const target = copy, started = generation;
    void encode(target)
      .then(image => request && started === generation ? deps.submit({ image, width: size.width, height: size.height }, context) : undefined)
      .then(() => { backoffMs = 0; }, () => {
        backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(1_000, backoffMs * 2));
        // The picture is still owed: the timer asks for another draw after the backoff.
        if (started === generation) owed = true;
      })
      .finally(() => { busy = false; });
  }

  function tick(): void {
    timer = undefined;
    if (!request) return;
    ensureSubscribed();
    if (owed && !busy && !deps.paused?.() && now() - lastAt >= interval()) deps.canvas3d()?.requestDraw();
    timer = setTimer(tick, interval());
  }

  function ensureSubscribed(): void {
    const canvas3d = deps.canvas3d();
    if (canvas3d === subscribedTo) return;
    subscription?.unsubscribe();
    subscription = undefined; subscribedTo = undefined;
    if (!canvas3d) return;
    subscribedTo = canvas3d;
    replaying = true;
    try { subscription = canvas3d.didDraw.subscribe(() => capture()); }
    finally { replaying = false; }
  }

  function stop(): void {
    request = undefined; generation++;
    subscription?.unsubscribe();
    subscription = undefined; subscribedTo = undefined;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined; owed = false; backoffMs = 0;
  }

  return {
    /** Follow the latest poll answer: a request starts or retunes capture, none stops it. */
    update(next: LiveViewRequest | undefined | null): void {
      const valid = next && Number.isFinite(next.intervalMs) && Number.isFinite(next.maxWidth) && next.maxWidth >= 16;
      if (!valid) { if (request) stop(); return; }
      const starting = !request;
      request = { intervalMs: next.intervalMs, maxWidth: Math.min(4096, Math.floor(next.maxWidth)) };
      ensureSubscribed();
      if (starting) {
        owed = true;
        deps.canvas3d()?.requestDraw();
        timer = setTimer(tick, interval());
      }
    },
    stop,
    get active(): boolean { return request !== undefined; },
  };
}
export type LiveViewCapture = ReturnType<typeof createLiveViewCapture>;
