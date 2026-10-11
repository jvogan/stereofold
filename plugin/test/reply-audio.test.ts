import { describe, it, expect, vi } from 'vitest';
// @ts-ignore Shared JavaScript playback of the reply audio this Mac rendered.
import { installReplyAudio, decodeReplyAudioBase64, replyAudioClipFrom, unlockReplyAudio, REPLY_AUDIO_EVENT } from '../../lab/browser-roundtrip/reply-audio.mjs';
// @ts-ignore Shared JavaScript name of the per-segment caption event.
import { REPLY_SEGMENT_EVENT } from '../../lab/browser-roundtrip/reply-segments.mjs';

const CLIP_BYTES = Buffer.from('OggS a short spoken sentence');
const clip = (overrides: Record<string, unknown> = {}) => ({
  base64: CLIP_BYTES.toString('base64'), mimeType: 'audio/ogg; codecs=opus',
  format: 'ogg-opus', bytes: CLIP_BYTES.byteLength, ...overrides,
});
const caption = (overrides: Record<string, unknown> = {}) => ({
  id: 'caption-1', text: 'Thirteen protofilaments, and EB3 marks the seam.',
  speak: true, holdSeconds: 6, audio: clip(), ...overrides,
});

/** A page-shaped event target that dispatches in registration order, as a browser does. */
function target() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  return {
    addEventListener(type: string, handler: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: any) => void) { listeners.get(type)?.delete(handler); },
    dispatchEvent(event: any) { for (const handler of [...(listeners.get(event.type) ?? [])]) handler(event); },
    count(type: string) { return listeners.get(type)?.size ?? 0; },
  };
}

function fakeAudio({ decode = 'ok' as 'ok' | 'reject', duration = 4.6 } = {}) {
  const started: any[] = [];
  let context: any;
  const factory = () => {
    context = {
      state: 'suspended',
      destination: { name: 'speakers' },
      resume() { context.state = 'running'; return Promise.resolve(); },
      decodeAudioData(buffer: ArrayBuffer) {
        return decode === 'reject'
          ? Promise.reject(Error('EncodingError: unsupported'))
          : Promise.resolve({ duration, sampleRate: 24_000, byteLength: buffer.byteLength });
      },
      createBufferSource() {
        const handlers = new Set<() => void>();
        const source: any = {
          buffer: undefined, connected: false, stopped: false,
          connect() { source.connected = true; },
          addEventListener(_type: string, handler: () => void) { handlers.add(handler); },
          start() { started.push(source); },
          stop() { source.stopped = true; },
          end() { for (const handler of handlers) handler(); },
        };
        return source;
      },
      close() { context.state = 'closed'; },
    };
    return context;
  };
  return { factory, started, context: () => context };
}

function fakeSynth() {
  const spoken: string[] = [];
  return { spoken, speak(utterance: any) { spoken.push(utterance?.text ?? ''); }, cancel() {} };
}

function scopeWith(extra: Record<string, unknown> = {}) {
  const entries: Array<{ kind: string; detail: any }> = [];
  return {
    entries,
    scope: {
      atob: globalThis.atob,
      __stereofoldDiagnostics: { record: (kind: string, detail: any) => { entries.push({ kind, detail }); return null; } },
      ...extra,
    } as any,
  };
}

const kinds = (entries: Array<{ kind: string }>) => entries.map(entry => entry.kind);
const detailOf = (entries: Array<{ kind: string; detail: any }>, kind: string) => entries.find(entry => entry.kind === kind)?.detail;
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

