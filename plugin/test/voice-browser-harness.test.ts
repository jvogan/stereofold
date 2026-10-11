import { describe, expect, it } from 'vitest';
import { fixtureWav, voiceBrowserOptions } from '../scripts/voice-browser-server.js';

describe('voice browser harness isolation', () => {
  it('supplies a repeatable two-second non-silent microphone WAV', () => {
    const wav = Buffer.from(fixtureWav(2), 'base64');
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(40)).toBe(2 * 24_000 * 2);
    expect(wav.length).toBe(wav.readUInt32LE(40) + 44);
    let peak = 0;
    for (let index = 44; index < wav.length; index += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(index)));
    expect(peak).toBeGreaterThan(1000);
  });
  it('uses deterministic narration and transcription and disables ambient voice providers', async () => {
    const options = voiceBrowserOptions('pause the tour');
    try {
      expect(await options.voice.transcribe()).toBe('pause the tour');
      const wav = Buffer.from((await options.voice.acknowledge()).wavBase64, 'base64');
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      expect(wav.readUInt32LE(4) + 8).toBe(wav.length);
      expect(options.transcriber.enabled).toBe(false);
      expect(options.transcriber.ready).toBe(false);
      expect(options.transcriber.applespeechBin).toBeUndefined();
      expect(options.transcriber.whisperBin).toBeUndefined();
      expect(options.replyAudio.enabled).toBe(false);
      expect(await options.replyAudio.synthesize()).toBeUndefined();
    } finally { await options.transcriber.dispose(); }
  });
});
