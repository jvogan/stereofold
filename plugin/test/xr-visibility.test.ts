import { describe, expect, it } from 'vitest';
import { panelAvailability } from '../src/inspection-panel-recovery.js';
import { xrStartupSchema } from '../src/inspection-contract.js';
// @ts-ignore Shared JavaScript grip module, the same one the companion bundles.
import { attachGripPushToTalk } from '../../lab/browser-roundtrip/push-to-talk-grip.mjs';
// @ts-ignore Shared JavaScript visibility module, the same one the companion bundles.
import { sessionVisibilityTransition } from '../../lab/browser-roundtrip/xr-visibility.mjs';

/** An XRSession stand-in with the two events the grip binding and the watch use. */
function fakeSession() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    visibilityState: 'visible',
    inputSources: [] as unknown[],
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: unknown) => void) { listeners.get(type)?.delete(handler); },
    emit(type: string, event: unknown = {}) { for (const handler of [...(listeners.get(type) ?? [])]) handler(event); },
  };
}

/** The version 2 streamer's surface, recording which ending was taken. */
function fakeStreamer() {
  const calls: string[] = [];
  return {
    calls,
    async start() { calls.push('start'); },
    async stop() { calls.push('stop'); return 'transcript'; },
    async cancel() { calls.push('cancel'); },
    async dispose() { calls.push('dispose'); },
    busy: () => calls.at(-1) === 'start',
  };
}

const BASE = { blocked: false, dirty: false, ready: true, interactionActive: false, navigating: false };

describe('a headset panel that cannot be seen', () => {
  it('answers busy, not ready, so the server admits no command', () => {
    expect(panelAvailability(BASE)).toBe('ready');
    expect(panelAvailability({ ...BASE, blind: true })).toBe('busy');
  });

  it('still reports unsaved work ahead of blindness, because that needs a different answer', () => {
    // `busy` makes the server wait; `unsaved` makes it cancel the command. A
    // panel with an unsaved scene must keep saying so even while blind.
    expect(panelAvailability({ ...BASE, dirty: true, blind: true })).toBe('unsaved');
    expect(panelAvailability({ ...BASE, blocked: true, blind: true })).toBe('unsaved');
  });

  it('is the desktop panel default, which has no wearer to lose', () => {
    expect(panelAvailability({ ...BASE, blind: false })).toBe('ready');
    expect(panelAvailability(BASE)).toBe('ready');
  });
});

describe('the session visibility the heartbeat carries', () => {
  const startup = {
    phase: 'active' as const, pending: false, reloadRequired: false,
    mode: 'immersive-ar' as const, gestureActive: true,
  };

  it('accepts each state WebXR defines, and null between sessions', () => {
    for (const value of ['visible', 'visible-blurred', 'hidden', null]) {
      expect(xrStartupSchema.safeParse({ ...startup, sessionVisibility: value }).success).toBe(true);
    }
  });

  it('rejects anything else, so a wrong reading cannot reach the agent as fact', () => {
    expect(xrStartupSchema.safeParse({ ...startup, sessionVisibility: 'blurred' }).success).toBe(false);
  });

  it('is optional, so a desktop panel and an older page still validate', () => {
    expect(xrStartupSchema.safeParse(startup).success).toBe(true);
  });
});

describe('a push-to-talk press the wearer never ended', () => {
  it('is cancelled rather than transcribed, and the Mac still gets its up edge', async () => {
    const session = fakeSession();
    const sent: string[] = [];
    const audio = fakeStreamer();
    const talk = attachGripPushToTalk({ session, audio, send: async (state: string) => { sent.push(state); } });

    await talk.start();
    expect(talk.listening()).toBe(true);
    expect(audio.calls).toEqual(['start']);

    await talk.cancel('xr-hidden');
    expect(audio.calls).toEqual(['start', 'cancel']);
    expect(audio.calls).not.toContain('stop');
    expect(talk.listening()).toBe(false);
    // The `down` edge was posted; a Mac left believing the button is still
    // held is exactly the state a headset on a table used to leave it in.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toEqual(['down', 'up']);
  });

  it('takes the ordinary transcribing ending when the wearer does let go', async () => {
    const session = fakeSession();
    const audio = fakeStreamer();
    const talk = attachGripPushToTalk({ session, audio, send: async () => {} });
    await talk.start();
    await talk.stop();
    expect(audio.calls).toEqual(['start', 'stop']);
  });

  it('drops a version one recording on the floor instead of sending it', async () => {
    const session = fakeSession();
    const capture = { started: 0, stopped: 0,
      async start() { this.started++; }, async stop() { this.stopped++; return 'pcm'; } };
    const delivered: unknown[] = [];
    const talk = attachGripPushToTalk({ session, audio: null, capture, send: async () => {},
      sendVoice: { async send(audio: unknown) { delivered.push(audio); return {}; } } });

    await talk.start();
    await talk.cancel('xr-visible-blurred');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(capture.stopped).toBe(1);
    expect(delivered).toEqual([]);
  });

  it('cancels the shared controller through the same path the page Cancel button uses', async () => {
    const session = fakeSession();
    const calls: string[] = [];
    const interaction = {
      async start() { calls.push('start'); },
      async stop() { calls.push('stop'); return {}; },
      async cancel() { calls.push('cancel'); },
    };
    const talk = attachGripPushToTalk({ session, audio: null, interaction, send: async () => {} });
    await talk.start();
    await talk.cancel('xr-hidden');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toEqual(['start', 'cancel']);
  });

  it('is safe to cancel when no press is open', async () => {
    const session = fakeSession();
    const sent: string[] = [];
    const audio = fakeStreamer();
    const talk = attachGripPushToTalk({ session, audio, send: async (state: string) => { sent.push(state); } });
    await talk.cancel('xr-hidden');
    await new Promise(resolve => setTimeout(resolve, 0));
    // The streamer is asked to cancel regardless: an utterance it closed on
    // its own duration cap can still be open with no hold left to read.
    expect(audio.calls).toEqual(['cancel']);
    expect(sent).toEqual([]);
  });
});

describe('the decision a blind session drives', () => {
  it('names the cancel and the pause in one diagnostic the headset log carries', () => {
    const { diagnostic } = sessionVisibilityTransition({ from: 'visible', to: 'hidden',
      talking: true, autoplay: true, tourActive: true });
    expect(diagnostic.kind).toBe('xr-visibility');
    expect(diagnostic.detail).toEqual({ from: 'visible', to: 'hidden', blind: true, cancelTalk: true, tour: 'pause' });
  });
});