describe('the reply clip a voiceless headset plays', () => {
  it('reads a clip off a caption and refuses one that carries nothing usable', () => {
    expect(replyAudioClipFrom(caption())).toMatchObject({ format: 'ogg-opus', bytes: CLIP_BYTES.byteLength });
    expect(replyAudioClipFrom({ text: 'no clip' })).toBeUndefined();
    expect(replyAudioClipFrom(caption({ audio: { base64: 'x' } }))).toBeUndefined();
    // A caption claiming a clip far past the page's ceiling is not decoded.
    expect(replyAudioClipFrom(caption({ audio: clip({ bytes: 9_000_000 }) }))).toBeUndefined();
    expect(decodeReplyAudioBase64(CLIP_BYTES.toString('base64'))).toEqual(new Uint8Array(CLIP_BYTES));
    expect(decodeReplyAudioBase64('not base64 at all!!')).not.toEqual(new Uint8Array(CLIP_BYTES));
  });

  it('plays the clip through the context and drops the orb utterance that would double it', async () => {
    const audio = fakeAudio();
    const synth = fakeSynth();
    const events = target();
    const { entries, scope } = scopeWith();
    const controller = installReplyAudio({ scope, target: events, contextFactory: audio.factory, synth, gestureTargets: [] });
    // The talk orb subscribes after the page does, and speaks synchronously.
    events.addEventListener(REPLY_AUDIO_EVENT, (event: any) => synth.speak({ text: event.detail.text }));

    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: caption() });
    await settle();

    expect(audio.started).toHaveLength(1);
    expect(audio.started[0].connected).toBe(true);
    expect(audio.context().state).toBe('running');
    expect(synth.spoken).toEqual([]);
    // e5bb157 records spoken evidence at audio start, including replies without IDs.
    expect(kinds(entries)).toEqual(['reply-audio-fetch', 'voice-loop', 'reply-audio-play']);
    expect(detailOf(entries, 'voice-loop')).toEqual({ stage: 'spoken-confirmation-started',
      spokenText: 'Thirteen protofilaments, and EB3 marks the seam.', spokenWords: 7 });
    expect(detailOf(entries, 'reply-audio-fetch')).toMatchObject({ bytes: CLIP_BYTES.byteLength, format: 'ogg-opus', inline: true });
    expect(detailOf(entries, 'reply-audio-play')).toMatchObject({ via: 'context', seconds: 4.6, rate: 24_000, suppressed: true });

    audio.started[0].end();
    expect(detailOf(entries, 'reply-audio-end')).toMatchObject({ seconds: 4.6, via: 'context' });

    // The same caption arriving on a repeated heartbeat plays once.
    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: caption() });
    await settle();
    expect(audio.started).toHaveLength(1);
    controller.stop();
    expect(events.count(REPLY_AUDIO_EVENT)).toBe(1);
  });

  it('leaves the browser to speak when the Mac sent no clip', async () => {
    const audio = fakeAudio();
    const synth = fakeSynth();
    const events = target();
    const { entries, scope } = scopeWith();
    installReplyAudio({ scope, target: events, contextFactory: audio.factory, synth, gestureTargets: [] });
    events.addEventListener(REPLY_AUDIO_EVENT, (event: any) => synth.speak({ text: event.detail.text }));

    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: { id: 'c2', text: 'No clip for this one.', speak: true } });
    // A reply the agent asked to stay silent is not played either.
    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: caption({ id: 'c3', speak: false }) });
    await settle();

    expect(audio.started).toHaveLength(0);
    expect(synth.spoken).toEqual(['No clip for this one.', 'Thirteen protofilaments, and EB3 marks the seam.']);
    expect(entries).toHaveLength(0);
  });

  it('hands the utterance back to the browser when the clip will not decode', async () => {
    const audio = fakeAudio({ decode: 'reject' });
    const synth = fakeSynth();
    const events = target();
    const { entries, scope } = scopeWith();
    installReplyAudio({ scope, target: events, contextFactory: audio.factory, synth, gestureTargets: [] });
    events.addEventListener(REPLY_AUDIO_EVENT, (event: any) => synth.speak({ text: event.detail.text }));

    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: caption() });
    await settle();

    expect(audio.started).toHaveLength(0);
    expect(kinds(entries)).toEqual(['reply-audio-fetch', 'reply-audio-error']);
    expect(detailOf(entries, 'reply-audio-error')).toMatchObject({ stage: 'decode' });
    // The wearer still hears the sentence, through whatever voice the browser has.
    expect(synth.spoken).toEqual(['Thirteen protofilaments, and EB3 marks the seam.']);
  });

  it('builds and resumes its context on the first press anywhere on the page', async () => {
    const audio = fakeAudio();
    const gestures = target();
    const events = target();
    const { entries, scope } = scopeWith();
    const controller = installReplyAudio({ scope, target: events, contextFactory: audio.factory, synth: fakeSynth(), gestureTargets: [gestures] });
    expect(controller.state()).toBe('absent');

    // The Enter VR button is an ordinary press as far as this module is concerned.
    gestures.dispatchEvent({ type: 'pointerdown' });
    expect(audio.context().state).toBe('running');
    expect(detailOf(entries, 'reply-audio-unlock')).toMatchObject({ via: 'pointerdown', state: 'suspended' });
    expect(controller.state()).toBe('running');

    // Any module that owns a button can unlock without importing this one.
    entries.length = 0;
    expect(unlockReplyAudio(scope, 'enter-vr')).toBe(true);
    expect(detailOf(entries, 'reply-audio-unlock')).toMatchObject({ via: 'enter-vr' });

    controller.stop();
    expect(unlockReplyAudio(scope)).toBe(false);
  });

  it('records why it is silent on a browser with no AudioContext', async () => {
    const synth = fakeSynth();
    const events = target();
    const { entries, scope } = scopeWith();
    installReplyAudio({
      scope, target: events, synth, gestureTargets: [],
      contextFactory: () => { throw Error('This browser has no AudioContext.'); },
    });
    events.addEventListener(REPLY_AUDIO_EVENT, (event: any) => synth.speak({ text: event.detail.text }));

    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: caption() });
    await settle();

    expect(kinds(entries)).toContain('reply-audio-error');
    expect(synth.spoken).toEqual(['Thirteen protofilaments, and EB3 marks the seam.']);
  });

  // Without the id, a record left in the ring by the previous answer is this
  // answer's proof that the wearer heard something, which is how a silent turn
  // reported as a spoken one.
  it('names which reply each record is about', async () => {
    const audio = fakeAudio();
    const events = target();
    const { entries, scope } = scopeWith();
    installReplyAudio({ scope, target: events, contextFactory: audio.factory, synth: fakeSynth(), gestureTargets: [] });

    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: caption({ id: 'caption-turn-2' }) });
    await settle();

    expect(detailOf(entries, 'reply-audio-play')).toMatchObject({ captionId: 'caption-turn-2', contextState: 'running', started: true });
    expect(detailOf(entries, 'reply-audio-fetch')).toMatchObject({ captionId: 'caption-turn-2' });
    audio.started[0].end();
    expect(detailOf(entries, 'reply-audio-end')).toMatchObject({ captionId: 'caption-turn-2' });
  });

  // An unattended Quest is exactly where a context is never resumed. The
  // source still starts and the record is still written; what it must not say
  // is that the context was running.
  it('records the context state a clip was started into, suspended and all', async () => {
    const audio = fakeAudio();
    const events = target();
    const { entries, scope } = scopeWith();
    installReplyAudio({ scope, target: events, gestureTargets: [], synth: fakeSynth(),
      contextFactory: () => { const context = audio.factory(); context.resume = () => Promise.resolve(); return context; } });

    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: caption({ id: 'caption-silent' }) });
    await settle();

    expect(audio.started).toHaveLength(1);
    expect(detailOf(entries, 'reply-audio-play')).toMatchObject({ captionId: 'caption-silent', contextState: 'suspended' });
  });
});


