import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INSPECTION_RECORDING_DURATION_MS,
  INSPECTION_RECORDING_FRAME_RATE,
  INSPECTION_RECORDING_TIMESLICE_MS,
  chooseInspectionRecordingMimeType,
  downloadInspectionRecording,
  findInspectionCanvas,
  recordInspectionCanvas,
  type RecordingMediaRecorder,
  type RecordingMediaRecorderConstructor,
} from '../src/inspection-recording.js';

afterEach(() => vi.useRealTimers());

function recorderHarness(supported = ['video/webm;codecs=vp9'], stopData: Blob | null | (() => Blob | null) = new Blob(['frame'])) {
  const tracks = [{ stop: vi.fn() }];
  const stream = { getTracks: () => tracks };
  const instances: FakeRecorder[] = [];
  class FakeRecorder implements RecordingMediaRecorder {
    static isTypeSupported(type: string) { return supported.includes(type); }
    readonly state: 'inactive' | 'recording' = 'inactive';
    readonly mimeType = supported[0] ?? 'video/webm';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onerror: ((event: { error?: unknown }) => void) | null = null;
    onstop: (() => void) | null = null;
    startTimeslice: number | undefined;
    stopCalls = 0;
    constructor() { instances.push(this); }
    start(timeslice?: number) { this.startTimeslice = timeslice; (this as { state: string }).state = 'recording'; }
    stop() {
      this.stopCalls++;
      (this as { state: string }).state = 'inactive';
      const data = typeof stopData === 'function' ? stopData() : stopData;
      if (data !== null) this.ondataavailable?.({ data });
      this.onstop?.();
    }
  }
  const mediaRecorder = FakeRecorder as unknown as RecordingMediaRecorderConstructor;
  const canvas = { captureStream: vi.fn(() => stream) };
  return { canvas, tracks, instances, mediaRecorder };
}

