/**
 * Talk presses inside VR when the host has no voice route.
 *
 * Enter VR skips the microphone request when the host reports that no voice
 * route will use it. Then no grant is parked, and a talk press inside VR would make the first
 * microphone request, which Quest Browser cannot show a prompt for: the press
 * would wait out its deadline with the menu lit. Both talk controls, a held
 * A or X and the menu's Talk row, refuse instead, before any microphone opens.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore Browser module exercised directly.
import { createPushToTalkAudio, createPushToTalkAudioEvents, primePushToTalkMicrophone, releasePushToTalkMicrophone, setPushToTalkMicrophoneOff, PUSH_TO_TALK_VOICE_OFF_MESSAGE } from '../../lab/browser-roundtrip/push-to-talk-audio.mjs';
// @ts-ignore Browser module exercised directly.
import { attachGripPushToTalk } from '../../lab/browser-roundtrip/push-to-talk-grip.mjs';
// @ts-ignore Browser module exercised directly.
import { createVoiceInteraction } from '../../lab/browser-roundtrip/voice-interaction.mjs';
import { refuseCaptureWhileVoiceOff, talkCaptureClosed, VOICE_OFF_CAPTURE_MESSAGE } from '../src/xr-entry-microphone.js';

const inspector = readFileSync(new URL('../src/inspector.ts', import.meta.url), 'utf8');
const UNAVAILABLE = 'Voice unavailable. Use the menu controls instead.';

afterEach(() => { setPushToTalkMicrophoneOff(undefined); releasePushToTalkMicrophone(); });

function streamer() {
  const getUserMedia = vi.fn(() => new Promise(() => { /* Quest draws no prompt inside VR: never settles. */ }));
  const events = createPushToTalkAudioEvents(), seen: any[] = [];
  events.on((event: any) => { seen.push(event); });
  class Recorder { static isTypeSupported() { return true; } state = 'inactive'; start() { this.state = 'recording'; } stop() { this.state = 'inactive'; } }
  const audio = createPushToTalkAudio({ send: async () => ({}), media: { getUserMedia }, recorderFactory: Recorder, events,
    setTimer: () => 0 as any, clearTimer: () => {} });
  return { audio, getUserMedia, seen };
}

function session() {
  return { inputSources: [], addEventListener() {}, removeEventListener() {} };
}

describe('a held A or X inside VR with no voice route on the host', () => {
  it('is refused at once and never asks for the microphone', async () => {
    setPushToTalkMicrophoneOff(() => true);
    const { audio, getUserMedia, seen } = streamer();
    await expect(audio.start()).rejects.toThrow(PUSH_TO_TALK_VOICE_OFF_MESSAGE);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(seen.map(event => event.state).slice(-2)).toEqual(['requesting-microphone', 'error']);
    expect(seen.at(-1).message).toBe(PUSH_TO_TALK_VOICE_OFF_MESSAGE);
    expect(audio.busy()).toBe(false);
  });

  it('tells the wearer on the menu status row, through the press the button reader makes', async () => {
    setPushToTalkMicrophoneOff(() => true);
    const { audio, getUserMedia } = streamer(), lines: string[] = [], edges: string[] = [];
    const talk = attachGripPushToTalk({ session: session(), send: async (state: string) => { edges.push(state); }, audio,
      status: (text: string) => { lines.push(text); } });
    try {
      await expect(talk.start()).rejects.toThrow(PUSH_TO_TALK_VOICE_OFF_MESSAGE);
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(lines.at(-1)).toBe(UNAVAILABLE);
      expect(talk.listening()).toBe(false);
      await Promise.resolve();
      expect(edges).toEqual(['down', 'up']);
    } finally { await talk.dispose(); }
  });

  it('also leaves a grant parked by an earlier ask unopened, since the host would refuse the audio', async () => {
    const track = { readyState: 'live', enabled: true, stop() { track.readyState = 'ended'; } };
    await primePushToTalkMicrophone({ media: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
    expect(track.enabled).toBe(false);
    setPushToTalkMicrophoneOff(() => true);
    const { audio } = streamer();
    await expect(audio.start()).rejects.toThrow(PUSH_TO_TALK_VOICE_OFF_MESSAGE);
    expect(track.enabled).toBe(false);
  });

  it('opens the microphone as before while the host has a voice route or has not said', async () => {
    for (const reader of [() => false, undefined]) {
      setPushToTalkMicrophoneOff(reader);
      const { audio, getUserMedia } = streamer();
      void audio.start().catch(() => {});
      await Promise.resolve();
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      await audio.cancel();
    }
  });
});

describe('the Talk row inside VR with no voice route on the host', () => {
  function talk(off: () => boolean) {
    const start = vi.fn(() => new Promise(() => { /* A prompt that cannot be drawn. */ }));
    const capture = refuseCaptureWhileVoiceOff({ start, stop: async () => undefined, active: () => false }, off);
    const playback = { unlock: async () => {}, play: async () => {}, close: async () => {} };
    const interaction = createVoiceInteraction({ capture, playback, begin: async () => ({}), send: async () => ({}) });
    return { interaction, start };
  }

  it('is refused at once with the unavailable line and never starts capture', async () => {
    const { interaction, start } = talk(() => true);
    await expect(interaction.toggle()).rejects.toThrow(UNAVAILABLE);
    expect(start).not.toHaveBeenCalled();
    expect(interaction.state()).toBe('idle');
    expect(interaction.message()).toBe(UNAVAILABLE);
  });

  it('starts capture as before when the gate is open', async () => {
    const { interaction, start } = talk(() => false);
    void interaction.toggle().catch(() => {});
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    await interaction.cancel();
  });

  it('the refusal reads as an unavailable microphone to the voice controller', () => {
    expect(VOICE_OFF_CAPTURE_MESSAGE).toMatch(/microphone capture is unavailable/i);
  });
});

describe('the companion page wiring', () => {
  it('reads voice capture from its own attach answer and heartbeat, and only a boolean', () => {
    expect(inspector).toMatch(/if\(beat && isCompanion && typeof \(result as any\)\?\.structuredContent\?\.voiceCapture==='boolean'\) hostVoiceCapture=\(result as any\)\.structuredContent\.voiceCapture;/);
  });
  it('closes both talk controls only on a host that said voice is off, and the Talk row only inside VR', () => {
    expect(inspector).toContain('setPushToTalkMicrophoneOff(()=>hostVoiceCapture===false);');
    expect(inspector).toContain('capture:refuseCaptureWhileVoiceOff(createVoiceCapture(),()=>talkCaptureClosed({voiceCapture:hostVoiceCapture,microphoneRefused:hostMicrophoneRefused},()=>workspace.snapshot().xrPresenting===true))');
    // Without the person's --no-ptt, the Talk row closes only inside VR on a host with no voice route.
    expect(talkCaptureClosed({ voiceCapture: false }, () => false)).toBe(false);
    expect(talkCaptureClosed({ voiceCapture: false }, () => true)).toBe(true);
    expect(talkCaptureClosed({ voiceCapture: true }, () => true)).toBe(false);
    expect(talkCaptureClosed({}, () => true)).toBe(false);
  });
});