it('records confirmation start with command and utterance IDs after audio starts',async()=>{
  const {scope,entries}=scopeWith(),events=target(),audio=fakeAudio();
  const controller=installReplyAudio({scope,target:events,contextFactory:audio.factory,synth:fakeSynth(),gestureTargets:[]});
  try {
    events.dispatchEvent({type:REPLY_AUDIO_EVENT,detail:caption({commandId:'c-loop',utteranceId:'u-loop'})});
    expect(entries.some(e=>e.kind==='voice-loop')).toBe(false);
    await settle();
    expect(audio.started).toHaveLength(1);
    expect(detailOf(entries,'voice-loop')).toEqual({stage:'spoken-confirmation-started',commandId:'c-loop',utteranceId:'u-loop',
      spokenText:'Thirteen protofilaments, and EB3 marks the seam.',spokenWords:7});
  } finally {controller.stop();}
});

it('releases reply audio across XR exit without losing the next gesture', async () => {
  const page=target(), audio=fakeAudio();
  const controller=installReplyAudio({scope:page,target:page,contextFactory:audio.factory});
  controller.unlock('entry');
  const first=audio.context();
  await controller.release?.();
  expect(first.state).toBe('closed');
  expect(controller.state()).toBe('absent');
  page.dispatchEvent({type:'pointerdown'});
  expect(audio.context()).not.toBe(first);
  expect(controller.state()).toBe('running');
  await controller.stop();
});

it('discards a reply decode completing after XR exit', async () => {
  const page=target(), source=vi.fn();
  let finish!:(value:any)=>void;
  const audio={state:'running',decodeAudioData:()=>new Promise(resolve=>{finish=resolve;}),
    createBufferSource:source,close:async()=>{}};
  const controller=installReplyAudio({scope:page,target:page,contextFactory:()=>audio});
  page.dispatchEvent({type:REPLY_AUDIO_EVENT,detail:caption()});
  await controller.release?.();
  finish({duration:1});
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(source).not.toHaveBeenCalled();
  expect(controller.state()).toBe('absent');
  await controller.stop();
});

it('stops the media fallback while its play promise is pending at exit', async () => {
  const page=target(), pause=vi.fn();
  let finish!:()=>void;
  class Audio {
    pause=pause;
    play=()=>new Promise<void>(resolve=>{finish=resolve;});
  }
  const scope={...page,Blob,URL:{createObjectURL:()=> 'blob:reply',revokeObjectURL:()=>{}}};
  const controller=installReplyAudio({scope,target:page,Audio,
    contextFactory:()=>{throw Error('No audio context');}});
  page.dispatchEvent({type:REPLY_AUDIO_EVENT,detail:caption()});
  await controller.release?.();
  finish();
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(pause).toHaveBeenCalled();
  expect(controller.state()).toBe('absent');
  await controller.stop();
});