describe('bounded inspector canvas recording', () => {
  it.each([false, true])('mounts the actual preview control outside optional lesson UI (companion=%s)', isCompanion => {
    const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const recordingStart = source.indexOf("  const recording=document.createElement('button');");
    const recordingEnd = source.indexOf("  recording.addEventListener('click'", recordingStart);
    const headerStart = source.indexOf("  const headerActions=document.querySelector('.header-actions')!;");
    const headerEnd = source.indexOf('  app.ontoolresult=', headerStart);
    expect(recordingStart).toBeGreaterThan(0);
    expect(headerStart).toBeGreaterThan(recordingEnd);
    const compiled = transformSync(source.slice(recordingStart, recordingEnd) + source.slice(headerStart, headerEnd)
      + '\nreturn recording;', { loader: 'ts', target: 'es2022' }).code;
    class ElementStub {
      parent?: ElementStub;
      children: ElementStub[] = [];
      dataset: Record<string, string> = {};
      hidden = false;
      append(...nodes: ElementStub[]) {
        for (const node of nodes) {
          if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node);
          node.parent = this; this.children.push(node);
        }
      }
      prepend(...nodes: ElementStub[]) { this.append(...nodes); }
      after(node: ElementStub) { this.parent?.append(node); }
      addEventListener() {}
    }
    // Custom structures may have no lesson node. Existing lesson nodes also
    // become hidden when an ordinary structure or an experience takes over.
    for (const hasLesson of [false, true]) {
      const header = new ElementStub(), lesson = new ElementStub(), explore = new ElementStub();
      lesson.hidden = true; lesson.append(explore);
      const document = {
        createElement: () => new ElementStub(), addEventListener() {},
        querySelector: (selector: string) => selector === '.header-actions' ? header
          : selector === '.tour-explore' && hasLesson ? explore : null,
      };
      const scope = { document, isCompanion, connect: new ElementStub(), quest: new ElementStub(),
        handoff: new ElementStub(), displayModeToggle: new ElementStub(), syncHandoff() {} };
      const recording = new Function('scope', `with(scope){${compiled}}`)(scope) as ElementStub;
      const ancestors: ElementStub[] = [];
      for (let node = recording.parent; node; node = node.parent) ancestors.push(node);
      expect(ancestors).toContain(header);
      expect(ancestors).not.toContain(lesson);
      expect(ancestors.every(node => !node.hidden)).toBe(true);
      expect(recording.dataset.recordInspection).toBe('');
    }
  });

  it('resolves only the molecular canvas under #scene', () => {
    const canvas = { captureStream: vi.fn() };
    const root = { querySelector: vi.fn((selector: string) => selector === '#scene > canvas' ? canvas : null) };
    expect(findInspectionCanvas(root)).toBe(canvas);
    expect(root.querySelector).toHaveBeenCalledWith('#scene > canvas');
    expect(() => findInspectionCanvas({ querySelector: () => null })).toThrow(/molecular canvas/);
  });

  it('chooses the first browser-supported WebM format', () => {
    const mediaRecorder = { isTypeSupported: (type: string) => type === 'video/webm' } as unknown as RecordingMediaRecorderConstructor;
    expect(chooseInspectionRecordingMimeType(mediaRecorder)).toBe('video/webm');
  });

  it('records the clean canvas for ten seconds, then closes its tracks', async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const pending = recordInspectionCanvas(harness.canvas, { mediaRecorder: harness.mediaRecorder });
    expect(harness.canvas.captureStream).toHaveBeenCalledWith(INSPECTION_RECORDING_FRAME_RATE);
    expect(harness.instances[0].startTimeslice).toBe(INSPECTION_RECORDING_TIMESLICE_MS);
    await vi.advanceTimersByTimeAsync(INSPECTION_RECORDING_DURATION_MS - 1);
    expect(harness.instances[0].stopCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const recording = await pending;
    expect(recording.durationMs).toBe(INSPECTION_RECORDING_DURATION_MS);
    expect(recording.frameRate).toBe(INSPECTION_RECORDING_FRAME_RATE);
    expect(recording.mimeType).toBe('video/webm;codecs=vp9');
    expect(recording.blob.size).toBeGreaterThan(0);
    expect(harness.instances[0].stopCalls).toBe(1);
    expect(harness.tracks[0].stop).toHaveBeenCalledOnce();
  });

  it('rejects a recorder that stops before the ten-second boundary', async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const pending = recordInspectionCanvas(harness.canvas, { mediaRecorder: harness.mediaRecorder });
    harness.instances[0].stop();
    await expect(pending).rejects.toMatchObject({ code: 'recording_ended_early' });
    expect(harness.tracks[0].stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(INSPECTION_RECORDING_DURATION_MS);
    expect(harness.instances[0].stopCalls).toBe(1);
  });

  it('rejects an empty MediaRecorder result after the bounded interval', async () => {
    vi.useFakeTimers();
    const harness = recorderHarness(['video/webm;codecs=vp9'], null);
    const pending = recordInspectionCanvas(harness.canvas, { mediaRecorder: harness.mediaRecorder });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'recording_empty' });
    await vi.advanceTimersByTimeAsync(INSPECTION_RECORDING_DURATION_MS);
    await rejection;
    expect(harness.tracks[0].stop).toHaveBeenCalledOnce();
  });

  it('stops an active encoder when MediaRecorder reports an error', async () => {
    const harness = recorderHarness();
    const pending = recordInspectionCanvas(harness.canvas, { mediaRecorder: harness.mediaRecorder });
    const rejection = expect(pending).rejects.toThrow('encoder failed');
    harness.instances[0].onerror?.({ error: Error('encoder failed') });
    await rejection;
    expect(harness.instances[0].stopCalls).toBe(1);
    expect(harness.tracks[0].stop).toHaveBeenCalledOnce();
  });

  it('paints a static canvas at the requested cadence only while the recorder is active', async () => {
    vi.useFakeTimers();
    let paintedFrames = 0;
    const harness = recorderHarness(undefined, () => paintedFrames ? new Blob([`frames:${paintedFrames}`]) : null);
    const requestDraw = vi.fn(() => {
      expect(harness.instances[0].state).toBe('recording');
      paintedFrames++;
    });
    const pending = recordInspectionCanvas(harness.canvas, { mediaRecorder: harness.mediaRecorder, frameRate: 10, requestDraw });
    expect(requestDraw).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(requestDraw).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requestDraw).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9900);
    expect(await (await pending).blob.text()).toBe('frames:100');
    expect(harness.tracks[0].stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requestDraw).toHaveBeenCalledTimes(100);
  });

  it('uses the live inspector guard before every desktop repaint', () => {
    const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const recordingCall = source.slice(source.indexOf('const result=await recordInspectionCanvas('));
    const body = recordingCall.match(/requestDraw:\(\)=>\{([\s\S]*?)\n        \},/)?.[1];
    expect(body).toBeTruthy();
    const requestDraw = vi.fn();
    let current = { ready: true, xrPresenting: false };
    const workspace = { snapshot: () => current, viewer: { plugin: { canvas3d: { requestDraw } } } };
    const draw = new Function('workspace', 'closed', 'controller', body!) as (workspace: unknown, closed: boolean, controller: AbortController) => void;
    const running = new AbortController();
    draw(workspace, false, running);
    expect(running.signal.aborted).toBe(false);
    expect(requestDraw).toHaveBeenCalledOnce();
    for (const [closed, ready, xrPresenting] of [[true, true, false], [false, false, false], [false, true, true]]) {
      current = { ready, xrPresenting };
      const controller = new AbortController();
      draw(workspace, closed, controller);
      expect(controller.signal.aborted).toBe(true);
    }
    expect(requestDraw).toHaveBeenCalledOnce();
  });

  it('aborts the encoder and tracks immediately without waiting for another timer tick', async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const controller = new AbortController();
    const pending = recordInspectionCanvas(harness.canvas, {
      mediaRecorder: harness.mediaRecorder, frameRate: 10, requestDraw: vi.fn(), signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'recording_aborted' });
    controller.abort();
    expect(harness.instances[0].stopCalls).toBe(1);
    expect(harness.tracks[0].stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await rejected;
  });

  it('rejects an already aborted request before opening a stream', async () => {
    const harness = recorderHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(recordInspectionCanvas(harness.canvas, {
      mediaRecorder: harness.mediaRecorder, signal: controller.signal,
    })).rejects.toMatchObject({ code: 'recording_aborted' });
    expect(harness.canvas.captureStream).not.toHaveBeenCalled();
  });

  it('does not deliver a delayed encoder completion after cancellation', async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const controller = new AbortController();
    const delivered = vi.fn();
    const pending = recordInspectionCanvas(harness.canvas, {
      mediaRecorder: harness.mediaRecorder, requestDraw: vi.fn(), signal: controller.signal,
    }).then(delivered);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'recording_aborted' });
    const recorder = harness.instances[0];
    const onstop = recorder.onstop!;
    recorder.onstop = null;
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort();
    expect(harness.tracks[0].stop).toHaveBeenCalledOnce();
    onstop();
    await rejected;
    expect(delivered).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('guards the actual download continuation and allows a fresh recording after cancellation', async () => {
    vi.useFakeTimers();
    const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const body = source.match(/recording\.addEventListener\('click',async\(\)=>\{([\s\S]*?)\n  \}\);\n  const connect/)?.[1];
    expect(body).toBeTruthy();
    let complete!: (result: unknown) => void;
    const record = vi.fn(() => new Promise(resolve => { complete = resolve; }));
    const revoke = vi.fn();
    const scope = {
      activePreviewRecording: undefined as AbortController | undefined, closed: false,
      workspace: { snapshot: () => ({ ready: true, xrPresenting: false }) },
      recording: { disabled: false, textContent: '' }, outcome: { textContent: '' },
      recordInspectionCanvas: record, findInspectionCanvas: () => ({}), document: {},
      downloadInspectionRecording: vi.fn(() => revoke), recordHeadsetEvent: vi.fn(),
      thrownErrorMessage: String,
    };
    const compiled = transformSync(`async function click(){${body}}`, { loader: 'ts', target: 'es2022' }).code;
    const click = new Function('scope', `with(scope){${compiled};return click;}`)(scope) as () => Promise<void>;
    const first = click();
    await click();
    expect(record).toHaveBeenCalledTimes(1);
    // The encoder has finished, but this retired page must not download when
    // the async continuation resumes. No repaint timer remains at this point.
    scope.closed = true;
    complete({});
    await first;
    expect(scope.downloadInspectionRecording).not.toHaveBeenCalled();
    expect(scope.outcome.textContent).toMatch(/cancelled/);
    expect(scope.recording.disabled).toBe(false);
    expect(scope.activePreviewRecording).toBeUndefined();
    scope.closed = false;
    const second = click();
    complete({});
    await second;
    expect(record).toHaveBeenCalledTimes(2);
    expect(scope.downloadInspectionRecording).toHaveBeenCalledOnce();
    expect(scope.activePreviewRecording).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('treats a source-change interruption as cancellation and records the next ready view', async () => {
    vi.useFakeTimers();
    const source = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
    const body = source.match(/recording\.addEventListener\('click',async\(\)=>\{([\s\S]*?)\n  \}\);\n  const connect/)?.[1];
    expect(body).toBeTruthy();
    let harness = recorderHarness();
    const interrupted = harness;
    let ready = true;
    const requestDraw = vi.fn(), revoke = vi.fn();
    const scope = {
      activePreviewRecording: undefined as AbortController | undefined, closed: false,
      workspace: { snapshot: () => ({ ready, xrPresenting: false }), viewer: { plugin: { canvas3d: { requestDraw } } } },
      recording: { disabled: false, textContent: '' }, outcome: { textContent: '' }, document: {},
      findInspectionCanvas: () => harness.canvas,
      // Only the browser encoder is replaced: lifecycle, draw timers, abort
      // handling and the UI's async continuation run their production code.
      recordInspectionCanvas: (canvas: Parameters<typeof recordInspectionCanvas>[0], options: Parameters<typeof recordInspectionCanvas>[1]) =>
        recordInspectionCanvas(canvas, { ...options, mediaRecorder: harness.mediaRecorder }),
      downloadInspectionRecording: vi.fn(() => revoke), recordHeadsetEvent: vi.fn(),
      thrownErrorMessage: (error: Error) => error.message,
    };
    const compiled = transformSync(`async function click(){${body}}`, { loader: 'ts', target: 'es2022' }).code;
    const click = new Function('scope', `with(scope){${compiled};return click;}`)(scope) as () => Promise<void>;
    const first = click();
    expect(requestDraw).toHaveBeenCalledOnce();
    ready = false; // The renderer is busy loading the replacement structure.
    await vi.advanceTimersByTimeAsync(100);
    await first;
    expect(interrupted.instances[0].stopCalls).toBe(1);
    expect(interrupted.tracks[0].stop).toHaveBeenCalledOnce();
    expect(interrupted.instances[0].onstop).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(scope.outcome.textContent).toMatch(/^Preview cancelled/);
    expect(scope.recordHeadsetEvent).not.toHaveBeenCalled();
    expect(scope.downloadInspectionRecording).not.toHaveBeenCalled();
    expect(scope.activePreviewRecording).toBeUndefined();
    expect(scope.recording.disabled).toBe(false);
    expect(requestDraw).toHaveBeenCalledOnce();

    harness = recorderHarness(); ready = true;
    const second = click();
    await vi.advanceTimersByTimeAsync(10_000);
    await second;
    expect(harness.instances[0].stopCalls).toBe(1);
    expect(harness.tracks[0].stop).toHaveBeenCalledOnce();
    expect(scope.downloadInspectionRecording).toHaveBeenCalledOnce();
    expect(scope.outcome.textContent).toMatch(/^Preview downloaded/);
    expect(scope.recordHeadsetEvent).not.toHaveBeenCalled();
    expect(scope.activePreviewRecording).toBeUndefined();
    expect(scope.recording.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoke).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops repainting at the deadline even if the encoder delays its stop event', async () => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    const requestDraw = vi.fn();
    const pending = recordInspectionCanvas(harness.canvas, { mediaRecorder: harness.mediaRecorder, frameRate: 10, requestDraw });
    const recorder = harness.instances[0];
    const onstop = recorder.onstop!;
    recorder.onstop = null;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recorder.stopCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requestDraw).toHaveBeenCalledTimes(100);
    onstop();
    await pending;
    expect(harness.tracks[0].stop).toHaveBeenCalledOnce();
  });

  it.each(['early-stop', 'encoder-error', 'draw-error'] as const)('cleans up the repaint pump after %s', async kind => {
    vi.useFakeTimers();
    const harness = recorderHarness();
    let failDraw = false;
    const requestDraw = vi.fn(() => { if (failDraw) throw Error('view entered XR'); });
    const pending = recordInspectionCanvas(harness.canvas, { mediaRecorder: harness.mediaRecorder, frameRate: 10, requestDraw });
    const rejected = expect(pending).rejects.toThrow(kind === 'early-stop' ? /stopped before/ : kind === 'encoder-error' ? /encoder failed/ : /view entered XR/);
    await vi.advanceTimersByTimeAsync(200);
    if (kind === 'early-stop') harness.instances[0].stop();
    else if (kind === 'encoder-error') harness.instances[0].onerror?.({ error: Error('encoder failed') });
    else { failDraw = true; await vi.advanceTimersByTimeAsync(100); }
    await rejected;
    const draws = requestDraw.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.instances[0].stopCalls).toBe(1);
    expect(harness.tracks[0].stop).toHaveBeenCalledOnce();
    expect(harness.instances[0].onstop).toBeNull();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(requestDraw).toHaveBeenCalledTimes(draws);
  });

  it('fails closed when MediaRecorder is unavailable', async () => {
    await expect(recordInspectionCanvas({ captureStream: vi.fn() })).rejects.toMatchObject({ code: 'recording_unsupported' });
  });

  it('rejects unbounded frame rates and unsupported formats', async () => {
    const harness = recorderHarness([]);
    expect(() => chooseInspectionRecordingMimeType(harness.mediaRecorder)).toThrow(/no supported WebM/);
    await expect(recordInspectionCanvas(harness.canvas, { mediaRecorder: harness.mediaRecorder, frameRate: 61 }))
      .rejects.toMatchObject({ code: 'recording_invalid_frame_rate' });
  });

  it('downloads only the recorded Blob and returns URL cleanup', () => {
    const click = vi.fn();
    const anchor = { href: '', download: '', rel: '', click };
    const documentRef = { createElement: vi.fn(() => anchor) } as unknown as Document;
    const url = { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() };
    const cleanup = downloadInspectionRecording({ blob: new Blob(['video']), mimeType: 'video/webm', durationMs: 10_000, frameRate: 30 }, { document: documentRef, url });
    expect(anchor.download).toBe('stereofold-inspection-10s.webm');
    expect(click).toHaveBeenCalledOnce();
    cleanup();
    expect(url.revokeObjectURL).toHaveBeenCalledWith('blob:test');
  });
});
