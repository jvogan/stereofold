/**
 * What the headset log has to say about an agent's reply.
 *
 * Two `say_to_headset` calls succeeded on the Mac while the headset log showed
 * nothing between the caption arriving and the wearer hearing nothing, so the
 * page now records the reply it was handed, the speech it asked for, and the
 * voices the browser actually has.
 */
import { beforeEach, describe, expect, it } from 'vitest';
// @ts-ignore Shared JavaScript reply diagnostics.
import { describeSpeechVoices, installTalkReplyDiagnostics, recordTalkReplyDelivery, recordTalkReplySeat, TALK_REPLY_EVENT } from '../../lab/browser-roundtrip/talk-reply-diagnostics.mjs';

/** A minimal EventTarget, so this test needs no DOM. */
function target() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  return {
    addEventListener(type: string, handler: (event: any) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: any) => void) { listeners.get(type)?.delete(handler); },
    dispatch(type: string, event: any) { for (const handler of [...(listeners.get(type) ?? [])]) handler(event); },
    count(type: string) { return listeners.get(type)?.size ?? 0; },
  };
}

/** A `SpeechSynthesisUtterance` stand-in that can report start, end or error. */
function utterance(text: string) {
  const handlers = new Map<string, Set<(event: any) => void>>();
  return {
    text,
    addEventListener(type: string, handler: (event: any) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    },
    fire(type: string, event: any = {}) { for (const handler of [...(handlers.get(type) ?? [])]) handler(event); },
  };
}

function speechSynthesis({ voices = [{ name: 'Samantha', lang: 'en-US' }] }: { voices?: any[] } = {}) {
  const spoken: any[] = [];
  return {
    spoken, speaking: false, pending: false,
    getVoices() { return voices; },
    speak(value: any) { spoken.push(value); },
    addEventListener() {}, removeEventListener() {},
  };
}

let entries: { kind: string; detail: any }[];
let scope: any;

beforeEach(() => {
  entries = [];
  scope = { __stereofoldDiagnostics: { record: (kind: string, detail: any) => { entries.push({ kind, detail }); return null; } } };
});

const kinds = () => entries.map(entry => entry.kind);
const detailOf = (kind: string) => entries.filter(entry => entry.kind === kind).map(entry => entry.detail);

describe('the reply half of the headset conversation', () => {
  it('records the caption the panel read off its heartbeat', () => {
    recordTalkReplyDelivery({ id: 'c1', text: 'Thirteen protofilaments.', speak: true, holdSeconds: 8 }, { scope });
    expect(kinds()).toEqual(['reply-received']);
    expect(detailOf('reply-received')[0]).toMatchObject({ chars: 24, speak: true, holdSeconds: 8, drawn: false, seatOutcome: 'pending' });
  });

  it('marks a caption delivered to a surface that draws no orb', () => {
    recordTalkReplyDelivery({ text: 'Rendered.', speak: false }, { scope, seatOutcome: 'unavailable' });
    expect(detailOf('reply-received')[0]).toMatchObject({ speak: false, drawn: false });
  });

  it.each(['shown', 'failed', 'unavailable', 'superseded'])('records a refusal seat as %s after the caption owner answers', seatOutcome => {
    const caption = { id: 'refusal-1', commandId: 'load-1', utteranceId: 'u-1', text: 'Private refusal detail',
      refusal: { tool: 'replace_inspection_source', reason: 'insecure address' } };
    recordTalkReplySeat(caption, { outcome: seatOutcome, fallback: 'structure-overlap' }, { scope });
    expect(detailOf('reply-received')[0]).toMatchObject({ captionId: 'refusal-1', seatOutcome, drawn: seatOutcome === 'shown' });
    expect(detailOf('outcome')[0]).toEqual({ status: 'refused', captionId: 'refusal-1', commandId: 'load-1', utteranceId: 'u-1',
      tool: 'replace_inspection_source', reason: 'insecure address', seatOutcome, drawn: seatOutcome === 'shown', fallback: 'structure-overlap' });
    expect(JSON.stringify(entries)).not.toContain(caption.text);
  });

  it('records the reply event the panel dispatches, and the voices this browser has', () => {
    const events = target();
    const synth = speechSynthesis();
    installTalkReplyDiagnostics({ scope, target: events, synth });
    expect(detailOf('speech-voices')[0]).toMatchObject({ voices: 1, names: 'Samantha (en-US)' });
    events.dispatch(TALK_REPLY_EVENT, { detail: { id: 'c2', text: 'Try the menu next.', speak: true } });
    expect(detailOf('reply-received')[0]).toMatchObject({ chars: 18, speak: true, delivered: 'event', drawn: false, seatOutcome: 'pending' });
  });

  it('reports a headset with no installed voice rather than staying silent about it', () => {
    installTalkReplyDiagnostics({ scope, target: target(), synth: speechSynthesis({ voices: [] }) });
    expect(detailOf('speech-voices')[0]).toMatchObject({ voices: 0, names: '' });
  });

  it('records the whole utterance: asked for, heard, finished', () => {
    const synth = speechSynthesis();
    installTalkReplyDiagnostics({ scope, target: target(), synth });
    const said = utterance('Try the menu next.');
    synth.speak(said);
    expect(synth.spoken).toEqual([said]);
    expect(kinds()).toContain('speech-start');
    expect(detailOf('speech-start')[0]).toMatchObject({ chars: 18, voices: 1 });
    said.fire('start');
    said.fire('end');
    expect(detailOf('speech-end')[0]).toMatchObject({ audible: true });
  });

  it('says when speech was queued and never made a sound', () => {
    const synth = speechSynthesis();
    installTalkReplyDiagnostics({ scope, target: target(), synth });
    const said = utterance('Silent.');
    synth.speak(said);
    said.fire('end');
    expect(detailOf('speech-end')[0]).toMatchObject({ audible: false });
  });

  it('records a refused utterance with the reason the browser gave', () => {
    const synth = speechSynthesis();
    installTalkReplyDiagnostics({ scope, target: target(), synth });
    const said = utterance('Refused.');
    synth.speak(said);
    said.fire('error', { error: 'not-allowed' });
    expect(detailOf('speech-error')[0]).toMatchObject({ reason: 'not-allowed' });
  });

  it('gives the page back exactly what it borrowed', () => {
    const events = target();
    const synth = speechSynthesis();
    const original = synth.speak;
    const stop = installTalkReplyDiagnostics({ scope, target: events, synth });
    expect(synth.speak).not.toBe(original);
    stop();
    stop();
    expect(synth.speak).toBe(original);
    expect(events.count(TALK_REPLY_EVENT)).toBe(0);
  });

  it('never lets a broken diagnostics hook cost the wearer the answer', () => {
    const hostile = { __stereofoldDiagnostics: { record() { throw Error('recorder is broken'); } } };
    const synth = speechSynthesis();
    installTalkReplyDiagnostics({ scope: hostile, target: target(), synth });
    const said = utterance('Still spoken.');
    expect(() => synth.speak(said)).not.toThrow();
    expect(synth.spoken).toEqual([said]);
    expect(() => recordTalkReplyDelivery({ text: 'x' }, { scope: hostile })).not.toThrow();
  });

  it('bounds the voices it lists', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ name: `Voice ${index}`, lang: 'en-US' }));
    const described = describeSpeechVoices({ getVoices: () => many } as any);
    expect(described.voices).toBe(40);
    expect(described.names.split(', ')).toHaveLength(6);
  });
});
