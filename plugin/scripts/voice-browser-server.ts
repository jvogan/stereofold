import { createStereoStructureServer, isDirectServerEntryPoint } from '../src/server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { createPushToTalkTranscriber } from '../src/push-to-talk-transcribe.js';

export function fixtureWav(seconds = 0.1) {
  const rate=24_000, samples=Math.round(rate*seconds), data=Buffer.alloc(samples*2);
  for(let i=0;i<samples;i++) {
    const t=i/rate, envelope=0.5+0.5*Math.sin(2*Math.PI*3*t);
    data.writeInt16LE(Math.round((Math.sin(2*Math.PI*220*t)+0.5*Math.sin(2*Math.PI*440*t))*6_000*envelope),i*2);
  }
  const header=Buffer.alloc(44); header.write('RIFF');header.writeUInt32LE(36+data.length,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(rate,24);
  header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);
  return Buffer.concat([header,data]).toString('base64');
}
export function voiceBrowserOptions(transcript = 'Can you explain this microtubule lattice?') {
  return {
    // Explicitly seal every voice route, including ones this scenario does not
    // expect to reach. A developer's installed helper must never be a fallback.
    transcriber: createPushToTalkTranscriber({ enabled: false, env: {}, exists: () => false }),
    replyAudio: {
      enabled: false, ready: false, describe: () => 'Reply provider disabled in browser test; narration uses the explicit fixture',
      synthesize: async () => undefined,
    },
    voice: {
      transcribe: async () => transcript,
      acknowledge: async () => ({ wavBase64: fixtureWav() }),
    },
  };
}

if (isDirectServerEntryPoint(process.argv[1], import.meta.url)) {
  const server = createStereoStructureServer(resolve('dist/inspector.html'), voiceBrowserOptions(process.argv[2] ?? process.env.VOICE_TEST_TRANSCRIPT));
  await server.connect(new StdioServerTransport());
}