/**
 * A long reply arrives as several clips on one caption. Playing them at once
 * would be three voices talking over each other, and playing the first alone
 * is the truncation this exists to remove.
 */
describe('a reply that takes more than one segment', () => {
  const segmented = (overrides: Record<string, unknown> = {}) => ({
    id: 'long-reply', speak: true, holdSeconds: 6,
    text: 'The seam runs the length of the lattice. EB3 marks it. Thirteen protofilaments.',
    segments: [
      { index: 0, text: 'The seam runs the length of the lattice.', audio: clip(), seconds: 3 },
      { index: 1, text: 'EB3 marks it.', audio: clip(), seconds: 2 },
      { index: 2, text: 'Thirteen protofilaments.', audio: clip(), seconds: 2 },
    ],
    ...overrides,
  });

  it('starts each segment only once the one before it has ended', async () => {
    const audio = fakeAudio();
    const events = target();
    const captions: string[] = [];
    events.addEventListener(REPLY_SEGMENT_EVENT, (event: any) => captions.push(event.detail.text));
    const { entries, scope } = scopeWith();
    const controller = installReplyAudio({ scope, target: events, contextFactory: audio.factory, synth: fakeSynth(), gestureTargets: [] });

    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: segmented() });
    await settle();
    expect(audio.started).toHaveLength(1);
    expect(captions).toEqual(['The seam runs the length of the lattice.']);

    audio.started[0].end();
    await settle();
    expect(audio.started).toHaveLength(2);
    expect(captions).toEqual(['The seam runs the length of the lattice.', 'EB3 marks it.']);

    audio.started[1].end();
    await settle();
    expect(audio.started).toHaveLength(3);
    expect(captions).toHaveLength(3);
    audio.started[2].end();
    await settle();

    // One reply is one spoken confirmation, whatever it took to say it.
    expect(kinds(entries).filter(kind => kind === 'voice-loop')).toHaveLength(1);
    expect(detailOf(entries, 'reply-segments-start')).toMatchObject({ captionId: 'long-reply', segments: 3 });
    expect(detailOf(entries, 'reply-segments-end')).toMatchObject({ captionId: 'long-reply', segments: 3 });
    controller.stop();
  });

  it('drops the rest of an older reply when a newer one arrives', async () => {
    const audio = fakeAudio();
    const events = target();
    const { entries, scope } = scopeWith();
    const controller = installReplyAudio({ scope, target: events, contextFactory: audio.factory, synth: fakeSynth(), gestureTargets: [] });

    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: segmented() });
    await settle();
    expect(audio.started).toHaveLength(1);

    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: caption({ id: 'correction', text: 'No, the other copy.' }) });
    await settle();
    // The older answer's clip was stopped rather than left talking under the
    // correction, and its two unplayed segments were reported.
    expect(audio.started[0].stopped).toBe(true);
    expect(detailOf(entries, 'reply-segments-dropped')).toMatchObject({ captionId: 'long-reply', stoppedAt: 0, dropped: 2, total: 3 });
    expect(audio.started).toHaveLength(2);

    // A late end from the stopped clip must not restart the older answer.
    audio.started[0].end();
    await settle();
    expect(audio.started).toHaveLength(2);
    controller.stop();
  });

  it('keeps the caption moving when the Mac rendered no clips for a long reply', async () => {
    const audio = fakeAudio();
    const synth = fakeSynth();
    const events = target();
    const captions: string[] = [];
    events.addEventListener(REPLY_SEGMENT_EVENT, (event: any) => captions.push(event.detail.text));
    const { scope } = scopeWith();
    const controller = installReplyAudio({ scope, target: events, contextFactory: audio.factory, synth, gestureTargets: [] });
    events.addEventListener(REPLY_AUDIO_EVENT, (event: any) => synth.speak({ text: event.detail.text }));

    const silent = segmented({ id: 'silent-reply',
      segments: segmented().segments.map(segment => ({ index: segment.index, text: segment.text, seconds: 0.001 })) });
    events.dispatchEvent({ type: REPLY_AUDIO_EVENT, detail: silent });
    await new Promise(resolve => setTimeout(resolve, 40));

    expect(audio.started).toHaveLength(0);
    expect(captions).toEqual(silent.segments.map((segment: any) => segment.text));
    // With no clip to put in its place the page's own voice is left alone.
    expect(synth.spoken).toEqual([silent.text]);
    controller.stop();
  });
});
