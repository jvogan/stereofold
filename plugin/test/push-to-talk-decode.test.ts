/**
 * The recording decode, run with the FFmpeg installed on this machine.
 *
 * The other push-to-talk tests answer for FFmpeg with a fake spawner. These
 * run the real binary with the input options the transcriber passes, so a
 * change to the demuxer for a type is caught by an actual decode. Skipped when
 * no FFmpeg is installed, and per container when this build cannot encode the
 * sample.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containerExtension, ffmpegBinCandidates, ffmpegInputOptions, readPcm16Wav } from '../src/push-to-talk-transcribe.js';

const ffmpeg = ffmpegBinCandidates().find(path => existsSync(path));
let directory = '';

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'stereofold-ptt-decode-')); });
afterEach(async () => { await rm(directory, { force: true, recursive: true }); });

function run(args: string[]) {
  return spawnSync(ffmpeg!, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 30_000 });
}

/** One second of tone in the container `mime` names, or undefined if this build cannot write it. */
function sample(mime: string, encoder: string[]): string | undefined {
  const path = join(directory, `utterance.${containerExtension(mime)}`);
  const made = run(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=1', '-ac', '1', '-ar', '48000', ...encoder, path]);
  return made.status === 0 ? path : undefined;
}

function decode(mime: string, input: string) {
  const output = join(directory, 'decoded.16k.wav');
  const result = run([...ffmpegInputOptions(mime), '-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output]);
  return { result, output };
}

describe.skipIf(!ffmpeg)('decoding recordings with this machine\'s FFmpeg', () => {
  it.for([
    ['audio/webm;codecs=opus', ['-c:a', 'libopus']],
    ['audio/mp4', ['-c:a', 'aac']],
    ['audio/ogg;codecs=opus', ['-c:a', 'libopus']],
    ['audio/mpeg', ['-c:a', 'libmp3lame']],
    ['audio/wav', ['-c:a', 'pcm_s16le']],
    ['audio/flac', ['-c:a', 'flac']],
    ['audio/aac', ['-c:a', 'aac', '-f', 'adts']],
    ['audio/aac', ['-c:a', 'aac', '-f', 'mp4']],
    ['audio/mp4a-latm', ['-c:a', 'aac', '-f', 'latm']],
  ] as [string, string[]][])('decodes %s written as %j', async ([mime, encoder], context) => {
    const input = sample(mime, encoder);
    if (!input) return context.skip();
    const { result, output } = decode(mime, input);
    expect(result.status, result.stderr).toBe(0);
    expect(readPcm16Wav(await readFile(output))?.samples.length).toBeGreaterThan(15_000);
  });

  it.each(['audio/webm;codecs=opus', 'audio/aac'])('does not follow an ffconcat script declared as %s', async mime => {
    // Probing reads this as a concat script and opens the file beside it,
    // which decodes as if it were the recording.
    const neighbour = join(directory, 'neighbour.wav');
    expect(run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '1', '-ar', '16000', neighbour]).status).toBe(0);
    const input = join(directory, `utterance.${containerExtension(mime)}`);
    await writeFile(input, "ffconcat version 1.0\nfile 'neighbour.wav'\n");
    const { result, output } = decode(mime, input);
    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });
});
