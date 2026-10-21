/**
 * A 16 kHz mono PCM16 WAV holding a 220 Hz tone, loud enough to pass the
 * push-to-talk speech-energy gate. Fake ffmpeg processes write this so a
 * test exercises transcript delivery rather than the silence path.
 */
export function voicedWav(seconds = 1, amplitude = 0.2): Buffer {
  const rate = 16_000;
  const count = Math.round(rate * seconds);
  const body = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index++)
    body.writeInt16LE(Math.round(Math.sin((index / rate) * 2 * Math.PI * 220) * amplitude * 32_767), index * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}
