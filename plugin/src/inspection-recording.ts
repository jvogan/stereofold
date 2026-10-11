/**
 * Bounded canvas-only recording for the inspector.
 *
 * The canvas is deliberately the only input: browser chrome, inspector
 * controls, and headset room views cannot enter the recording. Lesson/tour
 * control remains outside this module; callers start it after the desired
 * scene has rendered.
 */

export const INSPECTION_RECORDING_DURATION_MS = 10_000;
export const INSPECTION_RECORDING_FRAME_RATE = 30;
export const INSPECTION_RECORDING_TIMESLICE_MS = 250;
const MAX_RECORDING_DURATION_MS = INSPECTION_RECORDING_DURATION_MS;
const MAX_FRAME_RATE = 60;

export interface RecordingCanvas {
  captureStream(frameRate?: number): RecordingMediaStream;
}

export interface InspectionCanvasRoot {
  querySelector(selector: string): unknown;
}

export interface RecordingMediaStream {
  getTracks(): readonly RecordingMediaStreamTrack[];
}

export interface RecordingMediaStreamTrack {
  stop(): void;
}

export interface RecordingDataAvailableEvent {
  data: Blob;
}

export interface RecordingErrorEvent {
  error?: unknown;
}

export interface RecordingMediaRecorder {
  readonly state: 'inactive' | 'recording' | 'paused' | string;
  readonly mimeType: string;
  ondataavailable: ((event: RecordingDataAvailableEvent) => void) | null;
  onerror: ((event: RecordingErrorEvent) => void) | null;
  onstop: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface RecordingMediaRecorderConstructor {
  new (stream: RecordingMediaStream, options?: { mimeType?: string }): RecordingMediaRecorder;
  isTypeSupported?(mimeType: string): boolean;
}

export interface InspectionRecording {
  blob: Blob;
  mimeType: string;
  durationMs: typeof INSPECTION_RECORDING_DURATION_MS;
  frameRate: number;
}

export interface InspectionRecordingOptions {
  /** Test-only seam; production callers use the browser's MediaRecorder. */
  mediaRecorder?: RecordingMediaRecorderConstructor;
  /** Test-only seam; production callers use the browser's timer. */
  setTimeout?: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setTimeout>;
  /** Test-only seam; production callers use the browser's timer. */
  clearTimeout?: (handle: ReturnType<typeof globalThis.setTimeout>) => void;
  frameRate?: number;
  /** Request a fresh canvas paint while recording an otherwise static view. */
  requestDraw?: () => void;
  /** Cancel immediately when the owning desktop view closes or enters XR. */
  signal?: AbortSignal;
}

export const INSPECTION_RECORDING_MIME_TYPES = Object.freeze([
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const);

function recordingFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Resolve the workspace's molecular canvas without ever including its UI. */
export function findInspectionCanvas(root: InspectionCanvasRoot = globalThis.document): RecordingCanvas {
  const canvas = root.querySelector('#scene > canvas') as Partial<RecordingCanvas> | null;
  if (!canvas || typeof canvas.captureStream !== 'function') {
    throw recordingFailure('recording_canvas_unavailable', 'The inspector molecular canvas is unavailable.');
  }
  return canvas as RecordingCanvas;
}

function browserMediaRecorder(): RecordingMediaRecorderConstructor | undefined {
  const candidate = (globalThis as unknown as { MediaRecorder?: RecordingMediaRecorderConstructor }).MediaRecorder;
  return candidate;
}

export function chooseInspectionRecordingMimeType(
  mediaRecorder: RecordingMediaRecorderConstructor,
  candidates: readonly string[] = INSPECTION_RECORDING_MIME_TYPES,
): string {
  const supported = mediaRecorder.isTypeSupported;
  if (typeof supported === 'function') {
    for (const candidate of candidates) {
      if (supported.call(mediaRecorder, candidate)) return candidate;
    }
    throw recordingFailure('recording_unsupported', 'This browser has no supported WebM MediaRecorder format.');
  }
  return candidates[candidates.length - 1] ?? 'video/webm';
}

function errorFromRecordingEvent(event: RecordingErrorEvent): Error {
  if (event.error instanceof Error) return event.error;
  if (event.error && typeof event.error === 'object' && 'message' in event.error
      && typeof event.error.message === 'string') return Error(event.error.message);
  return Error('The browser MediaRecorder failed while recording the inspector canvas.');
}

/**
 * Record exactly the bounded ten-second inspector presentation.
 *
 * The returned WebM has no audio track. A caller may provide separately
 * authored OAuth narration after downloading it; this helper never captures
 * microphone, room audio, or headset state.
 */
export function recordInspectionCanvas(
  canvas: RecordingCanvas,
  options: InspectionRecordingOptions = {},
): Promise<InspectionRecording> {
  if (options.signal?.aborted) {
    return Promise.reject(recordingFailure('recording_aborted', 'The desktop preview was cancelled.'));
  }
  const mediaRecorder = options.mediaRecorder ?? browserMediaRecorder();
  if (!mediaRecorder) {
    return Promise.reject(recordingFailure('recording_unsupported', 'This browser does not expose MediaRecorder.'));
  }
  if (!canvas || typeof canvas.captureStream !== 'function') {
    return Promise.reject(recordingFailure('recording_canvas_unavailable', 'The inspector canvas is unavailable.'));
  }
  const frameRate = options.frameRate ?? INSPECTION_RECORDING_FRAME_RATE;
  if (!Number.isInteger(frameRate) || frameRate < 1 || frameRate > MAX_FRAME_RATE) {
    return Promise.reject(recordingFailure('recording_invalid_frame_rate', `Frame rate must be an integer from 1 to ${MAX_FRAME_RATE}.`));
  }
  let mimeType: string;
  try {
    mimeType = chooseInspectionRecordingMimeType(mediaRecorder);
  } catch (error) {
    return Promise.reject(error);
  }
  const setTimer = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);

  let stream: RecordingMediaStream;
  try {
    stream = canvas.captureStream(frameRate);
  } catch (error) {
    return Promise.reject(Object.assign(error instanceof Error ? error : Error(String(error)), { code: 'recording_canvas_unavailable' }));
  }

  let recorder: RecordingMediaRecorder;
  try {
    recorder = new mediaRecorder(stream, { mimeType });
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    return Promise.reject(Object.assign(error instanceof Error ? error : Error(String(error)), { code: 'recording_unsupported' }));
  }

  return new Promise<InspectionRecording>((resolve, reject) => {
    const chunks: BlobPart[] = [];
    let settled = false;
    let durationReached = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let drawTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const stopDrawing = () => {
      if (drawTimer !== undefined) clearTimer(drawTimer);
      drawTimer = undefined;
    };
    const cleanup = () => {
      stopDrawing();
      options.signal?.removeEventListener('abort', abort);
      if (timer !== undefined) clearTimer(timer);
      for (const track of stream.getTracks()) track.stop();
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      // An error may arrive while the recorder is still active. Stop it
      // before detaching handlers so the browser releases its encoder; the
      // original error remains the promise result even if stop also fails.
      if (error && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* Preserve the original failure. */ }
      }
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      if (chunks.length === 0) {
        reject(recordingFailure('recording_empty', 'The browser MediaRecorder produced no video data.'));
        return;
      }
      const actualMimeType = recorder.mimeType || mimeType;
      resolve({ blob: new Blob(chunks, { type: actualMimeType }), mimeType: actualMimeType,
        durationMs: INSPECTION_RECORDING_DURATION_MS, frameRate });
    };
    const abort = () => finish(recordingFailure('recording_aborted', 'The desktop preview was cancelled.'));
    const requestDraw = () => {
      drawTimer = undefined;
      if (settled || durationReached || recorder.state !== 'recording') return;
      try {
        options.requestDraw?.();
        if (!settled && !durationReached && recorder.state === 'recording') {
          drawTimer = setTimer(requestDraw, 1000 / frameRate);
        }
      } catch (error) {
        finish(Object.assign(error instanceof Error ? error : Error(String(error)), { code: 'recording_failed' }));
      }
    };
    recorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = event => finish(errorFromRecordingEvent(event));
    recorder.onstop = () => finish(durationReached ? undefined
      : recordingFailure('recording_ended_early', 'The browser MediaRecorder stopped before the ten-second recording completed.'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    try {
      recorder.start(INSPECTION_RECORDING_TIMESLICE_MS);
      const scheduled = setTimer(() => {
        durationReached = true;
        stopDrawing();
        if (settled || recorder.state === 'inactive') return;
        try { recorder.stop(); } catch (error) {
          finish(Object.assign(error instanceof Error ? error : Error(String(error)), { code: 'recording_failed' }));
        }
      }, MAX_RECORDING_DURATION_MS);
      if (settled) clearTimer(scheduled);
      else timer = scheduled;
      if (options.requestDraw) requestDraw();
    } catch (error) {
      finish(Object.assign(error instanceof Error ? error : Error(String(error)), { code: 'recording_failed' }));
    }
  });
}

export interface InspectionRecordingDownloadTarget {
  document?: Document;
  url?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
  filename?: string;
}

/** Trigger a normal browser download and return a cleanup function. */
export function downloadInspectionRecording(
  recording: InspectionRecording,
  options: InspectionRecordingDownloadTarget = {},
): () => void {
  const documentRef = options.document ?? globalThis.document;
  const urlRef = options.url ?? globalThis.URL;
  if (!documentRef || !urlRef?.createObjectURL) {
    throw recordingFailure('recording_download_unsupported', 'This browser cannot create a recording download.');
  }
  const objectUrl = urlRef.createObjectURL(recording.blob);
  const anchor = documentRef.createElement('a');
  anchor.href = objectUrl;
  anchor.download = options.filename ?? 'stereofold-inspection-10s.webm';
  anchor.rel = 'noopener';
  anchor.click();
  return () => urlRef.revokeObjectURL(objectUrl);
}
