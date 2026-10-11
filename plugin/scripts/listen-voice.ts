/** Print transcript JSON lines for a separate conversation consumer; this does not start an agent. */
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readControlState } from './local-agent.js';
import { createVoiceTranscriptConsumer, sameVoiceSession, transcriptJsonLine } from './voice-transcript-consumer.js';

export async function main(argv: string[], { signal }: { signal?: AbortSignal } = {}) {
  const [statePath, ...rest] = argv;
  if (!statePath || rest.some(argument => argument !== '--replay'))
    throw Error('Usage: listen-voice.ts /absolute/path/to/host-state.json [--replay]');
  if (!isAbsolute(statePath)) throw Error('The control state-file path must be absolute.');
  const consumer = createVoiceTranscriptConsumer(rest.includes('--replay'));
  let backoff = 1_000;
  console.error(`Listening through ${statePath}. Transcript JSON lines require a separate conversation consumer.`);
  while (!signal?.aborted) {
    try {
      const control = await readControlState(statePath);
      const entries = await consumer.poll(control);
      // Never dispatch a response from an obsolete server/session to its replacement.
      if (!sameVoiceSession(control, await readControlState(statePath))) continue;
      for (const entry of entries) if (entry.text.trim()) console.log(transcriptJsonLine(entry));
      backoff = 1_000;
    } catch (error) {
      console.error(`voice listener: ${error instanceof Error ? error.message : String(error)} Retrying in ${backoff / 1_000} s.`);
      await new Promise(done => setTimeout(done, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
