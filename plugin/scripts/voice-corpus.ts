/**
 * Play the 40-case voice corpus against an in-process host.
 *
 *   pnpm --dir plugin exec tsx scripts/voice-corpus.ts [--only V01,V02] [--update-corpus]
 *
 * The corpus logic is in `lab/voice-corpus/runner.mjs`;
 * this file exists because that lab is plain ESM and the server is TypeScript.
 * Read the runner's header before reading any output it produces: these runs
 * are INJECTED TRANSCRIPTS and are supporting evidence only. No case's status
 * moves out of `not_run` without real speech and a wearer.
 *
 * Nothing here starts a host, opens a share, or touches a headset.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyntheticCorpusHost } from './voice-corpus-host.js';
// @ts-ignore Shared JavaScript corpus runner; the lab is plain ESM by design.
import { BANNER, runCorpus, writeRun } from '../../lab/voice-corpus/runner.mjs';

const LAB = fileURLToPath(new URL('../../lab/voice-corpus/', import.meta.url));
const CORPUS = fileURLToPath(new URL('../../fixtures/voice-cases.json', import.meta.url));

export function parseVoiceCorpusArguments(argv: readonly string[]) {
  const options: { only?: string[]; updateCorpus: boolean; help: boolean } = { updateCorpus: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--only') options.only = argv[++index]?.split(',').map(value => value.trim().toUpperCase());
    else if (flag === '--update-corpus') options.updateCorpus = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw Error(`Unknown option "${flag}".`);
  }
  return options;
}

export const USAGE = `Usage: tsx scripts/voice-corpus.ts [--only V01,V02] [--update-corpus]

Plays fixtures/voice-cases.json against an in-process
host with INJECTED transcripts, and writes lab/voice-corpus/runs/<timestamp>/.
--update-corpus records each case's injected result in the corpus file without
touching any case's status, which only real speech may change.`;

async function main() {
  const options = parseVoiceCorpusArguments(process.argv.slice(2));
  if (options.help) { console.log(USAGE); return; }
  const host = await createSyntheticCorpusHost();
  try {
    const run = await runCorpus({ host, corpusPath: CORPUS, only: options.only });
    const directory = await writeRun(run, { outDir: resolve(LAB, 'runs'), corpusPath: CORPUS, updateCorpus: options.updateCorpus });
    console.log(BANNER);
    console.log(`Wrote ${directory}`);
    console.log(`Appropriate over scripted: ${run.totals.scriptedBar}. `
      + `Wrong target ${run.totals.wrongTarget}, duplicate ${run.totals.duplicate}, false completion ${run.totals.falseCompletion}.`);
    if (run.totals.runnerErrors > 0) process.exitCode = 1;
  } finally { await host.close(); }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) await main();
